import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from backend.models import BuildingFootprint
from backend.scene_build import inspect_scene


class TestSolverMeshPrecision(unittest.TestCase):
    def inspect_mesh(self, vertices, triangles, *, base_z=0):
        obj = BuildingFootprint(
            id="mesh", category="building", kind="mesh", enuPoints=[], height=2, baseZ=base_z,
            mesh={"vertices": vertices, "triangles": triangles},
        )
        itu = SimpleNamespace(ITU_MATERIALS_PROPERTIES={"concrete": {(1, 100): ()}})
        with patch.dict(sys.modules, {"sionna.rt.radio_materials.itu": itu}):
            return inspect_scene([obj], 3.5, [])

    def test_skips_an_imported_triangle_that_collapses_at_solver_precision(self):
        inspection = self.inspect_mesh([999999.99, 0, 0, 1000000, 0, 0, 999999.99, 0, 2], [0, 1, 2])

        self.assertEqual(inspection["objects"][0]["status"], "skipped")
        self.assertRegex(" ".join(inspection["objects"][0]["issues"]), "degenerate.*solver precision")
        self.assertEqual([mesh["id"] for mesh in inspection["meshes"]], [""])

    def test_keeps_surviving_faces_after_applying_base_elevation_and_rounding(self):
        inspection = self.inspect_mesh(
            [0, 0, 0, 0, 0, 0.01, 2, 0, 0, 0, 2, 0], [0, 1, 2, 0, 2, 3], base_z=1_000_000,
        )

        self.assertEqual(inspection["objects"][0]["status"], "physical")
        self.assertRegex(" ".join(inspection["objects"][0]["issues"]), "Removed 1 degenerate triangle")
        _, mesh = inspection["meshes"]
        vertices = np.asarray(mesh["vertices"]).reshape(-1, 3)
        self.assertEqual(len(vertices), 3)
        np.testing.assert_array_equal(vertices[mesh["triangles"]], [[0, 0, 1e6], [2, 0, 1e6], [0, 2, 1e6]])

    def test_rounding_does_not_turn_a_collinear_face_into_solver_geometry(self):
        inspection = self.inspect_mesh([999999.9375, 0, 2, 999999.953125, 1, 2, 999999.96875, 2, 2], [0, 1, 2])

        self.assertEqual(inspection["objects"][0]["status"], "skipped")
        self.assertEqual([mesh["id"] for mesh in inspection["meshes"]], [""])
