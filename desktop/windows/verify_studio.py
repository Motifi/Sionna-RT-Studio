"""Verify real tracing, cached export and teardown in an installed Studio runtime."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4
import zipfile

import numpy as np


HTTP = build_opener(ProxyHandler({}))  # Local Studio requests must bypass system proxies.
CFR_AXES = ["time", "ue", "rx_port", "ap", "tx_port", "subcarrier"]
CIR_AXES = CFR_AXES[:-1] + ["path"]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def request(origin, path, payload=None, *, token=None, timeout=180):
    headers = {"Studio-Token": token} if token else {}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    try:
        with HTTP.open(Request(origin + path, body, headers), timeout=timeout) as response:
            return response.read()
    except HTTPError as exc:
        if token:
            raise
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{path}: HTTP {exc.code} {message}") from exc


def enu(x, y):
    return {"x": x, "y": y, "z": 0}


def fixture():
    txs = [{"id": ident, "name": ident, "enu": enu(-20, y), "height": 5, "antennaArraySize": [2, 1]}
           for ident, y in [("ap1", 0), ("ap2", 10)]]
    rxs = [{"id": ident, "name": ident, "enu": enu(20, y), "height": 1.5, "antennaArraySize": [1, 2]}
           for ident, y in [("ue1", 0), ("ue2", 10), ("ue3", -10)]]
    return {
        "mode": "static", "output": "cir_cfr", "txs": txs, "rxs": rxs,
        "buildings": [], "freqGhz": 3.5, "maxDepth": 0, "numSubcarriers": 8,
        "subcarrierSpacing": 30_000, "normalizeDelays": False,
        "options": {"los": True, "specularReflection": False, "txPattern": "iso", "pathSamplesPerSource": 10_000},
    }


def read_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(set(archive.namelist()) == {"manifest.json", "csi.npz"}, "Unexpected ZIP entries")
        return json.loads(archive.read("manifest.json")), archive.read("csi.npz")


def verify_run(origin, folder, config, time_seconds, rx_positions):
    mode, output = config["mode"], config["output"]
    tx_ids = [tx["id"] for tx in config["txs"]]
    rx_ids = [rx["id"] for rx in config["rxs"]]
    expected_shape = (len(time_seconds), len(rx_ids), 2, len(tx_ids), 2, 8)
    capacities = {"ap1": 0, "ap2": 25}
    run = json.loads(request(origin, "/api/csi-runs", config))
    require(run["mode"] == mode and run["output"] == output, "Unexpected CSI run mode")
    require(tuple(run["shape"]) == expected_shape, f"Unexpected CSI shape {run['shape']}")
    require(run["txIds"] == tx_ids and run["rxIds"] == rx_ids, "Device order changed during solve")
    expected_links = {(rx_id, tx_id) for rx_id in rx_ids for tx_id in tx_ids}
    links = run["links"]
    require(len(links) == len(expected_links) and {(link["rxId"], link["txId"]) for link in links} == expected_links,
            "Unexpected number or IDs of preview links")
    if mode == "trajectory":
        require(run["execution"]["successfulPathSolverDispatches"] == 1, "Trajectory did not trace in one batch")

    route = f"/api/csi-runs/{run['runId']}"
    data = request(origin, route + "/export", {"fronthaulMbpsByTxId": capacities})
    archive_path = folder / f"{mode}-{output}.zip"
    archive_path.write_bytes(data)
    manifest, npz = read_archive(data)
    for name in ("runId", "mode", "output", "shape", "txIds", "rxIds", "pathCount", "timeSeconds", "rxPositions"):
        require(manifest[name] == run[name], f"Manifest and run disagree on {name}")
    require(manifest["fronthaulMbpsByTxId"] == capacities, "Fronthaul metadata changed during export")
    require(manifest["delayReference"] == "absolute_propagation", "Unexpected CIR delay reference")
    require(manifest["positionFrame"] == "ENU_m", "Unexpected export coordinate frame")
    require(manifest["axes"]["a"] == CIR_AXES, "Unexpected CIR axis order")

    with np.load(io.BytesIO(npz), allow_pickle=False) as arrays:
        np.testing.assert_array_equal(arrays["time_seconds"], time_seconds)
        np.testing.assert_allclose(arrays["rx_positions"], rx_positions, rtol=0, atol=1e-6)
        np.testing.assert_array_equal(arrays["rx_positions"], run["rxPositions"])
        np.testing.assert_array_equal(arrays["tx_positions"], run["txPositions"])
        np.testing.assert_array_equal(arrays["tx_ids"], tx_ids)
        np.testing.assert_array_equal(arrays["rx_ids"], rx_ids)
        frequencies = arrays["frequencies"]
        np.testing.assert_array_equal(frequencies, np.arange(-4, 4) * config["subcarrierSpacing"])
        np.testing.assert_array_equal(frequencies, manifest["frequenciesHz"])
        valid, tau, coeff = arrays["valid_paths"], arrays["tau_geometric"], arrays["a"]
        path_shape = (len(time_seconds), len(rx_ids), len(tx_ids), run["pathCount"])
        require(valid.shape == tau.shape == path_shape, "Unexpected CIR path geometry shape")
        require(coeff.shape == expected_shape[:-1] + (run["pathCount"],), "Unexpected CIR coefficient shape")
        require(coeff.dtype == np.complex64 and np.isfinite(coeff).all(), "Invalid CIR coefficients")
        require(valid.dtype == np.bool_ and np.all(valid.sum(axis=-1) == 1), "Expected one LOS path per link snapshot")
        distance = np.linalg.norm(arrays["rx_positions"][:, :, None, :] - arrays["tx_positions"], axis=-1)
        np.testing.assert_allclose(tau[valid], (distance / 299_792_458).ravel(), rtol=1e-5, atol=1e-12)
        phase = np.exp(-2j * np.pi * np.where(valid, tau, 0)[..., None] * frequencies)
        response = np.einsum("turapk,tuakf->turapf", coeff * valid[:, :, None, :, None, :], phase)
        require(np.isfinite(response).all() and np.all(np.any(np.abs(response) > 0, axis=(2, 4, 5))),
                "Expected finite, nonzero CFR on every LOS link snapshot")
        if output == "cir_cfr":
            require(manifest["axes"]["h_freq"] == CFR_AXES, "Unexpected CFR axis order")
            require(arrays["h_freq"].dtype == np.complex64, "Unexpected CFR precision")
            np.testing.assert_allclose(arrays["h_freq"], response, rtol=1e-5, atol=1e-10)
        else:
            require("h_freq" not in arrays.files and "h_freq" not in manifest["axes"], "CIR-only archive contains CFR")

    for sample, ue, ap in np.ndindex(expected_shape[0], expected_shape[1], expected_shape[3]):
        query = urlencode({"sampleIndex": sample, "rxId": rx_ids[ue], "txId": tx_ids[ap]})
        preview = json.loads(request(origin, route + "/preview?" + query))
        require(preview["metrics"]["numPaths"] == 1 and len(preview["paths"]) == 1, "LOS path missing in preview")
        np.testing.assert_array_equal(preview["frequenciesHz"], frequencies)
        power = np.mean(np.abs(response[sample, ue, :, ap]) ** 2, axis=(0, 1))
        np.testing.assert_allclose(preview["magnitudeDb"], 10 * np.log10(power), rtol=0, atol=1e-3)

    changed = {"ap1": 50, "ap2": None}
    second_manifest, second_npz = read_archive(request(origin, route + "/export", {"fronthaulMbpsByTxId": changed}))
    require(second_manifest["fronthaulMbpsByTxId"] == changed and second_npz == npz,
            "Fronthaul-only re-export did not preserve cached CSI bytes")
    return {
        "runId": run["runId"], "output": output, "shape": list(expected_shape), "links": len(expected_links),
        "verifiedLinkSnapshots": len(expected_links) * len(time_seconds), "timeSeconds": time_seconds,
        "rxPositions": rx_positions, "archive": archive_path.name, "archiveBytes": len(data),
        "npzSha256": sha256(npz).hexdigest(), "fronthaulOnlyReexportReusedNpz": True,
    }


def wait_ready(child, folder, token):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if token:
            port_file = folder / "server-port.txt"
            if port_file.exists():
                origin = "http://127.0.0.1:" + port_file.read_text(encoding="ascii").strip()
                try:
                    request(origin, "/_desktop-ready", token=token, timeout=2)
                    return {"origin": origin, "backendPid": child.pid}
                except (URLError, TimeoutError, ConnectionError):
                    pass
        else:
            error = folder / "desktop-error.json"
            ready = folder / "desktop-ready.json"
            if error.exists():
                raise RuntimeError(json.loads(error.read_text(encoding="utf-8-sig"))["error"])
            if ready.exists():
                result = json.loads(ready.read_text(encoding="utf-8-sig"))
                require(result.get("uiReady") is True and result.get("webgl2") is True,
                        "Windows desktop did not render the Studio UI and WebGL2 canvas")
                return result
        if child.poll() is not None:
            raise RuntimeError(f"Studio exited before readiness (exit code {child.returncode}). Check studio.log.")
        time.sleep(0.1)
    raise TimeoutError("Studio did not start within 180 seconds. Check studio.log.")


def stop(child, folder, origin):
    if child.poll() is None:
        if child.stdin is not None:
            child.stdin.close()
        else:
            (folder / "close").touch()
    try:
        child.wait(timeout=20)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=10)
        raise RuntimeError("Studio needed a forced shutdown") from None
    require(child.returncode == 0, f"Studio exited with code {child.returncode}")
    if origin:
        port = urlsplit(origin).port
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                raise RuntimeError(f"The Studio solver still accepts connections on port {port}")
        except (ConnectionRefusedError, TimeoutError):
            pass


def nvidia_diagnostics():
    tool = shutil.which("nvidia-smi")
    if tool is None:
        return {"available": False}
    try:
        result = subprocess.run(
            [tool, "--query-gpu=name,driver_version,compute_cap", "--format=csv,noheader"],
            capture_output=True, text=True, errors="replace", timeout=10,
        )
        return {"available": True, "exitCode": result.returncode, "output": (result.stdout + result.stderr).strip()}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": True, "error": str(exc)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    launcher = parser.add_mutually_exclusive_group(required=True)
    launcher.add_argument("--app", type=Path, help="Installed Windows desktop executable")
    launcher.add_argument("--headless", action="store_true", help="Start installed Python server for CI")
    parser.add_argument("--runtime", type=Path, required=True, help="Installed runtime containing backend and desktop")
    parser.add_argument("--report-directory", type=Path, required=True, help="Parent folder for the report and ZIPs")
    parser.add_argument("--allow-cpu", action="store_true", help="Permit compatibility verification without CUDA")
    args = parser.parse_args()
    started = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = args.report_directory.resolve() / f"{started}-{uuid4().hex[:8]}"
    folder.mkdir(parents=True)
    print(f"Studio verification files: {folder}", flush=True)
    report = {"ok": False, "cudaPassed": False, "requireCuda": not args.allow_cpu,
              "mode": "headless" if args.headless else "desktop", "results": {}}
    child, origin = None, None
    with ExitStack() as stack:
        try:
            report["nvidiaSmi"] = nvidia_diagnostics()
            token = None
            if args.headless:
                token = secrets.token_hex(32)
                env = dict(os.environ, SRTS_DESKTOP_LAUNCH_TOKEN=token,
                           SRTS_DESKTOP_PORT_FILE=str(folder / "server-port.txt"))
                env.pop("PYTHONHOME", None)
                env.pop("PYTHONPATH", None)
                log = stack.enter_context((folder / "studio.log").open("wb"))
                child = subprocess.Popen([sys.executable, "-B", "-u", "-m", "desktop.studio_server", "0"],
                                         cwd=args.runtime.resolve(), env=env, stdin=subprocess.PIPE,
                                         stdout=log, stderr=subprocess.STDOUT)
            else:
                child = subprocess.Popen([str(args.app.resolve()), "--acceptance", str(folder)])
            ready = wait_ready(child, folder, token)
            origin = ready["origin"].rstrip("/")
            require(re.fullmatch(r"http://127\.0\.0\.1:\d{1,5}", origin), "Studio did not report a loopback origin")
            health = json.loads(request(origin, "/api/health"))
            report["health"] = health
            report["uiReady"] = ready.get("uiReady")
            report["webgl2"] = ready.get("webgl2")
            report["backendPid"] = ready["backendPid"]
            require(health.get("ok") is True and health.get("engine") == "Sionna RT", "Studio solver is unhealthy")
            require(b'id="root"' in request(origin, "/"), "The packaged Studio interface is missing")
            is_cuda = health.get("gpu") is True and health.get("variant") == "cuda_ad_mono_polarized"
            print(f"Tracing with {health['variant']}", flush=True)

            static = fixture()
            report["results"]["static"] = verify_run(
                origin, folder, static, [0], [[[20, 0, 1.5], [20, 10, 1.5], [20, -10, 1.5]]],
            )
            print("PASS static CSI/CIR, 2 AP x 3 UE", flush=True)
            positions = [-10, 0, 10]
            trajectory = dict(static, mode="trajectory", output="cir", rxs=static["rxs"][:1], speedKmh=36,
                              waypoints=[enu(20, y) for y in positions], timeSeconds=[0, 1, 2])
            report["results"]["trajectory"] = verify_run(
                origin, folder, trajectory, [0, 1, 2], [[[20, y, 1.5]] for y in positions],
            )
            print("PASS single-UE trajectory CIR and reconstructed response", flush=True)
            report["cudaPassed"] = is_cuda
            require(is_cuda or args.allow_cpu,
                    f"CUDA acceptance requires an NVIDIA-backed solve. Studio used {health['variant']}.")
        except Exception as exc:
            report["error"] = str(exc)
        finally:
            if child is not None:
                try:
                    stop(child, folder, origin)
                    report["backendStopped"] = bool(origin)
                except Exception as exc:
                    report["shutdownError"] = str(exc)
    report["ok"] = "error" not in report and "shutdownError" not in report
    report_file = folder / "report.json"
    report_file.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    status = "PASS" if report["ok"] else "FAIL"
    print(f"{status}: {report_file}", flush=True)
    for key in ("error", "shutdownError"):
        if key in report:
            print(report[key], flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
