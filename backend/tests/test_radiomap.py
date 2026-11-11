"""Coverage-map allocation and visibility regressions."""

import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from backend.models import BuildingFootprint, ENUVector, RadioMapRequest, SolverOptions, Transmitter
from backend.scene_import import import_meshes
from backend.solver import solve_radiomap


def _tx(name, x=0, y=0, z=1):
    return Transmitter(id=name, enu=ENUVector(x=x, y=y, z=z), height=z,
                       heightReference="enu", antennaArraySize=(1, 1))


class TestCoverageGridBudget(unittest.TestCase):
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


@unittest.skipUnless(os.getenv("SRTS_TEST_RT"), "requires an initialized Mitsuba runtime")
class TestCoverageVisibility(unittest.TestCase):
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
