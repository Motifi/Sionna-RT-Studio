"""Deterministic rectangular office and apartment layouts in local ENU meters."""
from __future__ import annotations

from dataclasses import dataclass, field
from math import ceil, cos, radians, sin
from typing import Literal

from pydantic import BaseModel

from .models import BuildingFootprint, BuildingSpec, ENUVector, RfRole, TriangleMesh

Point = tuple[float, float, float]
Axis = Literal["x", "y"]
Rectangle = tuple[float, float, float, float]

_SLAB = 0.18
_PARAPET = 0.28


class GeneratedBuilding(BaseModel):
    spec: BuildingSpec
    objects: list[BuildingFootprint]


@dataclass
class Mesh:
    vertices: list[Point] = field(default_factory=list)
    indices: list[int] = field(default_factory=list)
    _vertex_ids: dict[Point, int] = field(default_factory=dict)

    def quad(self, a: Point, b: Point, c: Point, d: Point) -> None:
        corners = []
        for point in (a, b, c, d):
            index = self._vertex_ids.get(point)
            if index is None:
                index = len(self.vertices)
                self._vertex_ids[point] = index
                self.vertices.append(point)
            corners.append(index)
        i, j, k, m = corners
        self.indices.extend((i, j, k, i, k, m))

    def flat(self, bounds: Rectangle, z: float) -> None:
        x0, x1, y0, y1 = bounds
        self.quad((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z))

    def wall(self, axis: Axis, fixed: float, start: float, stop: float, low: float, high: float) -> None:
        if stop - start < 1e-8 or high - low < 1e-8:
            return
        if axis == "x":
            self.quad((fixed, start, low), (fixed, stop, low), (fixed, stop, high), (fixed, start, high))
        else:
            self.quad((start, fixed, low), (start, fixed, high), (stop, fixed, high), (stop, fixed, low))

    def surrounding(self, axis: Axis, fixed: float, start: float, stop: float, low: float, high: float,
                    opening: Rectangle) -> None:
        a, b, sill, head = opening
        outer = ((start, low), (stop, low), (stop, high), (start, high))
        inner = ((a, sill), (b, sill), (b, head), (a, head))
        for edge in range(4):
            following = (edge + 1) % 4
            if (edge == 0 and sill == low) or (edge == 2 and head == high):
                continue
            coordinates = (outer[edge], outer[following], inner[following], inner[edge])
            points = [(fixed, u, z) if axis == "x" else (u, fixed, z) for u, z in coordinates]
            self.quad(*(points if axis == "x" else points[::-1]))

    def edges(self, bounds: Rectangle, low: float, high: float) -> None:
        x0, x1, y0, y1 = bounds
        for x in (x0, x1):
            self.wall("x", x, y0, y1, low, high)
        for y in (y0, y1):
            self.wall("y", y, x0, x1, low, high)


def _bands(start: float, stop: float, pitch: float) -> list[tuple[float, float]]:
    count = max(1, round((stop - start) / pitch))
    cuts = [start + (stop - start) * index / count for index in range(count + 1)]
    return list(zip(cuts, cuts[1:]))


def _slab(bounds: Rectangle, low: float, high: float, hole: Rectangle | None = None) -> Mesh:
    # Keep one radio surface across the slab depth. Its material supplies the
    # transmission thickness. The fascia seals the visual edge at each floor.
    mesh = Mesh()
    if hole is None:
        mesh.flat(bounds, high)
    else:
        x0, x1, y0, y1 = bounds
        a, b, c, d = hole
        for strip in ((x0, a, y0, y1), (b, x1, y0, y1), (a, b, y0, c), (a, b, d, y1)):
            mesh.flat(strip, high)
        mesh.edges(hole, low, high)
    mesh.edges(bounds, low, high)
    return mesh


def _window(opaque: Mesh, glazing: Mesh, trim: Mesh, axis: Axis, fixed: float,
            direction: int, start: float, stop: float, low: float, high: float, office: bool) -> None:
    width = (stop - start) * (0.72 if office else 0.55)
    center = (start + stop) / 2
    a, b = center - width / 2, center + width / 2
    sill = low + min(0.88 if office else 0.99, (high - low) * 0.36)
    head = high - (0.28 if office else 0.40)
    opaque.surrounding(axis, fixed, start, stop, low, high, (a, b, sill, head))
    glazing.wall(axis, fixed, a, b, sill, head)

    # Shift the narrow frame bands out from the glass to avoid coplanar draw.
    face = fixed + direction * 0.025
    trim.surrounding(axis, face, a - 0.035, b + 0.035, sill - 0.055, head + 0.04,
                     (a + 0.035, b - 0.035, sill + 0.045, head - 0.045))
    if office:
        trim.wall(axis, face, center - 0.035, center + 0.035, sill + 0.045, head - 0.045)


def _facade(bounds: Rectangle, bays: list[tuple[float, float]], low: float, high: float,
            office: bool, first_floor: bool) -> tuple[Mesh, Mesh, Mesh]:
    x0, x1, y0, y1 = bounds
    opaque, glazing, trim = Mesh(), Mesh(), Mesh()
    for direction, y in ((-1, y0), (1, y1)):
        for start, stop in bays:
            _window(opaque, glazing, trim, "y", y, direction, start, stop, low, high, office)
    for direction, x in ((-1, x0), (1, x1)):
        for start, stop in _bands(y0, -1.65, 5.4) + _bands(1.65, y1, 5.4):
            _window(opaque, glazing, trim, "x", x, direction, start, stop, low, high, office)
        if first_floor:
            half_door = 1.03 if direction < 0 else 0.68
            head = min(low + 2.1, high - 0.04)
            opaque.surrounding("x", x, -1.65, 1.65, low, high, (-half_door, half_door, low, head))
            frame = x + direction * 0.035
            trim.wall("x", frame, -half_door, half_door, head, head + 0.055)
            for jamb in (-half_door, half_door):
                trim.wall("x", frame, jamb - 0.035, jamb + 0.035, low, head)
        else:
            _window(opaque, glazing, trim, "x", x, direction, -1.65, 1.65, low, high, office)
    return opaque, glazing, trim


@dataclass(frozen=True)
class Stairwell:
    hole: Rectangle
    room_end: float
    steps_per_flight: int

    def flights(self, low: float, high: float) -> Mesh:
        left, right, y0, y1 = self.hole
        mesh = Mesh()
        step_count = self.steps_per_flight
        going = 0.255
        landing = right - (left + step_count * going)
        flight_width = (y1 - y0 - 0.08) / 2
        rise = (high - low) / (2 * step_count)
        turn_x = right - landing
        for flight, (start, direction, y) in enumerate(((left, 1, y0), (turn_x, -1, y1 - flight_width))):
            for step in range(step_count):
                x = start + direction * step * going
                previous_z = low + (step_count * flight + step) * rise
                z = previous_z + rise
                mesh.wall("x", x, y, y + flight_width, previous_z, z)
                a, b = sorted((x, x + direction * going))
                mesh.flat((a, b, y, y + flight_width), z)
        mesh.flat((turn_x, right, y0, y1), (low + high) / 2)
        return mesh


def _stairwell(bounds: Rectangle, bays: list[tuple[float, float]], floor_height: float,
               corridor: float) -> Stairwell:
    left, _, y0, _ = bounds
    steps = ceil(floor_height / (2 * 0.185))
    x0 = left + 1.15
    x1 = x0 + steps * 0.255 + 1.0
    room_end = next(stop for _, stop in bays if stop >= x1 + 0.2)
    return Stairwell((x0, x1, y0 + 0.27, -corridor - 0.24), room_end, steps)


def _partition(mesh: Mesh, axis: Axis, fixed: float, a: float, b: float, low: float,
               high: float, door_center: float, door_width: float) -> None:
    half = door_width / 2
    mesh.surrounding(axis, fixed, a, b, low, high,
                     (door_center - half, door_center + half, low, low + 2.04))


def _partitions(bounds: Rectangle, bays: list[tuple[float, float]], corridor: float,
                low: float, high: float, office: bool, first_floor: bool, stairwell: Stairwell | None) -> Mesh:
    left, _, south, north = bounds
    mesh = Mesh()
    for sign, edge in ((-1, south), (1, north)):
        wall_y = sign * corridor
        room_bays = bays
        if sign < 0 and stairwell:
            end = stairwell.room_end
            _partition(mesh, "y", wall_y, left, end, low, high, left + 0.58, 0.94)
            if end < bays[-1][1]:
                mesh.wall("x", end, edge, wall_y, low, high)
            room_bays = [(a, b) for a, b in bays if a >= end]
        if office and sign > 0:
            # Alternate enclosed offices and wider meeting rooms.
            room_bays = [(room_bays[i][0], room_bays[min(i + 1, len(room_bays) - 1)][1])
                         for i in range(0, len(room_bays), 2)]
        for i, (a, b) in enumerate(room_bays):
            if not (first_floor and sign > 0 and i == 0):
                _partition(mesh, "y", wall_y, a, b, low, high, a + (b - a) * 0.4, 1.08 if office else 0.93)
            if i + 1 < len(room_bays):
                mesh.wall("x", b, min(wall_y, edge), max(wall_y, edge), low, high)
            depth = abs(edge - wall_y)
            if (not office and depth >= 4.6) or (office and sign > 0 and depth >= 12):
                setback = min(2.9, depth * 0.56) if not office else 6.2
                room_wall = edge - sign * setback
                _partition(mesh, "y", room_wall, a, b, low, high, a + (b - a) * 0.62, 0.88)
    return mesh


def generate_building(spec: BuildingSpec) -> GeneratedBuilding:
    """Create editable, floor-tagged scene objects with stable component IDs."""
    office = spec.layout == "office"
    floors = spec.floors
    assert floors is not None  # BuildingSpec normalizes omitted counts.
    floor_height = spec.height / floors
    x0, x1 = -spec.length / 2, spec.length / 2
    y0, y1 = -spec.width / 2, spec.width / 2
    bounds = (x0, x1, y0, y1)
    bays = _bands(x0, x1, 4.7 if office else 6.6)
    # Small buildings still have a corridor, while larger floor plates widen it.
    corridor = min(1.35 if office else 1.12, spec.width * 0.12)
    stairwell = _stairwell(bounds, bays, floor_height, corridor) if floors > 1 else None
    exterior_material = "itu_concrete" if office else "itu_brick"
    objects: list[BuildingFootprint] = []
    angle = radians(spec.rotationDeg)
    c, s = cos(angle), sin(angle)

    def add(mesh: Mesh, component: str, title: str, floor: str, material: str,
            role: RfRole = "surface") -> None:
        if not mesh.vertices:
            return
        vertices = [(round(spec.east + c * x - s * y, 6), round(spec.north + s * x + c * y, 6), round(z, 6))
                    for x, y, z in mesh.vertices]
        x, y, z = zip(*vertices)
        objects.append(BuildingFootprint(
            id=f"{spec.id}--{floor.lower()}-{component.replace('_', '-')}",
            name=f"{spec.name} · {floor} · {title}",
            category="building", type=f"generated_{component}", kind="mesh", floor=floor,
            source="template", geometrySource=f"Procedural {spec.layout} building", buildingSpec=spec,
            rfRole=role, material=material, baseZ=spec.baseZ, height=max(z) - min(z),
            points=[], enuPoints=[ENUVector(x=min(x), y=min(y), z=0), ENUVector(x=max(x), y=max(y), z=0)],
            mesh=TriangleMesh(vertices=[v for p in vertices for v in p], triangles=mesh.indices),
        ))

    roof_deck = spec.height - _PARAPET
    for level in range(floors):
        floor = f"{level + 1}F"
        slab_base = level * floor_height
        low = slab_base + _SLAB
        high = (level + 1) * floor_height if level + 1 < floors else roof_deck - _SLAB
        shell, windows, trim = _facade(bounds, bays, low, high, office, level == 0)
        add(shell, "facade", "Façade", floor, exterior_material)
        add(windows, "glazing", "Windows", floor, "itu_glass")
        add(trim, "trim", "Window and door frames", floor, "itu_metal", "visual")
        add(_slab(bounds, slab_base, low, stairwell.hole if stairwell and level else None),
            "slab", "Floor slab", floor, "itu_concrete")
        add(_partitions(bounds, bays, corridor, low, high, office, level == 0, stairwell),
            "partition", "Rooms and corridor", floor, "itu_plasterboard")
        if stairwell and level + 1 < floors:
            add(stairwell.flights(low, low + floor_height), "stair", "Stairs and landing", floor, "itu_concrete")

    entry = Mesh()
    entry_box = (x0 - 0.82, x0, -1.30, 1.30)
    canopy_bottom = _SLAB + 2.11
    entry.flat(entry_box, canopy_bottom + 0.08)
    entry.edges(entry_box, canopy_bottom, canopy_bottom + 0.08)
    add(entry, "entry", "Entrance canopy", "1F", "itu_metal", "visual")

    add(_slab(bounds, roof_deck - _SLAB, roof_deck), "slab", "Roof deck", "Roof", "itu_concrete")
    parapet = Mesh()
    parapet.edges(bounds, roof_deck, spec.height)
    add(parapet, "facade", "Parapet", "Roof", exterior_material)
    equipment = Mesh()
    for x in (-spec.length * 0.23, spec.length * 0.23):
        unit = (x - 0.95, x + 0.95, 0.50, 1.55)
        equipment.flat(unit, spec.height)
        equipment.edges(unit, roof_deck, spec.height)
    add(equipment, "roof_equipment", "Rooftop equipment", "Roof", "itu_metal", "visual")
    return GeneratedBuilding(spec=spec, objects=objects)
