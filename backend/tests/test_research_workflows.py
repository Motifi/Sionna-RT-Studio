import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from backend.models import PropagationPath
from backend.solver import MAX_PATHS, _channel_metrics
from scripts import research_workflows as workflow


class FakeStudio:
    def __init__(self, fail_calls=()):
        self.requests = []
        self.fail_calls = fail_calls

    def get(self, endpoint):
        return {"ok": True, "app": "SionnaRTStudio", "appVersion": "test"}

    def post(self, endpoint, request):
        self.requests.append(request)
        if len(self.requests) in self.fail_calls:
            raise workflow.ApiError("solver rejected this case")
        return {
            "runId": f"test-{len(self.requests)}",
            "projectId": request["projectId"],
            "sceneId": "test-scene",
            "links": [
                {"txId": tx["id"], "rxId": rx["id"], "metrics": {
                    "numPaths": 1 if rx["enu"]["x"] < 20 else 0,
                    "firstArrivalDelayNs": 25 if rx["enu"]["x"] < 20 else None,
                    "totalRxPowerDbm": -52 if rx["enu"]["x"] < 20 else -200,
                }}
                for tx in request["txs"] for rx in request["rxs"]
            ],
        }


PROJECT = {
    "format": "SionnaRTStudio Project", "schemaVersion": 5,
    "projectId": "12345678-9abc-4def-8abc-123456789abc",
    "state": {
        "scene": {"coordinateFrame": "ENU_m", "buildings": []},
        "devices": {
            "transmitters": [
                {"id": "a", "enu": {"x": 1, "y": 2, "z": 0}, "height": 3, "antennaArraySize": [1, 1]},
                {"id": "b", "enu": {"x": 2, "y": 3, "z": 0}, "height": 3, "antennaArraySize": [1, 1]},
            ],
            "receivers": [{"id": "u", "enu": {"x": 4, "y": 3, "z": 0}, "height": 1.5, "antennaArraySize": [1, 1]}],
            "fronthaulMbpsByTxId": {"a": 100, "b": 200},
        },
        "solver": {"carrierFrequencyGhz": 3.5, "maxDepth": 1, "options": {}, "materialConfigs": {}},
        "csi": {"numSubcarriers": 8, "subcarrierSpacingKhz": 30, "normalizeDelays": True},
        "coverage": {"bandwidthMhz": 100, "noiseFigureDb": 7},
    },
}


class ResearchWorkflowTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.project_path = self.write("project.json", PROJECT)

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding="utf-8")
        return path

    def test_legacy_project_id_is_reproducible_and_v1_keeps_csi_defaults(self):
        state = {key: value for key, value in PROJECT["state"].items() if key != "csi"}
        path = self.write("legacy.json", {"format": PROJECT["format"], "schemaVersion": 1, "state": state})
        first = workflow.read_project(path.read_bytes())
        second = workflow.read_project(path.read_bytes())
        self.assertEqual(first.project_id, second.project_id)
        self.assertEqual(first.request["numSubcarriers"], 1024)
        self.assertEqual(first.request["subcarrierSpacing"], 30_000)

    def test_sweep_preserves_project_scope_and_isolates_failed_solver_call(self):
        matrix = self.write("matrix.json", {
            "schemaVersion": 1, "freqGhz": [3.5, 28],
            "arrays": [{"id": "test-array", "tx": [4, 1], "rx": [2, 1]}],
            "deployments": [
                {"id": "original"},
                {"id": "move-b", "aps": {"b": {"enu": {"x": 9, "y": 8, "z": 7}, "height": 7}}},
            ],
        })
        api = FakeStudio(fail_calls=(2,))
        out = self.root / "sweep"
        report = workflow.sweep(api, self.project_path, matrix, out)
        self.assertEqual([case["status"] for case in report["cases"]], ["ok", "error", "ok", "ok"])
        self.assertEqual(api.requests[3]["projectId"], PROJECT["projectId"])
        self.assertEqual(api.requests[3]["txs"][0]["enu"]["x"], 9)
        self.assertEqual(api.requests[3]["txs"][0]["antennaArraySize"], [4, 1])
        self.assertEqual(api.requests[3]["rxs"][0]["antennaArraySize"], [2, 1])
        self.assertEqual(api.requests[3]["fronthaulMbpsByTxId"], {"b": 200})
        self.assertEqual(report["cases"][3]["run"]["runId"], "test-4")
        self.assertEqual(report["cases"][3]["run"]["sceneId"], "test-scene")
        self.assertEqual((out / "project.json").read_bytes(), self.project_path.read_bytes())
        self.assertEqual(json.loads((out / "report.json").read_text())["cases"], report["cases"])

    def test_compare_uses_absolute_height_and_delay_and_excludes_no_path(self):
        measurements = self.write("samples.csv", "point_id,ap_id,east_m,north_m,up_m,power_dbm,first_arrival_ns,split\n"
                                  "p1,a,1,2,-3,-50,24,calibration\n"
                                  "p2,a,2,3,4,-58,,validation\n"
                                  "p3,a,20,2,3,-70,80,validation\n")
        metadata = self.write("dataset.json", {
            "schemaVersion": 1, "datasetKind": "synthetic", "source": "manual test",
            "coordinateFrame": "ENU_m", "carrierFrequencyGhz": 3.5, "rxDeviceId": "u",
            "delayReference": "absolute_propagation", "materialNotes": "Defaults.",
            "foliageNotes": "None.",
        })
        api = FakeStudio()
        report = workflow.compare(api, self.project_path, measurements, metadata, self.root / "comparison")
        self.assertFalse(api.requests[0]["normalizeDelays"])
        self.assertEqual(api.requests[0]["rxs"][0]["heightReference"], "enu")
        self.assertEqual(api.requests[0]["rxs"][0]["height"], -3)
        self.assertEqual(report["points"][0]["powerResidualDb"], -2)
        self.assertEqual(report["points"][0]["delayResidualNs"], 1)
        self.assertEqual(report["points"][2]["status"], "no_path")
        power = report["metrics"]["overall"]["power"]
        self.assertEqual(power, {"requested": 3, "compared": 2, "mae": 4, "rmse": 20**0.5, "bias": 2})
        self.assertEqual(report["metrics"]["overall"]["delay"]["compared"], 1)
        self.assertEqual(report["metrics"]["bySplit"]["validation"]["power"]["requested"], 2)

    def test_rejects_nonfinite_csv_values_with_line_number(self):
        rows = b"point_id,ap_id,east_m,north_m,up_m,power_dbm\np,a,1,2,3,nan\n"
        with self.assertRaisesRegex(ValueError, "line 2.*power_dbm"):
            workflow.read_measurements(rows)

    def test_incomplete_delay_metric_is_not_reported_as_first_arrival(self):
        with self.assertRaisesRegex(workflow.ApiError, "first-arrival"):
            workflow.residuals({"numPaths": 2, "totalRxPowerDbm": -30},
                               {"power_dbm": -30, "first_arrival_ns": 25})

    def test_first_arrival_uses_full_path_set(self):
        strongest = PropagationPath(id="late", points=[], type="Reflection", order=1,
                                    distance=60, pathLossDb=60, receivedPowerDbm=-30, delayNs=200)
        earliest = strongest.model_copy(update={"delayNs": 150, "receivedPowerDbm": -90})
        metrics = _channel_metrics([strongest] * MAX_PATHS + [earliest])
        self.assertEqual(metrics.firstArrivalDelayNs, 150)
        self.assertIsNone(_channel_metrics([]).firstArrivalDelayNs)


if __name__ == "__main__":
    unittest.main()
