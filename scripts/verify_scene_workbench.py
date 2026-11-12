"""Exercise physical scenes through the real API and an independent replay.

Use the same Python as the API server. With --launch, start and restart a
loopback Uvicorn server with its own run directory and startup logs.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import platform
import secrets
import socket
import subprocess
import sys
import time
import traceback
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4
import zipfile

import numpy as np
from shapely.geometry import Point, Polygon

from candidate_info import ROOT, runtime_packages, source_revision


HTTP = build_opener(ProxyHandler({}))


def request(origin, path, payload=None, *, timeout=180):
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        with HTTP.open(Request(origin + "/api/" + path, data, {"Content-Type": "application/json"}),
                       timeout=timeout) as response:
            return response.read()
    except HTTPError as error:
        raise RuntimeError(f"{path}: HTTP {error.code}: {error.read().decode(errors='replace')}") from error


def write_json(path, payload):
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def point(x, y, z=0):
    return {"x": x, "y": y, "z": z}


def device(ident, x, y=0):
    return {"id": ident, "name": ident, "enu": point(x, y), "height": 1.5,
            "antennaArraySize": [1, 1]}


def wall(ident, a, b, material="itu_brick"):
    return {"id": ident, "category": "building", "kind": "wall", "height": 4.0,
            "baseZ": -0.2, "material": material, "enuPoints": [point(*a), point(*b)]}


def fixtures():
    clear = {
        "buildings": [], "txs": [device("ap", -20)], "rxs": [device("ue", 20)],
        "freqGhz": 3.5, "numSubcarriers": 16, "subcarrierSpacing": 30_000,
        "normalizeDelays": False, "maxDepth": 0,
        "options": {"txPattern": "iso", "los": True, "specularReflection": False,
                    "pathSamplesPerSource": 10_000, "pathSeed": 42},
    }
    blocked = {**clear, "buildings": [wall("partition", (0, -10), (0, 10))]}
    reflected = {
        **clear, "buildings": [wall("reflector", (-24, 12), (24, 12))], "maxDepth": 1,
        "options": {**clear["options"], "los": False, "specularReflection": True,
                    "pathSamplesPerSource": 100_000},
    }

    def surface(ident, role, base_z, z_values):
        xy = [(0, 0), (4, 0), (4, 4), (0, 4)]
        vertices = [coordinate for (x, y), z in zip(xy, z_values) for coordinate in (x, y, z)]
        return {"id": ident, "kind": "mesh", "category": "terrain" if role == "ground" else "building",
                "rfRole": role, "floor": "Level" if role == "surface" else None, "baseZ": base_z,
                "height": 0, "enuPoints": [], "mesh": {"vertices": vertices, "triangles": [0, 1, 2, 0, 2, 3]}}

    geometry = [surface("slope", "ground", 0, [0, 4, 4, 0]),
                surface("slab-lower", "surface", 4, [0] * 4),
                surface("slab-upper", "surface", 7, [0] * 4)]
    heights = {**clear, "buildings": geometry, "rxs": [
        {**device("ground", 2, 2), "heightReference": "ground"},
        {**device("lower-floor", 2, 2), "heightReference": "enu", "height": 5.5},
        {**device("upper-floor", 2, 2), "heightReference": "enu", "height": 8.5},
    ]}
    multi_ap = {
        **heights, "mode": "trajectory", "output": "cir", "normalizeDelays": True,
        "txs": [device("ap", -20), device("ap2", 20, -10)], "rxs": heights["rxs"][1:2],
        "speedKmh": 3.6, "waypointFrame": "ENU_m", "waypoints": [point(2, 2, 5.5 + i / 2) for i in range(7)],
        "timeSeconds": [i / 2 for i in range(7)], "fronthaulMbpsByTxId": {"ap": 0, "ap2": 25},
    }
    return {"los": clear, "blocked": blocked, "reflection": reflected, "slope-and-slabs": heights,
            "dual-ap-vertical-trajectory": multi_ap}


def verify(origin, output, *, expected_variant=None, restart=None, build_info=None):
    """Record the same fixtures on every backend, even if startup fails."""
    output.mkdir(parents=True, exist_ok=True)
    inputs = fixtures()
    write_json(output / "fixtures.json", inputs)
    report = {
        "ok": False, "startedAtUtc": datetime.now(timezone.utc).isoformat(),
        "build": build_info if build_info is not None else source_revision(),
        "requestedVariant": expected_variant, "host": platform.platform(),
        "verificationPython": runtime_packages(), "fixtures": "fixtures.json",
        "fixturesSha256": sha256((output / "fixtures.json").read_bytes()).hexdigest(),
        "tolerances": {"losDelayRtol": 1e-6, "losAmplitudeRtol": 2e-6, "replayRtol": 2e-5,
                       "replayDelayAtolSeconds": 1e-12, "replayChannelAtol": 1e-10,
                       "coordinatesAtolM": 1e-3},
        "results": {},
    }
    try:
        if callable(origin):
            origin = origin()
        health = json.loads(request(origin, "health", timeout=10))
        report["runtime"] = health
        if not health.get("ok"):
            raise RuntimeError("The ray-tracing service reported an unhealthy runtime.")
        if expected_variant and health["variant"] != expected_variant:
            raise RuntimeError(f"Expected {expected_variant}; solver used {health['variant']}.")
        if build_info and build_info.get("appVersion") != health.get("appVersion"):
            raise RuntimeError("Solver version does not match the supplied build-info.json.")
        _verify(origin, output, inputs, health, report["results"], restart)
        report["ok"] = True
    except Exception as error:
        report["failure"] = {"stage": "verification" if "runtime" in report else "startup",
                             "reason": str(error), "type": type(error).__name__}
        traceback.print_exc()
    write_json(output / "verification.json", report)
    print(f"{'PASS' if report['ok'] else 'FAIL'}: {output / 'verification.json'}", flush=True)
    return report


def _verify(origin, output, inputs, health, results, restart):
    def send(path, payload=None):
        return request(origin, path, payload)

    def read(path, payload=None):
        return json.loads(send(path, payload))

    clear, blocked, reflected = (inputs[name] for name in ("los", "blocked", "reflection"))
    inspection = read("scene-inspection", blocked)
    assert inspection["objects"][0]["status"] == "physical"
    assert inspection["objects"][0]["material"] == "itu_brick"
    assert len(inspection["meshes"][1]["triangles"]) == 6
    assert read("scene-inspection", clear)["sceneId"] != inspection["sceneId"]
    assert read("scene-inspection", {**blocked, "buildings": [{**blocked["buildings"][0], "name": "Label"}]})[
        "sceneId"] == inspection["sceneId"]
    repaired = {"id": "crossed", "category": "building", "height": 4, "material": "unknown",
                "enuPoints": [point(0, 0), point(8, 8), point(8, 0), point(0, 8)]}
    invalid = {"id": "missing", "category": "building", "height": 4, "enuPoints": [point(0, 0)]}
    issues = read("scene-inspection", {**clear, "buildings": [repaired, invalid]})["objects"]
    assert issues[0]["status"] == "physical" and len(issues[0]["issues"]) == 3
    assert issues[1]["status"] == "skipped" and issues[1]["issues"]

    collapsed = {"id": "collapsed", "category": "building", "kind": "mesh", "height": 2, "enuPoints": [],
                 "mesh": {"vertices": [999999.99, 0, 0, 1000000, 0, 0, 999999.99, 0, 2], "triangles": [0, 1, 2]}}
    collapsed_scene = {**clear, "buildings": [collapsed]}
    precision = read("scene-inspection", collapsed_scene)
    assert precision["objects"][0]["status"] == "skipped" and len(precision["meshes"]) == 1
    assert "solver precision" in " ".join(precision["objects"][0]["issues"])
    with zipfile.ZipFile(io.BytesIO(send("scene-export", collapsed_scene))) as bundle:
        assert [name for name in bundle.namelist() if name.endswith(".ply")] == ["meshes/ground.ply"]

    def trace(config):
        run = read("csi-runs", {**config, "mode": "static"})
        assert run["sceneId"] == read("scene-inspection", config)["sceneId"]
        assert run["solverRuntime"]["variant"] == health["variant"]
        archive = send("csi-runs/" + run["runId"] + "/export", {})
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            assert manifest["scene"]["sceneId"] == run["sceneId"]
            return np.load(io.BytesIO(bundle.read("csi.npz")))

    free = trace(clear)
    valid = free["valid_paths"]
    assert np.count_nonzero(valid) == 1
    delay = float(free["tau_geometric"][valid][0])
    np.testing.assert_allclose(delay, 40 / 299_792_458, rtol=1e-6, atol=0)
    amp = float(abs(free["a"].reshape(-1)[0]))
    np.testing.assert_allclose(amp, 299_792_458 / (4 * np.pi * 3.5e9 * 40), rtol=2e-6, atol=0)
    assert not trace(blocked)["valid_paths"].any()
    restored = trace(clear)
    for field in ("a", "tau_geometric", "h_freq"):
        np.testing.assert_array_equal(restored[field], free[field])

    # A pure single reflection. The exported box also contains a ground
    # reflection, so locate the vertical wall path by its image distance.
    one_bounce = trace(reflected)
    expected = np.hypot(40, 24) / 299_792_458
    assert np.isclose(one_bounce["tau_geometric"][one_bounce["valid_paths"]],
                      expected, rtol=2e-5, atol=1e-12).any()

    for name, config, studio in (("los", clear, free), ("reflection", reflected, one_bounce)):
        path = output / name
        path.mkdir(exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(send("scene-export", config))) as bundle:
            bundle.extractall(path)
            manifest = json.loads(bundle.read("manifest.json"))
            assert manifest["scene"]["sceneId"] == read("scene-inspection", config)["sceneId"]
        env = {**os.environ, "SRTS_MITSUBA_VARIANT": health["variant"]}
        subprocess.run([sys.executable, str(path / "load_scene.py")], cwd=path, env=env, check=True)
        with np.load(path / "cir.npz") as replay:
            # PathSolver can enumerate paths in a different order on replay.
            # These fixtures have distinct delays. Use the same permutation for
            # each delay and all of its complex antenna-port coefficients.
            studio_tau = studio["tau_geometric"][0]
            replay_tau = replay["tau"]
            studio_order = np.argsort(studio_tau, axis=-1)
            replay_order = np.argsort(replay_tau, axis=-1)
            np.testing.assert_allclose(
                np.take_along_axis(studio_tau, studio_order, axis=-1),
                np.take_along_axis(replay_tau, replay_order, axis=-1),
                rtol=2e-5, atol=1e-12,
            )
            np.testing.assert_allclose(
                np.take_along_axis(studio["a"][0], studio_order[:, None, :, None, :], axis=-1),
                np.take_along_axis(replay["a"][..., 0], replay_order[:, None, :, None, :], axis=-1),
                rtol=2e-5, atol=1e-10,
            )
            np.testing.assert_allclose(studio["h_freq"][0], replay["h"][..., 0, :], rtol=2e-5, atol=1e-10)

    # Import a centimetre-based OBJ wall using Y-up axes, then solve against
    # the compiled triangles. This uses the same upload endpoint as Scene.
    obj = b"v 0 0 -1000\nv 0 0 1000\nv 0 400 1000\nv 0 400 -1000\nf 1 2 3\nf 1 3 4\n"
    query = urlencode({"filename": "partition.obj", "axes": "y-up", "scale": 0.01, "material": "itu_glass"})
    with HTTP.open(Request(origin + "/api/mesh-import?" + query, obj), timeout=180) as response:
        imported = json.load(response)
    imported_scene = {**clear, "buildings": imported["objects"]}
    mesh = read("scene-inspection", imported_scene)["meshes"][1]
    np.testing.assert_allclose(np.asarray(mesh["vertices"]).reshape(-1, 3).min(axis=0), [0, -10, 0])
    np.testing.assert_allclose(np.asarray(mesh["vertices"]).reshape(-1, 3).max(axis=0), [0, 10, 4])
    assert mesh["material"] == "itu_glass" and not trace(imported_scene)["valid_paths"].any()

    padded_ply = (b"ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n"
                  b"element face 1\nproperty list uchar int vertex_indices\nend_header\n"
                  b"0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n" + b"\n" * 250_000)
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("scene.xml", '<scene><shape type="ply"><string name="filename" value="mesh.ply"/></shape></scene>')
        bundle.writestr("mesh.ply", padded_ply)
    for filename, payload in (("mesh.ply", padded_ply), ("scene.zip", package.getvalue())):
        upload = Request(origin + "/api/mesh-import?" + urlencode({"filename": filename}), payload)
        try:
            with HTTP.open(upload, timeout=10):
                raise AssertionError("ASCII PLY with too many rows was accepted")
        except HTTPError as error:
            assert error.code == 400 and "250000 data rows" in json.load(error)["detail"]

    building = {"id": "building", "category": "building", "height": 8, "baseZ": 3,
                "enuPoints": [point(-24, -3), point(-16, -3), point(-16, 3), point(-24, 3)]}
    elevated = {**clear, "buildings": [building]}
    assert trace(elevated)["tx_positions"][0, 2] == 12.5
    indoor_tx = {**clear["txs"][0], "height": 6, "heightReference": "enu"}
    assert trace({**elevated, "txs": [indoor_tx]})["tx_positions"][0, 2] == 6

    crossed = {**building, "baseZ": 0, "enuPoints": [point(0, 0), point(8, 8), point(0, 8), point(4, 0)]}
    roof, = read("scene-roofs", [crossed, invalid, blocked["buildings"][0]])
    exterior, *holes = [[(p["x"], p["y"]) for p in ring] for ring in roof["rings"]]
    footprint = Polygon(exterior, holes)
    assert roof["topZ"] == 8 and not footprint.contains(Point(2, 1)) and footprint.contains(Point(3, 7))
    receivers = [{**device("discarded", 2), "enu": point(2, 1)}, {**device("retained", 3), "enu": point(3, 7)}]
    repaired_run = trace({**clear, "buildings": [crossed], "rxs": receivers})
    np.testing.assert_array_equal(repaired_run["rx_positions"].reshape(-1, 3)[:, 2], [1.5, 9.5])

    route = read("csi-runs", {
        **clear, "mode": "trajectory", "output": "cir",
        "rxs": [{**clear["rxs"][0], "height": 3, "heightReference": "enu"}],
        "waypoints": [point(20, 0), {**point(20, 10), "z": 2}], "timeSeconds": [0, 1],
    })
    np.testing.assert_array_equal(route["rxPositions"], [[[20, 0, 3]], [[20, 10, 5]]])

    results.update({"losDelayNs": delay * 1e9, "freeSpacePathLossDb": -20 * np.log10(amp),
                    "wallLosPaths": 0, "restoredExactly": True, "reflectionDelayNs": expected * 1e9,
                    "importedObjLosPaths": 0, "roofPositionM": 12.5, "indoorPositionM": 6,
                    "legacyTrajectoryElevationsM": [3, 5],
                    "losCfrSha256": sha256(free["h_freq"].tobytes()).hexdigest()})
    _verify_archives(origin, output, inputs, health, results, restart)


def _compare_replay(studio, replay):
    assert set(studio.files) == set(replay.files)
    for key in set(studio.files) - {"a", "tau_geometric", "valid_paths", "h_freq"}:
        np.testing.assert_array_equal(replay[key], studio[key], err_msg=key)

    def sorted_paths(arrays):
        valid, delays, coefficients = (arrays[key] for key in ("valid_paths", "tau_geometric", "a"))
        order = np.argsort(np.where(valid, delays, np.inf), axis=-1, kind="stable")
        return (np.take_along_axis(valid, order, axis=-1),
                np.take_along_axis(delays, order, axis=-1),
                np.take_along_axis(coefficients, order[:, :, None, :, None, :], axis=-1))

    valid, delays, coefficients = sorted_paths(studio)
    other_valid, other_delays, other_coefficients = sorted_paths(replay)
    np.testing.assert_array_equal(other_valid, valid)
    np.testing.assert_allclose(other_delays, delays, rtol=2e-5, atol=1e-12)
    np.testing.assert_allclose(other_coefficients, coefficients, rtol=2e-5, atol=1e-10)
    if "h_freq" in studio.files:
        np.testing.assert_allclose(replay["h_freq"], studio["h_freq"], rtol=2e-5, atol=1e-10)
        if not valid.any():
            assert not replay["h_freq"].any() and not studio["h_freq"].any()


def _verify_archives(origin, output, inputs, health, results, restart):
    project_id, other_project_id = str(uuid4()), str(uuid4())
    project_path = f"projects/{project_id}/csi-runs"
    coordinates = [[2, 2, 5.5 + i / 2] for i in range(7)]
    results["archiveReplay"] = {}
    histories = []
    for name in ("slope-and-slabs", "dual-ap-vertical-trajectory", "blocked"):
        config = {"mode": "static", **inputs[name], "projectId": project_id}
        run = json.loads(request(origin, "csi-runs", config))
        route = f"csi-runs/{run['runId']}"
        suffix = "?" + urlencode({"projectId": project_id})
        preview_path = route + "/preview?" + urlencode({"projectId": project_id, "sampleIndex": 0,
                                                        "rxId": run["rxIds"][0], "txId": run["txIds"][0]})
        preview = json.loads(request(origin, preview_path))
        export_path = route + "/export" + suffix
        archive = request(origin, export_path, {})
        folder = output / f"csi-{name}"
        folder.mkdir(exist_ok=True)
        (output / f"csi-{name}.zip").write_bytes(archive)
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            for field in ("runId", "shape", "rxPositions", "txPositions", "timeSeconds", "txIds", "rxIds"):
                assert manifest[field] == run[field], field
            assert manifest["sceneId"] == run["sceneId"]
            assert bundle.getinfo("csi.npz").compress_type == zipfile.ZIP_STORED
            members = set(bundle.namelist())
            assert {"csi.npz", "manifest.json", "scene.xml", "request.json", "replay_csi.py"} <= members
            assert set(manifest["files"]) == members - {"manifest.json"}
            for member, expected in manifest["files"].items():
                assert sha256(bundle.read(member)).hexdigest() == expected, member
            bundle.extractall(folder)
            data = bundle.read("csi.npz")
        archived = json.loads((folder / "request.json").read_text(encoding="utf-8"))
        assert archived["projectId"] == project_id
        assert archived["mode"] == config["mode"]
        assert archived["options"]["pathSeed"] == config["options"]["pathSeed"]
        env = {**os.environ, "SRTS_MITSUBA_VARIANT": health["variant"], "PYTHONNOUSERSITE": "1"}
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        replay_path = folder / "csi-replay.npz"
        replay_path.unlink(missing_ok=True)
        with (folder / "replay.log").open("wb") as log:
            subprocess.run([sys.executable, "-B", "replay_csi.py"], cwd=folder, env=env,
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
        with np.load(io.BytesIO(data), allow_pickle=False) as studio, np.load(replay_path, allow_pickle=False) as replay:
            _compare_replay(studio, replay)
            assert tuple(run["shape"])[:5] == studio["a"].shape[:5]
            if name == "slope-and-slabs":
                expected = [[[2, 2, 3.5], [2, 2, 5.5], [2, 2, 8.5]]]
                for recorded in (run["rxPositions"], studio["rx_positions"]):
                    np.testing.assert_allclose(recorded, expected, rtol=0, atol=1e-3)
            elif name == "dual-ap-vertical-trajectory":
                assert run["txIds"] == ["ap", "ap2"] and run["rxIds"] == ["lower-floor"]
                assert run["execution"]["successfulPathSolverDispatches"] == 1
                assert "h_freq" not in studio.files
                assert manifest["fronthaulMbpsByTxId"] == {"ap": 0, "ap2": 25}
                for recorded in (run["rxPositions"], studio["rx_positions"]):
                    np.testing.assert_allclose(recorded, np.asarray(coordinates)[:, None, :], rtol=0, atol=1e-3)
                np.testing.assert_allclose(run["rxVelocities"], [[[0, 0, 1]]] * 7, rtol=0, atol=1e-3)
                np.testing.assert_array_equal(studio["time_seconds"], inputs[name]["timeSeconds"])
            else:
                assert not studio["valid_paths"].any()
        results["archiveReplay"][name] = {"runId": run["runId"], "sceneId": run["sceneId"],
                                          "shape": run["shape"], "npzSha256": sha256(data).hexdigest()}
        histories.append((run, preview_path, preview, export_path, sha256(data).hexdigest()))

    final = json.loads(request(origin, "health"))
    assert final["lastSolve"]["status"] == "succeeded" and final["lastSolve"]["operation"] == "csi"
    if restart is None:
        results["historyRestart"] = {"status": "skipped", "reason": "Use --launch or the Windows verifier to restart the solver."}
    else:
        origin = restart()
    assert json.loads(request(origin, "health"))["variant"] == health["variant"]
    actual = json.loads(request(origin, project_path))
    assert {row["runId"] for row in actual} == {run["runId"] for run, *_ in histories}
    assert json.loads(request(origin, f"projects/{other_project_id}/csi-runs")) == []
    for run, preview_path, preview, export_path, digest in histories:
        detail = json.loads(request(origin, f"{project_path}/{run['runId']}"))
        assert detail["run"] == run
        assert json.loads(request(origin, preview_path)) == preview
        with zipfile.ZipFile(io.BytesIO(request(origin, export_path, {}))) as bundle:
            assert sha256(bundle.read("csi.npz")).hexdigest() == digest
    results["historyRunsRecovered"] = len(histories)
    if restart is not None:
        results["historyRestart"] = {"status": "passed"}


@contextmanager
def local_server(origin, output, mac_runtime=None):
    address = urlsplit(origin)
    port = address.port
    if address.scheme != "http" or address.hostname != "127.0.0.1" or not port or address.netloc != f"127.0.0.1:{port}":
        raise ValueError("--launch requires an explicit HTTP loopback port, such as http://127.0.0.1:8011.")
    child = None
    launches = 0

    def stop():
        if child is not None and child.poll() is None:
            if child.stdin is not None:
                child.stdin.close()
            else:
                child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

    def start():
        nonlocal child, launches
        stop()
        with socket.socket(socket.AF_INET) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((address.hostname, port))
        launches += 1
        log_path = output / f"server-{launches}.log"
        env = {**os.environ, "SRTS_RUNS_DIR": str(output / "runs"), "PYTHONNOUSERSITE": "1"}
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        if mac_runtime:
            command = [sys.executable, "-B", str(mac_runtime / "studio_server.py"), str(port)]
            env["SRTS_DESKTOP_LAUNCH_TOKEN"] = secrets.token_hex(32)
        else:
            command = [sys.executable, "-B", "-m", "uvicorn", "backend.main:app", "--host", address.hostname, "--port", str(port)]
        with log_path.open("wb") as log:
            child = subprocess.Popen(
                command, cwd=mac_runtime or ROOT, env=env, stdin=subprocess.PIPE if mac_runtime else None,
                stdout=log, stderr=subprocess.STDOUT,
            )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and child.poll() is None:
            try:
                request(origin, "health", timeout=1)
                return origin
            except (URLError, TimeoutError, ConnectionError):
                time.sleep(0.1)
        reason = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
        raise RuntimeError(f"Studio did not start (see {log_path.name}).\n{reason}")

    try:
        yield start
    finally:
        stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", help="Loopback Studio origin, e.g. http://127.0.0.1:8011")
    parser.add_argument("output", type=Path)
    launcher = parser.add_mutually_exclusive_group()
    launcher.add_argument("--launch", action="store_true", help="Launch and restart a local API in this checkout")
    launcher.add_argument("--mac-runtime", type=Path, help="Launch and restart a built app's Contents/Resources server")
    parser.add_argument("--build-info", type=Path, help="Metadata from the running desktop bundle")
    parser.add_argument("--expected-variant", default=os.getenv("SRTS_MITSUBA_VARIANT"))
    args = parser.parse_args()
    mac_runtime = args.mac_runtime.resolve() if args.mac_runtime else None
    if mac_runtime and Path(sys.executable).resolve() != (mac_runtime / "python/bin/python3.12").resolve():
        parser.error("Use the app's bundled interpreter with --mac-runtime.")
    metadata_path = args.build_info or (mac_runtime / "build-info.json" if mac_runtime else None)
    build = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path else None
    output = args.output.resolve()
    origin = args.origin.rstrip("/")
    if args.launch or mac_runtime:
        if args.expected_variant:
            os.environ["SRTS_MITSUBA_VARIANT"] = args.expected_variant
        with local_server(origin, output, mac_runtime) as start:
            report = verify(start, output, expected_variant=args.expected_variant, restart=start, build_info=build)
    else:
        report = verify(origin, output, expected_variant=args.expected_variant, build_info=build)
    sys.exit(0 if report["ok"] else 1)
