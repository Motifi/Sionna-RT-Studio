"""Compile Studio objects to the shared ENU triangle mesh used by Sionna RT.

Buildings are closed prisms and a transmitted ray crosses each surface as a
separate radio slab. Walls use a single surface with the radio material's slab
thickness. Imported triangles keep their ENU positions. The solver ground is
derived from physical bounds. Display-only map objects never affect it.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import xml.etree.ElementTree as ET
from collections import OrderedDict
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import trimesh

from .models import BuildingFootprint, MaterialConfig

SCENE_VERSION = "3.0.0"
GROUND_MARGIN_M = 300.0  # how far the ground plane extends past the buildings
_CACHE_MAX = 4

# Frontend material id -> Sionna ITU radio-material short name.
MATERIAL_MAP = {
    "itu_concrete": "concrete",
    "itu_brick": "brick",
    "itu_glass": "glass",
    "itu_metal": "metal",
    "itu_wood": "wood",
    "itu_dry_ground": "medium_dry_ground",
    "itu_medium_dry_ground": "medium_dry_ground",
    "itu_wet_ground": "wet_ground",
}
# Concrete stays defined across 2.4–100 GHz; the ITU *ground* materials are only
# defined at low frequencies and break at mmWave (e.g. 28 GHz), so we use concrete
# for the ground plane.
GROUND_MATERIAL = "itu_concrete"
# The ground gets its own BSDF id purely so it is visually separable. Sionna's
# previewer colors geometry by radio material (`shape.bsdf().color`), so sharing
# one material with the concrete buildings merged ground and buildings into a
# single flat grey mass. The ITU type stays GROUND_MATERIAL's, and any
# GROUND_MATERIAL override is applied to it too, so the EM response is unchanged.
# Must not collide with a scene-object name: Sionna strips the "mesh-" prefix
# from shape ids, so the ground shape becomes the object "ground".
GROUND_BSDF_ID = "ground_plane"
GROUND_COLOR = (0.28, 0.30, 0.32)  # asphalt-ish, clearly darker than ITU concrete

# Raw OSM tags (e.g. building:material=brick) lack the `itu_` prefix. Map the
# common values onto our ITU ids so they aren't silently lost to concrete. The
# frontend normalizes too; this is a backend safety net for direct API callers.
OSM_MATERIAL_ALIASES = {
    "concrete": "itu_concrete",
    "cement": "itu_concrete",
    "stone": "itu_concrete",
    "brick": "itu_brick",
    "brickwork": "itu_brick",
    "glass": "itu_glass",
    "metal": "itu_metal",
    "steel": "itu_metal",
    "wood": "itu_wood",
    "timber": "itu_wood",
}


def _itu_value(material: str) -> str:
    return MATERIAL_MAP.get(material, "concrete")


def _resolve_material(raw: str | None) -> str:
    """Resolve a building material id to a known ITU id.

    Accepts our `itu_*` ids directly, maps common raw OSM tags via
    OSM_MATERIAL_ALIASES, and falls back to concrete for anything unknown.
    """
    if not raw:
        return "itu_concrete"
    if raw in MATERIAL_MAP:
        return raw
    return OSM_MATERIAL_ALIASES.get(raw.strip().lower(), "itu_concrete")


def building_polygon(footprint: BuildingFootprint):
    """Resolve the exact footprint used for extrusion and legacy roof mounting."""
    from shapely.geometry import Polygon
    from shapely.validation import make_valid

    if len(footprint.enuPoints) < 3 or footprint.height <= 0:
        return None, ["Building needs three vertices and a positive height."]
    polygon = Polygon([(p.x, p.y) for p in footprint.enuPoints])
    issues = []
    if not polygon.is_valid:
        polygon = make_valid(polygon)
        issues.append("Invalid polygon repaired.")
    if polygon.geom_type in ("MultiPolygon", "GeometryCollection"):
        parts = [part for part in polygon.geoms if part.geom_type == "Polygon"]
        if parts:
            polygon = max(parts, key=lambda part: part.area)
            issues.append("Only the largest polygon was retained.")
    if polygon.geom_type != "Polygon" or polygon.is_empty or polygon.area < 0.5:
        return None, [*issues, "No polygon with at least 0.5 m² remains."]
    if footprint.height < 1:
        issues.append("Building extrusion raised to the 1 m minimum.")
    return polygon, issues


def _object_mesh(obj: BuildingFootprint) -> tuple[trimesh.Trimesh | None, list[str]]:
    if obj.kind == "mesh":
        if obj.mesh is None:
            return None, ["Mesh contains no triangles."]
        vertices = np.asarray(obj.mesh.vertices).reshape(-1, 3).copy()
        vertices[:, 2] += obj.baseZ
        faces = np.asarray(obj.mesh.triangles).reshape(-1, 3)
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
        valid = mesh.nondegenerate_faces()
        if not valid.any():
            return None, ["Mesh contains no nondegenerate triangles."]
        if not valid.all():
            mesh.update_faces(valid)
            mesh.remove_unreferenced_vertices()
            return mesh, [f"Removed {len(valid) - int(valid.sum())} degenerate triangles."]
        return mesh, []
    if obj.kind == "wall":
        if len(obj.enuPoints) != 2 or obj.height <= 0:
            return None, ["Wall needs two endpoints and a positive height."]
        a, b = obj.enuPoints
        if np.hypot(a.x - b.x, a.y - b.y) < 0.01:
            return None, ["Wall endpoints are less than 1 cm apart."]
        bottom, top = obj.baseZ, obj.baseZ + obj.height
        return trimesh.Trimesh(
            vertices=[[a.x, a.y, bottom], [b.x, b.y, bottom], [b.x, b.y, top], [a.x, a.y, top]],
            faces=[[0, 1, 2], [0, 2, 3]], process=False,
        ), []
    polygon, issues = building_polygon(obj)
    if polygon is None:
        return None, issues
    try:
        mesh = trimesh.creation.extrude_polygon(polygon, max(obj.height, 1.0))
        mesh.apply_translation([0, 0, obj.baseZ])
        return mesh, issues
    except Exception as exc:
        return None, [*issues, f"Polygon triangulation failed: {exc}"]


def _ground_plane(meshes: list[trimesh.Trimesh]) -> trimesh.Trimesh:
    bounds = np.asarray([[[0, 0, 0], [0, 0, 0]], *(mesh.bounds for mesh in meshes)])
    minx, miny = bounds[:, 0, :2].min(axis=0) - GROUND_MARGIN_M
    maxx, maxy = bounds[:, 1, :2].max(axis=0) + GROUND_MARGIN_M
    return trimesh.Trimesh(
        vertices=[[minx, miny, 0], [maxx, miny, 0], [maxx, maxy, 0], [minx, maxy, 0]],
        faces=[[0, 1, 2], [0, 2, 3]], process=False,
    )


@dataclass
class CompiledScene:
    geometry_id: str
    scene_id: str
    meshes: list[tuple[str, str, trimesh.Trimesh]]
    reports: dict[str, dict]

    def inspect(self, buildings: list[BuildingFootprint], *, include_meshes: bool = True) -> dict:
        result = {
            "sceneId": self.scene_id,
            "geometryId": self.geometry_id,
            "coordinateFrame": "ENU_m",
            "objects": [
                {"id": obj.id, "name": obj.name, "source": obj.source,
                 "heightSource": obj.heightSource, "materialSource": obj.materialSource,
                 "rawTags": obj.rawTags, **self.reports.get(obj.id, {"status": "visual", "issues": []}),
                 "issues": [*obj.importIssues, *self.reports.get(obj.id, {}).get("issues", [])]}
                for obj in buildings
            ],
        }
        if include_meshes:
            result["meshes"] = [
                {"id": ident, "material": material,
                 # PLY stores float32 vertices. The preview uses those same values.
                 "vertices": mesh.vertices.astype("<f4").reshape(-1).tolist(),
                 "triangles": mesh.faces.reshape(-1).tolist()}
                for ident, material, mesh in self.meshes
            ]
        return result


@lru_cache(maxsize=_CACHE_MAX)
def _compile(objects_json: str, freq_ghz: float, materials_json: str) -> CompiledScene:
    from sionna.rt.radio_materials.itu import ITU_MATERIALS_PROPERTIES

    meshes = []
    reports = {}
    for raw in json.loads(objects_json):
        obj = BuildingFootprint.model_validate(raw)
        mesh, issues = _object_mesh(obj)
        material = _resolve_material(obj.material)
        if obj.material not in MATERIAL_MAP and obj.material.strip().lower() not in OSM_MATERIAL_ALIASES:
            issues.append(f"Unknown radio material {obj.material!r}; using concrete.")
        if not any(low <= freq_ghz <= high for low, high in ITU_MATERIALS_PROPERTIES[_itu_value(material)]):
            issues.append(f"{material} is undefined at {freq_ghz:g} GHz; using concrete.")
            material = GROUND_MATERIAL
        if mesh is not None:
            meshes.append((obj.id, material, mesh))
        reports[obj.id] = {"status": "physical" if mesh is not None else "skipped",
                           "material": material if mesh is not None else None, "issues": issues}

    ground = _ground_plane([mesh for _, _, mesh in meshes])
    meshes.insert(0, ("", GROUND_BSDF_ID, ground))
    geometry = hashlib.sha256()
    physics = hashlib.sha256()
    for _, material, mesh in meshes:
        vertices = mesh.vertices.astype("<f4")
        faces = mesh.faces.astype("<u4")
        geometry.update(np.asarray([len(vertices), len(faces)], dtype="<u4").tobytes())
        geometry.update(vertices.tobytes())
        geometry.update(faces.tobytes())
        physics.update(material.encode() + b"\0")
    geometry_id = geometry.hexdigest()
    physics.update(geometry_id.encode())
    applied = {material for _, material, _ in meshes} | {GROUND_MATERIAL}
    configs = {cfg["id"]: cfg for cfg in json.loads(materials_json) if cfg["id"] in applied}
    physics.update(json.dumps(configs, sort_keys=True).encode())
    return CompiledScene(geometry_id, physics.hexdigest(), meshes, reports)


def compile_scene(
    buildings: list[BuildingFootprint], freq_ghz: float, materials: list[MaterialConfig] | None = None,
) -> CompiledScene:
    fields = {"id", "height", "baseZ", "enuPoints", "category", "kind", "material", "mesh"}
    return _compile(
        json.dumps([obj.model_dump(include=fields) for obj in buildings if obj.category == "building"]),
        freq_ghz, json.dumps([cfg.model_dump() for cfg in materials or []]),
    )


def inspect_scene(buildings, freq_ghz, materials, *, include_meshes=True) -> dict:
    return compile_scene(buildings, freq_ghz, materials).inspect(buildings, include_meshes=include_meshes)


def _scattering_pattern(name: str):
    """Map a scattering-pattern name to a Sionna pattern instance (or None)."""
    from sionna.rt import (
        BackscatteringPattern,
        DirectivePattern,
        LambertianPattern,
    )

    if name == "lambertian":
        return LambertianPattern()
    if name == "directive":
        return DirectivePattern(alpha_r=4)
    if name == "backscattering":
        return BackscatteringPattern(alpha_r=4, alpha_i=4)
    return None


def _apply_materials(scene, materials: list[MaterialConfig]) -> None:
    """Apply per-material scattering + EM overrides onto a freshly loaded scene.

    The scene's radio materials are keyed by the frontend material id (the BSDF
    id written into the XML, e.g. ``itu_concrete``), so the config id maps 1:1.
    Applied after ``scene.frequency`` is set so ITU values are computed first and
    any explicit permittivity/conductivity override takes effect last.

    The ground plane carries its own BSDF id for visual separation only, so a
    GROUND_MATERIAL override is applied to it as well — otherwise splitting the
    material would silently change the ground's electromagnetic response.
    """
    import sys

    if not materials:
        return
    rms = scene.radio_materials
    for cfg in {config.id: config for config in materials}.values():
        target_ids = [cfg.id]
        if cfg.id == GROUND_MATERIAL:
            target_ids.append(GROUND_BSDF_ID)
        for target_id in target_ids:
            rm = rms.get(target_id) if isinstance(rms, dict) else None
            if rm is None:
                continue
            try:
                rm.scattering_coefficient = float(cfg.scatteringCoefficient)
                rm.xpd_coefficient = float(cfg.xpdCoefficient)
                pattern = _scattering_pattern(cfg.scatteringPattern)
                if pattern is not None:
                    rm.scattering_pattern = pattern
                if cfg.relativePermittivity is not None:
                    rm.relative_permittivity = float(cfg.relativePermittivity)
                if cfg.conductivity is not None:
                    rm.conductivity = float(cfg.conductivity)
                if cfg.thickness is not None:
                    rm.thickness = float(cfg.thickness)
            except Exception as exc:
                print(f"[scene_build] WARNING: failed to apply material "
                      f"{target_id!r}: {exc}", file=sys.stderr)


def _write_scene_xml(
    scene_dir: Path, meshes: list[tuple[str, str, str]], materials: set[str]
) -> Path:
    """meshes = list of (ply_filename, material_id, shape_id)."""
    root = ET.Element("scene", {"version": SCENE_VERSION})
    ET.SubElement(root, "integrator", {"type": "path"})
    emitter = ET.SubElement(root, "emitter", {"type": "constant"})
    ET.SubElement(emitter, "rgb", {"name": "radiance", "value": "0.7 0.7 0.7"})

    for material_id in sorted(materials):
        bsdf = ET.SubElement(root, "bsdf", {"type": "itu-radio-material", "id": material_id})
        ET.SubElement(bsdf, "string", {"name": "type", "value": _itu_value(material_id)})

    ground_bsdf = ET.SubElement(
        root, "bsdf", {"type": "itu-radio-material", "id": GROUND_BSDF_ID}
    )
    ET.SubElement(ground_bsdf, "string",
                  {"name": "type", "value": _itu_value(GROUND_MATERIAL)})
    ET.SubElement(ground_bsdf, "rgb",
                  {"name": "color",
                   "value": " ".join(f"{c:.3f}" for c in GROUND_COLOR)})

    for ply_name, material_id, shape_id in meshes:
        shape = ET.SubElement(root, "shape", {"type": "ply", "id": shape_id})
        ET.SubElement(shape, "string", {"name": "filename", "value": ply_name})
        # Our PLY exporter writes vertex normals, which Mitsuba interpolates —
        # shading a faceted prism like a smooth blob. Sionna's own scenes all set
        # this. Ray tracing is unaffected (the solver uses geometric normals).
        ET.SubElement(shape, "boolean", {"name": "face_normals", "value": "true"})
        ET.SubElement(shape, "ref", {"id": material_id})

    xml_path = scene_dir / "scene.xml"
    ET.ElementTree(root).write(xml_path, encoding="utf-8", xml_declaration=True)
    return xml_path


class _BuiltScene:
    def __init__(self, scene, tmpdir: tempfile.TemporaryDirectory):
        self.scene = scene
        self._tmpdir = tmpdir  # keep alive so the mesh files survive

    @property
    def scene_dir(self) -> Path:
        """Directory holding ``scene.xml`` and ``meshes/*.ply``."""
        return Path(self._tmpdir.name)


_scene_cache: "OrderedDict[tuple[str, float], _BuiltScene]" = OrderedDict()


def _build(
    compiled: CompiledScene,
    freq_ghz: float,
    material_configs: list[MaterialConfig] | None = None,
) -> _BuiltScene:
    """Load the compiled geometry into Sionna RT, reusing a cached scene."""
    from sionna.rt import PlanarArray, load_scene

    key = (compiled.scene_id, freq_ghz)
    cached = _scene_cache.get(key)
    if cached is not None:
        _scene_cache.move_to_end(key)
        return cached

    tmpdir = tempfile.TemporaryDirectory(prefix="srts_scene_")
    scene_dir = Path(tmpdir.name)
    mesh_dir = scene_dir / "meshes"
    mesh_dir.mkdir()

    mesh_refs: list[tuple[str, str, str]] = []
    materials: set[str] = set()

    for index, (_, material, mesh) in enumerate(compiled.meshes):
        name = "ground" if index == 0 else f"b{index - 1}"
        mesh.export(mesh_dir / f"{name}.ply", file_type="ply")
        if index:
            materials.add(material)
        mesh_refs.append((f"meshes/{name}.ply", material, f"mesh-{name}"))

    xml_path = _write_scene_xml(scene_dir, mesh_refs, materials)

    scene = load_scene(str(xml_path))
    scene.frequency = float(freq_ghz) * 1e9
    # Apply scattering / EM overrides after frequency is set (ITU values first).
    _apply_materials(scene, material_configs or [])
    # Safe defaults for callers that only build a scene. PathSolver entry points
    # replace both arrays from each request before tracing; RadioMapSolver
    # replaces the Tx array and uses its own ideal map-receiver model.
    iso = PlanarArray(num_rows=1, num_cols=1, vertical_spacing=0.5,
                      horizontal_spacing=0.5, pattern="iso", polarization="V")
    scene.tx_array = iso
    scene.rx_array = iso

    built = _BuiltScene(scene, tmpdir)
    _scene_cache[key] = built
    while len(_scene_cache) > _CACHE_MAX:
        _scene_cache.popitem(last=False)
    return built


def build_scene(
    buildings: list[BuildingFootprint],
    freq_ghz: float,
    material_configs: list[MaterialConfig] | None = None,
):
    """Return a Sionna RT Scene built from the building footprints (cached)."""
    compiled = compile_scene(buildings, freq_ghz, material_configs)
    return build_compiled_scene(compiled, freq_ghz, material_configs)


def build_compiled_scene(
    compiled: CompiledScene,
    freq_ghz: float,
    material_configs: list[MaterialConfig] | None = None,
):
    """Load a compiled scene using the same frequency and material settings."""
    return _build(compiled, freq_ghz, material_configs).scene


def build_scene_dir(
    buildings: list[BuildingFootprint],
    freq_ghz: float,
    material_configs: list[MaterialConfig] | None = None,
) -> Path:
    """Return the Mitsuba scene directory (``scene.xml`` + ``meshes/*.ply``).

    The directory is a self-contained, relocatable Mitsuba scene: every shape in
    the XML references its mesh by a relative path, so copying the tree gives a
    folder that ``sionna.rt.load_scene`` opens anywhere.

    Lifetime: the directory is owned by the scene cache and is deleted once the
    entry is evicted (``_CACHE_MAX``). Callers must copy what they need right
    away — the export endpoint does so while holding the solver lock, which is
    also what keeps a concurrent build from evicting the entry mid-copy.
    """
    compiled = compile_scene(buildings, freq_ghz, material_configs)
    return _build(compiled, freq_ghz, material_configs).scene_dir
