"""Compile Studio objects to the shared ENU triangle mesh used by Sionna RT.

Buildings are closed prisms and a transmitted ray crosses each surface as a
separate radio slab. Walls use a single surface with the radio material's slab
thickness. Imported triangles keep their ENU positions. An explicit ground
mesh replaces the generated flat ground. Foliage attenuates paths through its
volume and display-only features are excluded from the solver.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import xml.etree.ElementTree as ET
from collections import OrderedDict
from dataclasses import dataclass
from functools import cached_property, lru_cache
from pathlib import Path

import numpy as np
import trimesh

from .models import BuildingFootprint, MaterialConfig, RfRole

SCENE_VERSION = "3.0.0"
GROUND_MARGIN_M = 300.0  # how far the ground plane extends past the buildings
_CACHE_MAX = 4
_TERRAIN_QUERY_PAIRS = 131_072

# Frontend material id -> Sionna ITU radio-material short name.
MATERIAL_MAP = {
    "itu_concrete": "concrete",
    "itu_brick": "brick",
    "itu_glass": "glass",
    "itu_metal": "metal",
    "itu_wood": "wood",
    "itu_asphalt_concrete": "asphalt_concrete",
    "itu_plasterboard": "plasterboard",
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
    "asphalt": "itu_asphalt_concrete",
    "asphalt_concrete": "itu_asphalt_concrete",
    "plasterboard": "itu_plasterboard",
    "drywall": "itu_plasterboard",
}


def resolved_rf_role(obj: BuildingFootprint) -> RfRole:
    return obj.rfRole or ("surface" if obj.category == "building" else "visual")


FoliageCrown = tuple[tuple[float, float, float], tuple[float, float, float], float]


def _foliage_crown(obj: BuildingFootprint) -> FoliageCrown | None:
    if obj.rfRole != "foliage" or obj.foliage is None:
        return None
    center, radii = obj.foliage.center, obj.foliage.radii
    return ((center.x, center.y, center.z + obj.baseZ), (radii.x, radii.y, radii.z),
            obj.foliage.attenuationDbPerM)


def foliage_crowns(buildings: list[BuildingFootprint]) -> tuple[FoliageCrown, ...]:
    """Return effective ENU foliage ellipsoids and their attenuation rates."""
    return tuple(crown for obj in buildings if (crown := _foliage_crown(obj)) is not None)


def _is_custom_material(config: MaterialConfig | None) -> bool:
    return (config is not None and config.relativePermittivity is not None
            and config.conductivity is not None)


def _material_bsdf_id(material: str) -> str:
    # Sionna interprets some prefixes and names specially, and Mitsuba uses
    # one namespace for all XML ids. Keep caller-defined names out of both.
    if material in MATERIAL_MAP:
        return material
    encoded = material.encode("utf-8", errors="surrogatepass")
    return "srts-radio-" + hashlib.sha256(encoded).hexdigest()


def material_target_ids(material: str) -> tuple[str, ...]:
    if material == GROUND_MATERIAL:
        return (material, GROUND_BSDF_ID)
    return (_material_bsdf_id(material),)


def _resolve_material(
    raw: str, freq_ghz: float, configs: dict[str, MaterialConfig], itu_properties: dict,
) -> tuple[str, list[str]]:
    if raw in MATERIAL_MAP:
        material = raw
    elif _is_custom_material(configs.get(raw)):
        return raw, []
    else:
        material = OSM_MATERIAL_ALIASES.get(raw.strip().lower())
    if material is None:
        return GROUND_MATERIAL, [f"Unknown radio material {raw!r}; using concrete."]
    if not any(low <= freq_ghz <= high for low, high in itu_properties[MATERIAL_MAP[material]]):
        return GROUND_MATERIAL, [f"{material} is undefined at {freq_ghz:g} GHz; using concrete."]
    return material, []


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


def building_roofs(buildings: list[BuildingFootprint]):
    """Yield repaired roof polygons and the elevations used for antenna mounting."""
    for building in buildings:
        if (building.category != "building" or building.kind != "building"
                or resolved_rf_role(building) != "surface"):
            continue
        polygon, _ = building_polygon(building)
        if polygon is not None:
            yield polygon, building.baseZ + max(building.height, 1.0)


def inspect_roofs(buildings: list[BuildingFootprint]) -> list[dict]:
    return [
        {"topZ": top, "rings": [
            [{"x": x, "y": y} for x, y in ring.coords[:-1]]
            for ring in (polygon.exterior, *polygon.interiors)
        ]}
        for polygon, top in building_roofs(buildings)
    ]


def _object_mesh(obj: BuildingFootprint) -> tuple[trimesh.Trimesh | None, list[str]]:
    if obj.kind == "mesh":
        if obj.mesh is None:
            return None, ["Mesh contains no triangles."]
        vertices = np.asarray(obj.mesh.vertices).reshape(-1, 3).copy()
        vertices[:, 2] += obj.baseZ
        faces = np.asarray(obj.mesh.triangles).reshape(-1, 3)
        return trimesh.Trimesh(vertices=vertices, faces=faces, process=False), []
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


def _mesh_at_solver_precision(mesh: trimesh.Trimesh) -> tuple[trimesh.Trimesh | None, list[str]]:
    # Apply world transforms before rounding to the coordinates written to PLY.
    # Compile, inspect and export the same surviving triangles.
    with np.errstate(over="ignore"):
        vertices = mesh.vertices.astype("<f4")
    if not np.isfinite(vertices).all():
        return None, ["Mesh coordinates exceed the solver's float32 range."]
    # Rounding can also introduce area into a previously collinear face.
    valid = mesh.nondegenerate_faces()
    mesh.vertices = vertices
    valid &= mesh.nondegenerate_faces()
    if not valid.any():
        return None, ["Mesh has no nondegenerate triangles at solver precision."]
    removed = len(valid) - int(valid.sum())
    if removed:
        mesh.update_faces(valid)
        mesh.remove_unreferenced_vertices()
        return mesh, [f"Removed {removed} degenerate triangle(s) at solver precision."]
    return mesh, []


def _physical_mesh(obj: BuildingFootprint) -> tuple[trimesh.Trimesh | None, list[str]]:
    if obj.rfRole == "ground" and obj.kind != "mesh":
        return None, ["Ground requires a triangle mesh."]
    mesh, issues = _object_mesh(obj)
    if mesh is not None:
        mesh, precision_issues = _mesh_at_solver_precision(mesh)
        issues.extend(precision_issues)
    return mesh, issues


def _ground_plane(meshes: list[trimesh.Trimesh]) -> trimesh.Trimesh:
    bounds = np.asarray([[[0, 0, 0], [0, 0, 0]], *(mesh.bounds for mesh in meshes)])
    minx, miny = bounds[:, 0, :2].min(axis=0) - GROUND_MARGIN_M
    maxx, maxy = bounds[:, 1, :2].max(axis=0) + GROUND_MARGIN_M
    return trimesh.Trimesh(
        vertices=[[minx, miny, 0], [maxx, miny, 0], [maxx, maxy, 0], [minx, maxy, 0]],
        faces=[[0, 1, 2], [0, 2, 3]], process=False,
    )


def _cross_xy(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]


class _TerrainIndex:
    def __init__(self, meshes: tuple[trimesh.Trimesh, ...]):
        from shapely import STRtree, polygons

        triangles = np.concatenate([mesh.triangles for mesh in meshes]) if meshes else np.empty((0, 3, 3))
        edges = triangles[:, 1:] - triangles[:, :1]
        cross = _cross_xy(edges[:, 0], edges[:, 1])
        # Vertical faces may exist in a terrain mesh but have no area on XY.
        valid = cross != 0
        self.origins = triangles[valid, 0]
        self.edges = edges[valid]
        self.cross = cross[valid]
        self.tree = STRtree(polygons(triangles[valid, :, :2]))

    def sample(self, xy: np.ndarray) -> np.ndarray:
        from shapely import points

        if not len(self.cross):
            return np.full(len(xy), np.nan)
        result = np.full(len(xy), -np.inf)
        # A ground mesh can have many triangles overlapping one XY position.
        # Bound the pair arrays returned by the spatial index for each query.
        block_size = max(1, _TERRAIN_QUERY_PAIRS // len(self.cross))
        for start in range(0, len(xy), block_size):
            block = xy[start:start + block_size]
            point_ids, face_ids = self.tree.query(points(block), predicate="intersects")
            if not len(point_ids):
                continue
            origins = self.origins[face_ids]
            b, c = self.edges[face_ids].transpose(1, 0, 2)
            det = self.cross[face_ids]
            delta = block[point_ids] - origins[:, :2]
            u = _cross_xy(delta, c) / det
            v = _cross_xy(b, delta) / det
            np.maximum.at(result, start + point_ids, origins[:, 2] + u * b[:, 2] + v * c[:, 2])
        result[result == -np.inf] = np.nan
        return result


_MESH_FIELDS = {"id", "height", "baseZ", "enuPoints", "category", "kind", "material", "mesh", "rfRole"}


@lru_cache(maxsize=_CACHE_MAX)
def _terrain_for_objects(objects_json: str) -> _TerrainIndex:
    meshes = []
    for raw in json.loads(objects_json):
        mesh, _ = _physical_mesh(BuildingFootprint.model_validate(raw))
        if mesh is not None:
            meshes.append(mesh)
    return _TerrainIndex(tuple(meshes))


def terrain_elevations(
    buildings: list[BuildingFootprint], xy: np.ndarray, *, compiled: CompiledScene | None = None,
) -> np.ndarray:
    """Sample the upper ground triangle at each XY position, or NaN outside terrain."""
    if compiled is None:
        ground = [obj.model_dump(include=_MESH_FIELDS) for obj in buildings if obj.rfRole == "ground"]
        index = _terrain_for_objects(json.dumps(ground))
    else:
        index = compiled.terrain_index
    return index.sample(np.asarray(xy, dtype=float))


@dataclass
class CompiledScene:
    geometry_id: str
    scene_id: str
    meshes: list[tuple[str, str, trimesh.Trimesh]]
    reports: dict[str, dict]
    ground_meshes: tuple[trimesh.Trimesh, ...]
    foliage_crowns: tuple[FoliageCrown, ...]

    @cached_property
    def terrain_index(self) -> _TerrainIndex:
        return _TerrainIndex(self.ground_meshes)

    def inspect(self, buildings: list[BuildingFootprint], *, include_meshes: bool = True) -> dict:
        result = {
            "sceneId": self.scene_id,
            "geometryId": self.geometry_id,
            "coordinateFrame": "ENU_m",
            "groundModel": "terrain" if self.ground_meshes else "flat",
            "objects": [
                {"id": obj.id, "name": obj.name, "source": obj.source,
                 "heightSource": obj.heightSource, "materialSource": obj.materialSource,
                 "rfRole": resolved_rf_role(obj), "floor": obj.floor, "geometrySource": obj.geometrySource,
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
    grounds = []
    crowns = []
    reports = {}
    material_configs = {cfg["id"]: MaterialConfig.model_validate(cfg) for cfg in json.loads(materials_json)}
    for raw in json.loads(objects_json):
        obj = BuildingFootprint.model_validate(raw)
        role = resolved_rf_role(obj)
        if role == "foliage":
            crown = _foliage_crown(obj)
            if crown is None:
                reports[obj.id] = {"status": "skipped", "issues": ["Foliage requires an attenuation volume."]}
            else:
                center, radii, attenuation = crown
                crowns.append(crown)
                reports[obj.id] = {
                    "status": "physical", "issues": [], "foliage": {
                        "center": dict(zip("xyz", center)), "radii": dict(zip("xyz", radii)),
                        "attenuationDbPerM": attenuation,
                    },
                }
            continue
        mesh, issues = _physical_mesh(obj)
        material, material_issues = _resolve_material(
            obj.material, freq_ghz, material_configs, ITU_MATERIALS_PROPERTIES,
        )
        issues.extend(material_issues)
        if mesh is not None:
            if role == "ground":
                grounds.append(mesh)
            meshes.append((obj.id, material, mesh))
        reports[obj.id] = {"status": "physical" if mesh is not None else "skipped",
                           "material": material if mesh is not None else None, "issues": issues}

    if not grounds:
        ground = _ground_plane([mesh for _, _, mesh in meshes])
        meshes.insert(0, ("", GROUND_BSDF_ID, ground))
    geometry = hashlib.sha256()
    physics = hashlib.sha256()
    ground_mesh_ids = {id(mesh) for mesh in grounds}
    for ident, material, mesh in meshes:
        vertices = mesh.vertices.astype("<f4")
        faces = mesh.faces.astype("<u4")
        if id(mesh) in ground_mesh_ids:
            geometry.update(b"ground\0")
        geometry.update(np.asarray([len(vertices), len(faces)], dtype="<u4").tobytes())
        geometry.update(vertices.tobytes())
        geometry.update(faces.tobytes())
        bsdf_id = _material_bsdf_id(material) if ident else GROUND_BSDF_ID
        physics.update(bsdf_id.encode() + b"\0")
    if crowns:
        geometry.update(b"foliage\0")
        for center, radii, attenuation in crowns:
            geometry.update(np.asarray((*center, *radii), dtype="<f8").tobytes())
            physics.update(np.asarray(attenuation, dtype="<f8").tobytes())
    geometry_id = geometry.hexdigest()
    physics.update(geometry_id.encode())
    applied = {material if ident else GROUND_MATERIAL for ident, material, _ in meshes}
    configs = {ident: cfg.model_dump() for ident, cfg in material_configs.items() if ident in applied}
    physics.update(json.dumps(configs, sort_keys=True).encode())
    return CompiledScene(geometry_id, physics.hexdigest(), meshes, reports, tuple(grounds), tuple(crowns))


def compile_scene(
    buildings: list[BuildingFootprint], freq_ghz: float, materials: list[MaterialConfig] | None = None,
) -> CompiledScene:
    return _compile(
        json.dumps([obj.model_dump(include=_MESH_FIELDS | {"foliage"}) for obj in buildings
                    if resolved_rf_role(obj) != "visual"]),
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

    Resolve the configured id to the BSDF id written in the scene XML.
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
        for target_id in material_target_ids(cfg.id):
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
    scene_dir: Path, meshes: list[tuple[str, str, str]], materials: set[str],
    material_configs: list[MaterialConfig] | None = None,
) -> Path:
    """meshes = list of (ply_filename, material_id, shape_id)."""
    root = ET.Element("scene", {"version": SCENE_VERSION})
    ET.SubElement(root, "integrator", {"type": "path"})
    emitter = ET.SubElement(root, "emitter", {"type": "constant"})
    ET.SubElement(emitter, "rgb", {"name": "radiance", "value": "0.7 0.7 0.7"})

    configs = {cfg.id: cfg for cfg in material_configs or []}
    for material in sorted(materials):
        material_id = _material_bsdf_id(material)
        if material in MATERIAL_MAP:
            bsdf = ET.SubElement(root, "bsdf", {"type": "itu-radio-material", "id": material_id})
            ET.SubElement(bsdf, "string", {"name": "type", "value": MATERIAL_MAP[material]})
        else:
            cfg = configs[material]
            bsdf = ET.SubElement(root, "bsdf", {"type": "radio-material", "id": material_id})
            for name, value in (("relative_permittivity", cfg.relativePermittivity),
                                ("conductivity", cfg.conductivity), ("thickness", cfg.thickness)):
                if value is not None:
                    ET.SubElement(bsdf, "float", {"name": name, "value": str(value)})

    if any(shape_id == "mesh-ground" for _, _, shape_id in meshes):
        ground_bsdf = ET.SubElement(root, "bsdf", {"type": "itu-radio-material", "id": GROUND_BSDF_ID})
        ET.SubElement(ground_bsdf, "string", {"name": "type", "value": MATERIAL_MAP[GROUND_MATERIAL]})
        ET.SubElement(ground_bsdf, "rgb",
                      {"name": "color", "value": " ".join(f"{c:.3f}" for c in GROUND_COLOR)})

    for ply_name, material_id, shape_id in meshes:
        shape = ET.SubElement(root, "shape", {"type": "ply", "id": shape_id})
        ET.SubElement(shape, "string", {"name": "filename", "value": ply_name})
        # Our PLY exporter writes vertex normals, which Mitsuba interpolates —
        # shading a faceted prism like a smooth blob. Sionna's own scenes all set
        # this. Ray tracing is unaffected (the solver uses geometric normals).
        ET.SubElement(shape, "boolean", {"name": "face_normals", "value": "true"})
        bsdf_id = GROUND_BSDF_ID if shape_id == "mesh-ground" else _material_bsdf_id(material_id)
        ET.SubElement(shape, "ref", {"id": bsdf_id})

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


def load_scene_file(xml_path: Path, freq_ghz: float,
                    material_configs: list[MaterialConfig] | None = None):
    """Load a compiled Mitsuba scene with Studio's Python-side settings."""
    from sionna.rt import PlanarArray, load_scene

    scene = load_scene(str(xml_path))
    scene.frequency = float(freq_ghz) * 1e9
    # Apply scattering / EM overrides after frequency is set (ITU values first).
    _apply_materials(scene, material_configs or [])
    # Safe defaults for callers that only build a scene. Solver entry points
    # replace these arrays with the requested configurations before tracing.
    iso = PlanarArray(num_rows=1, num_cols=1, vertical_spacing=0.5,
                      horizontal_spacing=0.5, pattern="iso", polarization="V")
    scene.tx_array = iso
    scene.rx_array = iso
    return scene


def _build(
    compiled: CompiledScene,
    freq_ghz: float,
    material_configs: list[MaterialConfig] | None = None,
) -> _BuiltScene:
    """Load the compiled geometry into Sionna RT, reusing a cached scene."""
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

    has_generated_ground = not compiled.ground_meshes
    for index, (ident, material, mesh) in enumerate(compiled.meshes):
        name = f"b{index - int(has_generated_ground)}" if ident else "ground"
        mesh.export(mesh_dir / f"{name}.ply", file_type="ply")
        if ident:
            materials.add(material)
        mesh_refs.append((f"meshes/{name}.ply", material, f"mesh-{name}"))

    xml_path = _write_scene_xml(scene_dir, mesh_refs, materials, material_configs)

    scene = load_scene_file(xml_path, freq_ghz, material_configs)

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
