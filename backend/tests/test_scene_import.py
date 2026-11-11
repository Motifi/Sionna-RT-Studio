from io import BytesIO
import unittest
from zipfile import ZipFile

import numpy as np
import trimesh

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
