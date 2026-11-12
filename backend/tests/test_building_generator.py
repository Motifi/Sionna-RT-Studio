import unittest

import numpy as np
from pydantic import ValidationError

from backend.building_generator import generate_building
from backend.models import BuildingFootprint, BuildingSpec


def spec(**overrides):
    fields = dict(id="tower", name="Tower", east=100, north=200, length=24, width=16,
                  height=10.8, baseZ=2.5, layout="office")
    return BuildingSpec(**(fields | overrides))


def world_vertices(obj):
    return np.asarray(obj.mesh.vertices).reshape(-1, 3) + [0, 0, obj.baseZ]


def wall_covers(obj, axis, fixed, along, z):
    """Check a point in a triangle on a vertical plane, inclusive of shared edges."""
    vertices = world_vertices(obj)
    for tri in vertices[np.asarray(obj.mesh.triangles).reshape(-1, 3)]:
        if not np.allclose(tri[:, axis], fixed, atol=1e-8, rtol=0):
            continue
        edges = tri[1:] - tri[:1]
        dx, dy = along - tri[0, 1 - axis], z - tri[0, 2]
        a, b = edges[:, 1 - axis]
        c, d = edges[:, 2]
        det = a * d - b * c
        if det:
            u, v = (dx * d - dy * b) / det, (dy * a - dx * c) / det
            if min(u, v, 1 - u - v) >= -1e-8:
                return True
    return False


class BuildingGeneratorTests(unittest.TestCase):
    def test_rotation_world_bounds_and_floor_labels(self):
        result = generate_building(spec(rotationDeg=-270))
        self.assertEqual(result.spec.floors, 3)
        self.assertEqual(result.spec.rotationDeg, 90)
        self.assertEqual({obj.floor for obj in result.objects}, {"1F", "2F", "3F", "Roof"})
        vertices = np.concatenate([world_vertices(obj) for obj in result.objects if obj.rfRole == "surface"])
        np.testing.assert_allclose(vertices.min(axis=0), [92, 188, 2.5], atol=1e-7)
        np.testing.assert_allclose(vertices.max(axis=0), [108, 212, 13.3], atol=1e-7)
        self.assertEqual(spec(rotationDeg=-1e-100).rotationDeg, 0)

    def test_facade_doorway_and_window_are_distinct_geometry(self):
        first_floor = {obj.type: obj for obj in generate_building(spec()).objects if obj.floor == "1F"}
        facade, glazing = first_floor["generated_facade"], first_floor["generated_glazing"]
        self.assertEqual((facade.material, glazing.material), ("itu_concrete", "itu_glass"))
        self.assertTrue(all(obj.rfRole == "surface" for obj in (facade, glazing)))
        self.assertFalse(wall_covers(facade, 0, 88, 200, 4.0))
        self.assertFalse(wall_covers(glazing, 0, 88, 200, 4.0))
        self.assertTrue(wall_covers(facade, 0, 88, 201.4, 4.0))
        self.assertTrue(wall_covers(glazing, 1, 192, 90.4, 4.0))
        self.assertFalse(wall_covers(facade, 1, 192, 90.4, 4.0))
        self.assertEqual(first_floor["generated_trim"].rfRole, "visual")

    def test_corridor_walls_have_door_openings(self):
        result = generate_building(spec())
        wall = next(obj for obj in result.objects if obj.type == "generated_partition" and obj.floor == "2F")
        self.assertEqual(wall.material, "itu_plasterboard")
        north_wall = sorted(set(np.round(world_vertices(wall)[:, 1], 8)))
        corridor = min(y for y in north_wall if y > 200)
        opaque = [wall_covers(wall, 1, corridor, x, 7.8) for x in np.linspace(89, 111, 89)]
        self.assertTrue(any(opaque))
        self.assertIn(False, opaque)
        self.assertTrue(wall_covers(wall, 1, corridor, 110, 8.7))

    def test_generation_is_deterministic_but_layout_changes_materials_and_partitions(self):
        office = generate_building(spec())
        self.assertEqual(office, generate_building(spec()))
        ids = [obj.id for obj in office.objects]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(obj.id.startswith("tower--") for obj in office.objects))
        home = generate_building(spec(layout="apartments"))
        self.assertEqual(next(obj.material for obj in home.objects if obj.type == "generated_facade"), "itu_brick")
        by_id = {obj.id: obj for obj in home.objects}
        self.assertNotEqual(next(obj.mesh for obj in office.objects if obj.type == "generated_partition"),
                            next(obj.mesh for obj in by_id.values() if obj.type == "generated_partition"))

    def test_spec_rejects_impossible_and_nonfinite_inputs(self):
        for bad in ({"length": 5}, {"width": 151}, {"height": 10, "floors": 8},
                    {"height": float("nan")}, {"id": "bad id"}, {"floors": True}, {"floors": 2.5}):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                spec(**bad)

    def test_auto_floors_respect_minimum_floor_height(self):
        self.assertEqual(spec(height=4.8, layout="apartments").floors, 1)
        self.assertEqual(spec(height=120, layout="apartments").floors, 30)
        self.assertEqual(spec(height=8.1, floors=3).floors, 3)

    def test_largest_supported_building_fits_a_scene_package(self):
        for layout in ("office", "apartments"):
            with self.subTest(layout=layout):
                objects = generate_building(spec(length=150, width=150, height=120, layout=layout)).objects
                self.assertLessEqual(sum(len(obj.mesh.vertices) // 3 for obj in objects), 100_000)
                self.assertLessEqual(sum(len(obj.mesh.triangles) // 3 for obj in objects), 150_000)

    def test_recipe_metadata_rejects_a_component_in_another_group(self):
        data = generate_building(spec()).objects[0].model_dump()
        data["id"] = "another-building--1f-facade"
        with self.assertRaisesRegex(ValidationError, "recipe ID"):
            BuildingFootprint.model_validate(data)


if __name__ == "__main__":
    unittest.main()
