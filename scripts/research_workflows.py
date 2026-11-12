"""Run repeatable CSI sweeps and compare simulated links with a measurement CSV."""
from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from http.client import HTTPException
from io import StringIO
from itertools import product
import json
import math
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import NAMESPACE_URL, UUID, uuid5


CSI_ENDPOINT = "/api/csi-runs"
MAX_RECEIVERS_PER_RUN = 64


class ApiError(RuntimeError):
    """An error reported by Studio or its HTTP connection."""


class StudioApi:
    def __init__(self, base_url: str, timeout: float):
        parts = urlsplit(base_url)
        if (parts.scheme not in {"http", "https"} or not parts.hostname or parts.query
                or parts.fragment or parts.username or parts.password):
            raise ValueError("--url must be the base HTTP(S) URL of a Studio backend.")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get(self, endpoint: str):
        return self._request(endpoint)

    def post(self, endpoint: str, payload: dict):
        return self._request(endpoint, payload)

    def _request(self, endpoint: str, payload: dict | None = None):
        request = Request(
            self.base_url + endpoint, data=json_bytes(payload) if payload is not None else None,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as exc:
            with exc:
                body = exc.read(2048).decode("utf-8", errors="replace")
            raise ApiError(f"{endpoint} returned HTTP {exc.code}: {body}") from exc
        except (OSError, HTTPException, ValueError) as exc:
            raise ApiError(f"{endpoint}: {exc}") from exc


def json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def parse_json(raw: bytes, label: str) -> dict:
    def reject_constant(value: str):
        raise ValueError(f"Nonfinite number {value}")

    try:
        value = json.loads(raw, parse_constant=reject_constant)
    except (UnicodeError, ValueError) as exc:
        raise ValueError(f"{label}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object.")
    return value


def finite(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number.")
    try:
        result = float(value)
    except OverflowError as exc:
        raise ValueError(f"{label} must be a finite number.") from exc
    if not math.isfinite(result):
        raise ValueError(f"{label} must be a finite number.")
    return result


def positive(value, label: str) -> float:
    result = finite(value, label)
    if result <= 0:
        raise ValueError(f"{label} must be positive.")
    return result


@dataclass
class Project:
    version: int
    project_id: str
    request: dict


def read_project(raw: bytes) -> Project:
    doc = parse_json(raw, "Project")
    version = doc.get("schemaVersion")
    if doc.get("format") != "SionnaRTStudio Project" or type(version) is not int or not 1 <= version <= 5:
        raise ValueError("Expected a saved SionnaRTStudio project (schema v1–v5).")
    if version == 5:
        try:
            project_id = str(UUID(doc.get("projectId")))
        except (ValueError, AttributeError, TypeError) as exc:
            raise ValueError("Project v5 requires a valid projectId.") from exc
    else:
        project_id = str(uuid5(NAMESPACE_URL, "SionnaRTStudio legacy project:" + sha256(raw).hexdigest()))

    try:
        state = doc["state"]
        scene, devices, solver = state["scene"], state["devices"], state["solver"]
        csi = state.get("csi", {})
        coverage = state.get("coverage", {})
        if scene.get("coordinateFrame", "ENU_m" if version < 3 else None) != "ENU_m":
            raise ValueError("The project must use meter-scale ENU coordinates.")
        request = {
            "projectId": project_id,
            "mode": "static",
            "txs": devices["transmitters"],
            "rxs": devices["receivers"],
            "buildings": scene["buildings"],
            "anchor": scene.get("anchor"),
            "freqGhz": positive(solver["carrierFrequencyGhz"], "Project carrier frequency"),
            "maxDepth": solver["maxDepth"],
            "options": solver["options"],
            "materials": list(solver["materialConfigs"].values()),
            "fronthaulMbpsByTxId": devices.get("fronthaulMbpsByTxId", {}),
            "numSubcarriers": csi.get("numSubcarriers", 1024),
            "subcarrierSpacing": positive(csi.get("subcarrierSpacingKhz", 30), "Subcarrier spacing") * 1000,
            "normalizeDelays": csi.get("normalizeDelays", True),
            "systemBandwidthMhz": coverage.get("bandwidthMhz", 100),
            "noiseFigureDb": coverage.get("noiseFigureDb", 7),
        }
        for devices_key in ("txs", "rxs"):
            entries = request[devices_key]
            if not isinstance(entries, list) or not entries:
                raise ValueError("The project needs at least one AP and one UE.")
            ids = [entry["id"] for entry in entries]
            if any(not isinstance(ident, str) or not ident.strip() for ident in ids) or len(set(ids)) != len(ids):
                raise ValueError("Project AP and UE IDs must be nonempty and unique within each group.")
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError(f"The project is missing valid solver, scene or device settings: {exc}") from exc
    return Project(version, project_id, request)


def check_fields(value, allowed: set, label: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object.")
    extra = value.keys() - allowed
    if extra:
        raise ValueError(f"{label} has unsupported fields: {', '.join(sorted(extra))}.")


def variants(matrix: dict, key: str) -> list[dict]:
    entries = matrix.get(key, [{"id": "saved"}])
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"Matrix {key} must be a nonempty array.")
    names = set()
    for entry in entries:
        ident = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(ident, str) or not ident.strip() or ident in names:
            raise ValueError(f"Matrix {key} must have nonempty and unique IDs.")
        names.add(ident)
    return entries


def sweep_cases(raw: bytes, project: Project):
    matrix = parse_json(raw, "Matrix")
    check_fields(matrix, {"schemaVersion", "freqGhz", "arrays", "deployments", "output"}, "Matrix")
    if matrix.get("schemaVersion") != 1:
        raise ValueError("Expected matrix schemaVersion 1.")
    frequencies = matrix.get("freqGhz", [project.request["freqGhz"]])
    if not isinstance(frequencies, list) or not frequencies:
        raise ValueError("Matrix freqGhz must be a nonempty array.")
    frequencies = [positive(freq, "Matrix frequency") for freq in frequencies]
    if len(set(frequencies)) != len(frequencies):
        raise ValueError("Matrix frequencies must be unique.")
    output = matrix.get("output", "cir")
    if output not in ("cir", "cir_cfr"):
        raise ValueError("Matrix output must be cir or cir_cfr.")
    return product(frequencies, variants(matrix, "arrays"), variants(matrix, "deployments"), [output])


def sweep_request(base: dict, freq: float, array: dict, deployment: dict, output: str) -> dict:
    check_fields(array, {"id", "tx", "rx"}, "Array variant")
    check_fields(deployment, {"id", "aps"}, "Deployment variant")
    for side in ("tx", "rx"):
        if side in array:
            size = array[side]
            if not isinstance(size, list) or len(size) != 2 or any(type(n) is not int or n < 1 for n in size):
                raise ValueError(f"Array {side} must be [horizontal, vertical] with positive integers.")
    tx_by_id = {tx["id"]: tx for tx in base["txs"]}
    aps = deployment.get("aps", {ident: {} for ident in tx_by_id})
    if not isinstance(aps, dict) or not aps:
        raise ValueError("Deployment aps must map at least one saved AP ID to its settings.")
    capacities = base["fronthaulMbpsByTxId"]
    txs = []
    for ident, patch in aps.items():
        if ident not in tx_by_id:
            raise ValueError(f"Deployment AP {ident!r} does not exist in the project.")
        check_fields(patch, {"enu", "height", "heightReference", "powerDbm",
                             "beamsteeringAzimuth", "beamsteeringElevation"}, f"AP {ident!r}")
        if "enu" in patch:
            check_fields(patch["enu"], {"x", "y", "z"}, f"AP {ident!r} ENU")
            if patch["enu"].keys() != {"x", "y", "z"}:
                raise ValueError(f"AP {ident!r} ENU requires x, y and z in meters.")
        tx = {**tx_by_id[ident], **patch}
        txs.append({**tx, "antennaArraySize": array.get("tx", tx["antennaArraySize"])})
    rxs = [{**rx, "antennaArraySize": array.get("rx", rx["antennaArraySize"])} for rx in base["rxs"]]
    return {
        **base, "freqGhz": freq, "output": output, "txs": txs, "rxs": rxs,
        "fronthaulMbpsByTxId": {ident: capacities[ident] for ident in aps if ident in capacities},
    }


def start_report(api, project: Project, operation: str, out: Path, inputs: dict[str, bytes]) -> dict:
    health = api.get("/api/health")
    if not isinstance(health, dict) or health.get("app") != "SionnaRTStudio" or not health.get("ok"):
        raise ApiError("The URL did not return a healthy SionnaRTStudio backend.")
    out.mkdir(parents=True, exist_ok=False)
    for name, raw in inputs.items():
        (out / name).write_bytes(raw)
    return {
        "schemaVersion": 1, "operation": operation, "complete": False,
        "startedAtUtc": datetime.now(timezone.utc).isoformat(),
        "projectId": project.project_id, "projectSchemaVersion": project.version,
        "backend": {key: health[key] for key in ("appVersion", "variant", "deviceModel", "pythonVersion",
                                                 "sionnaRtVersion", "mitsubaVersion", "drjitVersion", "gpu")
                    if key in health},
        "inputs": {name: sha256(raw).hexdigest() for name, raw in inputs.items()},
    }


def write_report(out: Path, report: dict) -> None:
    temporary = out / ".report.json.tmp"
    temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(out / "report.json")


def submit_run(api, request: dict) -> dict:
    run = api.post(CSI_ENDPOINT, request)
    if (not isinstance(run, dict) or not run.get("runId") or not run.get("sceneId")
            or run.get("projectId") != request["projectId"] or not isinstance(run.get("links"), list)):
        raise ApiError("Studio did not return a project-scoped CSI run with link metrics.")
    return run


def sweep(api, project_path: Path, matrix_path: Path, out: Path) -> dict:
    inputs = {"project.json": project_path.read_bytes(), "matrix.json": matrix_path.read_bytes()}
    project = read_project(inputs["project.json"])
    cases = sweep_cases(inputs["matrix.json"], project)
    report = start_report(api, project, "sweep", out, inputs)
    report.update(cases=[], succeeded=0, failed=0)
    write_report(out, report)
    for index, (freq, array, deployment, output) in enumerate(cases, 1):
        case = {"case": index, "freqGhz": freq, "arrayId": array["id"], "deploymentId": deployment["id"],
                "output": output}
        try:
            request = sweep_request(project.request, freq, array, deployment, output)
            case["requestSha256"] = sha256(json_bytes(request)).hexdigest()
            case.update(status="ok", run=submit_run(api, request))
        except (ApiError, ValueError) as exc:
            case.update(status="error", error=str(exc))
        report["cases"].append(case)
        report["succeeded" if case["status"] == "ok" else "failed"] += 1
        write_report(out, report)
    report["complete"] = True
    write_report(out, report)
    return report


POSITION_FIELDS = ("east_m", "north_m", "up_m")
REQUIRED_COLUMNS = {"point_id", "ap_id", *POSITION_FIELDS}
METRIC_COLUMNS = {"power_dbm", "first_arrival_ns"}


def read_measurements(raw: bytes) -> list[dict]:
    csv_text = raw.decode("utf-8-sig")
    reader = csv.DictReader(StringIO(csv_text, newline=""), strict=True)
    rows = []
    seen = set()
    try:
        headers = reader.fieldnames or []
        fields = set(headers)
        if (len(fields) != len(headers) or not REQUIRED_COLUMNS <= fields or not METRIC_COLUMNS & fields
                or fields - (REQUIRED_COLUMNS | METRIC_COLUMNS | {"split"})):
            raise ValueError("CSV needs point_id, ap_id, east_m, north_m, up_m and power_dbm or "
                             "first_arrival_ns. Optional column: split.")
        for row in reader:
            try:
                if None in row or any(value is None for value in row.values()):
                    raise ValueError("Row has a different number of columns than the header.")
                row = {key: value.strip() for key, value in row.items()}
                ident = (row["ap_id"], row["point_id"])
                if not all(ident) or ident in seen:
                    raise ValueError("Each row needs a nonempty, unique (ap_id, point_id) pair.")
                seen.add(ident)
                for key in (*POSITION_FIELDS, "power_dbm", "first_arrival_ns"):
                    value = row.get(key, "")
                    if not value and key in METRIC_COLUMNS:
                        row[key] = None
                        continue
                    try:
                        row[key] = finite(float(value), key)
                    except ValueError as exc:
                        raise ValueError(f"{key} must be a finite number.") from exc
                if all(row[key] is None for key in METRIC_COLUMNS):
                    raise ValueError("At least one measured value is required.")
                if row["first_arrival_ns"] is not None and row["first_arrival_ns"] < 0:
                    raise ValueError("Absolute first_arrival_ns must be nonnegative.")
                row["split"] = row.get("split") or None
                rows.append(row)
            except ValueError as exc:
                raise ValueError(f"CSV line {reader.line_num}: {exc}") from exc
    except csv.Error as exc:
        raise ValueError(f"CSV line {reader.line_num}: {exc}") from exc
    if not rows:
        raise ValueError("The measurement CSV contains no points.")
    return rows


def residuals(metrics: dict, point: dict) -> dict:
    if metrics.get("numPaths") == 0:
        return {"status": "no_path", "numPaths": 0}
    try:
        power = finite(metrics.get("totalRxPowerDbm"), "Simulated received power")
        delay = metrics.get("firstArrivalDelayNs")
        if point["first_arrival_ns"] is not None:
            delay = finite(delay, "Simulated first-arrival delay (requires a P2-compatible backend)")
        return {
            "status": "ok", "numPaths": metrics["numPaths"],
            "simulatedPowerDbm": power, "simulatedFirstArrivalNs": delay,
            "powerResidualDb": None if point["power_dbm"] is None else
                finite(power - point["power_dbm"], "Power residual"),
            "delayResidualNs": None if point["first_arrival_ns"] is None else
                finite(delay - point["first_arrival_ns"], "Delay residual"),
        }
    except (KeyError, ValueError) as exc:
        raise ApiError(str(exc)) from exc


def error_stats(points: list[dict], measured: str, residual: str) -> dict:
    requested = sum(point[measured] is not None for point in points)
    values = [point[residual] for point in points if point.get(residual) is not None]
    size = len(values)
    scale = max(map(abs, values), default=0)
    if not size or not scale:
        value = 0.0 if size else None
        return {"requested": requested, "compared": size, "mae": value, "rmse": value, "bias": value}
    normalized = [value / scale for value in values]
    return {
        "requested": requested, "compared": size,
        "mae": scale * (math.fsum(map(abs, normalized)) / size),
        "rmse": scale * math.sqrt(math.fsum(value * value for value in normalized) / size),
        "bias": scale * (math.fsum(normalized) / size),
    }


def comparison_metrics(points: list[dict]) -> dict:
    def stats(group):
        return {
            "power": error_stats(group, "power_dbm", "powerResidualDb"),
            "delay": error_stats(group, "first_arrival_ns", "delayResidualNs"),
        }

    by_ap = {}
    by_split = {}
    for point in points:
        by_ap.setdefault(point["ap_id"], []).append(point)
        if point["split"] is not None:
            by_split.setdefault(point["split"], []).append(point)
    return {
        "overall": stats(points),
        "byAp": {key: stats(group) for key, group in by_ap.items()},
        "bySplit": {key: stats(group) for key, group in by_split.items()},
    }


def read_metadata(raw: bytes, base: dict) -> dict:
    meta = parse_json(raw, "Dataset metadata")
    if (meta.get("schemaVersion") != 1 or meta.get("datasetKind") not in ("measured", "synthetic")
            or meta.get("coordinateFrame") != "ENU_m" or meta.get("delayReference") != "absolute_propagation"):
        raise ValueError("Metadata requires schemaVersion 1, datasetKind measured or synthetic, "
                         "coordinateFrame ENU_m and delayReference absolute_propagation.")
    if positive(meta.get("carrierFrequencyGhz"), "Dataset carrier frequency") != base["freqGhz"]:
        raise ValueError("Dataset and project carrier frequencies must match.")
    for field in ("source", "rxDeviceId", "materialNotes", "foliageNotes"):
        if not isinstance(meta.get(field), str) or not meta[field].strip():
            raise ValueError(f"Dataset metadata requires {field}.")
    return meta


def compare(api, project_path: Path, csv_path: Path, metadata_path: Path, out: Path) -> dict:
    inputs = {"project.json": project_path.read_bytes(), "measurements.csv": csv_path.read_bytes(),
              "measurement-metadata.json": metadata_path.read_bytes()}
    project = read_project(inputs["project.json"])
    base = project.request
    meta = read_metadata(inputs["measurement-metadata.json"], base)
    rx = next((entry for entry in base["rxs"] if entry["id"] == meta["rxDeviceId"]), None)
    if rx is None:
        raise ValueError(f"Dataset rxDeviceId {meta['rxDeviceId']!r} does not exist in the project.")
    rows = read_measurements(inputs["measurements.csv"])
    tx_by_id = {tx["id"]: tx for tx in base["txs"]}
    by_ap = {}
    for index, row in enumerate(rows, 1):
        ap_id = row["ap_id"]
        if ap_id not in tx_by_id:
            raise ValueError(f"Point {row['point_id']!r} uses unknown AP ID {ap_id!r}.")
        by_ap.setdefault(ap_id, []).append((index, row))
    report = start_report(api, project, "compare", out, inputs)
    report.update(dataset=meta, settings={
        "coordinateFrame": "ENU_m", "delayReference": "absolute_propagation",
        "powerResidualUnit": "dB", "delayResidualUnit": "ns", "residualSign": "simulated_minus_measured",
        "powerReference": "per_AP_incoherent_ray_power_sum_after_Tx_precoding_summed_over_Rx_ports",
    }, runs=[], points=rows, failed=0)
    write_report(out, report)

    for ap_id, group in by_ap.items():
        for offset in range(0, len(group), MAX_RECEIVERS_PER_RUN):
            batch = group[offset:offset + MAX_RECEIVERS_PER_RUN]
            rxs = []
            for index, row in batch:
                x, y, z = (row[key] for key in POSITION_FIELDS)
                rxs.append({**rx, "id": f"point-{index}", "name": row["point_id"],
                            "enu": {"x": x, "y": y, "z": z}, "height": z, "heightReference": "enu"})
            capacities = base["fronthaulMbpsByTxId"]
            request = {
                **base, "txs": [tx_by_id[ap_id]], "rxs": rxs, "output": "cir", "normalizeDelays": False,
                "fronthaulMbpsByTxId": {ap_id: capacities[ap_id]} if ap_id in capacities else {},
            }
            record = {"apId": ap_id, "pointIds": [row["point_id"] for _, row in batch],
                      "requestSha256": sha256(json_bytes(request)).hexdigest()}
            try:
                run = submit_run(api, request)
                record.update(status="ok", run={key: value for key, value in run.items() if key != "links"})
                link_metrics = {link["rxId"]: link["metrics"] for link in run["links"] if link["txId"] == ap_id}
                for index, row in batch:
                    row.update(runId=run["runId"], sceneId=run["sceneId"], rxId=f"point-{index}")
                    metrics = link_metrics.get(row["rxId"])
                    try:
                        if metrics is None:
                            raise ApiError("Studio did not return metrics for this point.")
                        row.update(residuals(metrics, row))
                    except ApiError as exc:
                        row.update(status="error", error=str(exc))
                        report["failed"] += 1
            except ApiError as exc:
                record.update(status="error", error=str(exc))
                for _, row in batch:
                    row.update(status="error", error=str(exc))
                report["failed"] += len(batch)
            report["runs"].append(record)
            report["metrics"] = comparison_metrics(rows)
            write_report(out, report)
    report["complete"] = True
    write_report(out, report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    batch = commands.add_parser("sweep", help="Run a frequency, array and deployment matrix.")
    batch.add_argument("--matrix", type=Path, required=True)
    validation = commands.add_parser("compare", help="Compare ENU measurements with static CSI links.")
    validation.add_argument("--metadata", type=Path, required=True)
    for command in (batch, validation):
        command.add_argument("project", type=Path)
        command.add_argument("--out", type=Path, required=True, help="New directory for the report and input snapshots.")
        command.add_argument("--url", default="http://127.0.0.1:8000", help="Studio backend base URL.")
        command.add_argument("--timeout", type=float, default=600, help="Timeout in seconds per API request.")
    validation.add_argument("measurements", type=Path)
    args = parser.parse_args(argv)
    try:
        api = StudioApi(args.url, positive(args.timeout, "Timeout"))
        if args.operation == "sweep":
            report = sweep(api, args.project, args.matrix, args.out)
        else:
            report = compare(api, args.project, args.measurements, args.metadata, args.out)
    except (OSError, ValueError, ApiError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    print(f"{args.out / 'report.json'} ({report['failed']} failed)")
    return int(report["failed"] > 0)


if __name__ == "__main__":
    raise SystemExit(main())
