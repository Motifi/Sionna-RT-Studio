# 制作场景包 · Authoring a scene package

将 `scene.json` 放在 ZIP 根目录。可选的 `visual.glb` 和 PLY、OBJ 网格一起放入 ZIP，再从「场景 → 场景来源 → 导入场景包」打开。内置的 [Foundry Avenue 场景包](../assets/urban-scene.zip) 和[生成脚本](../scripts/build-urban-scene.py)可用于参考。包内资源和保存后的项目可以离线使用。

Put `scene.json` at the root of the ZIP. Include the optional GLB and the referenced PLY or OBJ files, then open it from **Scene → Scene Source → Import scene package**. The bundled [Foundry Avenue package](../assets/urban-scene.zip) and its [generator](../scripts/build-urban-scene.py) provide a working example.

```json
{
  "format": "SionnaRTStudio Scene",
  "schemaVersion": 1,
  "coordinateFrame": "ENU_m",
  "name": "Office block",
  "anchor": { "latitude": 38.9, "longitude": -77.0, "elevation": 29, "verticalDatum": "WGS84 ellipsoidal" },
  "objects": [
    { "id": "road", "category": "infrastructure", "rfRole": "ground", "meshFile": "meshes/road.ply", "material": "itu_asphalt_concrete" },
    { "id": "lobby-wall", "category": "building", "rfRole": "surface", "meshFile": "meshes/wall.ply", "material": "lobby-brick", "floor": "1F", "geometrySource": "Architectural model" },
    { "id": "oak", "category": "terrain", "rfRole": "foliage", "foliage": { "center": { "x": 12, "y": -3, "z": 5 }, "radii": { "x": 2.8, "y": 2.6, "z": 2 }, "attenuationDbPerM": 0.8 } }
  ],
  "materials": [
    { "id": "lobby-brick", "relativePermittivity": 4.1, "conductivity": 0.02, "thickness": 0.18 }
  ],
  "visual": { "file": "visual.glb", "objectIds": ["road", "lobby-wall", "oak"] }
}
```

1. Model in meters from a single origin. Keep both exports aligned. Physical vertices use ENU with `x` east, `y` north and `z` up. Export the display GLB in its normal Y-up frame with coordinates `(east, up, -north)`. `anchor.elevation` and `verticalDatum` describe the origin. `baseZ`, if supplied, adds an ENU Z offset to an object's physical mesh or crown. The GLB represents the initial world position including that offset.
2. Use Blender for the display mesh and materials. If starting with IFC, bring it into Blender with Bonsai and retain a separate, simplified copy of the walls, slabs, glazing, and terrain for the solver. Keep window and door openings in the solver copy. Avoid placing coincident faces with different RF materials. Each bound GLB object needs a default-scene root node whose unique name exactly matches its manifest `id`. Embed textures and buffers and export uncompressed geometry. Group a display object under the matching node if it has several meshes.
3. Assign each solver object a role. `ground` uses a triangle mesh as terrain and replaces the generated flat plane. `surface` uses a mesh or an extruded footprint as a radio boundary. `foliage` attenuates each ray segment by the distance inside an ellipsoidal crown. For overlapping crowns the strongest rate applies at each position. `visual` contributes only to the 3D view. Use `floor` for display filtering and `geometrySource` to record geometry provenance.
4. Assign an ITU preset or define a named profile with relative permittivity and conductivity in S/m. Thickness is in meters. Visual paint and texture come from the GLB. Enable refraction when evaluating transmission through glazing or walls. Crown coefficients are entered in dB/m and should be calibrated at the simulation frequency for site-specific work.
5. Check dimensions, material provenance, and missing surfaces in **Solver Check**. Relative device heights use the authored terrain where available. Use absolute ENU height for an indoor floor or a roof on an imported mesh. Coverage samples a specified height above the terrain and leaves terrain holes without coverage values. Scenes with terrain or foliage support up to 4,096 grid cells and 8,192 AP–cell pairs per run.

For inline physical meshes, use `mesh` with flat `vertices` and zero-based `triangles` arrays in place of `meshFile`. Object IDs use letters, digits, hyphens, or underscores. The ZIP limit is 32 MiB, with up to 100,000 solver vertices, 150,000 solver triangles, and a 16 MiB visual GLB.

## 参数化建筑 · Procedural buildings

界面和脚本使用同一个生成接口。以下示例在本地 Web 服务生成一栋办公楼。`east`、`north` 是相对场景原点的占地中心，`baseZ` 是当地 ENU 底部标高。`rotationDeg` 从东朝北为正。可将 `layout` 改为 `apartments`，也可省略 `floors` 让生成器估算楼层数。

The UI and scripts use the same generator. The request below generates an office with a rotated footprint at a local ENU position. Set `layout` to `apartments` for a residential plan or omit `floors` to infer it from the height.

```bash
curl -fsS http://127.0.0.1:8000/api/building-generate \
  -H 'Content-Type: application/json' \
  --data '{"id":"research-office","name":"Research Office","east":40,"north":15,"length":30,"width":20,"height":12,"baseZ":0,"floors":3,"rotationDeg":20,"layout":"office"}'
```

The endpoint returns the normalized `spec` and a list of `objects`. It has no project storage side effects. To compose a scene, use a distinct ID for each building and append its returned objects to the scene manifest. The objects retain `buildingSpec`, which lets Studio reopen the building parameters. In the UI, regeneration rebuilds geometry and keeps manually set radio materials on matching components. Set the absolute ENU height for devices on a particular floor. All building plans are generated from templates and represent synthetic geometry.
