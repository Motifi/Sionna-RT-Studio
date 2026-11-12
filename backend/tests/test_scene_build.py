import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from backend.models import BuildingFootprint, MaterialConfig
from backend import scene_build
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


class TestPhysicalScene(unittest.TestCase):
    def setUp(self):
        presets = SimpleNamespace(ITU_MATERIALS_PROPERTIES={
            "concrete": {(1, 100): ()},
            "asphalt_concrete": {(1, 40): ()},
            "plasterboard": {(1, 100): ()},
        })
        self.enterContext(patch.dict(sys.modules, {"sionna.rt.radio_materials.itu": presets}))

    def mesh(self, ident, **overrides):
        fields = {
            "id": ident, "category": "terrain", "kind": "mesh", "enuPoints": [], "height": 0,
            "mesh": {"vertices": [0, 0, 0, 4, 0, 4, 0, 4, 2], "triangles": [0, 1, 2]},
        }
        return BuildingFootprint(**(fields | overrides))

    def test_explicit_roles_include_ground_and_surfaces_from_any_category(self):
        ground = self.mesh("slope", rfRole="ground", material="itu_asphalt_concrete", baseZ=-6)
        wall = self.mesh("room-wall", rfRole="surface", material="itu_plasterboard", floor="L1")
        visual = self.mesh("display-building", category="building", rfRole="visual")
        road = self.mesh("display-road", category="infrastructure")
        inspection = inspect_scene([ground, wall, visual, road], 28, [])
        self.assertEqual(inspection["groundModel"], "terrain")
        self.assertEqual(
            [(mesh["id"], mesh["material"]) for mesh in inspection["meshes"]],
            [("slope", "itu_asphalt_concrete"), ("room-wall", "itu_plasterboard")],
        )
        self.assertEqual([obj["status"] for obj in inspection["objects"]],
                         ["physical", "physical", "visual", "visual"])
        self.assertEqual(inspection["objects"][1]["floor"], "L1")

    def test_terrain_sampling_uses_solver_elevation_on_triangle_and_boundary(self):
        ground = self.mesh("slope", rfRole="ground", baseZ=-6)
        surface = self.mesh("ceiling", rfRole="surface", baseZ=20)
        buildings = [ground, surface]
        positions = np.array([[1, 1], [4, 0], [3, 3]])
        compiled = scene_build.compile_scene(buildings, 28)
        for options in ({}, {"compiled": compiled}):
            heights = scene_build.terrain_elevations(buildings, positions, **options)
            np.testing.assert_allclose(heights, [-4.5, -2, np.nan])

    def test_overlapping_ground_queries_are_bounded_and_return_top_elevation(self):
        grounds = [self.mesh(f"ground-{i}", rfRole="ground", baseZ=i) for i in range(4)]
        compiled = scene_build.compile_scene(grounds, 28)
        tree = compiled.terrain_index.tree
        query = tree.query

        def bounded_query(*args, **kwargs):
            hits = query(*args, **kwargs)
            self.assertLessEqual(hits.shape[1], 8)
            return hits

        with (
            patch.object(scene_build, "_TERRAIN_QUERY_PAIRS", 8),
            patch.object(tree, "query", side_effect=bounded_query),
        ):
            heights = scene_build.terrain_elevations(
                grounds, np.array([[0, 0], [1, 1], [4, 0], [3, 3]]), compiled=compiled,
            )
        np.testing.assert_allclose(heights, [3, 4.5, 7, np.nan])

    def test_foliage_is_physical_without_hard_geometry_and_hashes_parameters(self):
        crown = self.mesh("tree", rfRole="foliage", baseZ=3, foliage={
            "center": {"x": 4, "y": 6, "z": 5},
            "radii": {"x": 2, "y": 3, "z": 4},
            "attenuationDbPerM": 0.6,
        })
        first = inspect_scene([crown], 28, [])
        self.assertEqual([mesh["id"] for mesh in first["meshes"]], [""])
        self.assertEqual(first["objects"][0]["status"], "physical")
        self.assertEqual(first["objects"][0]["foliage"]["center"], {"x": 4, "y": 6, "z": 8})
        crown.foliage.attenuationDbPerM = 0.8
        second = inspect_scene([crown], 28, [])
        self.assertEqual(first["geometryId"], second["geometryId"])
        self.assertNotEqual(first["sceneId"], second["sceneId"])
        crown.baseZ = 4
        self.assertNotEqual(second["geometryId"], inspect_scene([crown], 28, [])["geometryId"])

    def test_custom_material_requires_complete_explicit_electromagnetic_values(self):
        material = "mat-itu_partition & glass"
        wall = self.mesh("wall", rfRole="surface", material=material)
        partial = MaterialConfig(id=material, relativePermittivity=3.8)
        self.assertEqual(inspect_scene([wall], 28, [partial])["meshes"][1]["material"], "itu_concrete")
        config = MaterialConfig(id=material, relativePermittivity=3.8, conductivity=0.018)
        self.assertEqual(inspect_scene([wall], 28, [config])["meshes"][1]["material"], material)
