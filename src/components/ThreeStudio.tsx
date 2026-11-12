/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SceneObjectReport, SolverMesh } from '../api';
import type { SceneEditor } from '../sceneEditor';
import type { SceneVisual, SolverRoof, TrajectoryPoint, WaypointFrame } from '../types';
import { BuildingFootprint, GeoAnchor, Transmitter, Receiver, PropagationPath, ENUVector, PlacementMode } from '../types';
import { cn } from '../lib/utils';
import { enuToLatLon, getDeviceElevation, getWaypointPosition, isPointInPolygon } from '../utils';
import { RadioMapGrid } from '../types';
import type { ColormapName } from '../lib/colormaps';
import { coverageCellValue, coverageDisplayRange, setCoverageColor } from '../lib/coverageDisplay';
import { createAccessPointModel, createReceiverModel } from '../lib/deviceGeometry';
import { generatedBuildingMaterial } from '../lib/generatedBuildingMaterials';
import { findHorizontalSurface, isFloorSurface } from '../lib/sceneGeometry';
import { sceneObjectName } from '../lib/sceneLabels';
import { advanceWalkCamera, createWalkCamera, rotateWalkCamera, type WalkCameraState } from '../lib/sceneWalkCamera';
import { createFacadeWindows, createJunction, createStreetSegment } from '../lib/streetGeometry';
import {
  createFoliageVolume, isSceneObjectVisible, loadSceneVisual, positionVisualObject, type LoadedSceneVisual,
} from '../lib/sceneVisualGeometry';
import { Camera, ChevronDown, Eye, Footprints, Hand, Rotate3D } from 'lucide-react';
import { NumberField } from './NumberField';

// Free the GPU resources (geometry, materials, textures) held by an object tree.
// three.js does not release these on remove(), so skipping this leaks VRAM.
function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (mesh as THREE.Mesh).material;
    const mats = Array.isArray(material) ? material : material ? [material] : [];
    for (const m of mats) {
      const tex = (m as THREE.SpriteMaterial).map;
      if (tex) tex.dispose();
      m.dispose();
    }
  });
}

// Remove and dispose every child of a group.
function clearGroup(group: THREE.Group) {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    disposeObject3D(child);
  }
}

// Muted, matte building palette in the spirit of Sionna RT's preview renderer
// (earthy tan / beige / sage / mauve / terracotta / slate tones).
const BUILDING_PALETTE = [
  0xb08968, 0xddbea9, 0xa5a58d, 0x9a8c98,
  0xcb997e, 0x8d99ae, 0xb5838d, 0xc9ada7,
];
function buildingColor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BUILDING_PALETTE[h % BUILDING_PALETTE.length];
}

// A camera-facing text label (e.g. "Tx 1") rendered as a sprite, for the 3D scene.
function makeLabelSprite(text: string, borderColor: string): THREE.Sprite {
  const fontSize = 48;
  const pad = 18;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `bold ${fontSize}px sans-serif`;
  const tw = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  canvas.width = tw + pad * 2;
  canvas.height = fontSize + pad * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(11,12,14,0.82)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const worldH = 7; // label height in world units
  sprite.scale.set((worldH * canvas.width) / canvas.height, worldH, 1);
  sprite.renderOrder = 20;
  return sprite;
}

// Map-style street text painted into the road plane. It is deliberately not a
// billboard: orbiting/panning the camera must move the name exactly with the
// street, just like text printed on a physical map surface.
function makeStreetLabelMesh(
  text: string,
  segmentLength: number,
  maxAnisotropy: number,
): THREE.Mesh | null {
  const fontSize = 64;
  const padX = 18;
  const padY = 12;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = `700 ${fontSize}px sans-serif`;
  const textWidth = Math.ceil(measure.measureText(text).width);
  const canvas = document.createElement('canvas');
  canvas.width = textWidth + padX * 2;
  canvas.height = fontSize + padY * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `700 ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.95)';
  ctx.lineWidth = 12;
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  // The asphalt ribbon is 7.5 m wide. A 4.2 m text height gives the label the
  // visual weight of a web-map road name while retaining side clearance.
  const naturalHeight = 4.2;
  const naturalWidth = naturalHeight * canvas.width / canvas.height;
  const maxWidth = Math.min(48, Math.max(7, segmentLength - 4));
  const scale = Math.min(1, maxWidth / naturalWidth);
  if (scale < 0.42) return null; // too cramped to be useful at map scale

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(8, maxAnisotropy);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.08,
    // Respect scene geometry: a road name must not render through a building.
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(naturalWidth * scale, naturalHeight * scale),
    material,
  );
  mesh.renderOrder = 12;
  return mesh;
}

type DevicePlacement = Exclude<PlacementMode, 'none'>;
type SceneNavigation = 'orbit' | 'pan' | 'walk';

const WALK_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
  'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight',
]);

interface ThreeStudioProps {
  sceneEditor?: SceneEditor;
  onSelectSceneObject?: (id: string | null) => void;
  focusObject?: { id: string };
  sceneName?: string;
  sceneVisual?: SceneVisual;
  sceneFloor?: string;
  solverCheck?: boolean;
  physicalMeshes?: SolverMesh[];
  solverObjects?: SceneObjectReport[];
  solverRoofs?: SolverRoof[];
  buildings: BuildingFootprint[];
  anchor: GeoAnchor;
  tx: Transmitter;
  rx: Receiver;
  txs?: Transmitter[];
  rxs?: Receiver[];
  paths: PropagationPath[];
  matrixPaths?: PropagationPath[];
  showRaysOnHeatmap?: boolean;
  radioMap: RadioMapGrid | null;
  rmColormap: ColormapName;
  rmAutoRange: boolean;
  rmVmin: number;
  rmVmax: number;
  onPlaceDevice: (mode: DevicePlacement, enu: ENUVector, absoluteHeight?: number) => void;
  onSelectDevice: (kind: 'tx' | 'rx', id: string) => void;
  deploymentSelection: 'tx' | 'rx';
  showDevices: boolean;
  onToggleSceneDevices: () => void;
  editing: boolean;
  visible: boolean;
  activeMode: 'link' | 'heatmap' | 'playback';
  placementMode: PlacementMode;
  setPlacementMode: (mode: PlacementMode) => void;
  showOutlines: boolean;
  setShowOutlines: (val: boolean) => void;
  mobilityRxPosition: ENUVector | null;
  mobilityRxHeading: number;
  trajectoryPoints: TrajectoryPoint[];
  waypointFrame?: WaypointFrame;
  setTrajectoryPoints: (points: TrajectoryPoint[], frame?: WaypointFrame) => void;
}

// Map ENU Vector to Three.js vector
// East (X) -> +X
// North (Y) -> -Z
// Up (Z) -> +Y
function enuToThree(v: ENUVector): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

function expandObjectBounds(bounds: THREE.Box3, object: BuildingFootprint) {
  const base = object.baseZ ?? 0;
  if (object.mesh) {
    const vertices = object.mesh.vertices;
    const point = new THREE.Vector3();
    for (let i = 0; i < vertices.length; i += 3) {
      bounds.expandByPoint(point.set(vertices[i], base + vertices[i + 2], -vertices[i + 1]));
    }
    return;
  }
  if (object.foliage) {
    const { center, radii } = object.foliage;
    bounds.expandByPoint(new THREE.Vector3(center.x - radii.x, base + center.z - radii.z, -center.y - radii.y));
    bounds.expandByPoint(new THREE.Vector3(center.x + radii.x, base + center.z + radii.z, -center.y + radii.y));
    return;
  }
  for (const point of object.enuPoints) {
    bounds.expandByPoint(enuToThree({ ...point, z: base }));
    bounds.expandByPoint(enuToThree({ ...point, z: base + object.height }));
  }
}

export function ThreeStudio({
  sceneEditor,
  onSelectSceneObject,
  focusObject,
  sceneName,
  sceneVisual,
  sceneFloor,
  solverCheck,
  physicalMeshes,
  solverObjects,
  solverRoofs,
  buildings,
  anchor,
  tx,
  rx,
  txs,
  rxs,
  paths,
  matrixPaths,
  showRaysOnHeatmap,
  radioMap,
  rmColormap,
  rmAutoRange,
  rmVmin,
  rmVmax,
  onPlaceDevice,
  onSelectDevice,
  deploymentSelection,
  showDevices,
  onToggleSceneDevices,
  editing,
  visible,
  activeMode,
  placementMode,
  setPlacementMode,
  showOutlines,
  setShowOutlines,
  mobilityRxPosition,
  mobilityRxHeading,
  trajectoryPoints,
  waypointFrame,
  setTrajectoryPoints
}: ThreeStudioProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureScreenshotRef = useRef<(() => void) | null>(null);

  const [canvasState, setCanvasState] = useState<'initializing' | 'active' | 'unavailable'>('initializing');
  const [sceneVisualStatus, setSceneVisualStatus] = useState<'idle' | 'loading' | 'incomplete'>('idle');
  const [fps, setFps] = useState<number>(0);
  const [screenshotStatus, setScreenshotStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [performanceMode, setPerformanceMode] = useState<'high' | 'eco'>('high');
  const [cameraMode, setCameraMode] = useState<'orbit' | 'lockTx'>('orbit');
  const [pathDrawingMode, setPathDrawingMode] = useState(false);
  const [placementFloorId, setPlacementFloorId] = useState<string>();
  const [floorOffsets, setFloorOffsets] = useState<Partial<Record<'tx' | 'rx', number>>>({});
  const [placementIssue, setPlacementIssue] = useState<'floor' | 'terrain' | 'route'>();
  const [navigationMode, setNavigationMode] = useState<SceneNavigation>('orbit');
  const [walkPhase, setWalkPhase] = useState<'pick' | 'active' | 'no-surface'>('pick');
  const canNavigateScene = sceneEditor?.tool === 'select';
  const sceneNavigation = canNavigateScene ? navigationMode : 'orbit';

  useEffect(() => {
    if (!canNavigateScene) {
      setNavigationMode('orbit');
      setWalkPhase('pick');
    }
  }, [canNavigateScene]);

  const [hoveredCoordinate, setHoveredCoordinate] = useState<ENUVector | null>(null);
  const drawingTrajectory = editing && deploymentSelection === 'rx' && pathDrawingMode && placementMode === 'none';
  const floors = useMemo(() => buildings.filter(isFloorSurface), [buildings]);
  const activePlacementFloor = editing ? floors.find(object => object.id === placementFloorId) : undefined;
  const floorKind = placementMode === 'none' ? deploymentSelection : placementMode.endsWith('tx') ? 'tx' : 'rx';
  const floorOffset = floorOffsets[floorKind] ?? (floorKind === 'tx' ? 2.5 : 1.5);

  useEffect(() => {
    if (!editing || deploymentSelection !== 'rx' || placementMode !== 'none') setPathDrawingMode(false);
  }, [editing, deploymentSelection, placementMode]);
  useEffect(() => { setPathDrawingMode(false); }, [rx.id]);
  useEffect(() => { setPlacementIssue(undefined); }, [placementMode, drawingTrajectory, placementFloorId, rx.id]);

  useEffect(() => {
    if (placementMode === 'none' && !drawingTrajectory) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPlacementMode('none');
        setPathDrawingMode(false);
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [placementMode, drawingTrajectory, setPlacementMode]);

  // Keep references to access them in render loops & events stably
  const stateRef = useRef({
    sceneEditor, sceneName, sceneVisual, sceneFloor, solverCheck, physicalMeshes, solverObjects, solverRoofs, onSelectSceneObject, focusObject,
    buildings,
    anchor,
    tx,
    rx,
    txs,
    rxs,
    paths,
    matrixPaths,
    showRaysOnHeatmap,
    radioMap,
    rmColormap,
    rmAutoRange,
    rmVmin,
    rmVmax,
    placementMode,
    placementFloorId: activePlacementFloor?.id,
    floorOffset,
    activeMode,
    cameraMode,
    sceneNavigation,
    performanceMode,
    showOutlines,
    drawingTrajectory,
    mobilityRxPosition,
    mobilityRxHeading,
    trajectoryPoints,
    waypointFrame,
    setTrajectoryPoints,
    onPlaceDevice,
    onSelectDevice,
    editing,
    showDevices,
    visible,
    t,
  });

  useEffect(() => {
    stateRef.current = {
      sceneEditor, sceneName, sceneVisual, sceneFloor, solverCheck, physicalMeshes, solverObjects, solverRoofs, onSelectSceneObject, focusObject,
      buildings,
      anchor,
      tx,
      rx,
      txs,
      rxs,
      paths,
      matrixPaths,
      showRaysOnHeatmap,
      radioMap,
      rmColormap,
      rmAutoRange,
      rmVmin,
      rmVmax,
      placementMode,
      placementFloorId: activePlacementFloor?.id,
      floorOffset,
      activeMode,
      cameraMode,
      sceneNavigation,
      performanceMode,
      showOutlines,
      drawingTrajectory,
      mobilityRxPosition,
      mobilityRxHeading,
      trajectoryPoints,
      waypointFrame,
      setTrajectoryPoints,
      onPlaceDevice,
      onSelectDevice,
      editing,
      showDevices,
      visible,
      t,
    };
  }, [sceneEditor, sceneName, sceneVisual, sceneFloor, solverCheck, physicalMeshes, solverObjects, solverRoofs, onSelectSceneObject, focusObject, buildings, anchor, tx, rx, txs, rxs, paths, matrixPaths, showRaysOnHeatmap, radioMap, rmColormap, rmAutoRange, rmVmin, rmVmax, placementMode, activePlacementFloor, floorOffset, activeMode, cameraMode, sceneNavigation, performanceMode, showOutlines, drawingTrajectory, mobilityRxPosition, mobilityRxHeading, trajectoryPoints, waypointFrame, setTrajectoryPoints, onPlaceDevice, onSelectDevice, editing, showDevices, visible, t]);

  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    const width = Math.max(1, containerRef.current.clientWidth);
    const height = containerRef.current.clientHeight || 580;

    // 1. Initial Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8fafc); // Bright elegant light mode background
    // No distance fog — it washed the whole scene hazy when zoomed out.

    // 2. Camera Setup. Near plane at 1 (not 0.1) so the depth buffer keeps
    // precision across the large city extent → no z-fighting flicker far out.
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 6000);
    if (stateRef.current.buildings.some(object => object.source === 'template' && object.type === 'avenue')) {
      // Look along the main street so the near buildings leave the devices visible.
      camera.position.set(-228, 166, 93);
    } else {
      camera.position.set(0, 180, 240);
    }

    // 3. WebGL Renderer. logarithmicDepthBuffer eliminates the flicker between
    // the many coplanar flat layers (ground, grid, roads, parks, water).
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvasRef.current,
        antialias: true,
        alpha: true,
        logarithmicDepthBuffer: true,
        powerPreference: 'high-performance',
      });
      setCanvasState('active');
    } catch {
      setCanvasState('unavailable');
      return;
    }
    const onContextLost = () => setCanvasState('unavailable');
    const onContextRestored = () => setCanvasState('active');
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 4. Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // restrict to ground-level rotations
    controls.screenSpacePanning = true;

    // 5. Lights — soft, even, Sionna-preview style (mostly ambient + sky/ground fill).
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xc7ccd4, 0.6);
    hemiLight.position.set(0, 300, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
    dirLight.position.set(120, 250, 80);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 1000;
    const dSide = 400;
    dirLight.shadow.camera.left = -dSide;
    dirLight.shadow.camera.right = dSide;
    dirLight.shadow.camera.top = dSide;
    dirLight.shadow.camera.bottom = -dSide;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    // Grid Floor matching Light Minimal GIS setup
    const gridHelper = new THREE.GridHelper(1000, 100, 0x94a3b8, 0xcbd5e1);
    gridHelper.position.y = -0.1;
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.34;
    gridHelper.material.depthWrite = false;
    scene.add(gridHelper);

    // Ground slab
    const groundGeom = new THREE.PlaneGeometry(2000, 2000);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0, // Elegant deeper slate-200 ground base for maximum contrast against white buildings
      roughness: 0.9,
      metalness: 0.05
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Grouping nodes for logical clear layers
    const buildingGroup = new THREE.Group();
    const visualSelectionGroup = new THREE.Group();
    const draftGroup = new THREE.Group();
    scene.add(draftGroup);
    const footprintPositions = new THREE.BufferAttribute(new Float32Array(12), 3).setUsage(THREE.DynamicDrawUsage);
    const footprintGeometry = new THREE.BufferGeometry().setAttribute('position', footprintPositions);
    const footprintPreview = new THREE.LineLoop(footprintGeometry,
      new THREE.LineBasicMaterial({ color: 0xb45309, depthTest: false, depthWrite: false }));
    footprintPreview.visible = false;
    footprintPreview.frustumCulled = false;
    footprintPreview.renderOrder = 25;
    scene.add(footprintPreview);
    const streetLabelGroup = new THREE.Group();
    const transmitterGroup = new THREE.Group();
    const receiverGroup = new THREE.Group();
    const pathsGroup = new THREE.Group();
    const heatmapGroup = new THREE.Group();
    const trajectoryGroup = new THREE.Group();
    const interactionGroup = new THREE.Group();

    scene.add(buildingGroup);
    scene.add(visualSelectionGroup);
    scene.add(streetLabelGroup);
    scene.add(transmitterGroup);
    scene.add(receiverGroup);
    scene.add(pathsGroup);
    scene.add(heatmapGroup);
    scene.add(trajectoryGroup);
    scene.add(interactionGroup);

    let loadedVisual: LoadedSceneVisual | undefined;
    let visualLoadGeneration = 0;
    let authoredGroundIds = new Set<string>();
    let footprintHover: THREE.Vector3 | null = null;

    function replaceSceneVisual(visual?: SceneVisual) {
      const generation = ++visualLoadGeneration;
      loadedVisual?.dispose();
      loadedVisual = undefined;
      setSceneVisualStatus(visual ? 'loading' : 'idle');
      if (!visual) return;

      const isCurrent = () => generation === visualLoadGeneration && stateRef.current.sceneVisual === visual;
      void loadSceneVisual(visual).then(asset => {
        if (!isCurrent()) {
          asset.dispose();
          return;
        }
        loadedVisual = asset;
        scene.add(asset.root);
        rebuildBuildings3D();
        setSceneVisualStatus(asset.incomplete ? 'incomplete' : 'idle');
      }, () => {
        if (isCurrent()) setSceneVisualStatus('incomplete');
      });
    }

    function addTriangleMesh(
      data: { vertices: number[]; triangles: number[] }, id: string, base = 0, object?: BuildingFootprint,
    ) {
      const positions = new Float32Array(data.vertices.length);
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = data.vertices[i];
        positions[i + 1] = data.vertices[i + 2] + base;
        positions[i + 2] = -data.vertices[i + 1];
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(data.triangles);
      geometry.computeVertexNormals();
      const selected = id && stateRef.current.sceneEditor?.selected?.id === id;
      const appearance = object && generatedBuildingMaterial(object);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        side: THREE.DoubleSide, flatShading: true,
        ...appearance,
        color: selected && !appearance ? 0xf59e0b : appearance?.color ?? (id ? buildingColor(id) : 0x94a3b8),
      }));
      mesh.name = id;
      mesh.castShadow = !!id && !appearance?.transparent;
      mesh.receiveShadow = true;
      buildingGroup.add(mesh);
      const { solverCheck, physicalMeshes, showOutlines } = stateRef.current;
      const check = solverCheck ?? (physicalMeshes !== undefined);
      const highlight = !!appearance && selected;
      if (check || showOutlines || highlight) {
        const edges = check ? new THREE.WireframeGeometry(geometry) : new THREE.EdgesGeometry(geometry);
        buildingGroup.add(new THREE.LineSegments(edges,
          new THREE.LineBasicMaterial({
            color: highlight ? 0xd97706 : 0x334155,
            transparent: true,
            opacity: highlight ? 0.9 : appearance ? 0.22 : 0.5,
          })));
      }
    }

    function rebuildDraft() {
      clearGroup(draftGroup);
      const editor = stateRef.current.sceneEditor;
      const points = editor?.draft ?? [];
      if (!points.length) return;
      const geometry = new THREE.BufferGeometry().setFromPoints(points.map(point => enuToThree({
        ...point, z: (editor?.tool === 'generate' ? point.z : 0) + 0.2,
      })));
      draftGroup.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xb45309, size: 8, sizeAttenuation: false })));
      draftGroup.add(new THREE.Line(geometry.clone(), new THREE.LineBasicMaterial({ color: 0xb45309 })));
    }

    function updateFootprintPreview() {
      const editor = stateRef.current.sceneEditor;
      const start = editor?.draft[0];
      const end = footprintHover;
      if (editor?.tool !== 'generate' || !start || !end) {
        footprintPreview.visible = false;
        return;
      }
      const elevation = (start.z + end.y) / 2 + 0.2;
      footprintPositions.setXYZ(0, start.x, start.z + 0.2, -start.y);
      footprintPositions.setXYZ(1, end.x, elevation, -start.y);
      footprintPositions.setXYZ(2, end.x, end.y + 0.2, end.z);
      footprintPositions.setXYZ(3, start.x, elevation, end.z);
      footprintPositions.needsUpdate = true;
      footprintPreview.visible = true;
    }

    // 6. BUILD GENERATOR: Building Geometry Extruders
    function rebuildBuildings3D() {
      clearGroup(buildingGroup);
      clearGroup(streetLabelGroup);
      clearGroup(visualSelectionGroup);

      const current = stateRef.current;
      const check = current.solverCheck ?? (current.physicalMeshes !== undefined);
      const selectedId = current.sceneEditor?.selected?.id;
      // Pick a starting point in the cutaway, then show ceilings in first-person view.
      const visibleFloor = walkView ? undefined : current.sceneFloor;
      const visibleObject = (object: BuildingFootprint) =>
        current.placementFloorId
          ? object.id === current.placementFloorId || object.rfRole === 'ground'
          : isSceneObjectVisible(object, current.sceneEditor?.hiddenLayers, visibleFloor);
      const objectsById = new Map<string, BuildingFootprint>(current.buildings.map(object => [object.id, object]));
      authoredGroundIds = new Set(current.buildings.filter(object => object.rfRole === 'ground' && object.mesh)
        .map(object => object.id));
      ground.visible = !check && authoredGroundIds.size === 0;
      gridHelper.visible = ground.visible;

      if (loadedVisual) {
        loadedVisual.root.visible = !check && !current.placementFloorId;
        if (loadedVisual.root.visible) {
          for (const [id, binding] of loadedVisual.bindings) {
            const object = objectsById.get(id);
            binding.node.visible = !!object && visibleObject(object);
            if (!object || !binding.node.visible) continue;
            positionVisualObject(binding, object);
            if (id === selectedId) {
              const bounds = new THREE.Box3().setFromObject(binding.node);
              if (!bounds.isEmpty()) visualSelectionGroup.add(new THREE.Box3Helper(bounds, 0xf59e0b));
            }
          }
        }
      }

      if (check) {
        for (const mesh of current.physicalMeshes ?? []) {
          const object = objectsById.get(mesh.id);
          if (!mesh.id || (object && visibleObject(object))) addTriangleMesh(mesh, mesh.id);
        }
        for (const report of current.solverObjects ?? []) {
          const object = objectsById.get(report.id);
          if (!object || !report.foliage || !visibleObject(object)) continue;
          const volume = createFoliageVolume(report.foliage, 0, true, report.id === selectedId);
          volume.name = report.id;
          buildingGroup.add(volume);
        }
        return;
      }
      type NamedStreetSegment = {
        key: string;
        name: string;
        length: number;
        startX: number;
        startZ: number;
        endX: number;
        endZ: number;
        angle: number;
      };
      const namedStreetSegments: NamedStreetSegment[] = [];
      current.buildings.forEach(b => {
        if (!visibleObject(b) || (!current.placementFloorId && loadedVisual?.bindings.has(b.id))) return;
        const selected = selectedId === b.id;
        if (b.rfRole === 'foliage' && b.foliage) {
          const volume = createFoliageVolume(b.foliage, b.baseZ ?? 0, false, selected);
          volume.name = b.id;
          buildingGroup.add(volume);
          return;
        }
        if (b.kind === 'mesh' && b.mesh) {
          addTriangleMesh(b.mesh, b.id, b.baseZ, b);
          return;
        }
        const pts = b.enuPoints;
        if (pts.length < 2) return;

        if (b.category === 'infrastructure') {
          if (b.source === 'template' && b.type === 'junction' && pts.length >= 3) {
            const junction = createJunction(pts, selected);
            junction.name = b.id;
            buildingGroup.add(junction);
            return;
          }
          const sidewalks = b.source === 'template' && (b.type === 'avenue' || b.type === 'lane') ? b.type : null;
          const roadWidth = sidewalks === 'avenue' ? 14 : sidewalks === 'lane' ? 10 : 7.5;
          for (let i = 0; i < pts.length - 1; i++) {
            const p1 = pts[i];
            const p2 = pts[i + 1];
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y; // North-South
            const segLen = Math.sqrt(dx * dx + dy * dy);
            if (segLen < 0.1) continue;

            const mx = (p1.x + p2.x) / 2;
            const mz = -(p1.y + p2.y) / 2; // Negate North-South for Three.js Z-axis
            const angle = Math.atan2(dy, dx); // Angle of rotation in XZ

            // Preserve every named segment. The layout pass below repeats a
            // street name at controlled intervals across its visible extent.
            const streetName = sceneObjectName(b, current.t)?.trim();
            if (streetName) {
              const key = streetName.toLocaleLowerCase();
              let labelAngle = angle;
              // Choose one consistent reading direction for the north-up
              // scene while keeping the text baseline parallel to the road.
              if (labelAngle > Math.PI / 2) labelAngle -= Math.PI;
              if (labelAngle < -Math.PI / 2) labelAngle += Math.PI;
              namedStreetSegments.push({
                key,
                name: streetName,
                length: segLen,
                startX: p1.x,
                startZ: -p1.y,
                endX: p2.x,
                endZ: -p2.y,
                angle: labelAngle,
              });
            }

            const road = createStreetSegment(segLen, roadWidth, { selected, sidewalks, markings: current.showOutlines });
            road.name = b.id;
            road.position.set(mx, 0, mz);
            road.rotation.y = angle;
            buildingGroup.add(road);
          }
          return;
        }

        // --- 2. VEGETATION / FLAT GREEN TERRAIN ---
        if (b.category === 'terrain') {
          if (pts.length < 3) return;

          // Draw green park polygons
          const shape = new THREE.Shape();
          shape.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            shape.lineTo(pts[i].x, pts[i].y);
          }
          shape.closePath();

          const terrainGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
          terrainGeom.rotateX(-Math.PI / 2);

          const terrainMat = new THREE.MeshStandardMaterial({
            color: selected ? 0xf59e0b : 0x86efac,
            roughness: 0.9,
            metalness: 0.05
          });

          const terrainMesh = new THREE.Mesh(terrainGeom, terrainMat);
          terrainMesh.name = b.id;
          terrainMesh.receiveShadow = true;
          terrainMesh.position.y = 0.05;
          buildingGroup.add(terrainMesh);

          // Add beautiful 3D low-poly conifer trees scattered inside the park area!
          // Compute simple 2D bounding box
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          pts.forEach(p => {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
          });

          // Seeded random tree generation to make it deterministic across rerenders
          let seed = b.id.charCodeAt(b.id.length - 1) || 42;
          const randomSeeded = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
          };

          // Scatter trees proportional to park area
          const area = (maxX - minX) * (maxY - minY);
          const numTrees = Math.min(12, Math.max(3, Math.floor(area / 300)));

          for (let t = 0; t < numTrees; t++) {
            const rx = minX + randomSeeded() * (maxX - minX);
            const ry = minY + randomSeeded() * (maxY - minY);

            // Verify if point is physically inside the park footprint
            if (isPointInPolygon({ x: rx, y: ry }, b.enuPoints)) {
              const treeGroup = new THREE.Group();
              treeGroup.name = b.id;
              treeGroup.position.set(rx, 0.09, -ry);

              // Wood trunk
              const trunkHeight = 1.2 + randomSeeded() * 1.2;
              const trunkGeom = new THREE.CylinderGeometry(0.18, 0.25, trunkHeight, 5);
              const trunkMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.95 }); // bark brown
              const trunkMesh = new THREE.Mesh(trunkGeom, trunkMat);
              trunkMesh.position.y = trunkHeight / 2;
              trunkMesh.castShadow = true;
              treeGroup.add(trunkMesh);

              // Conical green pine canopy
              const canopyHeight = 2.0 + randomSeeded() * 1.8;
              const canopyRadius = 0.7 + randomSeeded() * 0.7;
              const canopyGeom = new THREE.ConeGeometry(canopyRadius, canopyHeight, 5);
              
              const leafColors = [0x166534, 0x15803d, 0x14532d, 0x15803d];
              const leafColor = leafColors[Math.floor(randomSeeded() * leafColors.length)];
              const canopyMat = new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.9 });
              const canopyMesh = new THREE.Mesh(canopyGeom, canopyMat);
              canopyMesh.position.y = trunkHeight + canopyHeight / 2 - 0.25;
              canopyMesh.castShadow = true;
              treeGroup.add(canopyMesh);

              buildingGroup.add(treeGroup);
            }
          }
          return;
        }

        // --- 3. WATER BODIES (LAKES / RIVER PIPELINE) ---
        if (b.category === 'water') {
          if (pts.length < 3) return;

          const shape = new THREE.Shape();
          shape.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            shape.lineTo(pts[i].x, pts[i].y);
          }
          shape.closePath();

          const waterGeom = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
          waterGeom.rotateX(-Math.PI / 2);

          const waterMat = new THREE.MeshStandardMaterial({
            color: selected ? 0xf59e0b : 0x0ea5e9,
            roughness: 0.05,
            metalness: 0.3,
            transparent: true,
            opacity: 0.95
          });

          const waterMesh = new THREE.Mesh(waterGeom, waterMat);
          waterMesh.name = b.id;
          waterMesh.position.y = 0.08;
          buildingGroup.add(waterMesh);
          return;
        }

        if (b.kind === 'wall') {
          const [a, end] = pts;
          const h = b.height;
          addTriangleMesh({
            vertices: [a.x, a.y, 0, end.x, end.y, 0, end.x, end.y, h, a.x, a.y, h],
            triangles: [0, 1, 2, 0, 2, 3],
          }, b.id, b.baseZ);
          return;
        }

        // --- 4. BUILDINGS (DEFAULT RENDERING) ---
        if (pts.length < 3) return;

        const h = b.height;
        const shape = new THREE.Shape();
        // Shape works in 2D coordinates
        // Map East (X) and North (Y) to keep exact rotation directions
        shape.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          shape.lineTo(pts[i].x, pts[i].y);
        }
        shape.closePath();

        const extrudeSettings = {
          depth: h,
          bevelEnabled: false
        };

        const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        // Rotate so depth matches +Y height upright
        geom.rotateX(-Math.PI / 2);
        geom.translate(0, b.baseZ ?? 0, 0);

        // Matte, muted, solid buildings — matches Sionna RT's preview look.
        // Each building gets a distinct earthy tone (deterministic by id).
        const meshMat = new THREE.MeshStandardMaterial({
          color: selected ? 0xf59e0b : buildingColor(b.id),
          roughness: 0.97,
          metalness: 0.0,
          flatShading: true,
        });

        const mesh = new THREE.Mesh(geom, meshMat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = b.id;

        buildingGroup.add(mesh);
        if (b.source === 'template' && b.name) {
          const windows = createFacadeWindows(b, selected);
          if (windows) buildingGroup.add(windows);
        }

        // Optional blueprint edge outlines
        if (current.showOutlines) {
          const edgeGeom = new THREE.EdgesGeometry(geom);
          const outlineLine = new THREE.LineSegments(
            edgeGeom,
            new THREE.LineBasicMaterial({ color: 0x1e293b, linewidth: 1.5 }) // Dark Slate ink-blueprint borders for crisp silhouette
          );
          buildingGroup.add(outlineLine);
        }
      });

      // OSM splits roads at junctions and sometimes across multiple ways. Group
      // all pieces by normalized name, then place repeated labels roughly every
      // block along the visible street. Limits prevent dense maps from turning
      // into a wall of text.
      const segmentsByStreet = new Map<string, NamedStreetSegment[]>();
      namedStreetSegments.forEach((segment) => {
        const group = segmentsByStreet.get(segment.key) ?? [];
        group.push(segment);
        segmentsByStreet.set(segment.key, group);
      });

      const MAX_LABELS_PER_STREET = 4;
      const TARGET_REPEAT_METERS = 110;
      const MIN_REPEAT_SPACING_METERS = 65;
      const MIN_CROSS_STREET_SPACING_METERS = 12;
      const occupied: { x: number; z: number }[] = [];

      segmentsByStreet.forEach((segments) => {
        const totalVisibleLength = segments.reduce((sum, segment) => sum + segment.length, 0);
        const accepted: { x: number; z: number }[] = [];
        for (const segment of segments) {
          if (accepted.length >= MAX_LABELS_PER_STREET) break;

          const count = Math.min(
            MAX_LABELS_PER_STREET - accepted.length,
            Math.max(1, Math.ceil(segment.length / TARGET_REPEAT_METERS)),
          );
          const slotLength = segment.length / count;

          for (let index = 0; index < count; index++) {
            if (accepted.length >= MAX_LABELS_PER_STREET) break;
            const fraction = (index + 0.5) / count;
            const x = THREE.MathUtils.lerp(segment.startX, segment.endX, fraction);
            const z = THREE.MathUtils.lerp(segment.startZ, segment.endZ, fraction);
            const distanceTo = (point: { x: number; z: number }) =>
              Math.hypot(x - point.x, z - point.z);

            if (accepted.some((point) => distanceTo(point) < MIN_REPEAT_SPACING_METERS)) continue;
            if (occupied.some((point) => distanceTo(point) < MIN_CROSS_STREET_SPACING_METERS)) continue;

            const label = makeStreetLabelMesh(
              segment.name,
              // Curved OSM ways are often made of many short line segments.
              // Let a label span adjacent pieces when the named street has
              // enough total visible length, rather than dropping every name.
              Math.max(slotLength, Math.min(TARGET_REPEAT_METERS, totalVisibleLength)),
              renderer.capabilities.getMaxAnisotropy(),
            );
            if (!label) continue;

            // Apply rotations to the geometry in the same order as the asphalt
            // ribbon above. This keeps the decal fixed to the road during orbit.
            label.geometry.rotateX(-Math.PI / 2);
            label.geometry.rotateY(segment.angle);
            label.position.set(x, 0.24, z);
            streetLabelGroup.add(label);
            const position = { x, z };
            accepted.push(position);
            occupied.push(position);
          }
        }
      });
    }

    let activeReceiverModel: THREE.Group | null = null;
    const deployedAccessPointPosition = new THREE.Vector3();
    const deployedReceiverPosition = new THREE.Vector3();

    function updateReceiverPose() {
      if (!activeReceiverModel) return;
      const current = stateRef.current;
      const position = current.mobilityRxPosition;
      activeReceiverModel.position.copy(position ? enuToThree(position) : deployedReceiverPosition);
      activeReceiverModel.rotation.y = position ? current.mobilityRxHeading : 0;
    }

    function drawNodes3D() {
      clearGroup(transmitterGroup);
      clearGroup(receiverGroup);
      activeReceiverModel = null;

      const current = stateRef.current;
      if (!current.showDevices) return;

      const elevation = (device: Transmitter | Receiver) =>
        getDeviceElevation(device, current.buildings, current.solverRoofs);
      const mountHeight = (device: Transmitter | Receiver, top: number) =>
        device.heightReference === 'enu'
          ? Math.max(0, top - (elevation({ ...device, heightReference: 'roof', height: 0 }) ?? 0))
          : device.height;

      const placeModel = (model: THREE.Group, device: Transmitter | Receiver, kind: 'tx' | 'rx', top: number) => {
        model.position.copy(enuToThree({ ...device.enu, z: top }));
        const label = makeLabelSprite(device.name, kind === 'tx' ? '#d9aaa2' : '#a9c2c9');
        label.position.y = kind === 'tx' ? 8 : 6;
        model.add(label);
        model.traverse(part => {
          part.userData.deviceId = device.id;
          part.userData.deviceKind = kind;
        });
      };

      for (const ap of current.txs ?? [current.tx]) {
        const top = elevation(ap);
        if (top === undefined) continue;
        const active = ap.id === current.tx.id;
        const model = createAccessPointModel(
          mountHeight(ap, top), ap.beamsteeringAzimuth, ap.beamsteeringElevation, active,
        );
        placeModel(model, ap, 'tx', top);
        if (active) deployedAccessPointPosition.copy(model.position);
        transmitterGroup.add(model);
      }

      for (const ue of current.rxs ?? [current.rx]) {
        const active = ue.id === current.rx.id;
        const phaseCenter = elevation(ue) ?? (active ? current.mobilityRxPosition?.z : undefined);
        if (phaseCenter === undefined) continue;
        const model = createReceiverModel(mountHeight(ue, phaseCenter), active);
        placeModel(model, ue, 'rx', phaseCenter);
        receiverGroup.add(model);
        if (active) {
          activeReceiverModel = model;
          deployedReceiverPosition.copy(model.position);
        }
      }
      updateReceiverPose();
    }

    function drawRayPaths3D() {
      clearGroup(pathsGroup);

      const current = stateRef.current;
      // Rays draw in Link/Playback, and in Radio Coverage when the overlay toggle is on.
      const allowRays =
        current.activeMode === 'link' ||
        current.activeMode === 'playback' ||
        (current.activeMode === 'heatmap' && current.showRaysOnHeatmap);
      if (!allowRays) return;

      // Playback must show the active per-step mobility rays. Matrix mode still
      // draws every Tx/Rx pair in link/heatmap overlays.
      const list = current.activeMode !== 'playback' && current.matrixPaths && current.matrixPaths.length > 0
        ? current.matrixPaths
        : current.paths;

      list.forEach(path => {
        const points = path.points.map(enuToThree);
        const geom = new THREE.BufferGeometry().setFromPoints(points);

        // Neon coloring: Link status green, reflections glowing orange splitters
        const color = path.type === 'LOS' ? 0x22c55e : 0xf97316;
        const width = path.type === 'LOS' ? 2.5 : 1.2;

        const mat = new THREE.LineBasicMaterial({
          color: color,
          linewidth: width,
          transparent: true,
          opacity: 0.9
        });

        const line = new THREE.Line(geom, mat);
        pathsGroup.add(line);

        // Stagger animated propagation wave rings moving along the wire!
        points.forEach((pt, pi) => {
          if (pi < points.length - 1) {
            // Render bouncing point spheres
            const ringGeom = new THREE.OctahedronGeometry(0.7, 1);
            const ringMat = new THREE.MeshBasicMaterial({ color: color, wireframe: true });
            const pMesh = new THREE.Mesh(ringGeom, ringMat);
            pMesh.position.copy(pt);
            pathsGroup.add(pMesh);
          }
        });
      });
    }

    // 9. DYNAMIC HEATMAP: Instanced colored grid squares for ultra performance
    function drawRadioMap3D() {
      clearGroup(heatmapGroup);

      const current = stateRef.current;
      if (current.activeMode !== 'heatmap' || !current.radioMap) return;

      const rm = current.radioMap;
      const metric = rm.metric ?? 'power';
      const size = rm.gridSize;
      const terrain = current.buildings.some(object => object.rfRole === 'ground' && object.mesh);

      const range = coverageDisplayRange(rm, current.rmAutoRange, current.rmVmin, current.rmVmax);
      if (!range) return;
      const valid: { position: ENUVector; value: number }[] = [];
      for (const cell of rm.cells) {
        // Cells outside the authored terrain have no usable coverage value.
        const value = coverageCellValue(cell, metric);
        if (value === null) continue;
        const z = rm.floorId ? cell.z : terrain ? cell.z - rm.heightOffset + 0.2 : 0.2;
        valid.push({ position: { x: cell.x, y: cell.y, z }, value });
      }

      // Solid cell tiles that tile seamlessly (no gaps), flat on the ground.
      const cellGeom = new THREE.PlaneGeometry(size * 1.02, size * 1.02);
      cellGeom.rotateX(-Math.PI / 2);

      const cellMat = new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1.0,
      });

      const instMesh = new THREE.InstancedMesh(cellGeom, cellMat, valid.length);
      instMesh.renderOrder = 3; // draw cleanly over the ground grid
      const dummy = new THREE.Object3D();
      const tmp = new THREE.Color();

      valid.forEach((cell, idx) => {
        dummy.position.copy(enuToThree(cell.position));
        dummy.updateMatrix();
        instMesh.setMatrixAt(idx, dummy.matrix);

        instMesh.setColorAt(idx, setCoverageColor(current.rmColormap, cell.value, range, tmp));
      });

      instMesh.instanceColor!.needsUpdate = true;
      heatmapGroup.add(instMesh);
    }


    function drawTrajectory3D() {
      clearGroup(trajectoryGroup);

      const current = stateRef.current;
      if (current.trajectoryPoints.length === 0) return;

      const pts = current.trajectoryPoints.map(({ enu }) => {
        const position = getWaypointPosition(enu, current.rx, current.buildings, current.solverRoofs, current.waypointFrame);
        return position && enuToThree(position);
      });
      const segments: THREE.Vector3[] = [];
      for (let i = 1; i < pts.length; i++) {
        const start = pts[i - 1], end = pts[i];
        if (start && end) segments.push(start, end);
      }
      if (segments.length) {
        const geom = new THREE.BufferGeometry().setFromPoints(segments);
        const mat = new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.95 });
        trajectoryGroup.add(new THREE.LineSegments(geom, mat));
      }

      pts.forEach((pt, idx) => {
        if (!pt) return;
        const color = idx === 0 ? 0x10b981 : idx === pts.length - 1 ? 0xf27d26 : 0xe2e8f0;
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(idx === 0 || idx === pts.length - 1 ? 1.1 : 0.75, 12, 12),
          new THREE.MeshBasicMaterial({ color }),
        );
        marker.position.copy(pt);
        trajectoryGroup.add(marker);
      });
    }

    // Initial build — the dynamic layers (nodes/rays/heatmap/trajectory) draw on
    // the first animation frame via the change watcher below.
    // 10. ANCHORED RAYCAST EVENT LISTENER (Snaps Tx / Rx precisely onto ground/roof points)
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const drawingPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0));
    const walkKeys = new Set<string>();
    let walkView: { camera: WalkCameraState; orbitPosition: THREE.Vector3; orbitTarget: THREE.Vector3; near: number } | null = null;
    let walkDrag: { pointerId: number; x: number; y: number } | null = null;
    let press: { x: number; y: number; dragged: boolean } | null = null;

    function sceneHits(includeGround: boolean) {
      const objects = includeGround ? [ground, ...buildingGroup.children] : [...buildingGroup.children];
      if (loadedVisual?.root.visible) {
        // Raycaster visits invisible objects too. Only include active asset roots.
        objects.push(...loadedVisual.root.children.filter(object => object.visible));
      }
      return raycaster.intersectObjects(objects, true);
    }

    function scenePointerPoint() {
      const editor = stateRef.current.sceneEditor;
      if (editor && editor.tool !== 'select' && authoredGroundIds.size === 0) {
        return raycaster.ray.intersectPlane(drawingPlane, new THREE.Vector3());
      }
      return sceneHits(ground.visible).find(({ object }) => {
        if (!(object instanceof THREE.Mesh)) return false;
        if (editor?.tool !== 'generate') return true;
        const id = selectedObjectId(object);
        return id !== undefined && authoredGroundIds.has(id);
      })?.point;
    }

    function selectedObjectId(hit: THREE.Object3D): string | undefined {
      for (let part: THREE.Object3D | null = hit; part && part !== scene; part = part.parent) {
        const id = loadedVisual?.ids.get(part);
        if (id) return id;
        if (part.parent === buildingGroup) return part.name || undefined;
      }
    }

    function pickHorizontalSurface(floorId?: string) {
      const { buildings } = stateRef.current;
      return findHorizontalSurface(sceneHits(ground.visible), object => {
        const id = selectedObjectId(object);
        if (floorId) return id === floorId;
        const role = id ? buildings.find(candidate => candidate.id === id)?.rfRole : undefined;
        return role !== 'visual' && role !== 'foliage';
      })?.point;
    }

    function startWalk(point: THREE.Vector3) {
      const orbitPosition = camera.position.clone();
      const orbitTarget = controls.target.clone();
      // Discard any remaining orbit damping before restoring the saved pose later.
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = true;
      walkView = {
        camera: createWalkCamera(point, orbitTarget.clone().sub(orbitPosition)),
        orbitPosition, orbitTarget, near: camera.near,
      };
      controls.enabled = false;
      camera.near = 0.08;
      camera.updateProjectionMatrix();
      renderer.domElement.focus({ preventScroll: true });
      setHoveredCoordinate(null);
      setWalkPhase('active');
    }

    function stopWalk() {
      walkKeys.clear();
      if (walkDrag && renderer.domElement.hasPointerCapture(walkDrag.pointerId)) {
        renderer.domElement.releasePointerCapture(walkDrag.pointerId);
      }
      walkDrag = null;
      if (walkView) {
        camera.position.copy(walkView.orbitPosition);
        controls.target.copy(walkView.orbitTarget);
        camera.near = walkView.near;
        camera.updateProjectionMatrix();
        controls.enabled = true;
        controls.update();
        walkView = null;
      }
      setWalkPhase('pick');
    }

    function handleWalkKeyDown(e: KeyboardEvent) {
      if (!walkView || stateRef.current.sceneNavigation !== 'walk' || !WALK_KEYS.has(e.code) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      walkKeys.add(e.code);
    }

    function handleWalkKeyUp(e: KeyboardEvent) { walkKeys.delete(e.code); }
    function clearWalkKeys() { walkKeys.clear(); }

    function handleWalkEscape(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented || stateRef.current.sceneNavigation === 'orbit') return;
      if (e.target instanceof Element && e.target.closest('dialog[open], input, select, textarea, [contenteditable]')) return;
      e.preventDefault();
      stopWalk();
      setNavigationMode('orbit');
    }

    function handlePointerDown(e: PointerEvent) {
      if (walkView && stateRef.current.sceneNavigation === 'walk' && e.button === 0 && e.isPrimary) {
        e.preventDefault();
        renderer.domElement.focus({ preventScroll: true });
        renderer.domElement.setPointerCapture(e.pointerId);
        walkDrag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
      press = e.button === 0 ? { x: e.clientX, y: e.clientY, dragged: false } : null;
    }

    function handleContainerClick(e: MouseEvent) {
      const dragged = press && (press.dragged || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5);
      press = null;
      if (e.button !== 0 || dragged) return;
      const current = stateRef.current;
      if (!current.sceneEditor && !current.editing) return;
      if (current.sceneNavigation === 'pan' || walkView) return;

      // Calculate mouse canvas click coords
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      if (current.sceneNavigation === 'walk') {
        const point = pickHorizontalSurface();
        if (point) startWalk(point);
        else setWalkPhase('no-surface');
        return;
      }

      if (current.sceneEditor) {
        if (current.sceneEditor.tool === 'select') {
          let id: string | undefined;
          for (const { object } of sceneHits(false)) {
            id = selectedObjectId(object);
            if (id) break;
          }
          current.onSelectSceneObject?.(id ?? null);
          return;
        }
        const point = scenePointerPoint();
        if (!point) return;
        current.sceneEditor.click({ x: point.x, y: -point.z, z: current.sceneEditor.tool === 'generate' ? point.y : 0 });
        return;
      }

      if (current.placementMode === 'none' && !current.drawingTrajectory) {
        const hit = raycaster.intersectObjects([transmitterGroup, receiverGroup], true)
          .find(({ object }) => typeof object.userData.deviceId === 'string');
        if (hit) {
          const { deviceId, deviceKind } = hit.object.userData;
          current.onSelectDevice(deviceKind, deviceId);
        }
        return;
      }

      const floorId = current.placementFloorId;
      const device = current.placementMode.endsWith('tx') ? current.tx : current.rx;
      const point = floorId ? pickHorizontalSurface(floorId) : scenePointerPoint();
      if (!point) {
        if (floorId) setPlacementIssue('floor');
        else if (device.heightReference === 'ground') setPlacementIssue('terrain');
        return;
      }

      const enu = { x: point.x, y: -point.z, z: floorId ? point.y + current.floorOffset : 0 };
      if (current.placementMode !== 'none') {
        if (!floorId && getDeviceElevation({ ...device, enu }, current.buildings, current.solverRoofs) === undefined) {
          setPlacementIssue('terrain');
          return;
        }
        setPlacementIssue(undefined);
        current.onPlaceDevice(current.placementMode, enu, floorId ? enu.z : undefined);
      } else if (current.drawingTrajectory) {
        const resolve = (position: ENUVector) => getWaypointPosition(position, current.rx, current.buildings, current.solverRoofs);
        const frame = floorId ? 'ENU_m' : current.waypointFrame;
        const next = floorId ? enu : resolve(enu);
        if (!next) {
          setPlacementIssue('terrain');
          return;
        }
        let points = current.trajectoryPoints;
        if (floorId && !current.waypointFrame) {
          points = [];
          for (const entry of current.trajectoryPoints) {
            const position = resolve(entry.enu);
            if (!position) {
              setPlacementIssue('route');
              return;
            }
            points.push({ ...entry, enu: position });
          }
        }
        setPlacementIssue(undefined);
        current.setTrajectoryPoints([...points, { ...enuToLatLon(enu, current.anchor), enu: frame ? next : enu }], frame);
      }
    }

    function handlePointerMove(e: PointerEvent) {
      if (walkView) {
        if (walkDrag?.pointerId === e.pointerId) {
          rotateWalkCamera(walkView.camera, e.clientX - walkDrag.x, e.clientY - walkDrag.y);
          walkDrag.x = e.clientX;
          walkDrag.y = e.clientY;
        }
        return;
      }
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) press.dragged = true;
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const current = stateRef.current;
      const hitPt = current.sceneNavigation === 'walk' || current.placementFloorId
        ? pickHorizontalSurface(current.placementFloorId) : scenePointerPoint();
      if (stateRef.current.sceneEditor?.tool === 'generate') {
        footprintHover = hitPt ?? null;
        updateFootprintPreview();
      }
      if (hitPt) {
        setHoveredCoordinate({
          x: hitPt.x,
          y: -hitPt.z,
          z: hitPt.y
        });
      } else {
        setHoveredCoordinate(null);
      }
    }

    function handleWalkPointerEnd(e: PointerEvent) {
      if (walkDrag?.pointerId === e.pointerId) walkDrag = null;
    }

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('lostpointercapture', handleWalkPointerEnd);
    renderer.domElement.addEventListener('keydown', handleWalkKeyDown);
    renderer.domElement.addEventListener('keyup', handleWalkKeyUp);
    renderer.domElement.addEventListener('blur', clearWalkKeys);
    window.addEventListener('blur', clearWalkKeys);
    window.addEventListener('keydown', handleWalkEscape);
    const clearCoordinates = () => {
      footprintHover = null;
      updateFootprintPreview();
      setHoveredCoordinate(null);
    };
    renderer.domElement.addEventListener('pointerleave', clearCoordinates);
    renderer.domElement.addEventListener('click', handleContainerClick);

    // 11. CENTRALIZED REALTIME ANIMATION DRAW LOOP
    let animationFrameId: number;
    let lastTime = performance.now();
    let lastFrameTime = lastTime;
    let frameCount = 0;

    // Redraw each dynamic layer only when one of its inputs actually changed.
    // App state updates are immutable, so reference comparison is exact — no
    // string keys, no polling interval, no rebuild churn.
    type Snapshot = Partial<typeof stateRef.current>;
    let prev: Snapshot | null = null;
    let previousWalk = false;

    const watchAndRedraw = () => {
      const c = stateRef.current;
      const first = prev === null;
      const p = prev ?? ({} as Snapshot);

      if (c.performanceMode !== p.performanceMode) {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, c.performanceMode === 'high' ? 2 : 0.85));
      }
      if (c.sceneVisual !== p.sceneVisual) replaceSceneVisual(c.sceneVisual);
      const authoredScene = !!(c.sceneName || c.sceneVisual);
      const openingGeneratedScene = (first || c.anchor !== p.anchor) && c.buildings.some(object => object.buildingSpec);
      if (c.sceneName !== p.sceneName || c.sceneVisual !== p.sceneVisual ||
          (authoredScene && c.anchor !== p.anchor) || openingGeneratedScene) {
        if (c.sceneNavigation === 'walk') {
          stopWalk();
          setNavigationMode('orbit');
        }
        frameScene(authoredScene, c.buildings, openingGeneratedScene);
      }
      if (walkView && (c.sceneFloor !== p.sceneFloor || c.sceneNavigation !== 'walk')) stopWalk();
      const walking = !!walkView;
      if (walking !== previousWalk || c.t !== p.t || c.buildings !== p.buildings || c.showOutlines !== p.showOutlines || c.sceneVisual !== p.sceneVisual ||
          c.sceneFloor !== p.sceneFloor || c.placementFloorId !== p.placementFloorId || c.solverCheck !== p.solverCheck || c.physicalMeshes !== p.physicalMeshes ||
          c.solverObjects !== p.solverObjects || c.sceneEditor?.selected?.id !== p.sceneEditor?.selected?.id ||
          c.sceneEditor?.hiddenLayers !== p.sceneEditor?.hiddenLayers) rebuildBuildings3D();
      if (c.sceneEditor?.draft !== p.sceneEditor?.draft || c.sceneEditor?.tool !== p.sceneEditor?.tool) {
        if (c.sceneEditor?.tool !== 'generate') footprintHover = null;
        rebuildDraft();
        updateFootprintPreview();
      }
      if (first || c.buildings !== p.buildings || c.solverRoofs !== p.solverRoofs || c.tx !== p.tx || c.rx !== p.rx || c.txs !== p.txs || c.rxs !== p.rxs ||
          Boolean(c.mobilityRxPosition) !== Boolean(p.mobilityRxPosition) ||
          c.showDevices !== p.showDevices) {
        drawNodes3D();
      } else if (c.mobilityRxPosition !== p.mobilityRxPosition || c.mobilityRxHeading !== p.mobilityRxHeading) {
        updateReceiverPose();
      }
      if (first || c.paths !== p.paths || c.matrixPaths !== p.matrixPaths ||
          c.activeMode !== p.activeMode || c.showRaysOnHeatmap !== p.showRaysOnHeatmap) {
        drawRayPaths3D();
      }
      if (first || c.radioMap !== p.radioMap || c.activeMode !== p.activeMode || c.buildings !== p.buildings ||
          c.rmColormap !== p.rmColormap || c.rmAutoRange !== p.rmAutoRange ||
          c.rmVmin !== p.rmVmin || c.rmVmax !== p.rmVmax) {
        drawRadioMap3D();
      }
      if (first || c.rx !== p.rx || c.trajectoryPoints !== p.trajectoryPoints || c.waypointFrame !== p.waypointFrame ||
          c.solverRoofs !== p.solverRoofs || c.buildings !== p.buildings) drawTrajectory3D();

      prev = { ...c };
      previousWalk = walking;
    };

    let followingTx = false;
    let overhead = false;
    let lastFocus: ThreeStudioProps['focusObject'];

    function frameScene(authoredScene: boolean, objects: BuildingFootprint[], openingGeneratedScene: boolean) {
      const bounds = new THREE.Box3();
      if (authoredScene || openingGeneratedScene) objects.forEach(object => expandObjectBounds(bounds, object));

      const lowPoint = authoredScene && !bounds.isEmpty() ? Math.min(0, bounds.min.y) : 0;
      ground.position.y = lowPoint - 0.2;
      gridHelper.position.y = lowPoint - 0.1;
      if (bounds.isEmpty()) {
        controls.target.set(0, 0, 0);
        if (objects.some(object => object.source === 'template' && object.type === 'avenue')) {
          camera.position.set(-228, 166, 93);
        } else {
          camera.position.set(0, 180, 240);
        }
      } else {
        const { center, radius } = bounds.getBoundingSphere(new THREE.Sphere());
        const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
        const halfFov = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
        const distance = Math.max(7, 0.95 * radius / Math.sin(halfFov));
        const offset = new THREE.Vector3(0.88, 0.8, 1).setLength(distance);
        controls.target.copy(center);
        camera.position.copy(center).add(offset);
      }
      controls.update();
      controls.saveState();
      if (overhead) {
        const distance = camera.position.distanceTo(controls.target);
        camera.position.copy(controls.target).add(new THREE.Vector3(0, distance, distance * 0.001));
      }
    }

    const updateCamera = (deltaSeconds = 0) => {
      const current = stateRef.current;
      const top = !!current.sceneEditor?.top;
      const locating = current.focusObject && current.focusObject !== lastFocus;
      if (walkView && (current.sceneNavigation !== 'walk' || locating || top !== overhead)) {
        stopWalk();
        if (current.sceneNavigation === 'walk') setNavigationMode('orbit');
      }
      if (walkView) {
        advanceWalkCamera(walkView.camera, walkKeys, deltaSeconds);
        const { position, yaw, pitch } = walkView.camera;
        camera.position.copy(position);
        camera.rotation.set(pitch, yaw, 0, 'YXZ');
        return;
      }

      const panning = current.sceneNavigation === 'pan';
      controls.mouseButtons.LEFT = panning ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
      controls.touches.ONE = panning ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
      controls.zoomToCursor = !!current.sceneEditor;
      if (top !== overhead) {
        if (top) {
          controls.saveState();
          const distance = camera.position.distanceTo(controls.target);
          camera.position.copy(controls.target).add(new THREE.Vector3(0, distance, distance * 0.001));
        } else {
          const distance = camera.position.distanceTo(controls.target);
          const offset = controls.position0.clone().sub(controls.target0).setLength(distance);
          camera.position.copy(controls.target).add(offset);
        }
        controls.enableRotate = !top;
        overhead = top;
      }
      const shouldFollowTx = !current.sceneEditor && current.cameraMode === 'lockTx';
      if (shouldFollowTx && !followingTx) {
        controls.saveState();
      } else if (!shouldFollowTx && followingTx) {
        // Clear any momentum from the tracking view before restoring the free view.
        const damping = controls.enableDamping;
        controls.enableDamping = false;
        controls.update();
        controls.reset();
        controls.enableDamping = damping;
      }
      followingTx = shouldFollowTx;

      if (shouldFollowTx) {
        controls.target.lerp(deployedAccessPointPosition, 0.1);
      }
      if (locating) {
        lastFocus = current.focusObject;
        const object = current.buildings.find(building => building.id === lastFocus?.id);
        if (object) {
          const bounds = new THREE.Box3();
          const groupId = object.buildingSpec?.id;
          if (groupId) {
            for (const part of current.buildings) {
              if (part.buildingSpec?.id === groupId &&
                isSceneObjectVisible(part, current.sceneEditor?.hiddenLayers, current.sceneFloor)) {
                expandObjectBounds(bounds, part);
              }
            }
          } else {
            const visual = loadedVisual?.bindings.get(object.id)?.node;
            if (visual?.visible && loadedVisual?.root.visible) bounds.setFromObject(visual);
            else expandObjectBounds(bounds, object);
          }
          if (!bounds.isEmpty()) {
            const center = bounds.getCenter(new THREE.Vector3());
            const span = bounds.getSize(new THREE.Vector3()).length();
            const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
            const halfFov = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
            const distance = groupId
              ? Math.max(7, span * 0.55 / Math.sin(halfFov))
              : Math.max(current.sceneName || current.sceneVisual ? 5 : 30, span * 1.6);
            const offset = camera.position.clone().sub(controls.target).setLength(distance);
            controls.target.copy(center);
            camera.position.copy(center).add(offset);
          }
        }
      }
      controls.update();
    };

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const time = performance.now();
      const deltaSeconds = (time - lastFrameTime) / 1000;
      lastFrameTime = time;
      if (!stateRef.current.visible) return;

      // FPS tracking counter (skip the state update when the reading is stable
      // so an idle scene doesn't re-render React every second).
      frameCount++;
      if (time >= lastTime + 1000) {
        const fpsNow = Math.round((frameCount * 1000) / (time - lastTime));
        setFps((old) => (Math.abs(old - fpsNow) > 1 ? fpsNow : old));
        frameCount = 0;
        lastTime = time;
      }

      watchAndRedraw();
      updateCamera(deltaSeconds);
      renderer.render(scene, camera);
    };

    animate();

    // Capture on demand without preserveDrawingBuffer (which would penalize
    // every frame). Re-render once, then encode the full backing canvas so a
    // Retina/HiDPI viewport exports at its native pixel resolution.
    captureScreenshotRef.current = () => {
      setScreenshotStatus('saving');
      watchAndRedraw();
      updateCamera();
      renderer.render(scene, camera);
      renderer.domElement.toBlob((blob) => {
        if (!blob) {
          setScreenshotStatus('error');
          return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `sionna_rt_studio_scene_${timestamp}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Safari may consume the blob URL after the click handler returns.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setScreenshotStatus('saved');
        window.setTimeout(() => setScreenshotStatus('idle'), 1800);
      }, 'image/png');
    };

    // 12. DYNAMIC STATE WATCHERS
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      if (w === 0) return;
      const h = containerRef.current.clientHeight || 580;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      captureScreenshotRef.current = null;
      ++visualLoadGeneration;
      loadedVisual?.dispose();
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('lostpointercapture', handleWalkPointerEnd);
      renderer.domElement.removeEventListener('keydown', handleWalkKeyDown);
      renderer.domElement.removeEventListener('keyup', handleWalkKeyUp);
      renderer.domElement.removeEventListener('blur', clearWalkKeys);
      window.removeEventListener('blur', clearWalkKeys);
      window.removeEventListener('keydown', handleWalkEscape);
      renderer.domElement.removeEventListener('pointerleave', clearCoordinates);
      renderer.domElement.removeEventListener('click', handleContainerClick);
      controls.dispose();
      // Release every GPU resource this effect created.
      [buildingGroup, visualSelectionGroup, draftGroup, streetLabelGroup, transmitterGroup, receiverGroup, pathsGroup,
       heatmapGroup, trajectoryGroup, interactionGroup].forEach(clearGroup);
      disposeObject3D(footprintPreview);
      ground.geometry.dispose();
      groundMat.dispose();
      gridHelper.geometry.dispose();
      (gridHelper.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, []);

  const placementButtons: { mode: DevicePlacement; label: string; title: string }[] = [
    { mode: 'add-tx', label: t('+ Add AP', '+ 新增 AP'), title: t('Add a transmitter at each scene click', '每点击一个位置，就新增一个发射端（AP / Tx）') },
    { mode: 'add-rx', label: t('+ Add UE', '+ 新增 UE'), title: t('Add a receiver at each scene click', '每点击一个位置，就新增一个接收端（UE / Rx）') },
    { mode: 'move-tx', label: t('Move selected AP', '移动所选 AP'), title: t(`Choose a new location for ${tx.name}`, `为 ${tx.name} 选择新位置`) },
    { mode: 'move-rx', label: t('Move selected UE', '移动所选 UE'), title: t(`Choose a new location for ${rx.name}`, `为 ${rx.name} 选择新位置`) },
  ];
  const placementHint = {
    'none': '',
    'add-tx': t('Click the scene to add APs. Press Esc or Done to finish.', '点击场景连续添加 AP，按 Esc 或点击「完成」结束。'),
    'add-rx': t('Click the scene to add UEs. Press Esc or Done to finish.', '点击场景连续添加 UE，按 Esc 或点击「完成」结束。'),
    'move-tx': t(`Click the new location for ${tx.name}. Esc cancels.`, `点击场景移动 ${tx.name}，按 Esc 取消。`),
    'move-rx': t(`Click the new location for ${rx.name}. Esc cancels.`, `点击场景移动 ${rx.name}，按 Esc 取消。`),
  }[placementMode];
  const placementFeedback = placementIssue === 'floor'
    ? t('No supporting surface on this floor. Choose a solid part of the slab.', '此处没有楼板支撑面。请选择楼板实体区域。')
    : placementIssue === 'terrain'
      ? t('No terrain surface at that point. Choose a point on the terrain.', '此处没有地形表面。请在地形上重新选点。')
      : placementIssue === 'route'
        ? t('An existing waypoint has no terrain surface. Adjust the route before placing a floor waypoint.',
          '已有控制点下方没有地形。请先调整轨迹，再添加楼板控制点。')
        : activePlacementFloor && (placementMode !== 'none' || drawingTrajectory)
          ? t('Click the slab to place the antenna at the specified height above it.', '点击楼板，天线将放在指定的离板高度。')
          : placementHint || (drawingTrajectory ? t('Click to add a waypoint. Esc ends drawing.', '点击添加轨迹点，按 Esc 结束绘制。') : '');

  const viewButton = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--ink-750)]';
  const navigationButtons = [
    { mode: 'orbit', Icon: Rotate3D, label: t('Orbit', '旋转'), title: t('Drag to orbit. Right-drag or Shift-drag to pan.', '拖动旋转视角。右键拖动或按住 Shift 拖动可平移。') },
    { mode: 'pan', Icon: Hand, label: t('Pan', '平移'), title: t('Drag to move the view.', '直接拖动即可平移视图。') },
    { mode: 'walk', Icon: Footprints, label: t('Walk', '漫游'), title: t('Choose a point on the ground or a floor to enter first-person view.', '点击地面或楼板，进入第一人称视角。') },
  ] as const;
  const navigationHint = sceneNavigation === 'pan'
    ? t('Drag to pan · Scroll or pinch to zoom', '拖动平移 · 滚动或双指捏合缩放')
    : sceneNavigation === 'walk'
      ? walkPhase === 'active'
        ? t('Drag to look · WASD or arrows to move · Q/E down/up · Esc to exit', '拖动转头 · WASD 或方向键移动 · Q/E 下降／上升 · Esc 退出')
        : walkPhase === 'no-surface'
          ? t('No floor at that point. Click the ground or select a floor and try again.', '该处未找到地面或楼板。请选择楼层，再点击可见的楼板。')
          : t('Select a floor to see inside. Click the ground or a floor to start walking.', '查看室内时先选择楼层。点击地面或楼板开始漫游。')
      : '';
  const coordinates = hoveredCoordinate && (
    <span className="readout">
      {t('East / North / Up (m)', '东向 / 北向 / 高程（米）')} · {hoveredCoordinate.x.toFixed(1)}, {hoveredCoordinate.y.toFixed(1)}, {hoveredCoordinate.z.toFixed(1)}
    </span>
  );

  return (
    <div id="three-studio-frame" className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-[#f4f6f8]">
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          id="canvas-3d"
          tabIndex={sceneEditor ? 0 : undefined}
          className={cn('absolute inset-0 block h-full w-full',
            (placementHint || drawingTrajectory || (sceneEditor && sceneEditor.tool !== 'select') ||
              (sceneNavigation === 'walk' && walkPhase !== 'active')) && 'cursor-crosshair',
            (sceneNavigation === 'pan' || (sceneNavigation === 'walk' && walkPhase === 'active')) && 'cursor-grab active:cursor-grabbing')}
          aria-label={t('3D propagation scene', '三维传播场景')}
        />

        {sceneEditor && <div role="group" aria-label={t('Scene navigation', '场景浏览')}
          className="absolute left-2 top-2 z-10 flex max-w-[calc(100%-90px)] flex-wrap gap-1">
          {navigationButtons.map(({ mode, Icon, label, title }) => <button key={mode} id={`btn-scene-${mode}`}
            type="button" className="studio-tool" title={title} aria-pressed={sceneNavigation === mode}
            disabled={!canNavigateScene || canvasState !== 'active'} onClick={() => {
              setWalkPhase('pick');
              setNavigationMode(mode === 'walk' && sceneNavigation === 'walk' ? 'orbit' : mode);
            }}>
            <Icon className="h-4 w-4" aria-hidden="true" />{label}
          </button>)}
        </div>}

        {editing && (
          <div className="absolute left-2 top-2 z-10 flex max-w-[calc(100%-90px)] flex-wrap gap-1">
            {placementButtons
              .filter(({ mode }) => mode.startsWith('add-') || mode === `move-${deploymentSelection}`)
              .map(({ mode, label, title }) => (
                <button key={mode} id={`btn-${mode}`} type="button" title={title}
                  aria-pressed={placementMode === mode} className="studio-tool"
                  onClick={() => setPlacementMode(placementMode === mode ? 'none' : mode)}>
                  {label}
                </button>
              ))}
            {deploymentSelection === 'rx' && (
              <button id="btn-draw-3d-mobility-path" type="button" aria-pressed={drawingTrajectory}
                className="studio-tool" onClick={() => {
                  setPlacementMode('none');
                  setPathDrawingMode(!drawingTrajectory);
                }}>
                {drawingTrajectory ? t('Finish route', '结束绘制') : t('Draw route', '绘制轨迹')}
              </button>
            )}
            {placementMode !== 'none' && (
              <button id="btn-finish-placement" type="button" className="studio-tool" onClick={() => setPlacementMode('none')}>
                {placementMode.startsWith('add-') ? t('Done', '完成') : t('Cancel', '取消')}
              </button>
            )}
            {drawingTrajectory && (
              <button id="btn-undo-3d-mobility-path" type="button" className="studio-tool"
                disabled={trajectoryPoints.length === 0}
                onClick={() => setTrajectoryPoints(trajectoryPoints.slice(0, -1), trajectoryPoints.length > 1 ? waypointFrame : undefined)}>
                {t('Undo point', '撤销轨迹点')}
              </button>
            )}
            {floors.length > 0 && (
              <label className="studio-tool">
                {t('Placement surface', '放置表面')}
                <select id="deployment-floor" className="max-w-48 truncate rounded border border-[var(--line)] bg-white"
                  value={activePlacementFloor?.id ?? ''} onChange={event => setPlacementFloorId(event.target.value || undefined)}>
                  <option value="">{t('Scene', '场景')}</option>
                  {floors.map(object => <option key={object.id} value={object.id}>
                    {sceneObjectName(object, t) ?? object.floor} · {object.id}
                  </option>)}
                </select>
              </label>
            )}
            {activePlacementFloor && (placementMode !== 'none' || drawingTrajectory) && (
              <label className="studio-tool">
                {t('Height above slab (m)', '离板高度（米）')}
                <NumberField id="deployment-floor-offset" value={floorOffset} min={0} step="any"
                  className="w-16 rounded border border-[var(--line)] bg-white px-1"
                  onChange={offset => setFloorOffsets(previous => ({ ...previous, [floorKind]: offset }))} />
              </label>
            )}
          </div>
        )}

        <details className="absolute right-2 top-2 z-10">
          <summary className="studio-tool list-none" aria-label={t('Viewport settings', '视图设置')}>
            <Eye aria-hidden="true" className="h-4 w-4" />
            {t('View', '视图')}
            <ChevronDown aria-hidden="true" className="h-3 w-3" />
          </summary>
          <div className="panel absolute right-0 mt-1 w-48 space-y-0.5 p-1.5 text-sm shadow-md">
            {sceneEditor ? (
              <>
                <label className={viewButton}>
                  <input type="checkbox" checked={sceneEditor.top} onChange={event => {
                    if (sceneNavigation === 'walk' && walkPhase === 'active') setNavigationMode('orbit');
                    sceneEditor.setTop(event.target.checked);
                  }} />
                  {t('Top view', '俯视')}
                </label>
                <label className={viewButton}>
                  <input type="checkbox" checked={showDevices} onChange={onToggleSceneDevices} />
                  {t('Reference AP/UE', '参考 AP / UE')}
                </label>
              </>
            ) : (
              <label className={viewButton}>
                <input id="btn-camera-mode" type="checkbox" checked={cameraMode === 'lockTx'}
                  onChange={event => setCameraMode(event.target.checked ? 'lockTx' : 'orbit')} />
                {t('Follow selected AP', '跟踪所选 AP')}
              </label>
            )}
            <label className={viewButton}>
              <input type="checkbox" checked={showOutlines} onChange={event => setShowOutlines(event.target.checked)} />
              {t('Outlines', '轮廓线')}
            </label>
            <label className={viewButton}>
              <input type="checkbox" checked={performanceMode === 'high'}
                onChange={event => setPerformanceMode(event.target.checked ? 'high' : 'eco')} />
              {t('High quality', '高画质')}
            </label>
            <button id="btn-export-scene-screenshot" type="button" className={viewButton}
              onClick={() => captureScreenshotRef.current?.()} disabled={canvasState !== 'active' || screenshotStatus === 'saving'}>
              <Camera aria-hidden="true" className="h-4 w-4" />
              {screenshotStatus === 'saving' ? t('Saving…', '正在保存…')
                : screenshotStatus === 'saved' ? t('PNG saved', '已保存 PNG')
                : screenshotStatus === 'error' ? t('Screenshot failed', '截图失败')
                : t('Save screenshot', '保存截图')}
            </button>
            {canvasState === 'active' && <p className="readout px-2 py-1 text-xs text-[var(--text-mid)]">WebGL · {fps} FPS</p>}
          </div>
        </details>

        <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex max-w-[85%] flex-col items-start gap-1 text-xs">
          {navigationHint && <p role="status" className="rounded border border-[var(--line)] bg-white/95 px-2 py-1 font-semibold">
            {navigationHint}
          </p>}
          {placementFeedback && (
            <p role="status" className="rounded border border-[var(--line)] bg-white/95 px-2 py-1 font-semibold">
              {placementFeedback}
            </p>
          )}
          {canvasState !== 'active' && (
            <p role="status" className="rounded bg-white/95 px-2 py-1">
              WebGL · {canvasState === 'unavailable' ? t('Unavailable', '不可用') : t('Starting', '正在启动')}
            </p>
          )}
          {sceneVisual && !solverCheck && sceneVisualStatus !== 'idle' && (
            <p role="status" className="rounded bg-white/95 px-2 py-1">
              {sceneVisualStatus === 'loading' ? t('Loading 3D scene model…', '正在加载三维场景模型…')
                : t('Some model geometry is unavailable. Showing available geometry.', '部分模型无法加载，已显示可用的几何。')}
            </p>
          )}
          {coordinates && <p className="rounded bg-white/90 px-2 py-0.5 text-[var(--text-mid)]">{coordinates}</p>}
        </div>
      </div>
    </div>
  );
}
