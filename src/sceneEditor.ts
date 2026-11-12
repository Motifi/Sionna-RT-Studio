import { useState } from 'react';
import type { BuildingFootprint, ENUVector, GeoAnchor } from './types';
import { createIdSuffix, enuToLatLon } from './utils';
import { radioRole } from './lib/sceneGeometry';

export type SceneTool = 'select' | 'generate' | 'rectangle' | 'polygon' | 'wall' | 'move';
export type SceneLayer = BuildingFootprint['category'];

export function withFootprint(object: BuildingFootprint, vertices: ENUVector[], anchor: GeoAnchor) {
  return { ...object, enuPoints: vertices, points: vertices.map(vertex => enuToLatLon(vertex, anchor)) };
}

export function useSceneEditor(
  buildings: BuildingFootprint[], anchor: GeoAnchor,
  setBuildings: (objects: BuildingFootprint[]) => void, setAnchor: (anchor: GeoAnchor) => void,
  initialHiddenLayers: SceneLayer[] = [],
  onDrawBuilding?: (first: ENUVector, opposite: ENUVector) => void,
) {
  const [history, setHistory] = useState<{
    buildings: BuildingFootprint[]; anchor: GeoAnchor; restoreMaterials?: () => void;
  }[]>([]);
  const [selectedId, select] = useState<string | null>(null);
  const [tool, setTool] = useState<SceneTool>('select');
  const [draft, setDraft] = useState<ENUVector[]>([]);
  const [top, setTop] = useState(false);
  const [solverMesh, setSolverMesh] = useState(false);
  const [hiddenLayers, setHiddenLayers] = useState<SceneLayer[]>(initialHiddenLayers);
  const selected = buildings.find(object => object.id === selectedId);
  const chooseTool = (next: SceneTool) => {
    setDraft([]);
    setTool(next);
    if (next !== 'select') setTop(true);
  };
  const commit = (objects: BuildingFootprint[], nextAnchor = anchor, restoreMaterials?: () => void) => {
    setHistory(previous => [...previous.slice(-29), { buildings, anchor, restoreMaterials }]);
    setBuildings(objects);
    if (nextAnchor !== anchor) setAnchor(nextAnchor);
  };
  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setBuildings(previous.buildings);
    previous.restoreMaterials?.();
    if (previous.anchor !== anchor) setAnchor(previous.anchor);
    chooseTool('select');
  };
  const reset = () => {
    setHistory([]);
    select(null);
    chooseTool('select');
  };
  const update = (object: BuildingFootprint) =>
    commit(buildings.map(existing => existing.id === object.id ? object : existing));
  const insert = (object: BuildingFootprint) => {
    commit([...buildings, object]);
    select(object.id);
    chooseTool('select');
  };
  const create = (kind: 'building' | 'wall', vertices: ENUVector[]) => {
    insert(withFootprint({
      id: createIdSuffix(), kind, category: 'building', source: 'manual',
      type: kind, height: kind === 'wall' ? 3 : 8, baseZ: 0, material: 'itu_concrete',
      heightSource: 'manual', materialSource: 'manual', enuPoints: [], points: [],
    }, vertices, anchor));
  };
  const shift = (object: BuildingFootprint, dx: number, dy: number) => {
    const vertices = object.enuPoints.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
    const mesh = object.mesh && { ...object.mesh, vertices: object.mesh.vertices.map(
      (value, index) => value + (index % 3 === 0 ? dx : index % 3 === 1 ? dy : 0),
    ) };
    const foliage = object.foliage && {
      ...object.foliage, center: { ...object.foliage.center, x: object.foliage.center.x + dx, y: object.foliage.center.y + dy },
    };
    return withFootprint({ ...object, mesh, foliage }, vertices, anchor);
  };
  const click = (point: ENUVector, hitId?: string) => {
    if (tool === 'select') {
      select(hitId ?? null);
    } else if (tool === 'move' && selected?.enuPoints.length) {
      const first = selected.enuPoints[0];
      update(shift(selected, point.x - first.x, point.y - first.y));
      chooseTool('select');
    } else if (tool === 'polygon' || draft.length === 0) {
      setDraft([...draft, point]);
    } else if (tool === 'wall') {
      create('wall', [draft[0], point]);
    } else if (tool === 'generate') {
      onDrawBuilding?.(draft[0], point);
      chooseTool('select');
    } else if (tool === 'rectangle') {
      const first = draft[0];
      create('building', [first, { ...first, x: point.x }, point, { ...first, y: point.y }]);
    }
  };
  return {
    commit, reset, undo, canUndo: history.length > 0,
    selected, select, tool, chooseTool, top, setTop, solverMesh, setSolverMesh,
    hiddenLayers, setHiddenLayers, draft, click, update,
    finish: () => { if (tool === 'polygon' && draft.length >= 3) create('building', draft); },
    duplicate: () => {
      if (selected) insert({ ...shift(selected, 3, 3), id: createIdSuffix(), buildingSpec: undefined });
    },
    remove: () => {
      if (selected) commit(buildings.filter(object => object.id !== selected.id));
      select(null);
      chooseTool('select');
    },
  };
}

export type SceneEditor = ReturnType<typeof useSceneEditor>;

// Coordinates/EM inputs only. Labels, map decorations and view controls are
// excluded from the frontend invalidation key.
export function physicalSceneInputs(objects: BuildingFootprint[]) {
  return objects.filter(object => radioRole(object) !== 'visual').map(
    object => [object.id, radioRole(object), object.kind ?? 'building', object.baseZ ?? 0, object.height,
      object.material, object.enuPoints.map(({ x, y }) => [x, y]), object.mesh, object.foliage],
  );
}
