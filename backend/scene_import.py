"""Import a bounded, offline mesh copy. Mitsuba XML is parsed as data."""
from io import BytesIO
import json
from pathlib import PurePosixPath
import re
from uuid import uuid4
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile

import numpy as np
import trimesh

from .models import BuildingFootprint, ENUVector, TriangleMesh
from .scene_build import GROUND_BSDF_ID, GROUND_MATERIAL, MATERIAL_MAP

MAX_UPLOAD = 32 * 1024 * 1024
MAX_VERTICES = 100_000
MAX_TRIANGLES = 150_000
MAX_SHAPES = 256
STUDIO_GROUND_PATH = PurePosixPath("meshes/ground.ply")

# Match Trimesh's header terminator token and the UTF-8 line breaks used by str.splitlines().
_PLY_END_HEADER = re.compile(r"(?<!\S)end_header(?!\S)")
_PLY_LINE_BREAKS = tuple(separator.encode("utf-8") for separator in "\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029")

# Prefer canonical UI ids where more than one id refers to the same preset.
ITU_IDS = {value: key for key, value in MATERIAL_MAP.items()}


def _check_ply_limits(data: bytes) -> None:
    row_limit = MAX_VERTICES + MAX_TRIANGLES
    declared_rows = 0
    with BytesIO(data) as stream:
        if b"ply" not in stream.readline().lower():
            raise ValueError("Expected a PLY header.")
        is_ascii = "ascii" in stream.readline().decode("utf-8").lower()
        for raw in stream:
            line = raw.decode("utf-8")
            if _PLY_END_HEADER.search(line):
                break
            fields = line.split(maxsplit=3)
            if not fields:
                raise ValueError("Empty line in PLY header.")
            # Trimesh treats a first token containing "element" as a declaration.
            if "element" not in fields[0]:
                continue
            if len(fields) != 3:
                raise ValueError("Expected an element name and row count in the PLY header.")
            _, element, length = fields
            count = int(length)
            if count < 0:
                raise ValueError("PLY element counts must be nonnegative.")
            if (
                (element == "vertex" and count > MAX_VERTICES)
                or (element == "face" and count > MAX_TRIANGLES)
            ):
                raise ValueError(f"Import is capped at {MAX_VERTICES} vertices and {MAX_TRIANGLES} triangles.")
            declared_rows += count
            if is_ascii and declared_rows > row_limit:
                raise ValueError(f"ASCII PLY is capped at {row_limit} data rows.")
        else:
            raise ValueError("PLY header is missing end_header.")
        start = stream.tell()

    if not is_ascii:
        return
    # Trimesh allocates one array per physical row, including trailing blank rows.
    # Count directly in the bytes and treat CRLF as a single break.
    rows = sum(data.count(separator, start) for separator in _PLY_LINE_BREAKS)
    rows -= data.count(b"\r\n", start)
    if start < len(data) and not data.endswith(_PLY_LINE_BREAKS, start):
        rows += 1
    if rows > row_limit:
        raise ValueError(f"ASCII PLY is capped at {row_limit} data rows.")
    if rows < declared_rows:
        raise ValueError("ASCII PLY has fewer data rows than declared.")


def _load_mesh(data: bytes, suffix: str) -> trimesh.Trimesh:
    try:
        if suffix == "ply":
            _check_ply_limits(data)
        mesh = trimesh.load(BytesIO(data), file_type=suffix, force="mesh", process=False, skip_materials=True)
    except Exception as exc:
        raise ValueError(f"Invalid {suffix.upper()} mesh: {exc}") from exc
    if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces):
        raise ValueError("Mesh must contain triangles.")
    return mesh


def _numbers(node: ET.Element) -> list[float]:
    return [float(value) for value in node.get("value", "").replace(",", " ").split()]


def _vector(node: ET.Element, default: float) -> list[float]:
    values = _numbers(node)
    if values:
        if len(values) == 1:
            return values * 3
        if len(values) == 3:
            return values
        raise ValueError("Expected one or three transform components.")
    return [float(node.get(axis, default)) for axis in "xyz"]


def _transform(shape: ET.Element) -> np.ndarray:
    result = np.eye(4)
    for item in shape.findall("./transform[@name='to_world']/*"):
        if item.tag == "matrix":
            matrix = np.asarray(_numbers(item)).reshape(4, 4)
        elif item.tag == "translate":
            matrix = trimesh.transformations.translation_matrix(_vector(item, 0))
        elif item.tag == "scale":
            matrix = np.diag([*_vector(item, 1), 1])
        elif item.tag == "rotate":
            matrix = trimesh.transformations.rotation_matrix(
                np.deg2rad(float(item.attrib["angle"])), _vector(item, 0),
            )
        else:
            raise ValueError(f"Unsupported Mitsuba transform {item.tag!r}.")
        if not np.isfinite(matrix).all() or not np.array_equal(matrix[3], [0, 0, 0, 1]):
            raise ValueError("Mesh transform must be finite and affine.")
        result = matrix @ result
    return result


def _has_studio_ground(archive: ZipFile, xml: PurePosixPath, names: set[str]) -> bool:
    path = str(xml.parent / "manifest.json")
    if path not in names or archive.getinfo(path).file_size > 2 * 1024 * 1024:
        return False
    try:
        manifest = json.loads(archive.read(path))
    except (ValueError, RecursionError):
        return False
    return (
        isinstance(manifest, dict)
        and manifest.get("format") == "SionnaRTStudio standalone Sionna RT scene"
        and isinstance(manifest.get("meshFiles"), list)
        and str(STUDIO_GROUND_PATH) in manifest["meshFiles"]
    )


def _package_meshes(data: bytes):
    try:
        with ZipFile(BytesIO(data)) as archive:
            members = archive.infolist()
            if sum(member.file_size for member in members) > MAX_UPLOAD * 2 or len(members) > 4096:
                raise ValueError("Expanded scene package is too large.")
            names = {member.filename for member in members}
            if len(names) != len(members):
                raise ValueError("Scene package contains duplicate filenames.")
            xml_files = [name for name in names if name.lower().endswith(".xml") and not name.startswith("__MACOSX/")]
            if len(xml_files) != 1:
                raise ValueError("Scene package needs exactly one Mitsuba XML scene.")
            xml = PurePosixPath(xml_files[0])
            source = archive.read(str(xml))
            if len(source) > 2 * 1024 * 1024:
                raise ValueError("Scene XML exceeds 2 MiB.")
            text = source.decode("utf-8-sig")
            if "<!DOCTYPE" in text or "<!ENTITY" in text:
                raise ValueError("Scene XML cannot contain DTDs or entities.")
            root = ET.fromstring(text)
            if root.tag != "scene" or root.findall(".//include") or root.findall(".//instance"):
                raise ValueError("Expected a self-contained Mitsuba scene with explicit mesh shapes.")
            materials = {bsdf.get("id"): bsdf for bsdf in root.findall("bsdf")}
            shapes = root.findall("shape")
            if len(shapes) > MAX_SHAPES:
                raise ValueError(f"Scene package exceeds {MAX_SHAPES} shapes.")
            has_studio_ground = _has_studio_ground(archive, xml, names)
            skipped = []
            for shape in shapes:
                suffix = shape.get("type")
                ident = shape.get("id") or "Imported mesh"
                if suffix not in ("ply", "obj"):
                    skipped.append(f"Skipped shape {ident!r} of type {suffix!r}.")
                    continue
                file_node = shape.find("./string[@name='filename']")
                path = PurePosixPath(file_node.get("value", "") if file_node is not None else "")
                if path.is_absolute() or ".." in path.parts or "\\" in str(path) or str(xml.parent / path) not in names:
                    raise ValueError(f"Missing or unsafe mesh reference {str(path)!r}.")
                mesh = _load_mesh(archive.read(str(xml.parent / path)), suffix)
                mesh.apply_transform(_transform(shape))
                reference = shape.find("ref")
                bsdf = materials.get(reference.get("id")) if reference is not None else shape.find("bsdf")
                itu_name = None
                if bsdf is not None and bsdf.get("type") == "itu-radio-material":
                    type_node = bsdf.find("./string[@name='type']")
                    itu_name = type_node.get("value") if type_node is not None else None
                material = ITU_IDS.get(itu_name)
                generated_ground = (
                    has_studio_ground and suffix == "ply" and shape.get("id") == "mesh-ground"
                    and path == STUDIO_GROUND_PATH
                    and reference is not None and reference.get("id") == GROUND_BSDF_ID
                    and material == GROUND_MATERIAL and shape.find("transform") is None
                    and len(mesh.vertices) == 4 and len(mesh.faces) == 2
                    and np.isfinite(mesh.vertices).all() and np.all(mesh.vertices[:, 2] == 0)
                )
                issues = [] if material else [f"No supported ITU material mapping for {ident!r}; using the selected preset."]
                if material and len(bsdf) > 1:
                    issues.append("Imported the ITU preset; XML material overrides need review.")
                yield mesh, ident if shape.get("id") else path.stem, material, issues, generated_ground
            if skipped:
                yield None, "", None, skipped, False
    except (BadZipFile, ET.ParseError, KeyError, NotImplementedError, RuntimeError) as exc:
        raise ValueError(f"Invalid Mitsuba scene package: {exc}") from exc


def import_meshes(data: bytes, filename: str, axes: str, scale: float, fallback: str) -> dict:
    path = PurePosixPath(filename)
    suffix = path.suffix.lower().lstrip(".")
    if suffix not in ("ply", "obj", "zip"):
        raise ValueError("Choose PLY, OBJ or a Mitsuba ZIP.")
    if fallback not in MATERIAL_MAP:
        raise ValueError("Choose a supported radio material.")
    entries = _package_meshes(data) if suffix == "zip" else [(_load_mesh(data, suffix), path.stem, fallback, [], False)]
    objects = []
    issues = []
    regenerate_ground = False
    vertices = triangles = 0
    for mesh, name, material, notes, generated_ground in entries:
        if generated_ground:
            regenerate_ground = True
            continue
        if mesh is None:
            issues.extend(notes)
            continue
        vertices += len(mesh.vertices)
        triangles += len(mesh.faces)
        if vertices > MAX_VERTICES or triangles > MAX_TRIANGLES:
            raise ValueError(f"Import is capped at {MAX_VERTICES} vertices and {MAX_TRIANGLES} triangles.")
        points = np.asarray(mesh.vertices) * scale
        if axes == "y-up":
            points = points[:, [0, 2, 1]]
            points[:, 1] *= -1
        if not np.isfinite(points).all() or np.max(np.abs(points)) > 1_000_000:
            raise ValueError("Mesh coordinates must be finite and within ±1,000,000 ENU meters.")
        low, high = points.min(axis=0), points.max(axis=0)
        objects.append(BuildingFootprint(
            id=str(uuid4()), name=name, category="building", kind="mesh", source="import",
            height=float(high[2] - low[2]), material=material or fallback or GROUND_MATERIAL,
            materialSource="tag" if suffix == "zip" and material else "manual",
            enuPoints=[ENUVector(x=low[0], y=low[1], z=0), ENUVector(x=high[0], y=high[1], z=0)],
            points=[], importIssues=notes,
            rawTags={"file": path.name, "axes": axes, "metersPerUnit": str(scale),
                     "boundsMinENU": str(low.tolist()), "boundsMaxENU": str(high.tolist())},
            mesh=TriangleMesh(vertices=points.reshape(-1).tolist(), triangles=mesh.faces.reshape(-1).tolist()),
        ))
    if not objects and not regenerate_ground:
        raise ValueError("Package has no supported PLY or OBJ shapes.")
    if regenerate_ground:
        issues.append("Studio will generate the ground plane for the resulting scene.")
    return {"objects": [obj.model_dump(exclude_none=True) for obj in objects], "issues": issues, "vertexCount": vertices, "triangleCount": triangles}
