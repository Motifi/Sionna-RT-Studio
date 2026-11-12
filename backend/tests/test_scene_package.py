import io
import json
import struct
import unittest
import zipfile

from backend.scene_package import read_scene_package


def package(*, image_uri=None, visual_id="street", replace_object=None, accessors=None):
    manifest = {
        "format": "SionnaRTStudio Scene", "schemaVersion": 1, "coordinateFrame": "ENU_m",
        "name": "Street", "anchor": {"latitude": 31.0, "longitude": 121.0, "elevation": 3, "verticalDatum": "local"},
        "objects": [
            {"id": "street", "rfRole": "ground", "category": "infrastructure",
             "material": "itu_asphalt_concrete", "meshFile": "street.ply"},
        ],
        "visual": {"file": "visual.glb", "objectIds": [visual_id]},
    }
    if replace_object is not None:
        manifest["objects"] = [replace_object]
    gltf = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"name": "street"}]}
    if image_uri:
        gltf["images"] = [{"uri": image_uri}]
    if accessors:
        gltf["accessors"] = accessors
    gltf_json = json.dumps(gltf).encode()
    gltf_json += b" " * (-len(gltf_json) % 4)
    glb = struct.pack("<4sIIII", b"glTF", 2, 20 + len(gltf_json), len(gltf_json), 0x4E4F534A) + gltf_json
    ply = b"""ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
3 0 0
0 4 1
3 0 1 2
"""
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as archive:
        archive.writestr("scene.json", json.dumps(manifest))
        archive.writestr("street.ply", ply)
        archive.writestr("visual.glb", glb)
    return result.getvalue()


class ScenePackageTests(unittest.TestCase):
    def test_loads_physical_and_visual_layers_at_the_same_origin(self):
        scene = read_scene_package(package())
        self.assertEqual(scene["anchor"]["verticalDatum"], "local")
        self.assertEqual(scene["objects"][0]["rfRole"], "ground")
        self.assertEqual(scene["objects"][0]["mesh"]["triangles"], [0, 1, 2])
        self.assertEqual(scene["visual"]["bindings"], [{"id": "street", "origin": {"x": 0.0, "y": 0.0, "z": 0.0}}])

    def test_rejects_external_visual_dependencies(self):
        with self.assertRaisesRegex(ValueError, "embedded"):
            read_scene_package(package(image_uri="https://example.invalid/texture.png"))

    def test_rejects_a_visual_binding_without_a_scene_object(self):
        with self.assertRaisesRegex(ValueError, "unknown scene object"):
            read_scene_package(package(visual_id="missing"))

    def test_inline_ground_is_always_a_mesh(self):
        scene = read_scene_package(package(replace_object={
            "id": "street", "category": "infrastructure", "rfRole": "ground",
            "mesh": {"vertices": [0, 0, 0, 3, 0, 0, 0, 4, 1], "triangles": [0, 1, 2]},
        }))
        self.assertEqual(scene["objects"][0]["kind"], "mesh")

    def test_rejects_unbounded_foliage_dimensions_and_mesh_offsets(self):
        with self.assertRaisesRegex(ValueError, "ENU coordinate limit"):
            read_scene_package(package(replace_object={
                "id": "street", "category": "terrain", "rfRole": "foliage",
                "foliage": {"center": {"x": 0, "y": 0, "z": 5}, "radii": {"x": 1, "y": 1, "z": 1e308},
                            "attenuationDbPerM": 1},
            }))
        with self.assertRaisesRegex(ValueError, "elevation limit"):
            read_scene_package(package(replace_object={
                "id": "street", "category": "terrain", "rfRole": "ground", "meshFile": "street.ply", "baseZ": 1e6,
            }))

    def test_rejects_a_small_glb_declaring_an_excessive_accessor(self):
        with self.assertRaisesRegex(ValueError, "oversized accessor"):
            read_scene_package(package(accessors=[{"count": 1_000_000, "type": "VEC3", "componentType": 5126}]))
