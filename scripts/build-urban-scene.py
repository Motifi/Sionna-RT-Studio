"""Build the original, deterministic urban example shipped with Studio.

Run with Python 3.10 or newer. The geometry and embedded textures use only
the standard library and require no downloads.
"""

from collections import defaultdict
from dataclasses import dataclass
from math import cos, pi, sin, sqrt
from pathlib import Path
import json
import random
import struct
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
import zlib


@dataclass
class Mesh:
    vertices: list
    faces: list


def combine(meshes):
    vertices, faces = [], []
    for mesh in meshes:
        first = len(vertices)
        vertices.extend(mesh.vertices)
        faces.extend(tuple(index + first for index in face) for face in mesh.faces)
    return Mesh(vertices, faces)


def quad(*points):
    return Mesh(list(points), [(0, 1, 2), (0, 2, 3)])


def box(x1, x2, y1, y2, z1, z2):
    vertices = [
        (x1, y1, z1), (x2, y1, z1), (x2, y2, z1), (x1, y2, z1),
        (x1, y1, z2), (x2, y1, z2), (x2, y2, z2), (x1, y2, z2),
    ]
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    faces = [(a, b, c) for a, b, c, _ in quads] + [(a, c, d) for a, _, c, d in quads]
    return Mesh(vertices, faces)


def ground_height(x, y):
    return 0.65 + 0.009 * x + 0.004 * y


def terrain_patch(x1, x2, y1, y2, offset=0):
    return quad(*[(x, y, ground_height(x, y) + offset)
                  for x, y in [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]])


def path_ribbon(points, width):
    edges = []
    for i, (x, y) in enumerate(points):
        previous, following = points[max(0, i - 1)], points[min(len(points) - 1, i + 1)]
        dx, dy = following[0] - previous[0], following[1] - previous[1]
        scale = width * 0.5 / sqrt(dx * dx + dy * dy)
        sides = [(x + dy * scale, y - dx * scale), (x - dy * scale, y + dx * scale)]
        edges.append([(px, py, ground_height(px, py) + 0.045) for px, py in sides])
    return [quad(a, b, c, d) for (a, d), (b, c) in zip(edges, edges[1:])]


def prism(x, y, z0, z1, radius, top_radius, sides=9):
    vertices = [(x, y, z0), (x, y, z1)]
    for z, r in [(z0, radius), (z1, top_radius)]:
        vertices.extend((x + r * cos(i * 2 * pi / sides), y + r * sin(i * 2 * pi / sides), z)
                        for i in range(sides))
    faces = []
    for i in range(sides):
        a, b = 2 + i, 2 + (i + 1) % sides
        c, d = a + sides, b + sides
        faces.extend([(0, b, a), (1, c, d), (a, b, d), (a, d, c)])
    return Mesh(vertices, faces)


def crown_lobe(x, y, z, rx, ry, rz, rng):
    steps, bands = 12, 7
    vertices = [(x, y, z - rz)]
    for band in range(1, bands):
        phi = -pi / 2 + pi * band / bands
        for step in range(steps):
            theta = 2 * pi * step / steps
            length = rng.uniform(0.87, 1.13)
            vertices.append((x + rx * length * cos(phi) * cos(theta),
                             y + ry * length * cos(phi) * sin(theta),
                             z + rz * length * sin(phi)))
    top = len(vertices)
    vertices.append((x, y, z + rz))
    faces = []
    for step in range(steps):
        following = (step + 1) % steps
        faces.append((0, 1 + following, 1 + step))
        for ring in range(bands - 2):
            a, b = 1 + ring * steps + step, 1 + ring * steps + following
            faces.extend([(a, b, b + steps), (a, b + steps, a + steps)])
        last = 1 + (bands - 2) * steps
        faces.append((top, last + step, last + following))
    return Mesh(vertices, faces)


def rgb(value):
    def linear(channel):
        return channel / 12.92 if channel < 0.04045 else ((channel + 0.055) / 1.055) ** 2.4
    return [linear(int(value[i:i + 2], 16) / 255) for i in (0, 2, 4)]


# Visual properties are independent of the solver material IDs in the manifest.
# Palette entries are base color, roughness, metalness, texture, alpha.
PALETTE = {
    "asphalt": ("4c5157", 0.98, 0, "aggregate", 1),
    "concrete": ("c6c5bb", 0.92, 0, "pavers", 1),
    "plaza": ("aeaaa1", 0.88, 0, "pavers", 1),
    "lawn": ("77885d", 0.96, 0, "aggregate", 1),
    "planting": ("655846", 0.96, 0, "aggregate", 1),
    "white": ("deddd2", 0.89, 0, None, 1),
    "stripe": ("e0af57", 0.83, 0, None, 1),
    "curb": ("d7d1bc", 0.89, 0, "aggregate", 1),
    "stone": ("c6b89f", 0.91, 0, "pavers", 1),
    "cream": ("e4daca", 0.85, 0, "aggregate", 1),
    "brick": ("a65f4c", 0.93, 0, "masonry", 1),
    "earth": ("906150", 0.96, 0, "masonry", 1),
    "teal": ("4f6d70", 0.77, 0.13, "aggregate", 1),
    "trim": ("3a4c52", 0.52, 0.26, None, 1),
    "opaque-glass": ("50727b", 0.35, 0.22, None, 1),
    "glass": ("83aab5", 0.24, 0.12, None, 0.56),
    "roof": ("8c8d88", 0.98, 0, "aggregate", 1),
    "tile": ("d4cec0", 0.72, 0, "pavers", 1),
    "wood": ("8e6345", 0.85, 0, "aggregate", 1),
    "leaf-dark": ("4f673e", 1, 0, None, 1),
    "leaf-mid": ("607a47", 1, 0, None, 1),
    "leaf-light": ("789155", 1, 0, None, 1),
    "solar": ("304957", 0.36, 0.27, None, 1),
}


class City:
    def __init__(self):
        self.objects = []
        self.models = {}

    def add(self, ident, name, category, role, source, material, visual, *,
            physical=None, floor=None, foliage=None):
        visual = {paint: combine(meshes) for paint, meshes in visual.items() if meshes}
        item = {
            "id": ident, "name": name, "category": category, "rfRole": role,
            "geometrySource": source, "material": material,
        }
        if floor:
            item["floor"] = floor
        if physical:
            item["mesh"] = {
                "vertices": [round(c, 6) for point in physical.vertices for c in point],
                "triangles": [i for face in physical.faces for i in face],
            }
            item["kind"] = "mesh"
        elif foliage:
            item["foliage"] = foliage
        else:
            points = [p for mesh in visual.values() for p in mesh.vertices]
            lows = [min(p[i] for p in points) for i in range(3)]
            highs = [max(p[i] for p in points) for i in range(3)]
            item["enuPoints"] = [dict(x=x, y=y, z=0) for x, y in [
                (lows[0], lows[1]), (highs[0], lows[1]), (highs[0], highs[1]), (lows[0], highs[1]),
            ]]
            item["height"] = max(0.05, highs[2] - lows[2])
            item["baseZ"] = lows[2]
        self.objects.append(item)
        self.models[ident] = visual


def street(city):
    city.add("avenue", "Foundry Avenue", "infrastructure", "ground", "Synthetic sloped pavement",
             "itu_asphalt_concrete", {"asphalt": [terrain_patch(-72, 72, -6, 6)]},
             physical=terrain_patch(-72, 72, -6, 6))
    for side, lo, hi in [("north", 6, 11.2), ("south", -11.2, -6)]:
        patch = terrain_patch(-72, 72, lo, hi)
        city.add(f"sidewalk-{side}", f"{side.title()} sidewalk", "infrastructure", "ground",
                 "Synthetic sloped concrete sidewalk", "itu_concrete", {"concrete": [patch]}, physical=patch)
    plots = [
        ("north-west", -72, 4, 11.2, 50, "plaza"),
        ("exchange", 4, 45, 11.2, 50, "plaza"),
        ("north-east", 45, 72, 11.2, 50, "lawn"),
        ("south-park", -72, 24, -50, -11.2, "lawn"),
        ("south-east", 24, 72, -50, -11.2, "plaza"),
    ]
    for ident, x1, x2, y1, y2, paint in plots:
        patch = terrain_patch(x1, x2, y1, y2)
        city.add(f"ground-{ident}", f"{ident.replace('-', ' ').title()} ground", "terrain", "ground",
                 "Synthetic continuous ENU terrain", "itu_medium_dry_ground" if paint == "lawn" else "itu_concrete",
                 {paint: [patch]}, physical=patch)

    markings = defaultdict(list)
    for x in range(-70, 70, 6):
        if not 12 < x < 20:
            markings["stripe"].append(terrain_patch(x, x + 3, -0.11, 0.11, 0.018))
    for y in (-5.35, 5.35):
        markings["white"].append(terrain_patch(-72, 72, y - 0.05, y + 0.05, 0.018))
    for x in [13.4 + i * 0.62 for i in range(9)]:
        markings["white"].append(terrain_patch(x, x + 0.34, -5.1, 5.1, 0.025))
    for y in [-6.1, 6.1]:
        for start, end in [(-72, 13), (19, 72)]:
            markings["curb"].append(terrain_patch(start, end, y - 0.12, y + 0.12, 0.07))
    city.add("street-markings", "Crosswalk, lane markings and curbs", "infrastructure", "visual",
             "Procedural street detail", "itu_concrete", markings)

    park_path = path_ribbon([(-59, -24.8), (-53, -21.8), (-46, -17.9), (-39, -16.4),
                             (-30, -17.1), (-21, -19.9), (-13, -24.1), (-4, -24.4),
                             (4, -21.3), (11, -17.6), (16, -11.2)], 2.3)
    branch = path_ribbon([(-39, -16.4), (-39, -13.4), (-38, -11.2)], 1.8)
    courtyard = [terrain_patch(27.2, 55, -20.8, -12.9, 0.03)]
    parking = [terrain_patch(x, x + 0.08, -20.8, -16.7, 0.05) for x in range(29, 55, 3)]
    city.add("courtyard-paving", "Park paths and studio forecourt", "infrastructure", "visual",
             "Procedural landscape paving", "itu_concrete", {
                 "plaza": [*park_path, *branch], "asphalt": courtyard, "white": parking,
             })

    fixtures = defaultdict(list)
    for x, y in [(-53, 8.6), (-29, 8.6), (2, 8.6), (39, 8.6), (61, 8.6), (-63, -8.2), (1, -8.2), (58, -8.2)]:
        z = ground_height(x, y)
        fixtures["trim"].extend([
            prism(x, y, z, z + 5.5, 0.115, 0.078),
            box(x - 0.13, x + 0.13, y - 0.96, y + 0.03, z + 5.37, z + 5.54),
        ])
        fixtures["cream"].append(box(x - 0.085, x + 0.085, y - 0.87, y - 0.24, z + 5.34, z + 5.38))
    for x, y in [(-16, -13.8), (-7, -14.8), (26, 9.2), (33, 9.4), (-25, 11.8)]:
        z = ground_height(x, y)
        for xx in [x - 0.92, x + 0.92]:
            fixtures["trim"].append(box(xx - 0.06, xx + 0.06, y - 0.29, y + 0.32, z, z + 0.48))
        fixtures["wood"].extend([
            box(x - 1.22, x + 1.22, y - 0.31, y + 0.32, z + 0.44, z + 0.52),
            box(x - 1.22, x + 1.22, y + 0.27, y + 0.36, z + 0.68, z + 1.02),
        ])
    for x in [12.4, 19.4, 21, 22.6]:
        z = ground_height(x, 10.5)
        fixtures["trim"].append(prism(x, 10.5, z, z + 0.93, 0.075, 0.075))
    city.add("street-fixtures", "Lighting, benches and bollards", "infrastructure", "visual",
             "Procedural streetscape detail", "itu_metal", fixtures)


def infill(city, ident, name, x1, x2, y1, y2, floors, wall_paint, rf_material, setback=0):
    low = min(ground_height(x1, y1), ground_height(x2, y2)) - 0.12
    top = low + floors * 3.6 + 0.35
    terrace = low + (floors - 1) * 3.6
    roof_bounds = x1 + setback, x2 - setback, y1 + setback * 1.7, y2 - setback
    masses = [box(x1, x2, y1, y2, low, top)] if not setback else [
        box(x1, x2, y1, y2, low, terrace), box(*roof_bounds, terrace, top),
    ]
    visual = defaultdict(list, {wall_paint: masses})
    for level in range(floors):
        if level == floors - 1:
            x1, x2, y1, y2 = roof_bounds
        z = low + 1.15 + level * 3.6
        count = int((x2 - x1) / 3.7)
        for i in range(count):
            cx = x1 + (i + 0.5) * (x2 - x1) / count
            width = min(1.24, (x2 - x1) / count * 0.34)
            for y, direction in [(y1, -1), (y2, 1)]:
                y_a, y_b = sorted([y + direction * 0.055, y + direction * 0.115])
                visual["trim"].append(box(cx - width, cx + width, y_a, y_b, z, z + 1.93))
                outer = y + direction * 0.145
                glass_a, glass_b = sorted([y + direction * 0.11, outer])
                visual["opaque-glass"].append(box(cx - width + 0.15, cx + width - 0.15,
                                                   glass_a, glass_b, z + 0.14, z + 1.76))
                trim_a, trim_b = sorted([outer, outer + direction * 0.03])
                visual["trim"].append(box(cx - 0.045, cx + 0.045, trim_a, trim_b, z + 0.13, z + 1.76))
        count = int((y2 - y1) / 4.1)
        for i in range(count):
            cy = y1 + (i + 0.5) * (y2 - y1) / count
            for x in (x1, x2):
                a, b = (x - 0.13, x - 0.035) if x == x1 else (x + 0.035, x + 0.13)
                visual["opaque-glass"].append(box(a, b, cy - 1.06, cy + 1.06, z + 0.06, z + 1.76))
        visual["cream"].append(box(x1 - 0.13, x2 + 0.13, y1 - 0.15, y2 + 0.15, z - 0.37, z - 0.19))
    visual["roof"].append(box(x1 - 0.25, x2 + 0.25, y1 - 0.25, y2 + 0.25, top, top + 0.31))
    visual["trim"].append(box(x1 + 3.2, x1 + 6.1, y2 - 7.2, y2 - 4.2, top + 0.31, top + 1.15))
    city.add(ident, name, "building", "surface", "Synthetic building envelope with decorative glazing",
             rf_material, visual, physical=combine(masses))


def exchange(city):
    z1, z2, z3 = 1.25, 5.45, 9.65
    city.add("exchange-slab", "Exchange · entry slab", "building", "surface", "Synthetic concrete slab",
             "itu_concrete", {"tile": [box(5, 42, 12, 39, z1 - 0.12, z1)]},
             physical=box(5, 42, 12, 39, z1 - 0.12, z1), floor="1F")
    side_walls = [
        box(5, 5.34, 12, 39, z1, z2),
        box(41.66, 42, 12, 39, z1, z2),
        box(5.34, 41.66, 38.64, 39, z1, z2),
    ]
    facade = []
    for x1, x2 in [(5.34, 6.6), (13.45, 14.45), (17.55, 18.55), (26.8, 28), (35.5, 36.45), (40.95, 41.66)]:
        facade.append(box(x1, x2, 12, 12.43, z1, z2))
    for x1, x2 in [(6.6, 13.45), (18.55, 26.8), (28, 35.5), (36.45, 40.95)]:
        facade.append(box(x1, x2, 12, 12.43, z1, z1 + 0.68))
        facade.append(box(x1, x2, 12, 12.43, z2 - 0.62, z2))
    facade.append(box(14.45, 17.55, 12, 12.43, z1 + 3.35, z2))
    stone = side_walls + facade
    cornice_low, cornice_high = z2 - 0.16, z2 + 0.05
    cornice = [
        box(4.72, 42.28, 11.72, 12.48, cornice_low, cornice_high),
        box(4.72, 42.28, 38.60, 39.24, cornice_low, cornice_high),
        box(4.72, 5.4, 12.48, 38.60, cornice_low, cornice_high),
        box(41.62, 42.28, 12.48, 38.60, cornice_low, cornice_high),
        box(13.7, 18.3, 10.7, 12.6, z1 + 3.32, z1 + 3.51),
    ]
    city.add("exchange-shell", "Exchange · stone façade", "building", "surface", "Synthetic façade piers and exterior walls",
             "itu_concrete", {"stone": stone, "cream": cornice}, physical=combine(stone), floor="1F")
    ramp = quad((14.9, 9.6, ground_height(14.9, 9.6) + 0.025),
                (17.1, 9.6, ground_height(17.1, 9.6) + 0.025), (17.1, 12, z1), (14.9, 12, z1))
    city.add("exchange-ramp", "Exchange · entrance ramp", "infrastructure", "surface",
             "Synthetic concrete ramp from sidewalk to lobby slab", "itu_concrete",
             {"tile": [ramp]}, physical=ramp, floor="1F")

    windows, frames = [], []
    for x1, x2 in [(6.6, 13.45), (18.55, 26.8), (28, 35.5), (36.45, 40.95)]:
        low, high = z1 + 0.68, z2 - 0.62
        windows.append(quad((x1, 12.25, low), (x2, 12.25, low), (x2, 12.25, high), (x1, 12.25, high)))
        for x in [x1, (x1 + x2) / 2, x2]:
            frames.append(box(x - 0.052, x + 0.052, 12.15, 12.35, low, high))
        for z in [low, low + 1.55, high]:
            frames.append(box(x1, x2, 12.13, 12.32, z - 0.05, z + 0.05))
    for x1, x2, low, high in [(14.45, 14.87, z1, z1 + 3.35), (17.13, 17.55, z1, z1 + 3.35),
                              (14.87, 17.13, z1 + 2.73, z1 + 3.35)]:
        windows.append(quad((x1, 12.25, low), (x2, 12.25, low), (x2, 12.25, high), (x1, 12.25, high)))
    for x in [14.45, 14.87, 17.13, 17.55]:
        frames.append(box(x - 0.05, x + 0.05, 12.1, 12.38, z1, z1 + 3.35))
    frames.append(box(14.45, 17.55, 12.1, 12.38, z1 + 2.68, z1 + 2.79))
    city.add("exchange-entry-glass", "Exchange · glazing and open entry", "building", "surface",
             "Synthetic single-sided RF glazing panels with an open doorway",
             "itu_glass", {"glass": windows, "trim": frames}, physical=combine(windows), floor="1F")

    partitions = [
        box(5.34, 22.95, 21.9, 22.16, z1, z2 - 0.18),
        box(25.05, 41.66, 21.9, 22.16, z1, z2 - 0.18),
        box(28.32, 28.56, 22.16, 38.64, z1, z2 - 0.18),
        box(5.34, 12.2, 29.3, 29.53, z1, z2 - 0.18),
        box(14.1, 28.32, 29.3, 29.53, z1, z2 - 0.18),
    ]
    city.add("exchange-partitions", "Exchange · lobby and rooms", "building", "surface",
             "Synthetic full-height masonry partitions and door openings",
             "itu_brick", {"cream": partitions, "wood": [
                 box(22.84, 22.99, 21.83, 22.23, z1, z1 + 2.4),
                 box(25.01, 25.16, 21.83, 22.23, z1, z1 + 2.4),
                 box(22.84, 25.16, 21.83, 22.23, z1 + 2.36, z1 + 2.5),
                 box(12.04, 12.2, 29.24, 29.6, z1, z1 + 2.43),
                 box(14.08, 14.23, 29.24, 29.6, z1, z1 + 2.43),
             ]}, physical=combine(partitions), floor="1F")
    fittings = [
        box(31.5, 35.9, 16.1, 17.55, z1, z1 + 1.12),
        box(19.6, 22.6, 33.3, 34.6, z1 + 0.79, z1 + 0.92),
        box(10.7, 14.8, 25.8, 27.2, z1 + 0.79, z1 + 0.92),
        box(8.2, 9.7, 14.5, 17.4, z1, z1 + 0.56),
    ]
    city.add("exchange-fittings", "Exchange · reception desk and furnishings", "building", "visual",
             "Procedural interior fixtures", "itu_wood", {"wood": fittings, "teal": [
                 box(31.2, 36.1, 15.96, 17.74, z1 + 1.12, z1 + 1.24),
                 box(19.35, 22.85, 33.04, 34.86, z1 + 0.67, z1 + 0.78),
                 box(10.55, 14.95, 25.66, 27.34, z1 + 0.67, z1 + 0.78),
             ]}, floor="1F")

    slab = box(5, 42, 12, 39, z2 - 0.18, z2)
    upper = [
        box(8, 8.31, 14.5, 38, z2, z3),
        box(39.7, 40, 14.5, 38, z2, z3),
        box(8.31, 39.7, 37.7, 38, z2, z3),
        box(8.31, 39.7, 14.5, 14.87, z2, z2 + 0.58),
        box(8.31, 39.7, 14.5, 14.87, z3 - 0.67, z3),
        box(8.31, 22.45, 25.9, 26.12, z2, z3),
        box(24.55, 39.7, 25.9, 26.12, z2, z3),
    ]
    city.add("exchange-upper", "Exchange · second-floor slab and partitions", "building", "surface",
             "Synthetic second-floor slab, exterior and interior walls", "itu_concrete",
             {"tile": [slab], "cream": upper}, physical=combine([slab, *upper]), floor="2F")
    panel = quad((8.31, 14.72, z2 + 0.58), (39.7, 14.72, z2 + 0.58),
                 (39.7, 14.72, z3 - 0.67), (8.31, 14.72, z3 - 0.67))
    dividers = [box(x - 0.08, x + 0.08, 14.59, 14.83, z2 + 0.57, z3 - 0.66)
                for x in [8.31 + (39.7 - 8.31) * i / 12 for i in range(13)]]
    dividers.append(box(8.3, 39.72, 14.57, 14.85, z2 + 1.97, z2 + 2.11))
    city.add("exchange-upper-glass", "Exchange · upper curtain wall", "building", "surface",
             "Synthetic curtain glazing", "itu_glass", {"glass": [panel], "trim": dividers},
             physical=panel, floor="2F")
    roof = box(7.5, 40.5, 14.0, 38.5, z3, z3 + 0.32)
    roof_detail = [box(32, 37, 31, 35.5, z3 + 0.32, z3 + 1.45)]
    solar = [quad((x, 26.1, z3 + 0.54), (x + 2.2, 26.1, z3 + 0.54),
                  (x + 2.2, 29.8, z3 + 1.14), (x, 29.8, z3 + 1.14))
             for x in range(13, 28, 3)]
    city.add("exchange-roof", "Exchange · roof and rooftop equipment", "building", "surface",
             "Synthetic roof slab with decorative rooftop equipment", "itu_concrete",
             {"roof": [roof], "trim": roof_detail, "solar": solar}, physical=roof, floor="Roof")


def tree(city, ident, name, x, y, radii, absorption, seed):
    rng = random.Random(seed)
    rx, ry, rz = radii
    base = ground_height(x, y)
    center_z = base + 1.2 + rz
    visual = defaultdict(list, {
        "wood": [prism(x, y, base, center_z + 0.35, 0.27, 0.13)],
        "leaf-mid": [crown_lobe(x, y, center_z, 0.79 * rx, 0.79 * ry, 0.84 * rz, rng)],
        "planting": [prism(x, y, base + 0.045, base + 0.11, 1.07, 1.07)],
    })
    colors = ["leaf-mid", "leaf-dark", "leaf-light"]
    for i in range(11):
        angle = i * 2.399963
        band = rng.uniform(-0.44, 0.55)
        visual[colors[i % len(colors)]].append(crown_lobe(
            x + rx * 0.52 * cos(angle), y + ry * 0.52 * sin(angle), center_z + rz * band,
            rx * rng.uniform(0.3, 0.46), ry * rng.uniform(0.33, 0.46), rz * rng.uniform(0.38, 0.52), rng,
        ))
    city.add(ident, name, "terrain", "foliage", "Synthetic canopy ellipsoid for segment attenuation",
             "itu_wood", visual, foliage={
                 "center": dict(x=x, y=y, z=center_z), "radii": dict(x=rx, y=ry, z=rz),
                 "attenuationDbPerM": absorption,
             })


def make_city():
    city = City()
    street(city)
    exchange(city)
    infill(city, "warehouse", "Kiln Warehouse", -63, -41, 16, 41, 3, "brick", "itu_brick")
    infill(city, "workshop", "Foundry Workshop", -36, -11, 17, 34, 2, "stone", "itu_concrete", setback=1.75)
    infill(city, "design-center", "Design Center", 47, 66, 19, 43, 4, "teal", "itu_glass", setback=1.4)
    infill(city, "studio-annex", "Studio Annex", 27, 55, -39, -21, 2, "earth", "itu_brick")
    infill(city, "park-pavilion", "Park Pavilion", -64, -48, -39, -25, 1, "cream", "itu_concrete")
    trees = [
        (-38, -9.1, (3.9, 3.2, 3.0), 1.25),
        (-26, -9.0, (3.4, 2.95, 2.8), 1.00),
        (-14, -9.0, (3.5, 2.9, 3.05), 1.20),
        (-51, -21, (4.0, 3.9, 3.65), 0.85),
        (-33, -28, (4.4, 4.0, 3.85), 1.00),
        (-23, -22, (3.7, 3.6, 3.35), 0.85),
        (-16, -34, (4.7, 4.4, 3.95), 1.05),
        (-2, -19, (3.25, 3.0, 2.8), 0.90),
        (9, -28, (4.3, 4.0, 3.55), 1.10),
        (49, 11.7, (3.7, 3.15, 3.3), 0.95),
        (63, 11.7, (3.45, 3.0, 3.0), 1.00),
    ]
    for i, (x, y, radii, attenuation) in enumerate(trees, 1):
        tree(city, f"tree-{i:02}", f"{'Avenue' if i <= 3 else 'Courtyard'} tree {i}",
             x, y, radii, attenuation, 2700 + i)
    return city


def texture_png(style):
    size = 128
    rng = random.Random(style)
    scanlines = bytearray()
    for y in range(size):
        scanlines.append(0)
        for x in range(size):
            value = rng.randint(203, 245)
            if style == "pavers":
                value = rng.randint(225, 248)
                if y % 32 < 2 or (x + 16 * (y // 32 % 2)) % 32 < 2:
                    value -= 40
            elif style == "masonry":
                value = rng.randint(206, 240)
                if y % 9 == 0 or (x + 8 * (y // 9 % 2)) % 16 == 0:
                    value = 248
            scanlines.extend((value, value, value))
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scanlines, 9)) + chunk(b"IEND", b""))


def three_vector(p):
    return p[0], p[2], -p[1]


def mesh_attributes(mesh):
    positions, normals, uv = [], [], []
    for face in mesh.faces:
        a, b, c = (mesh.vertices[i] for i in face)
        u, v = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
        normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        length = sqrt(sum(n * n for n in normal))
        if length < 1e-12:
            continue
        unit = three_vector([n / length for n in normal])
        major_axis = max(range(3), key=lambda i: abs(normal[i]))
        axes = [i for i in range(3) if i != major_axis]
        for point in (a, b, c):
            positions.append(three_vector(point))
            normals.append(unit)
            uv.append(tuple(point[i] * 0.44 for i in axes))
    return positions, normals, uv


def visual_glb(models):
    binary = bytearray()
    gltf = {
        "asset": {"version": "2.0", "generator": "SionnaRTStudio urban example"},
        "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [], "materials": [],
        "buffers": [], "bufferViews": [], "accessors": [], "textures": [], "images": [],
    }

    def view(data, target=None):
        index = len(gltf["bufferViews"])
        entry = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)}
        if target is not None:
            entry["target"] = target
        gltf["bufferViews"].append(entry)
        binary.extend(data)
        binary.extend(b"\0" * (-len(binary) % 4))
        return index

    def attribute(vectors, size, bounds=False):
        flat = [n for vector in vectors for n in vector]
        entry = {
            "bufferView": view(struct.pack(f"<{len(flat)}f", *flat), 34962),
            "componentType": 5126, "count": len(vectors), "type": f"VEC{size}",
        }
        if bounds:
            entry["min"] = [min(v[i] for v in vectors) for i in range(size)]
            entry["max"] = [max(v[i] for v in vectors) for i in range(size)]
        gltf["accessors"].append(entry)
        return len(gltf["accessors"]) - 1

    texture_ids = {}
    for style in ["aggregate", "pavers", "masonry"]:
        texture_ids[style] = len(gltf["textures"])
        gltf["textures"].append({"source": len(gltf["images"])})
        gltf["images"].append({"mimeType": "image/png", "bufferView": view(texture_png(style))})

    materials = {}
    for name, (color, roughness, metalness, texture, alpha) in PALETTE.items():
        material = {
            "name": name, "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorFactor": [*rgb(color), alpha],
                "roughnessFactor": roughness, "metallicFactor": metalness,
            },
        }
        if texture:
            material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": texture_ids[texture]}
        if alpha < 1:
            material["alphaMode"] = "BLEND"
        materials[name] = len(gltf["materials"])
        gltf["materials"].append(material)

    for ident, model in models.items():
        primitives = []
        for paint, mesh in model.items():
            positions, normals, uv = mesh_attributes(mesh)
            primitives.append({
                "material": materials[paint],
                "attributes": {
                    "POSITION": attribute(positions, 3, bounds=True), "NORMAL": attribute(normals, 3),
                    "TEXCOORD_0": attribute(uv, 2),
                },
            })
        gltf["scenes"][0]["nodes"].append(len(gltf["nodes"]))
        gltf["nodes"].append({"name": ident, "mesh": len(gltf["meshes"])})
        gltf["meshes"].append({"primitives": primitives})
    gltf["buffers"].append({"byteLength": len(binary)})
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode()
    json_bytes += b" " * (-len(json_bytes) % 4)
    return (struct.pack("<4sIIII", b"glTF", 2, 28 + len(json_bytes) + len(binary), len(json_bytes), 0x4E4F534A)
            + json_bytes + struct.pack("<II", len(binary), 0x004E4942) + binary)


def main():
    city = make_city()
    manifest = {
        "format": "SionnaRTStudio Scene", "schemaVersion": 1, "coordinateFrame": "ENU_m",
        "name": "Foundry Avenue",
        "anchor": {"latitude": 38.9226, "longitude": -77.0194, "elevation": 29.4,
                   "verticalDatum": "WGS84 ellipsoidal (illustrative)"},
        "objects": city.objects, "visual": {"file": "visual.glb", "objectIds": list(city.models)},
    }
    archive_path = Path(__file__).resolve().parents[1] / "assets" / "urban-scene.zip"
    with ZipFile(archive_path, "w") as archive:
        for name, data in [("scene.json", json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()),
                           ("visual.glb", visual_glb(city.models))]:
            entry = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            archive.writestr(entry, data, compress_type=ZIP_DEFLATED, compresslevel=9)
    print(f"Wrote {archive_path} ({len(city.objects)} objects, {archive_path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
