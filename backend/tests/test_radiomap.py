"""Coverage-map allocation, visibility, and export regressions."""

import io
import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from backend.models import BuildingFootprint, ENUVector, RadioMapRequest, SolverOptions, Transmitter
from backend.scene_import import import_meshes
from backend.solver import _coverage_stats, _device_z, _mobility_kinematics, solve_radiomap


def _tx(name, x=0, y=0, z=1):
    return Transmitter(id=name, enu=ENUVector(x=x, y=y, z=z), height=z,
                       heightReference="enu", antennaArraySize=(1, 1))


class TestCoverageGridBudget(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(sys.modules, {"sionna.rt.radio_materials.itu": SimpleNamespace(
            ITU_MATERIALS_PROPERTIES={"concrete": {(1, 100): ()}},
        )}))

    def test_served_rate_counts_no_path_as_unserved(self):
        values = np.array([-70.0, *([-np.inf] * 99)])
        stats = _coverage_stats(values, "power", -90)
        self.assertEqual((stats.servedPercent, stats.p5), (1, -70))

    def test_preflight_sizes_the_custom_region_and_reports_limits_before_native_load(self):
        from backend.solver import preflight_radiomap

        req = RadioMapRequest(
            txs=[_tx("first", 90_000), _tx("second")], buildings=[],
            region={"minX": -5, "maxX": 7, "minY": 2, "maxY": 10},
            gridSize=4, samplesPerTx=1000,
        )
        with patch("backend.solver.build_compiled_scene", side_effect=AssertionError("Scene load started")):
            plan = preflight_radiomap(req)
            oversize = preflight_radiomap(req.model_copy(update={"region": req.region.model_copy(
                update={"maxX": 100_000, "maxY": 100_000},
            )}))
        self.assertEqual((plan.solverMethod, plan.nx, plan.ny, plan.cells, plan.apCells),
                         ("radio_map", 3, 2, 6, 12))
        self.assertEqual(plan.issues, [])
        self.assertGreater(oversize.cells, oversize.maxCells)
        self.assertIn("grid step", oversize.issues[0])
        self.assertRaisesRegex(ValueError, "grid step", solve_radiomap, req.model_copy(
            update={"region": req.region.model_copy(update={"maxX": 100_000, "maxY": 100_000})},
        ))

    def test_floor_slice_masks_cells_outside_the_compiled_floor_and_sets_elevation(self):
        from backend.solver import preflight_radiomap

        floor = BuildingFootprint(
            id="second-floor", floor="2F", kind="mesh", category="building", rfRole="surface",
            height=0, baseZ=10, enuPoints=[],
            mesh={"vertices": [0, 0, 3, 8, 0, 3, 0, 8, 3], "triangles": [0, 1, 2]},
        )
        req = RadioMapRequest(
            txs=[_tx("first")], buildings=[floor], floorId=floor.id,
            gridSize=4, gridHeight=1.5, maxDepth=0, coverageThresholdDb=20,
        )
        plan = preflight_radiomap(req)
        self.assertEqual((plan.measuredCells, plan.traceBatches), (3, 1))
        scene = SimpleNamespace(thermal_noise_power=np.array([1e-3]))
        traced = SimpleNamespace(a=(np.ones((3, 2, 1, 1, 1)) * 0.1, np.zeros((3, 2, 1, 1, 1))))
        with (
            patch("backend.solver.build_compiled_scene", return_value=scene),
            patch("backend.solver._set_tx_array", return_value=1),
            patch("backend.solver._set_planar_array"),
            patch("backend.solver._trace_batched", return_value=traced) as trace,
            patch("backend.solver._segment_visibility", return_value=np.ones(3, dtype=bool)),
        ):
            result = solve_radiomap(req)
        self.assertEqual((result.floorId, result.floorElevationM), (floor.id, 13))
        self.assertEqual(trace.call_args.args[2], [[2, 2, 14.5], [6, 2, 14.5], [2, 6, 14.5]])
        self.assertEqual([c.sampled for c in result.cells], [True, True, True, False])
        self.assertEqual(result.stats.thresholdDb, 20)
        self.assertEqual(result.stats.servedPercent, 0)

    def test_traced_preflight_counts_batches_before_reporting_sample_budget(self):
        from backend.solver import preflight_radiomap

        terrain = BuildingFootprint(
            id="survey", kind="mesh", category="terrain", rfRole="ground", height=0, enuPoints=[],
            mesh={"vertices": [0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 64, 0],
                  "triangles": [0, 1, 2, 0, 2, 3]},
        )
        req = RadioMapRequest(
            txs=[_tx("first"), _tx("second")], buildings=[terrain],
            gridSize=1, samplesPerTx=10_000_000,
        )
        with patch("backend.solver.build_compiled_scene", side_effect=AssertionError("Scene load started")):
            plan = preflight_radiomap(req)
            with self.assertRaisesRegex(ValueError, "ray-sampling budget"):
                solve_radiomap(req)
        self.assertEqual((plan.measuredCells, plan.traceBatches, plan.samplesPerBatch, plan.totalSamples),
                         (4096, 128, 20_000_000, 2_560_000_000))
        self.assertIn("1,000,000 or fewer", plan.issues[0])

    def test_automatic_terrain_extent_rejects_a_grid_without_measured_cells(self):
        from backend.solver import preflight_radiomap

        terrain = [
            BuildingFootprint(
                id=f"terrain-{x}", kind="mesh", category="terrain", rfRole="ground", height=0, enuPoints=[],
                mesh={"vertices": [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0],
                      "triangles": [0, 1, 2, 0, 2, 3]},
            ) for x in (0, 10)
        ]
        req = RadioMapRequest(txs=[_tx("first")], buildings=terrain, gridSize=8, maxDepth=0)
        plan = preflight_radiomap(req)
        self.assertEqual((plan.cells, plan.measuredCells), (2, 0))
        self.assertTrue(plan.issues)
        with (
            patch("backend.solver.build_compiled_scene", side_effect=AssertionError("Scene load started")),
            self.assertRaisesRegex(ValueError, "No grid centers"),
        ):
            solve_radiomap(req)

    def test_rejects_oversized_physical_grid_before_loading_ray_tracing_scene(self):
        cases = ((100_000, 1, None), (100_000, 1, []),
                 (3_900, 5, [{"x": 0, "y": 0, "z": 0}]))
        for location, num_tx, footprint in cases:
            with self.subTest(location=location, transmitters=num_tx, footprint=footprint):
                obj = (
                    f"v {location} {location} 0\n"
                    f"v {location + 1} {location} 0\n"
                    f"v {location} {location + 1} 1\nf 1 2 3\n"
                ).encode()
                imported = import_meshes(obj, "distant.obj", "z-up", 1, "itu_concrete")
                if footprint is not None:
                    imported["objects"][0]["enuPoints"] = footprint
                req = RadioMapRequest(txs=[_tx(f"tx{i}") for i in range(num_tx)],
                                      buildings=imported["objects"], gridSize=8)
                # Compile real geometry with static material data and ensure the
                # native scene cannot be loaded for an oversized request.
                with (
                    patch.dict(sys.modules, {
                        "sionna.rt": SimpleNamespace(RadioMapSolver=None),
                        "sionna.rt.radio_materials.itu": SimpleNamespace(
                            ITU_MATERIALS_PROPERTIES={"concrete": {(1, 100): ()}},
                        ),
                    }),
                    patch("backend.scene_build._build", side_effect=AssertionError("Scene load started")),
                    self.assertRaisesRegex(ValueError, "grid step"),
                ):
                    solve_radiomap(req)


class TestTerrainCoverage(unittest.TestCase):
    def setUp(self):
        self.terrain = BuildingFootprint(
            id="slope", category="terrain", kind="mesh", rfRole="ground",
            height=0, enuPoints=[], baseZ=-6,
            mesh={"vertices": [0, 0, 0, 8, 0, 4, 0, 8, 0], "triangles": [0, 1, 2]},
        )

    def test_terrain_relative_placement_and_velocity_follow_the_resolved_slope(self):
        start = ENUVector(x=2, y=2, z=99)
        finish = ENUVector(x=6, y=2, z=99)
        self.assertEqual(_device_z(start, 2, [self.terrain]), -3)
        self.assertEqual(_device_z(start, 2, [self.terrain], "enu"), 2)
        self.assertEqual(_device_z(ENUVector(x=6, y=6, z=99), 2, [self.terrain]), 2)
        positions, velocities = _mobility_kinematics([start, finish], 2, [self.terrain], 10)
        self.assertEqual(positions, [[2, 2, -3], [6, 2, -1]])
        np.testing.assert_allclose(velocities, [[8.94427191, 0, 4.472135955]] * 2)

    def test_grid_retains_unmapped_cells_without_reporting_coverage_there(self):
        req = RadioMapRequest(
            txs=[_tx("first"), _tx("second")], buildings=[self.terrain],
            gridSize=4, gridHeight=1.5, maxDepth=0, samplesPerTx=1000,
        )
        scene = SimpleNamespace(thermal_noise_power=np.array([1e-3]))
        # The traced pair amplitudes correspond to gains 0.04 and 0.01.
        # Tx power is 30 dBm (1 W), so SINR is 0.04/(0.01+0.001).
        coefficients = np.broadcast_to(np.array([0.2, 0.1]).reshape(1, 1, 2, 1, 1), (3, 1, 2, 1, 1))
        traced = SimpleNamespace(a=(coefficients, np.zeros_like(coefficients)))
        with (
            patch.dict(sys.modules, {"sionna.rt.radio_materials.itu": SimpleNamespace(
                ITU_MATERIALS_PROPERTIES={"concrete": {(1, 100): ()}},
            )}),
            patch("backend.solver.build_compiled_scene", return_value=scene),
            patch("backend.solver._set_tx_array", return_value=1),
            patch("backend.solver._set_planar_array"),
            patch("backend.solver._trace_batched", return_value=traced),
            patch("backend.solver._segment_visibility", return_value=np.ones(3, dtype=bool)),
        ):
            result = solve_radiomap(req)

        self.assertEqual((result.minX, result.maxX, result.minY, result.maxY), (0, 8, 0, 8))
        self.assertEqual((result.solverMethod, result.traceBatches), ("direct_receivers", 1))
        self.assertEqual([(c.x, c.y, c.z) for c in result.cells],
                         [(2, 2, -3.5), (6, 2, -1.5), (2, 6, -3.5), (6, 6, 1.5)])
        self.assertEqual([c.servingTx for c in result.cells], [0, 0, 0, None])
        self.assertEqual([c.isLos for c in result.cells], [True, True, True, False])
        self.assertAlmostEqual(result.cells[0].powerDbm, 16.0205999133)
        self.assertAlmostEqual(result.cells[0].sinr, 5.6066730617)
        self.assertIsNone(result.cells[3].sinr)
        self.assertEqual(result.stats.servedPercent, 100)


@unittest.skipUnless(os.getenv("SRTS_TEST_RT"), "requires an initialized Mitsuba runtime")
class TestCoverageVisibility(unittest.TestCase):
    def test_cfr_export_traces_sampled_floor_cells_beyond_the_terrain(self):
        from backend import main
        from backend.models import ChannelGridRequest

        floor = BuildingFootprint(
            id="floor", floor="2F", kind="mesh", category="building", rfRole="surface",
            height=0, baseZ=10, enuPoints=[],
            mesh={"vertices": [0, 0, 3, 8, 0, 3, 0, 8, 3], "triangles": [0, 1, 2]},
        )
        terrain = BuildingFootprint(
            id="terrain", kind="mesh", category="terrain", rfRole="ground", height=0, enuPoints=[],
            mesh={"vertices": [0, 0, 0, 3, 0, 0, 3, 8, 0, 0, 8, 0],
                  "triangles": [0, 1, 2, 0, 2, 3]},
        )
        shared = dict(tx=_tx("first", 2, 2, 15.5), buildings=[floor, terrain], maxDepth=0,
                      options=SolverOptions(txPattern="iso"))
        result = main.api_radiomap(RadioMapRequest(
            **shared, floorId=floor.id, gridSize=4, gridHeight=1.5, samplesPerTx=1000,
        ))
        sampled = [c for c in result.cells if c.sampled]
        self.assertEqual([c.servingTx for c in sampled], [0, 0, 0])

        response = main.api_channel_grid(ChannelGridRequest(
            **shared, numSubcarriers=4, cellsAreSampled=True,
            cells=[ENUVector(x=c.x, y=c.y, z=c.z) for c in sampled],
        ))
        with np.load(io.BytesIO(response.body)) as exported:
            np.testing.assert_array_equal(exported["coordinates"], [[2, 2, 14.5], [6, 2, 14.5], [2, 6, 14.5]])
            self.assertTrue(np.isfinite(exported["received_power_dbm"][1]))
            self.assertTrue(exported["los"][1])
            self.assertTrue(np.abs(exported["h"][1]).any())

    def test_floor_grid_uses_native_tracing_at_the_planned_receiver_elevation(self):
        from backend import main

        floor = BuildingFootprint(
            id="second-floor-native", floor="2F", kind="mesh", category="building", rfRole="surface",
            height=0, baseZ=10, enuPoints=[],
            mesh={"vertices": [0, 0, 3, 8, 0, 3, 0, 8, 3], "triangles": [0, 1, 2]},
        )
        req = RadioMapRequest(
            txs=[_tx("first", 2, 2, 15.5)], buildings=[floor], floorId=floor.id,
            gridSize=4, gridHeight=1.5, maxDepth=0, samplesPerTx=1000,
        )
        plan = main.api_radiomap_preflight(req)
        result = main.api_radiomap(req)
        self.assertEqual((plan.cells, plan.measuredCells), (4, 3))
        self.assertEqual((plan.solverMethod, result.solverMethod), ("direct_receivers", "direct_receivers"))
        self.assertEqual([c.z for c in result.cells], [14.5] * 4)
        self.assertEqual([c.servingTx for c in result.cells], [0, 0, 0, None])

    def test_coverage_extents_follow_transmitters_and_compiled_physical_geometry(self):
        from backend import main

        distant_point = ENUVector(x=100_000, y=100_000, z=0)
        display_road = BuildingFootprint(id="road", category="infrastructure", height=0,
                                        enuPoints=[distant_point])
        skipped_wall = BuildingFootprint(id="skipped", kind="wall", category="building",
                                         height=4, enuPoints=[distant_point, distant_point])
        wall = BuildingFootprint(id="wall", kind="wall", category="building", height=4,
                                 enuPoints=[ENUVector(x=x, y=y, z=0) for x, y in [(-170, -60), (-120, -75)]])
        raised = BuildingFootprint(id="raised", category="building", baseZ=10, height=3,
                                  enuPoints=[ENUVector(x=x, y=y, z=0) for x, y in [(30, 177), (35, 177), (35, 182)]])
        mesh = BuildingFootprint(
            id="mesh", kind="mesh", category="building", height=2, enuPoints=[distant_point],
            mesh={"vertices": [200, 160, 0, 205, 160, 0, 200, 165, 2, 200_000, 200_000, 0],
                  "triangles": [0, 1, 2]},
        )
        req = RadioMapRequest(
            txs=[_tx("first"), _tx("second", -150, -100)],
            buildings=[display_road, skipped_wall, wall, raised, mesh],
            gridSize=8, samplesPerTx=1000, maxDepth=0,
        )
        result = main.api_radiomap(req)
        self.assertEqual((result.minX, result.maxX, result.minY, result.maxY), (-170, 205, -100, 182))
        self.assertEqual(len(result.cells), 55 * 43)

    def test_uses_best_transmitter_and_compiled_geometry_for_geometric_visibility(self):
        from backend import main  # Initialize the same Mitsuba variant as the server.

        wall = BuildingFootprint(id="wall", kind="wall", category="building", height=4,
                                 enuPoints=[ENUVector(x=0, y=y, z=0) for y in (-2, 2)])
        mesh_obj = b"v 0 8 0\nv 0 12 0\nv 0 10 4\nf 1 2 3\n"
        mesh = import_meshes(mesh_obj, "triangle.obj", "z-up", 1, "itu_concrete")["objects"][0]
        raised = BuildingFootprint(
            id="raised", category="building", baseZ=10, height=3,
            enuPoints=[ENUVector(x=x, y=y, z=0) for x, y in [(-1, 18), (1, 18), (1, 22), (-1, 22)]],
        )
        req = RadioMapRequest(
            txs=[_tx("wall", -5), _tx("mesh", -5, 10), _tx("above", -5, 20, 11), _tx("below", -5, 20)],
            buildings=[wall, mesh, raised], gridSize=8, options=SolverOptions(los=False),
        )
        # Keep actual scene compilation and ray intersection, but make coverage
        # samples deterministic so each center exercises a particular segment.
        centers = np.array([[5, 0, 1], [5, 10, 1], [5, 20, 11], [5, 20, 1],
                            [-1, 0, 1], [0, 0, 1], [-5, 0, 1], [5, 30, 1]])
        rss = np.zeros((4, len(centers)))
        rss[[0, 1, 2, 3, 0, 0, 0], np.arange(7)] = 1e-6
        with patch("sionna.rt.RadioMapSolver") as mock_solver:
            mock_solver.return_value.return_value = SimpleNamespace(cell_centers=centers, rss=rss, sinr=rss)
            result = main.api_radiomap(req)

        self.assertEqual([c.isLos for c in result.cells], [False, False, False, True, True, True, False, False])
        self.assertEqual([c.servingTx for c in result.cells], [0, 1, 2, 3, 0, 0, 0, None])
