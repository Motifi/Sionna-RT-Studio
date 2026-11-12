"""Read a georeferenced scene with separate solver meshes and an offline GLB."""

from __future__ import annotations

import base64
import io
import json
import re
import struct
from pathlib import PurePosixPath
from typing import Literal
from zipfile import BadZipFile, ZipFile

import numpy as np
from pydantic import BaseModel, Field

from .models import BuildingFootprint, ENUVector, GeoAnchor, MaterialConfig
from .scene_import import MAX_TRIANGLES, MAX_UPLOAD, MAX_VERTICES, _load_mesh

_OBJECT_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_MAX_GLTF = 16 * 1024 * 1024
_MAX_COORDINATE = 1_000_000
_MAX_ACCESSOR_BYTES = 64 * 1024 * 1024
_ACCESSOR_WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
_COMPONENT_BYTES = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}


class VisualAsset(BaseModel):
    file: str
    objectIds: list[str] = Field(min_length=1, max_length=1024)


class SceneManifest(BaseModel):
    format: Literal["SionnaRTStudio Scene"]
    schemaVersion: Literal[1]
    coordinateFrame: Literal["ENU_m"]
    name: str = Field(min_length=1, max_length=180)
    anchor: GeoAnchor
    objects: list[dict] = Field(min_length=1, max_length=1024)
    materials: list[MaterialConfig] = Field(default_factory=list, max_length=256)
    visual: VisualAsset | None = None


def _package_members(archive: ZipFile) -> dict:
    members = archive.infolist()
    if len(members) > 2048 or sum(member.file_size for member in members) > MAX_UPLOAD * 2:
        raise ValueError("Expanded scene package is too large.")
    files = {}
    for member in members:
        name = member.filename
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
            raise ValueError("Scene package contains an unsafe path.")
        if member.is_dir():
            continue
        if str(path) != name or name in files:
            raise ValueError("Scene package paths must be unique and normalized.")
        files[name] = member
    return files


def _object_data(archive: ZipFile, files: dict, raw: dict) -> BuildingFootprint:
    fields = dict(raw)
    mesh_file = fields.pop("meshFile", None)
    ident = fields.get("id")
    if not isinstance(ident, str) or not _OBJECT_ID.fullmatch(ident):
        raise ValueError("Scene object IDs must use letters, digits, hyphens, or underscores.")
    fields.setdefault("type", "")
    fields.setdefault("source", "import")
    fields.setdefault("points", [])
    if mesh_file is not None:
        if not isinstance(mesh_file, str) or mesh_file not in files or "mesh" in fields:
            raise ValueError(f"Invalid meshFile for scene object {ident}.")
        suffix = PurePosixPath(mesh_file).suffix.lower()
        if suffix not in (".ply", ".obj"):
            raise ValueError("Scene mesh files must be PLY or OBJ.")
        mesh = _load_mesh(archive.read(files[mesh_file]), suffix[1:])
        vertices = np.asarray(mesh.vertices)
        fields["mesh"] = {"vertices": vertices.reshape(-1).tolist(), "triangles": mesh.faces.reshape(-1).tolist()}
    if "mesh" in fields:
        raw_vertices = fields["mesh"].get("vertices") if isinstance(fields["mesh"], dict) else None
        if not isinstance(raw_vertices, list) or not 9 <= len(raw_vertices) <= MAX_VERTICES * 3 or len(raw_vertices) % 3:
            raise ValueError(f"Invalid vertices for scene object {ident}.")
        try:
            vertices = np.asarray(raw_vertices, dtype=float).reshape(-1, 3)
        except (TypeError, OverflowError, ValueError) as exc:
            raise ValueError(f"Invalid vertex coordinates for scene object {ident}.") from exc
        if not np.isfinite(vertices).all() or np.max(np.abs(vertices)) > _MAX_COORDINATE:
            raise ValueError("Scene mesh coordinates must be finite and within ±1,000,000 ENU meters.")
        low, high = vertices.min(axis=0), vertices.max(axis=0)
        fields["kind"] = "mesh"
        fields.setdefault("height", float(high[2] - low[2]))
        fields.setdefault("enuPoints", [{"x": float(v[0]), "y": float(v[1]), "z": 0} for v in (low, high)])
    elif fields.get("rfRole") == "foliage":
        fields.setdefault("height", 0)
        fields.setdefault("enuPoints", [])
    obj = BuildingFootprint.model_validate(fields)
    if obj.mesh and max(abs(low[2] + obj.baseZ), abs(high[2] + obj.baseZ)) > _MAX_COORDINATE:
        raise ValueError(f"Scene mesh {ident} exceeds the ENU elevation limit after applying baseZ.")
    if obj.rfRole == "ground" and obj.mesh is None:
        raise ValueError(f"Ground object {ident} needs a triangle mesh.")
    if obj.kind == "mesh" and obj.mesh is None:
        raise ValueError(f"Mesh object {ident} needs a triangle mesh.")
    if obj.rfRole == "foliage" and obj.foliage is None:
        raise ValueError(f"Foliage object {ident} needs a canopy volume.")
    if obj.rfRole != "foliage" and obj.foliage is not None:
        raise ValueError(f"Scene object {ident} needs the foliage role to use a canopy volume.")
    if obj.levels is not None and not np.isfinite(obj.levels):
        raise ValueError(f"Scene object {ident} has a non-finite floor count.")
    if obj.foliage:
        c, r = obj.foliage.center, obj.foliage.radii
        if max(abs(c.x) + r.x, abs(c.y) + r.y, abs(c.z + obj.baseZ) + r.z) > _MAX_COORDINATE:
            raise ValueError(f"Foliage object {ident} exceeds the ENU coordinate limit.")
        if not obj.enuPoints:
            obj.enuPoints = [ENUVector(x=c.x - r.x, y=c.y - r.y, z=0), ENUVector(x=c.x + r.x, y=c.y + r.y, z=0)]
            obj.height = 2 * r.z
    return obj


def _visual_nodes(data: bytes) -> set[str]:
    if len(data) < 20 or len(data) > _MAX_GLTF:
        raise ValueError("The visual GLB must be between 20 bytes and 16 MiB.")
    magic, version, total, json_size, chunk_type = struct.unpack_from("<4sIIII", data)
    if magic != b"glTF" or version != 2 or total != len(data) or json_size > total - 20 or chunk_type != 0x4E4F534A:
        raise ValueError("The visual file must be a valid glTF 2.0 binary (GLB).")
    gltf = json.loads(data[20:20 + json_size])
    if not isinstance(gltf, dict):
        raise ValueError("The visual GLB has no valid scene.")
    for key in ("buffers", "images"):
        entries = gltf.get(key, [])
        if not isinstance(entries, list) or any(not isinstance(item, dict) for item in entries):
            raise ValueError("The visual GLB has invalid buffers or images.")
        for entry in entries:
            uri = entry.get("uri")
            if uri is not None and (not isinstance(uri, str) or not uri.startswith("data:")):
                raise ValueError("All GLB buffers and textures must be embedded.")
    accessors = gltf.get("accessors", [])
    if not isinstance(accessors, list):
        raise ValueError("The visual GLB has invalid accessors.")
    decoded_bytes = 0
    for accessor in accessors:
        if not isinstance(accessor, dict):
            raise ValueError("The visual GLB has invalid accessors.")
        count, kind, component = (accessor.get(key) for key in ("count", "type", "componentType"))
        if (type(count) is not int or not 1 <= count <= 4_000_000
                or not isinstance(kind, str) or kind not in _ACCESSOR_WIDTHS
                or type(component) is not int or component not in _COMPONENT_BYTES):
            raise ValueError("The visual GLB has invalid or oversized accessors.")
        size = count * _ACCESSOR_WIDTHS[kind] * _COMPONENT_BYTES[component]
        sparse = accessor.get("sparse")
        if sparse is not None and (not isinstance(sparse, dict) or type(sparse.get("count")) is not int
                                   or not 1 <= sparse["count"] <= count):
            raise ValueError("The visual GLB has invalid sparse accessors.")
        if accessor.get("bufferView") is None and size > 8 * 1024 * 1024:
            raise ValueError("The visual GLB has an oversized accessor without a buffer view.")
        decoded_bytes += size
        if decoded_bytes > _MAX_ACCESSOR_BYTES:
            raise ValueError("The visual GLB exceeds the decoded geometry budget.")
    try:
        scene = gltf["scenes"][gltf.get("scene", 0)]
        nodes = gltf["nodes"]
        root_indices = scene["nodes"]
        if any(type(index) is not int or not 0 <= index < len(nodes) for index in root_indices):
            raise ValueError("The visual GLB has invalid root indices.")
        roots = [nodes[index].get("name") for index in root_indices]
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise ValueError("The visual GLB has no valid scene.") from exc
    names = [name for name in roots if isinstance(name, str)]
    if len(names) != len(set(names)):
        raise ValueError("GLB root node names must be unique.")
    return set(names)


def read_scene_package(payload: bytes) -> dict:
    if len(payload) > MAX_UPLOAD:
        raise ValueError("Scene package exceeds 32 MiB.")
    try:
        with ZipFile(io.BytesIO(payload)) as archive:
            files = _package_members(archive)
            if "scene.json" not in files:
                raise ValueError("The ZIP must contain scene.json at its root.")
            manifest = SceneManifest.model_validate_json(archive.read(files["scene.json"]))
            objects: dict[str, BuildingFootprint] = {}
            vertices = triangles = mesh_bytes = 0
            for raw in manifest.objects:
                mesh_file = raw.get("meshFile")
                if isinstance(mesh_file, str) and mesh_file in files:
                    mesh_bytes += files[mesh_file].file_size
                    if mesh_bytes > MAX_UPLOAD * 2:
                        raise ValueError("Referenced scene mesh data exceeds 64 MiB.")
                obj = _object_data(archive, files, raw)
                if obj.id in objects:
                    raise ValueError("Scene object IDs must be unique.")
                if obj.mesh:
                    vertices += len(obj.mesh.vertices) // 3
                    triangles += len(obj.mesh.triangles) // 3
                    if vertices > MAX_VERTICES or triangles > MAX_TRIANGLES:
                        raise ValueError(f"Scene solver meshes are capped at {MAX_VERTICES} vertices and {MAX_TRIANGLES} triangles.")
                objects[obj.id] = obj
            if len({material.id for material in manifest.materials}) != len(manifest.materials):
                raise ValueError("Radio material profile IDs must be unique.")
            result = {
                "name": manifest.name, "anchor": manifest.anchor.model_dump(exclude_none=True),
                "objects": [obj.model_dump(exclude_none=True) for obj in objects.values()],
                "materials": [material.model_dump(exclude_none=True) for material in manifest.materials],
            }
            if manifest.visual:
                visual_file, ids = manifest.visual.file, manifest.visual.objectIds
                if visual_file not in files or PurePosixPath(visual_file).suffix.lower() != ".glb":
                    raise ValueError("The visual GLB file is missing from the package.")
                if files[visual_file].file_size > _MAX_GLTF:
                    raise ValueError("The visual GLB exceeds 16 MiB.")
                if len(ids) != len(set(ids)) or any(ident not in objects for ident in ids):
                    raise ValueError("Visual bindings contain a duplicate or unknown scene object.")
                data = archive.read(files[visual_file])
                roots = _visual_nodes(data)
                if any(ident not in roots for ident in ids):
                    raise ValueError("Each visual binding needs a GLB root node with the same ID.")
                bindings = []
                for ident in ids:
                    obj = objects[ident]
                    if not obj.enuPoints:
                        raise ValueError(f"Visual object {ident} needs a footprint anchor.")
                    first = obj.enuPoints[0]
                    bindings.append({"id": ident, "origin": {"x": first.x, "y": first.y, "z": obj.baseZ}})
                result["visual"] = {"glb": base64.b64encode(data).decode("ascii"), "bindings": bindings}
            return result
    except (BadZipFile, UnicodeDecodeError, NotImplementedError, RuntimeError) as exc:
        raise ValueError("Invalid or unsupported scene ZIP.") from exc
