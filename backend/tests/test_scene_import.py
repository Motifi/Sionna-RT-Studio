from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

import numpy as np
import trimesh

from backend.models import BuildingFootprint, SceneExportRequest
from backend.scene_build import GROUND_BSDF_ID, _ground_plane, _object_mesh, _write_scene_xml
from backend.scene_export import _manifest
from backend.scene_import import import_meshes

OBJ = b"""v 0 0 0
v 200 0 0
v 0 200 100
f 1 2 3
"""


def package(xml, mesh="meshes/wall.ply"):
    buffer = BytesIO()
    with ZipFile(buffer, "w") as archive:
        archive.writestr("scene/scene.xml", xml)
        geometry = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [0, 0, 2]], faces=[[0, 1, 2]])
        archive.writestr(f"scene/{mesh}", geometry.export(file_type="ply"))
    return buffer.getvalue()


def studio_package(*, include_wall=True, include_manifest=True):
    wall = trimesh.Trimesh(vertices=[[10, 0, 0], [20, 0, 0], [10, 0, 3]], faces=[[0, 1, 2]])
    meshes = [("meshes/ground.ply", GROUND_BSDF_ID, "mesh-ground", _ground_plane([wall] if include_wall else []))]
    if include_wall:
        meshes.append(("meshes/b0.ply", "itu_brick", "mesh-b0", wall))
    buffer = BytesIO()
    with TemporaryDirectory() as directory, ZipFile(buffer, "w") as archive:
        xml = _write_scene_xml(Path(directory), [row[:3] for row in meshes], {"itu_brick"})
        archive.write(xml, "scene.xml")
        for path, _, _, mesh in meshes:
            archive.writestr(path, mesh.export(file_type="ply"))
        if include_manifest:
            manifest = _manifest(SceneExportRequest(buildings=[]), [row[0] for row in meshes])
            archive.writestr("manifest.json", json.dumps(manifest))
    return buffer.getvalue()


class TestSceneImport(unittest.TestCase):
    def test_obj_units_axes_and_material(self):
        result = import_meshes(OBJ, "mesh.obj", "y-up", 0.01, "itu_glass")
        obj, = result["objects"]
        self.assertEqual(obj["material"], "itu_glass")
        self.assertEqual(obj["mesh"]["triangles"], [0, 1, 2])
        np.testing.assert_array_equal(np.reshape(obj["mesh"]["vertices"], (3, 3)),
                                      [[0, 0, 0], [2, 0, 0], [0, -1, 2]])

    def test_ply_mitsuba_shape_transform_and_material(self):
        xml = """<scene version="3.0.0">
          <bsdf type="itu-radio-material" id="brick"><string name="type" value="brick"/></bsdf>
          <shape type="ply" id="wall">
            <string name="filename" value="meshes/wall.ply"/>
            <transform name="to_world"><scale value="2"/><translate x="10" z="4"/></transform>
            <ref id="brick"/>
          </shape>
          <shape type="sphere" id="unsupported"/>
        </scene>"""
        result = import_meshes(package(xml), "scene.zip", "enu", 1, "itu_concrete")
        obj, = result["objects"]
        self.assertEqual(obj["material"], "itu_brick")
        self.assertEqual(obj["materialSource"], "tag")
        self.assertTrue(result["issues"])
        np.testing.assert_array_equal(np.reshape(obj["mesh"]["vertices"], (3, 3)),
                                      [[10, 0, 4], [12, 0, 4], [10, 0, 8]])

    def test_rejects_unsafe_mesh_references(self):
        data = package('<scene><shape type="ply"><string name="filename" value="../wall.ply"/></shape></scene>')
        with self.assertRaisesRegex(ValueError, "unsafe mesh reference"):
            import_meshes(data, "scene.zip", "enu", 1, "itu_concrete")

    def test_studio_zip_regenerates_one_ground_with_the_original_bounds(self):
        result = import_meshes(studio_package(), "studio.zip", "enu", 1, "itu_concrete")
        self.assertEqual([obj["name"] for obj in result["objects"]], ["mesh-b0"])
        self.assertEqual(result["triangleCount"], 1)
        wall, _ = _object_mesh(BuildingFootprint.model_validate(result["objects"][0]))
        np.testing.assert_array_equal(_ground_plane([wall]).bounds, [[-300, -300, 0], [320, 300, 0]])

    def test_studio_ground_only_zip_imports_an_empty_editable_scene(self):
        result = import_meshes(studio_package(include_wall=False), "studio.zip", "enu", 1, "itu_concrete")
        self.assertEqual(result["objects"], [])
        self.assertEqual(result["triangleCount"], 0)

    def test_generic_mitsuba_zip_keeps_a_ground_named_mesh(self):
        result = import_meshes(studio_package(include_manifest=False), "third-party.zip", "enu", 1, "itu_concrete")
        self.assertEqual([obj["name"] for obj in result["objects"]], ["mesh-ground", "mesh-b0"])
