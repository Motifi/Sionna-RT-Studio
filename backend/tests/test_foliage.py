"""Regression tests for attenuating the geometric rays before channel assembly."""

import os
from pathlib import Path
import unittest

import numpy as np

from backend.foliage import attenuate_paths


class _SyntheticPaths:
    # Two receivers, one transmitter, two valid rays per receiver.
    sources = np.array([[-4.0], [0.0], [0.0]])
    targets = np.array([[4.0, 4.0], [0.0, 0.0], [0.0, 0.0]])
    valid = np.ones((2, 1, 2), dtype=bool)
    interactions = np.array([[[[0, 1]], [[0, 1]]]])
    vertices = np.array([[[[[0, 0, 0], [0, 4, 0]]], [[[0, 0, 0], [0, 0, 0]]]]])
    a = (np.ones((2, 2, 1, 3, 2), dtype=np.float32),
         np.ones((2, 2, 1, 3, 2), dtype=np.float32))

    def cir(self, *, normalize_delays, out_type):
        delays = np.broadcast_to(np.array([0, 0.25], dtype=np.float32), self.valid.shape)
        return (self.a[0] + 1j * self.a[1])[..., None], delays


class TestFoliage(unittest.TestCase):
    crowns = (
        ((-1, 0, 0), (2, 2, 2), 1),
        ((1, 0, 0), (2, 2, 2), 2),
    )

    def test_overlapping_crowns_use_strongest_rate_for_shared_distance(self):
        paths = _SyntheticPaths()
        attenuated = attenuate_paths(paths, self.crowns)
        # 2 m at 1 dB/m then 4 m at 2 dB/m gives 10 dB total. The elevated
        # detour misses both crowns; the second receiver's detour does not.
        factor = 10 ** (-10 / 20)
        expected = np.array([[factor, 1], [factor, factor]])
        for component in attenuated.a:
            np.testing.assert_allclose(component[:, 1, 0, 2], expected, rtol=1e-6)
        self.assertTrue(np.all(paths.a[0] == 1))

    def test_cfr_is_coherent_sum_of_attenuated_coefficients_at_original_delays(self):
        paths = _SyntheticPaths()
        attenuated = attenuate_paths(paths, self.crowns)
        coefficients, delays = attenuated.cir(normalize_delays=False, out_type="numpy")
        np.testing.assert_array_equal(delays, paths.cir(normalize_delays=False, out_type="numpy")[1])
        factor = 10 ** (-10 / 20)
        np.testing.assert_allclose(coefficients[0, 1, 0, 2, :, 0], (1 + 1j) * np.array([factor, 1]))
        response = attenuated.cfr(frequencies=np.array([0, 2]), normalize_delays=False, out_type="numpy")
        self.assertEqual(response.shape, (2, 2, 1, 3, 1, 2))
        np.testing.assert_allclose(response[0, 1, 0, 2, 0], (1 + 1j) * np.array([factor + 1, factor - 1]), rtol=1e-6)
        self.assertAlmostEqual(float(abs(response[1, 1, 0, 2, 0, 1])), 0.0, places=6)

    def test_clear_and_tangent_rays_keep_original_paths(self):
        paths = _SyntheticPaths()
        self.assertIs(attenuate_paths(paths, ()), paths)
        self.assertIs(attenuate_paths(paths, (((0, 0, 2), (2, 2, 2), 1),)), paths)

    def test_ray_endpoint_inside_crown_counts_only_distance_traversed(self):
        paths = _SyntheticPaths()
        attenuated = attenuate_paths(paths, (((-4, 0, 0), (2, 1, 1), 3),))
        self.assertAlmostEqual(float(attenuated.a[0][0, 0, 0, 0, 0]), 10 ** (-6 / 20), places=6)


@unittest.skipUnless(os.getenv("SRTS_TEST_RT"), "requires an initialized Mitsuba runtime")
class TestNativeFoliage(unittest.TestCase):
    def setUp(self):
        from backend import main  # Initialize the same Mitsuba variant as the server.
        from backend.models import BuildingFootprint, ENUVector, Receiver, SolverOptions, Transmitter

        self.tx = Transmitter(enu=ENUVector(x=-7, y=-5, z=2.5), height=2.5,
                              heightReference="enu", antennaArraySize=(2, 1))
        self.rx = Receiver(enu=ENUVector(x=5, y=-5, z=2.5), height=2.5, heightReference="enu")
        self.options = SolverOptions(txPattern="iso", pathSamplesPerSource=10_000)
        self.tree = BuildingFootprint(
            id="tree", category="terrain", rfRole="foliage", height=0, enuPoints=[], baseZ=1,
            foliage={"center": {"x": 0, "y": -5, "z": 1.5},
                     "radii": {"x": 2, "y": 1, "z": 1}, "attenuationDbPerM": 3},
        )
        self.ground = BuildingFootprint(
            id="ground", category="terrain", kind="mesh", rfRole="ground", height=0, enuPoints=[],
            mesh={"vertices": [-10, -10, 0, 10, -10, 0, 10, 10, 2, -10, 10, 2],
                  "triangles": [0, 1, 2, 0, 2, 3]},
        )

    def test_link_cir_and_csi_share_the_same_attenuated_ray(self):
        from backend.csi_runs import CsiRunRequest, solve_csi_run
        from backend.models import CIRRequest, SolveRequest
        from backend.solver import solve_cir, solve_link

        request = dict(tx=self.tx, rx=self.rx, maxDepth=0, options=self.options)
        clear_rays, clear = solve_link(SolveRequest(**request, buildings=[]))
        attenuated_rays, attenuated = solve_link(SolveRequest(**request, buildings=[self.tree]))
        self.assertAlmostEqual(clear.totalRxPowerDbm - attenuated.totalRxPowerDbm, 12, places=5)
        self.assertEqual(clear_rays[0].delayNs, attenuated_rays[0].delayNs)

        cir_request = dict(**request, freqGhz=28, numSubcarriers=4, normalizeDelays=False)
        baseline = solve_cir(CIRRequest(**cir_request, buildings=[]))
        channel = solve_cir(CIRRequest(**cir_request, buildings=[self.tree]))
        factor = 10 ** (-12 / 20)
        np.testing.assert_allclose(channel["a"], baseline["a"] * factor, rtol=1e-6, atol=1e-10)
        np.testing.assert_allclose(channel["h"], baseline["h"] * factor, rtol=1e-6, atol=1e-10)
        np.testing.assert_array_equal(channel["tau"], baseline["tau"])

        csi = solve_csi_run(CsiRunRequest(
            mode="static", txs=[self.tx], rxs=[self.rx], buildings=[self.tree], freqGhz=28,
            maxDepth=0, options=self.options, numSubcarriers=4, normalizeDelays=False,
        ))
        self.addCleanup(csi.directory.cleanup)
        with np.load(Path(csi.directory.name) / "csi.npz") as exported:
            np.testing.assert_allclose(exported["h_freq"][0], channel["h"][..., 0, :], rtol=1e-6, atol=1e-10)
        self.assertAlmostEqual(csi.summary["links"][0]["metrics"].totalRxPowerDbm,
                               attenuated.totalRxPowerDbm, places=5)

    def test_terrain_coverage_and_foliage_loss_at_cell_centers(self):
        from backend.models import ChannelGridRequest, ENUVector, RadioMapRequest
        from backend.solver import solve_channel_grid, solve_radiomap

        self.ground.mesh.triangles = [0, 1, 3]
        request = dict(tx=self.tx, gridSize=10, gridHeight=2, maxDepth=0,
                       options=self.options, samplesPerTx=1000)
        baseline = solve_radiomap(RadioMapRequest(**request, buildings=[self.ground]))
        result = solve_radiomap(RadioMapRequest(**request, buildings=[self.ground, self.tree]))
        self.assertEqual([(c.x, c.y, c.z) for c in result.cells],
                         [(-5, -5, 2.5), (5, -5, 2.5), (-5, 5, 3.5), (5, 5, 2)])
        self.assertAlmostEqual(baseline.cells[0].powerDbm - result.cells[0].powerDbm, 0, places=5)
        self.assertAlmostEqual(baseline.cells[1].powerDbm - result.cells[1].powerDbm, 12, places=5)
        self.assertTrue(result.cells[1].isLos)
        self.assertIsNone(result.cells[3].servingTx)

        grid = solve_channel_grid(ChannelGridRequest(
            tx=self.tx, buildings=[self.ground, self.tree], numSubcarriers=4, maxDepth=0,
            cells=[ENUVector(x=c.x, y=c.y, z=c.z) for c in result.cells], options=self.options,
        ))
        self.assertTrue(grid["h"][1].any())
        self.assertFalse(grid["h"][3].any())
        self.assertTrue(grid["los"][1])
        self.assertFalse(grid["los"][3])
        self.assertTrue(np.isneginf(grid["received_power_dbm"][3]))
