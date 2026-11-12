"""Exercise the extracted replay entry point without a running Studio service."""
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4
import zipfile

import numpy as np

from backend.csi_replay import _verify_files
from backend.csi_runs import CsiRunRequest, _sha256, _trace_batched, solve_csi_run
from backend.csi_store import CsiRunStore


def _point(x, y, z=0):
    return {"x": x, "y": y, "z": z}


def _device(ident, x, y=0):
    return {"id": ident, "enu": _point(x, y), "height": 2.5, "antennaArraySize": [1, 1]}


class TestReplayIntegrity(unittest.TestCase):
    def test_checksums_detect_changed_meshes(self):
        with TemporaryDirectory() as tmp:
            folder = Path(tmp).resolve()
            mesh = folder / "ground.ply"
            mesh.write_bytes(b"archived mesh")
            files = {mesh.name: _sha256(mesh)}
            _verify_files(folder, files)
            mesh.write_bytes(b"edited mesh")
            with self.assertRaisesRegex(ValueError, "checksum differs: ground.ply"):
                _verify_files(folder, files)


@unittest.skipUnless(os.getenv("SRTS_TEST_RT"), "requires an initialized Mitsuba runtime")
class TestOfflineCsiReplay(unittest.TestCase):
    def test_csi_export_velocity_matches_sample_times_and_terrain_positions(self):
        from backend import main  # Initializes the selected real solver.

        req = CsiRunRequest(
            mode="trajectory", output="cir", txs=[_device("ap", -5)],
            rxs=[{**_device("ue", 0, 1), "heightReference": "ground", "height": 1.5}],
            buildings=[{
                "id": "slope", "kind": "mesh", "category": "terrain", "rfRole": "ground",
                "height": 0, "enuPoints": [], "mesh": {
                    "vertices": [0, 0, 0, 10, 0, 10, 10, 2, 10, 0, 2, 0],
                    "triangles": [0, 1, 2, 0, 2, 3],
                },
            }],
            freqGhz=3.5, maxDepth=0, numSubcarriers=8, speedKmh=3.6,
            waypoints=[_point(0, 1), _point(10, 1)], timeSeconds=[0, 20],
        )
        for timing, duration, component in (
            ({"timeSeconds": [0, 20]}, 20, 0.5),
            ({"deriveTimeFromSpeed": True, "timeSeconds": []}, 14.1421356237, 0.707106781187),
        ):
            with self.subTest(timing=timing):
                request = CsiRunRequest.model_validate({**req.model_dump(), **timing})
                summary = main.api_csi_run(request)
                run = main._csi_runs.pop(summary["runId"])
                self.addCleanup(run.directory.cleanup)
                self.assertEqual(summary["rxPositions"], [[[0, 1, 1.5]], [[10, 1, 11.5]]])
                np.testing.assert_allclose(summary["timeSeconds"], [0, duration], rtol=1e-9)
                with np.load(Path(run.directory.name) / "csi.npz") as archive:
                    np.testing.assert_array_equal(archive["time_seconds"], summary["timeSeconds"])
                    np.testing.assert_allclose(archive["rx_velocities"][:, 0], [[component, 0, component]] * 2, rtol=1e-9)

        impossible = req.model_copy(update={"timeSeconds": [0, 1e-300]})
        with patch("backend.csi_runs.build_scene", side_effect=AssertionError("Scene loaded")):
            with self.assertRaisesRegex(ValueError, "velocity is outside"):
                solve_csi_run(impossible)

    def test_static_and_multi_ap_trajectory_replay(self):
        from backend import main  # Initializes the selected real solver.

        tree = {
            "id": "tree", "category": "terrain", "rfRole": "foliage", "height": 0, "enuPoints": [],
            "baseZ": 1,
            "foliage": {"center": _point(0, 0, 1.5), "radii": _point(2, 1, 1), "attenuationDbPerM": 3},
        }
        wall = {
            "id": "partition", "category": "building", "kind": "wall", "height": 4,
            "enuPoints": [_point(0, -15), _point(0, 15)],
        }
        base = {
            "mode": "static", "txs": [_device("ap1", -7)], "rxs": [_device("ue", 5)],
            "freqGhz": 3.5, "numSubcarriers": 16, "normalizeDelays": False, "maxDepth": 0,
            "options": {"txPattern": "iso", "specularReflection": False,
                        "pathSamplesPerSource": 10_000, "pathSeed": 13},
        }
        trajectory = {
            **base, "mode": "trajectory", "output": "cir", "normalizeDelays": True,
            "txs": [*base["txs"], _device("ap2", 12, 3)], "speedKmh": 3.6, "waypointFrame": "ENU_m",
            "waypoints": [_point(5, 0, 5.5 + 0.5 * i) for i in range(7)],
            "deriveTimeFromSpeed": True, "buildings": [tree],
        }
        material = {"id": "itu_concrete", "relativePermittivity": 5.0, "conductivity": 0.1}
        reflected = {
            **base, "maxDepth": 1, "buildings": [tree], "materials": [material],
            "options": {**base["options"], "specularReflection": True},
        }
        for name, config, expect_paths in (
            ("foliage-and-reflection", reflected, True),
            ("blocked", {**base, "buildings": [wall]}, False),
            ("trajectory", trajectory, True),
        ):
            with self.subTest(case=name), TemporaryDirectory() as folder:
                self._check_replay(Path(folder), config, expect_paths, main.health()["variant"])

    def _check_replay(self, folder, config, expect_paths, variant):
        project_id = uuid4()
        store = CsiRunStore(folder / "runs")
        request = CsiRunRequest(**config, projectId=project_id)
        bundle = folder / "download.zip"
        with patch("backend.csi_runs._trace_batched", wraps=_trace_batched) as trace:
            run = solve_csi_run(request, staging_parent=store.prepare(project_id))
            store.publish(project_id, run)
            reopened_store = CsiRunStore(store.root)
            archived = reopened_store.get(project_id, run.summary["runId"])
            self.assertEqual(archived.preview(0, "ap1", "ue")["magnitudeDb"],
                             run.preview(0, "ap1", "ue")["magnitudeDb"])
            archived.write_export(bundle, None)
            trace.assert_called_once()
        extraction = folder / "offline copy"
        with zipfile.ZipFile(bundle) as archive:
            archive.extractall(extraction)
        manifest = json.loads((extraction / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["sceneId"], run.summary["sceneId"])
        original = extraction / "csi.npz"
        self.assertEqual(_sha256(original), manifest["files"]["csi.npz"])
        result = subprocess.run(
            [sys.executable, "replay_csi.py"], cwd=extraction,
            env={**os.environ, "SRTS_MITSUBA_VARIANT": variant},
            capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(_sha256(original), manifest["files"]["csi.npz"])
        with np.load(original) as a, np.load(extraction / "csi-replay.npz") as b:
            self.assertEqual(set(a.files), set(b.files))
            for field in ("tx_ids", "rx_ids", "tx_positions", "rx_positions", "rx_velocities",
                          "time_seconds", "frequencies"):
                np.testing.assert_array_equal(a[field], b[field])
            self.assertEqual(bool(a["valid_paths"].any()), expect_paths)
            if request.mode == "trajectory":
                self.assertEqual(b["time_seconds"].tolist(), [0.5 * i for i in range(7)])
                self.assertEqual(b["rx_positions"][:, 0, 2].tolist(), [5.5 + 0.5 * i for i in range(7)])
                np.testing.assert_allclose(b["rx_velocities"][:, 0], [[0, 0, 1]] * 7)
            if request.output == "cir_cfr":
                np.testing.assert_allclose(a["h_freq"], b["h_freq"], rtol=2e-5, atol=1e-10)
                if not expect_paths:
                    self.assertFalse(b["h_freq"].any())
            self._check_paths(a, b)

    def _check_paths(self, a, b):
        a_valid, b_valid = a["valid_paths"], b["valid_paths"]
        self.assertEqual(a_valid.shape, b_valid.shape)
        self.assertEqual(a["a"].shape, b["a"].shape)
        for time, rx, tx in np.ndindex(a_valid.shape[:-1]):
            delays, coeffs = [], []
            for archive, valid in ((a, a_valid), (b, b_valid)):
                mask = valid[time, rx, tx]
                delay = archive["tau_geometric"][time, rx, tx, mask]
                order = np.argsort(delay)
                delays.append(delay[order])
                coeffs.append(archive["a"][time, rx, :, tx][..., mask][..., order])
            np.testing.assert_allclose(*delays, rtol=2e-5, atol=1e-12)
            np.testing.assert_allclose(*coeffs, rtol=2e-5, atol=1e-10)
