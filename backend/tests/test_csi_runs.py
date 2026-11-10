"""CSI artifact and tensor regression checks without a ray-tracing runtime."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

import numpy as np
from pydantic import ValidationError

from backend.csi_runs import CsiExportRequest, CsiRun, CsiRunRequest, _write_csi


class _Paths:
    def __init__(self, path_count=1):
        self.valid = np.ones((2, 1, path_count), dtype=bool)
        self.frequency_calls = []

    def cir(self, *, normalize_delays, out_type):
        path_count = self.valid.shape[-1]
        a = np.ones((2, 1, 1, 2, path_count, 1), dtype=np.complex64)
        tau = np.zeros(self.valid.shape, dtype=np.float32)
        return a, tau

    def cfr(self, *, frequencies, normalize_delays, out_type):
        self.frequency_calls.extend(frequencies.tolist())
        a = np.zeros((2, 1, 1, 2, 1, len(frequencies)), dtype=np.complex64)
        if self.valid.shape[-1]:
            a[0, 0, 0, 0, 0] = frequencies + 1j
            a[0, 0, 0, 1, 0] = (frequencies + 1j) * 2
            a[1] = a[0] * 3
        return a


class TestCsiArtifacts(unittest.TestCase):
    def test_chunked_cfr_matches_exported_curve_and_preserves_axes(self):
        frequencies = np.arange(5, dtype=np.float32)
        for moving in (False, True):
            with self.subTest(moving=moving), TemporaryDirectory() as folder:
                shape = (2, 1, 1, 1, 2, 5) if moving else (1, 2, 1, 1, 2, 5)
                paths = _Paths()
                with patch("backend.csi_runs._CFR_CHUNK_BYTES", 96):
                    plotted, curves, path_count, output_bytes = _write_csi(
                        Path(folder), paths, frequencies, moving, False, shape, {},
                    )
                with np.load(Path(folder) / "csi.npz") as archive:
                    cfr = archive["h_freq"]
                    self.assertEqual(cfr.shape, shape)
                    self.assertEqual(archive["a"].shape, shape[:-1] + (1,))
                    self.assertEqual(archive["tau_geometric"].shape, shape[:2] + (1, 1))
                    np.testing.assert_allclose(cfr[0, 0, 0, 0, 0], frequencies + 1j)
                    second = cfr[1, 0] if moving else cfr[0, 1]
                    np.testing.assert_allclose(second[0, 0, 1], (frequencies + 1j) * 6)
                    expected_db = 10 * np.log10(np.mean(np.abs(cfr) ** 2, axis=(2, 4)))
                    np.testing.assert_allclose(curves, expected_db)
                np.testing.assert_array_equal(plotted, frequencies)
                self.assertEqual(path_count, 1)
                self.assertEqual(output_bytes, 202)
                self.assertEqual(paths.frequency_calls, frequencies.tolist())
                self.assertFalse((Path(folder) / "cfr.npy").exists())

    def test_cir_only_reconstructs_preview_without_allocating_dense_cfr(self):
        class MaskedPaths(_Paths):
            def cir(self, **kwargs):
                a, tau = super().cir(**kwargs)
                a[0, 0, 0, :, :, 0] = [[1, 2, np.nan], [3j, 4j, np.nan]]
                tau[0, 0] = [0, 0.25, np.nan]
                self.valid[0, 0, -1] = False
                self.valid[1, 0] = False
                return a, tau

        frequencies = np.arange(5, dtype=np.float32)
        with TemporaryDirectory() as folder:
            shape = (2, 1, 1, 1, 2, 5)
            paths = MaskedPaths(path_count=3)
            with patch("backend.csi_runs._MAX_OUTPUT_BYTES", 130):
                with self.assertRaisesRegex(ValueError, r"CIR \+ CFR"):
                    _write_csi(Path(folder), paths, frequencies, True, False, shape, {})
            with patch("backend.csi_runs._MAX_OUTPUT_BYTES", 100), patch(
                "backend.csi_runs._CIR_CURVE_CHUNK_BYTES", 32,
            ):
                plotted, curves, path_count, output_bytes = _write_csi(
                    Path(folder), paths, frequencies, True, False, shape, {}, output_mode="cir",
                )
            with np.load(Path(folder) / "csi.npz") as archive:
                self.assertNotIn("h_freq", archive)
                self.assertEqual(archive["a"].shape, shape[:-1] + (3,))
                self.assertEqual(output_bytes, sum(archive[key].nbytes for key in ("a", "tau_geometric", "valid_paths")))
                self.assertEqual(path_count, 3)
                mask = archive["valid_paths"][0, 0, 0]
                phase = np.exp(-2j * np.pi * archive["tau_geometric"][0, 0, 0, mask, None] * frequencies)
                h = archive["a"][0, 0, 0, 0][:, mask] @ phase
                np.testing.assert_allclose(curves[0, 0, 0], 10 * np.log10(np.mean(np.abs(h) ** 2, axis=0)))
            self.assertEqual(paths.frequency_calls, [])
            np.testing.assert_array_equal(plotted, frequencies)
            self.assertTrue(np.isneginf(curves[1]).all())
            self.assertFalse((Path(folder) / "cfr.npy").exists())

    def test_cir_only_keeps_its_own_output_limit(self):
        with TemporaryDirectory() as folder, patch("backend.csi_runs._MAX_CIR_BYTES", 40):
            with self.assertRaisesRegex(ValueError, "CIR alone"):
                _write_csi(Path(folder), _Paths(), np.arange(3), True, True,
                           (2, 1, 1, 1, 2, 3), {}, output_mode="cir")

    def test_no_paths_produces_valid_zero_frequency_response(self):
        with TemporaryDirectory() as folder:
            shape = (2, 1, 1, 1, 2, 3)
            for output_mode in ("cir_cfr", "cir"):
                with self.subTest(output=output_mode):
                    _, curves, path_count, _ = _write_csi(
                        Path(folder), _Paths(path_count=0), np.arange(3), True, True, shape, {},
                        output_mode=output_mode,
                    )
                    with np.load(Path(folder) / "csi.npz") as archive:
                        self.assertEqual(archive["valid_paths"].shape, (2, 1, 1, 0))
                        if output_mode == "cir_cfr":
                            self.assertEqual(archive["h_freq"].shape, shape)
                            self.assertFalse(archive["h_freq"].any())
                        else:
                            self.assertNotIn("h_freq", archive)
                    self.assertEqual(path_count, 0)
                    self.assertTrue(np.isneginf(curves).all())

    def test_export_updates_fronthaul_without_changing_csi_bytes(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        folder = Path(directory.name)
        np.savez_compressed(folder / "csi.npz", h_freq=np.ones(1))
        csi_bytes = (folder / "csi.npz").read_bytes()
        run = CsiRun(directory, {"txIds": ["ap1", "ap2"]}, {"runId": "test"}, [], np.array([]), np.array([]))
        for rate in (0, 42.5):
            run.write_export(folder / "export.zip", {"ap1": rate})
            with zipfile.ZipFile(folder / "export.zip") as archive:
                self.assertEqual(archive.read("csi.npz"), csi_bytes)
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["fronthaulMbpsByTxId"], {"ap1": rate, "ap2": None})
                self.assertEqual(manifest["runId"], "test")
        with self.assertRaisesRegex(ValueError, "outside this CSI run"):
            run.write_export(folder / "export.zip", {"unknown": 0})


class TestCsiValidation(unittest.TestCase):
    def test_trajectory_requires_one_receiver_and_strictly_ordered_timestamps(self):
        a, b = {"x": 0, "y": 0, "z": 0}, {"x": 1, "y": 0, "z": 0}
        config = dict(mode="trajectory", txs=[{"enu": a}], rxs=[{"enu": b}],
                      buildings=[], freqGhz=3.5, waypoints=[a, b], timeSeconds=[0, 0.2])
        request = CsiRunRequest(**config)
        self.assertEqual(request.timeSeconds, [0, 0.2])
        self.assertEqual(request.output, "cir_cfr")
        self.assertEqual(CsiRunRequest(**config, output="cir").output, "cir")
        for invalid in (dict(timeSeconds=[0, 0]), dict(timeSeconds=[1, 2]), dict(timeSeconds=[0]),
                        dict(output="cfr"),
                        dict(rxs=[{"enu": a, "id": "1"}, {"enu": b, "id": "2"}])):
            with self.assertRaises(ValidationError):
                CsiRunRequest(**{**config, **invalid})

    def test_invalid_fronthaul_is_rejected(self):
        for rate in (-1, float("inf"), float("nan")):
            with self.assertRaises(ValidationError):
                CsiExportRequest(fronthaulMbpsByTxId={"ap1": rate})
