"""Exercise one physical scene through the real API and an independent replay.

Usage: python scripts/verify_scene_workbench.py http://127.0.0.1:8000 output-directory
Use the same Python and SRTS_MITSUBA_VARIANT as the server to replay the export.
"""
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener
import zipfile

import numpy as np
from shapely.geometry import Point, Polygon


def verify(origin, output):
    http = build_opener(ProxyHandler({}))

    def request(path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        with http.open(Request(origin + "/api/" + path, data, {"Content-Type": "application/json"}),
                       timeout=180) as response:
            return response.read()

    def read(path, payload=None):
        return json.loads(request(path, payload))

    def point(x, y):
        return {"x": x, "y": y, "z": 0}

    def device(ident, x):
        return {"id": ident, "name": ident, "enu": point(x, 0), "height": 1.5,
                "antennaArraySize": [1, 1]}

    def wall(ident, a, b, material="itu_brick"):
        return {"id": ident, "category": "building", "kind": "wall", "height": 4.0,
                "baseZ": -0.2, "material": material, "enuPoints": [point(*a), point(*b)]}

    clear = {
        "buildings": [], "txs": [device("ap", -20)], "rxs": [device("ue", 20)],
        "freqGhz": 3.5, "numSubcarriers": 16, "subcarrierSpacing": 30_000,
        "normalizeDelays": False, "maxDepth": 0,
        "options": {"txPattern": "iso", "los": True, "specularReflection": False,
                    "pathSamplesPerSource": 10_000, "pathSeed": 42},
    }
    blocked = {**clear, "buildings": [wall("partition", (0, -10), (0, 10))]}
    reflected = {
        **clear, "buildings": [wall("reflector", (-24, 12), (24, 12))], "maxDepth": 1,
        "options": {**clear["options"], "los": False, "specularReflection": True,
                    "pathSamplesPerSource": 100_000},
    }

    health = read("health")
    inspection = read("scene-inspection", blocked)
    assert inspection["objects"][0]["status"] == "physical"
    assert inspection["objects"][0]["material"] == "itu_brick"
    assert len(inspection["meshes"][1]["triangles"]) == 6
    assert read("scene-inspection", clear)["sceneId"] != inspection["sceneId"]
    assert read("scene-inspection", {**blocked, "buildings": [{**blocked["buildings"][0], "name": "Label"}]})[
        "sceneId"] == inspection["sceneId"]
    repaired = {"id": "crossed", "category": "building", "height": 4, "material": "unknown",
                "enuPoints": [point(0, 0), point(8, 8), point(8, 0), point(0, 8)]}
    invalid = {"id": "missing", "category": "building", "height": 4, "enuPoints": [point(0, 0)]}
    issues = read("scene-inspection", {**clear, "buildings": [repaired, invalid]})["objects"]
    assert issues[0]["status"] == "physical" and len(issues[0]["issues"]) == 3
    assert issues[1]["status"] == "skipped" and issues[1]["issues"]

    collapsed = {"id": "collapsed", "category": "building", "kind": "mesh", "height": 2, "enuPoints": [],
                 "mesh": {"vertices": [999999.99, 0, 0, 1000000, 0, 0, 999999.99, 0, 2], "triangles": [0, 1, 2]}}
    collapsed_scene = {**clear, "buildings": [collapsed]}
    precision = read("scene-inspection", collapsed_scene)
    assert precision["objects"][0]["status"] == "skipped" and len(precision["meshes"]) == 1
    assert "solver precision" in " ".join(precision["objects"][0]["issues"])
    with zipfile.ZipFile(io.BytesIO(request("scene-export", collapsed_scene))) as bundle:
        assert [name for name in bundle.namelist() if name.endswith(".ply")] == ["meshes/ground.ply"]

    def trace(config):
        run = read("csi-runs", {**config, "mode": "static"})
        assert run["sceneId"] == read("scene-inspection", config)["sceneId"]
        assert run["solverRuntime"]["variant"] == health["variant"]
        archive = request("csi-runs/" + run["runId"] + "/export", {})
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            assert manifest["scene"]["sceneId"] == run["sceneId"]
            return np.load(io.BytesIO(bundle.read("csi.npz")))

    free = trace(clear)
    valid = free["valid_paths"]
    assert np.count_nonzero(valid) == 1
    delay = float(free["tau_geometric"][valid][0])
    np.testing.assert_allclose(delay, 40 / 299_792_458, rtol=1e-6)
    amp = float(abs(free["a"].reshape(-1)[0]))
    np.testing.assert_allclose(amp, 299_792_458 / (4 * np.pi * 3.5e9 * 40), rtol=2e-6)
    assert not trace(blocked)["valid_paths"].any()
    restored = trace(clear)
    for field in ("a", "tau_geometric", "h_freq"):
        np.testing.assert_array_equal(restored[field], free[field])

    # A pure single reflection. The exported box also contains a ground
    # reflection, so locate the vertical wall path by its image distance.
    one_bounce = trace(reflected)
    expected = np.hypot(40, 24) / 299_792_458
    assert np.isclose(one_bounce["tau_geometric"][one_bounce["valid_paths"]],
                      expected, rtol=2e-5, atol=1e-12).any()

    output.mkdir(parents=True, exist_ok=True)
    for name, config, studio in (("los", clear, free), ("reflection", reflected, one_bounce)):
        path = output / name
        path.mkdir(exist_ok=True)
        with zipfile.ZipFile(io.BytesIO(request("scene-export", config))) as bundle:
            bundle.extractall(path)
            manifest = json.loads(bundle.read("manifest.json"))
            assert manifest["scene"]["sceneId"] == read("scene-inspection", config)["sceneId"]
        env = {**os.environ, "SRTS_MITSUBA_VARIANT": health["variant"]}
        subprocess.run([sys.executable, str(path / "load_scene.py")], cwd=path, env=env, check=True)
        with np.load(path / "cir.npz") as replay:
            for source, target in (("a", "a"), ("tau_geometric", "tau"), ("h_freq", "h")):
                actual, expected_array = studio[source][0], replay[target]
                if source == "a":
                    actual = actual[..., None]
                elif source == "h_freq":
                    expected_array = expected_array[..., 0, :]
                np.testing.assert_allclose(actual, expected_array, rtol=2e-5, atol=1e-10 if source != "tau_geometric" else 1e-12)

    # Import a centimetre-based OBJ wall using Y-up axes, then solve against
    # the compiled triangles. This uses the same upload endpoint as Scene.
    obj = b"v 0 0 -1000\nv 0 0 1000\nv 0 400 1000\nv 0 400 -1000\nf 1 2 3\nf 1 3 4\n"
    query = urlencode({"filename": "partition.obj", "axes": "y-up", "scale": 0.01, "material": "itu_glass"})
    with http.open(Request(origin + "/api/mesh-import?" + query, obj), timeout=180) as response:
        imported = json.load(response)
    imported_scene = {**clear, "buildings": imported["objects"]}
    mesh = read("scene-inspection", imported_scene)["meshes"][1]
    np.testing.assert_allclose(np.asarray(mesh["vertices"]).reshape(-1, 3).min(axis=0), [0, -10, 0])
    np.testing.assert_allclose(np.asarray(mesh["vertices"]).reshape(-1, 3).max(axis=0), [0, 10, 4])
    assert mesh["material"] == "itu_glass" and not trace(imported_scene)["valid_paths"].any()

    padded_ply = (b"ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n"
                  b"element face 1\nproperty list uchar int vertex_indices\nend_header\n"
                  b"0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n" + b"\n" * 250_000)
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("scene.xml", '<scene><shape type="ply"><string name="filename" value="mesh.ply"/></shape></scene>')
        bundle.writestr("mesh.ply", padded_ply)
    for filename, payload in (("mesh.ply", padded_ply), ("scene.zip", package.getvalue())):
        upload = Request(origin + "/api/mesh-import?" + urlencode({"filename": filename}), payload)
        try:
            with http.open(upload, timeout=10):
                raise AssertionError("ASCII PLY with too many rows was accepted")
        except HTTPError as error:
            assert error.code == 400 and "250000 data rows" in json.load(error)["detail"]

    building = {"id": "building", "category": "building", "height": 8, "baseZ": 3,
                "enuPoints": [point(-24, -3), point(-16, -3), point(-16, 3), point(-24, 3)]}
    elevated = {**clear, "buildings": [building]}
    assert trace(elevated)["tx_positions"][0, 2] == 12.5
    indoor_tx = {**clear["txs"][0], "height": 6, "heightReference": "enu"}
    assert trace({**elevated, "txs": [indoor_tx]})["tx_positions"][0, 2] == 6

    crossed = {**building, "baseZ": 0, "enuPoints": [point(0, 0), point(8, 8), point(0, 8), point(4, 0)]}
    roof, = read("scene-roofs", [crossed, invalid, blocked["buildings"][0]])
    exterior, *holes = [[(p["x"], p["y"]) for p in ring] for ring in roof["rings"]]
    footprint = Polygon(exterior, holes)
    assert roof["topZ"] == 8 and not footprint.contains(Point(2, 1)) and footprint.contains(Point(3, 7))
    receivers = [{**device("discarded", 2), "enu": point(2, 1)}, {**device("retained", 3), "enu": point(3, 7)}]
    repaired_run = trace({**clear, "buildings": [crossed], "rxs": receivers})
    np.testing.assert_array_equal(repaired_run["rx_positions"].reshape(-1, 3)[:, 2], [1.5, 9.5])

    route = read("csi-runs", {
        **clear, "mode": "trajectory", "output": "cir",
        "rxs": [{**clear["rxs"][0], "height": 3, "heightReference": "enu"}],
        "waypoints": [point(20, 0), {**point(20, 10), "z": 2}], "timeSeconds": [0, 1],
    })
    np.testing.assert_array_equal(route["rxPositions"], [[[20, 0, 3]], [[20, 10, 5]]])

    final = read("health")
    assert final["lastSolve"]["status"] == "succeeded" and final["lastSolve"]["operation"] == "csi"
    report = {"runtime": health, "losDelayNs": delay * 1e9, "freeSpacePathLossDb": -20 * np.log10(amp),
              "wallLosPaths": 0, "restoredExactly": True, "reflectionDelayNs": expected * 1e9,
              "importedObjLosPaths": 0, "roofPositionM": 12.5, "indoorPositionM": 6,
              "trajectoryElevationsM": [3, 5],
              "losCfrSha256": sha256(free["h_freq"].tobytes()).hexdigest()}
    (output / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    verify(sys.argv[1], Path(sys.argv[2]).resolve())
