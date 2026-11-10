/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { GeoAnchor, Transmitter, Receiver, BuildingFootprint, PropagationPath, RadioMapGrid, ChannelMetrics, MatrixCell, SolverOptions, DEFAULT_SOLVER_OPTIONS, MaterialConfig, CoverageMetric, MobilityCombineMode, TrajectoryPoint, defaultMaterialConfig } from './types';
import { ColormapName } from './lib/colormaps';
import { ThreeStudio } from './components/ThreeStudio';
import { TopNav } from './components/TopNav';
import { WorkflowNav } from './components/WorkflowNav';
import { MapSelector } from './components/MapSelector';
import { SolverControls } from './components/SolverControls';
import { LinkPanel } from './components/LinkPanel';
import { CoveragePanel } from './components/CoveragePanel';
import { PlanningControls } from './components/PlanningControls';
import { CsiPreviewPanel } from './components/CsiPreviewPanel';
import { GeographyPanel } from './components/GeographyPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
import { ExportPanel } from './components/ExportPanel';
import { DevicePanel } from './components/DevicePanel';
import type { PlacementMode, ENUVector } from './types';
import { useI18n, type LocalizedText } from './i18n';
import {
  latLonToENU,
  enuToLatLon,
  fetchOSMBuildings,
} from './utils';
import { solveLink, solveRadioMap, checkBackend, createCsiRun, inspectCsiLink } from './api';
import type { CsiRun, CsiRunMode, CsiSelection, CsiLinkPreview, HandoverConfig } from './api';
import {
  clearAutosavedProject,
  loadAutosavedProject,
  parseProjectDocument,
  saveAutosavedProject,
  StudioProjectState,
  DEFAULT_CSI_SETTINGS,
} from './project';
import type { StudioWorkspace } from './project';

const EMPTY_METRICS: ChannelMetrics = {
  totalRxPowerDbm: -200,
  losStatus: 'NLOS',
  numPaths: 0,
  rmsDelaySpreadNs: 0,
  rmsDelaySpreadValid: true,
  strongestPathPowerDbm: -200,
  strongestPathType: 'None',
};

const EMPTY_TRACK: TrajectoryPoint[] = [];
const EMPTY_PATHS: PropagationPath[] = [];

function sampleTrajectory(points: TrajectoryPoint[], intervalMs: number, speedKmh: number) {
  const arc = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].enu;
    const b = points[i].enu;
    arc.push(arc[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const length = arc[arc.length - 1];
  const speed = speedKmh / 3.6;
  if (length < 1e-6 || speed <= 0 || intervalMs <= 0) return { waypoints: [], timeSeconds: [] };
  const segments = Math.min(99, Math.max(1, Math.ceil(length / Math.max(speed * intervalMs / 1000, 0.05))));
  const waypoints: ENUVector[] = [];
  const timeSeconds: number[] = [];
  let edge = 1;
  for (let i = 0; i <= segments; i++) {
    const distance = length * i / segments;
    while (edge < arc.length - 1 && arc[edge] < distance) edge++;
    const fraction = (distance - arc[edge - 1]) / Math.max(arc[edge] - arc[edge - 1], 1e-9);
    const a = points[edge - 1].enu;
    const b = points[edge].enu;
    waypoints.push({ x: a.x + fraction * (b.x - a.x), y: a.y + fraction * (b.y - a.y), z: a.z + fraction * (b.z - a.z) });
    timeSeconds.push(distance / speed);
  }
  return { waypoints, timeSeconds };
}

const INITIAL_ANCHOR: GeoAnchor = {
  latitude: 38.9226,
  longitude: -77.0194, // Howard University, Washington DC
};

function positionDevice<T extends Transmitter | Receiver>(device: T, enu: ENUVector, anchor: GeoAnchor): T {
  const { lat, lon } = enuToLatLon(enu, anchor);
  return { ...device, enu, latitude: lat, longitude: lon };
}

function nextDeviceName(devices: (Transmitter | Receiver)[], prefix: 'Tx' | 'Rx') {
  const names = new Set(devices.map(device => device.name));
  let index = devices.length + 1;
  while (names.has(`${prefix} ${index}`)) index += 1;
  return `${prefix} ${index}`;
}

// Lightweight procedural starter scene; replace it with live OSM features for
// site-specific studies.
const PRELOADED_BUILDINGS: BuildingFootprint[] = [
  {
    id: 'pre_skyscraper_1',
    points: [],
    enuPoints: [
      { x: -60, y: -70, z: 0 },
      { x: -10, y: -70, z: 0 },
      { x: -10, y: -20, z: 0 },
      { x: -60, y: -20, z: 0 },
    ],
    height: 46.0,
    category: 'building',
    type: 'commercial',
    material: 'itu_glass',
  },
  {
    id: 'pre_office_2',
    points: [],
    enuPoints: [
      { x: 45, y: -80, z: 0 },
      { x: 95, y: -80, z: 0 },
      { x: 95, y: -30, z: 0 },
      { x: 45, y: -30, z: 0 },
    ],
    height: 26.5,
    category: 'building',
    type: 'office',
    material: 'itu_concrete',
  },
  {
    id: 'pre_apartment_3',
    points: [],
    enuPoints: [
      { x: -90, y: 35, z: 0 },
      { x: -40, y: 35, z: 0 },
      { x: -40, y: 85, z: 0 },
      { x: -90, y: 85, z: 0 },
    ],
    height: 18.0,
    category: 'building',
    type: 'apartments',
    material: 'itu_brick',
  },
  {
    id: 'pre_skytower_4',
    points: [],
    enuPoints: [
      { x: 40, y: 40, z: 0 },
      { x: 90, y: 40, z: 0 },
      { x: 90, y: 90, z: 0 },
      { x: 40, y: 90, z: 0 },
    ],
    height: 54.0,
    category: 'building',
    type: 'office',
    material: 'itu_glass',
  },
  {
    id: 'pre_road_major_1',
    points: [],
    enuPoints: [
      { x: -200, y: -5, z: 0 },
      { x: 200, y: -5, z: 0 },
    ],
    height: 0.1,
    category: 'infrastructure',
    type: 'primary',
    material: 'itu_dry_ground',
  },
  {
    id: 'pre_road_major_2',
    points: [],
    enuPoints: [
      { x: -5, y: -200, z: 0 },
      { x: -5, y: 200, z: 0 },
    ],
    height: 0.1,
    category: 'infrastructure',
    type: 'primary',
    material: 'itu_dry_ground',
  },
  {
    id: 'pre_park_green_1',
    points: [],
    enuPoints: [
      { x: -180, y: 15, z: 0 },
      { x: -110, y: 15, z: 0 },
      { x: -110, y: 85, z: 0 },
      { x: -180, y: 85, z: 0 },
    ],
    height: 0.05,
    category: 'terrain',
    type: 'park',
    material: 'itu_dry_ground',
  },
  {
    id: 'pre_park_green_2',
    points: [],
    enuPoints: [
      { x: 110, y: -180, z: 0 },
      { x: 180, y: -180, z: 0 },
      { x: 180, y: -110, z: 0 },
      { x: 110, y: -110, z: 0 },
    ],
    height: 0.05,
    category: 'terrain',
    type: 'grass',
    material: 'itu_dry_ground',
  },
];

const AUTOSAVED_PROJECT = loadAutosavedProject()?.state ?? null;

export default function App() {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<GeoAnchor>(
    () => AUTOSAVED_PROJECT?.scene.anchor ?? INITIAL_ANCHOR,
  );
  const [mapAnchor, setMapAnchor] = useState(anchor);

  // ── Multiple transmitters & receivers ───────────────────────────────────
  // The arrays hold every device; `activeTxId`/`activeRxId` mark the one the
  // sliders, map drag and 3D drag currently edit. `tx`/`rx` below are derived
  // from those, so all single-device UI keeps working on the active device.
  const [txs, setTxs] = useState<Transmitter[]>(() => AUTOSAVED_PROJECT?.devices.transmitters ?? [
    {
      id: 'tx_1',
      name: 'Tx 1',
      latitude: INITIAL_ANCHOR.latitude + 0.0003,
      longitude: INITIAL_ANCHOR.longitude - 0.0004,
      height: 12.0,
      enu: latLonToENU(INITIAL_ANCHOR.latitude + 0.0003, INITIAL_ANCHOR.longitude - 0.0004, INITIAL_ANCHOR),
      powerDbm: 30,
      antennaArraySize: [8, 8],
      beamsteeringAzimuth: 145,
      beamsteeringElevation: 5,
    },
  ]);
  const [rxs, setRxs] = useState<Receiver[]>(() => AUTOSAVED_PROJECT?.devices.receivers ?? [
    {
      id: 'rx_1',
      name: 'Rx 1',
      latitude: INITIAL_ANCHOR.latitude - 0.0003,
      longitude: INITIAL_ANCHOR.longitude + 0.0004,
      height: 1.5,
      enu: latLonToENU(INITIAL_ANCHOR.latitude - 0.0003, INITIAL_ANCHOR.longitude + 0.0004, INITIAL_ANCHOR),
      antennaArraySize: [1, 1],
    },
  ]);
  const [activeTxId, setActiveTxId] = useState(
    () => AUTOSAVED_PROJECT?.devices.activeTxId ?? 'tx_1',
  );
  const [activeRxId, setActiveRxId] = useState(
    () => AUTOSAVED_PROJECT?.devices.activeRxId ?? 'rx_1',
  );
  const [fronthaulMbpsByTxId, setFronthaul] = useState<Record<string, number | null>>(
    () => AUTOSAVED_PROJECT?.devices.fronthaulMbpsByTxId ?? {},
  );

  const tx = txs.find((t) => t.id === activeTxId) ?? txs[0];
  const rx = rxs.find((r) => r.id === activeRxId) ?? rxs[0];

  const [buildings, setBuildings] = useState<BuildingFootprint[]>(
    () => AUTOSAVED_PROJECT?.scene.buildings ?? PRELOADED_BUILDINGS,
  );
  const [freqGhz, setFreqGhz] = useState(
    () => AUTOSAVED_PROJECT?.solver.carrierFrequencyGhz ?? 28.0,
  ); // Default to mmWave
  const [maxDepth, setMaxDepth] = useState(
    () => AUTOSAVED_PROJECT?.solver.maxDepth ?? 3,
  ); // Sionna RT max interaction depth

  // Ray-interaction switches + Tx antenna pattern/polarization (sionna-rt-gui style).
  const [solverOptions, setSolverOptions] = useState<SolverOptions>(
    () => AUTOSAVED_PROJECT?.solver.options ?? DEFAULT_SOLVER_OPTIONS,
  );
  const [csiSettings, setCsiSettings] = useState(() => AUTOSAVED_PROJECT?.csi ?? DEFAULT_CSI_SETTINGS);

  // Radio map display (colormap + manual range), like sionna-rt-gui's map panel.
  const [rmColormap, setRmColormap] = useState<ColormapName>(
    () => AUTOSAVED_PROJECT?.display.radioMapColormap ?? 'viridis',
  );
  const [rmAutoRange, setRmAutoRange] = useState(
    () => AUTOSAVED_PROJECT?.display.radioMapAutoRange ?? true,
  );
  const [rmVmin, setRmVmin] = useState(
    () => AUTOSAVED_PROJECT?.display.radioMapVmin ?? -120,
  );
  const [rmVmax, setRmVmax] = useState(
    () => AUTOSAVED_PROJECT?.display.radioMapVmax ?? -50,
  );

  const [workspace, setWorkspace] = useState<StudioWorkspace>(
    () => AUTOSAVED_PROJECT?.display.workspace ?? 'scene',
  );

  // Active Studio Modes
  const [activeMode, setActiveMode] = useState<'link' | 'heatmap' | 'playback'>(
    () => AUTOSAVED_PROJECT?.display.activeMode ?? 'link',
  );
  const [placementMode, setPlacementMode] = useState<PlacementMode>('none');
  const [showOutlines, setShowOutlines] = useState(
    () => AUTOSAVED_PROJECT?.display.showOutlines ?? true,
  );
  const [showRaysOnHeatmap, setShowRaysOnHeatmap] = useState(
    () => AUTOSAVED_PROJECT?.display.showRaysOnHeatmap ?? false,
  ); // overlay rays on coverage

  // Coverage Map State
  const [radioMap, setRadioMap] = useState<RadioMapGrid | null>(null);
  const [loadingHeatmap, setLoadingHeatmap] = useState(false);
  // Interference-aware coverage controls (Sionna RadioMapSolver rss/sinr).
  const [coverageMetric, setCoverageMetric] = useState<CoverageMetric>(
    () => AUTOSAVED_PROJECT?.coverage.metric ?? 'power',
  );
  const [coverageBandwidthMhz, setCoverageBandwidthMhz] = useState(
    () => AUTOSAVED_PROJECT?.coverage.bandwidthMhz ?? 100,
  );
  const [coverageNoiseFigureDb, setCoverageNoiseFigureDb] = useState(
    () => AUTOSAVED_PROJECT?.coverage.noiseFigureDb ?? 7,
  );
  const [coverageHeight, setCoverageHeight] = useState(
    () => AUTOSAVED_PROJECT?.coverage.heightM ?? 1.5,
  );
  const [coverageRes, setCoverageRes] = useState(
    () => AUTOSAVED_PROJECT?.coverage.gridStepM ?? 8,
  );
  const [coverageSamplesPerTx, setCoverageSamplesPerTx] = useState(
    () => AUTOSAVED_PROJECT?.coverage.samplesPerTx ?? 1_000_000,
  );
  const [radioMapSeed, setRadioMapSeed] = useState(
    () => AUTOSAVED_PROJECT?.coverage.seed ?? 42,
  );

  // Per-material scattering / EM overrides, keyed by material id, sent with solves.
  const [materialConfigs, setMaterialConfigs] = useState<Record<string, MaterialConfig>>(
    () => AUTOSAVED_PROJECT?.solver.materialConfigs ?? {},
  );
  const materialIds = React.useMemo(
    () => Array.from(new Set(buildings.filter((b) => b.category === 'building').map((b) => b.material))),
    [buildings],
  );
  const materialList = React.useMemo<MaterialConfig[]>(
    () => materialIds.map((id) => materialConfigs[id] ?? defaultMaterialConfig(id)),
    [materialIds, materialConfigs],
  );
  const updateMaterial = (cfg: MaterialConfig) =>
    setMaterialConfigs((prev) => ({ ...prev, [cfg.id]: cfg }));

  // GIS Data Fetcher States
  const [gisLoading, setGisLoading] = useState(false);
  const gisRequest = useRef(0);
  const [downloadMessage, setDownloadProgress] = useState<LocalizedText>(['', '']);
  const downloadProgress = t(...downloadMessage);

  // Trajectory points state
  const [trajectoriesByRxId, setTrajectories] = useState<Record<string, TrajectoryPoint[]>>(
    () => AUTOSAVED_PROJECT?.mobility.trajectoriesByRxId ?? {},
  );
  const trajectoryPoints = Object.hasOwn(trajectoriesByRxId, rx.id) ? trajectoriesByRxId[rx.id] : EMPTY_TRACK;
  const setTrajectoryPoints = (points: TrajectoryPoint[]) => setTrajectories(prev => ({ ...prev, [rx.id]: points }));

  // PROPAGATION LINK PHYSICS SOLVER — real Sionna RT on the backend, run on demand.
  const [paths, setPaths] = useState<PropagationPath[]>([]);
  const [metrics, setMetrics] = useState<ChannelMetrics>(EMPTY_METRICS);
  const [solving, setSolving] = useState(false);
  const [solveIssue, setSolveError] = useState<LocalizedText | null>(null);
  const solveError = solveIssue ? t(...solveIssue) : '';
  const [backendOnline, setBackendOnline] = useState(false);
  const backendOnlineRef = useRef(backendOnline);
  backendOnlineRef.current = backendOnline;

  // Probe the backend on mount, then keep polling while it's offline so the
  // solve buttons recover when the backend is started after the frontend.
  useEffect(() => {
    let cancelled = false;
    const probe = () => checkBackend().then((ok) => { if (!cancelled) setBackendOnline(ok); });
    probe();
    const id = window.setInterval(() => {
      if (!backendOnlineRef.current) probe();
    }, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);
  // All-pairs link matrix (Tx × Rx), keyed `${txId}|${rxId}`.
  const [matrix, setMatrix] = useState<Record<string, MatrixCell>>({});
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixProgress, setMatrixProgress] = useState('');
  // Whether the 3D scene overlays ALL matrix rays. True right after Solve All
  // Pairs; false once the user focuses a single pair (cell click / Solve Link),
  // so a fresh single-link solve isn't drowned out by every pair's rays.
  const [matrixRaysVisible, setMatrixRaysVisible] = useState(false);
  const [previewSource, setPreviewSource] = useState<'csi' | 'legacy'>('csi');
  const sceneRevision = useRef(0);
  const activePair = useRef({ txId: activeTxId, rxId: activeRxId });
  activePair.current = { txId: activeTxId, rxId: activeRxId };

  useEffect(() => {
    sceneRevision.current += 1;
    setPaths([]);
    setMetrics(EMPTY_METRICS);
    setMatrix({});
    setMatrixRaysVisible(false);
  }, [
    buildings,
    // Every device edit (position, power, antenna, beam — active or not) flows
    // through setTxs/setRxs, so the two arrays cover all device-driven staleness.
    // Mobility ray-traces every Tx and the radio map uses every Tx.
    txs,
    rxs,
    freqGhz,
    maxDepth,
    solverOptions,
    materialConfigs,
  ]);

  const handleSolve = async () => {
    const revision = sceneRevision.current;
    setSolving(true);
    setSolveError(null);
    setPreviewSource('legacy');
    try {
      const res = await solveLink(tx, rx, buildings, freqGhz, maxDepth, solverOptions, materialList);
      if (revision !== sceneRevision.current || activePair.current.txId !== tx.id || activePair.current.rxId !== rx.id) return;
      setPaths(res.paths);
      setMetrics(res.metrics);
      setMatrixRaysVisible(false); // focus the 3D scene on this single link
      setBackendOnline(true);
    } catch (e: any) {
      const detail = e instanceof Error ? ` (${e.message})` : '';
      setSolveError([`Link solve failed${detail}`, `链路求解失败${detail}`]);
      checkBackend().then(setBackendOnline); // a solve error != backend offline
    } finally {
      setSolving(false);
    }
  };

  // Solve every Tx → Rx pair (serial GPU ray traces, scene is cached).
  const handleSolveMatrix = async () => {
    const revision = sceneRevision.current;
    setMatrixLoading(true);
    setSolveError(null);
    setPreviewSource('legacy');
    const next: Record<string, MatrixCell> = {};
    const total = txs.length * rxs.length;
    let done = 0;
    try {
      for (const t of txs) {
        for (const r of rxs) {
          done += 1;
          setMatrixProgress(`${t.name} → ${r.name}  (${done}/${total})`);
          const res = await solveLink(t, r, buildings, freqGhz, maxDepth, solverOptions, materialList);
          if (revision !== sceneRevision.current) return;
          next[`${t.id}|${r.id}`] = { txId: t.id, rxId: r.id, metrics: res.metrics, paths: res.paths };
        }
      }
      setMatrix(next);
      setMatrixRaysVisible(true); // show every pair's rays until a pair is focused
      const act = next[`${activePair.current.txId}|${activePair.current.rxId}`];
      if (act) {
        setPaths(act.paths);
        setMetrics(act.metrics);
      }
      setBackendOnline(true);
    } catch (e: any) {
      const detail = e instanceof Error ? ` (${e.message})` : '';
      setSolveError([`Link matrix solve failed${detail}`, `链路矩阵求解失败${detail}`]);
      checkBackend().then(setBackendOnline);
    } finally {
      setMatrixLoading(false);
      setMatrixProgress('');
    }
  };

  // All multipath from every solved Tx→Rx pair, combined for the 3D scene
  // (empty once the user focuses a single pair).
  const matrixPaths = React.useMemo(
    () => (matrixRaysVisible ? Object.values(matrix).flatMap((c: MatrixCell) => c.paths) : []),
    [matrix, matrixRaysVisible],
  );

  // Selecting a matrix cell focuses that Tx→Rx pair and shows its multipath.
  const handleSelectPair = (txId: string, rxId: string) => {
    setPreviewSource('legacy');
    setActiveTxId(txId);
    setActiveRxId(rxId);
    const cell = matrix[`${txId}|${rxId}`];
    if (!cell && txId === activeTxId && rxId === activeRxId) return;
    setPaths(cell?.paths ?? []);
    setMetrics(cell?.metrics ?? EMPTY_METRICS);
    setMatrixRaysVisible(false);
  };

  // ── Device list management (add / remove / select) ──────────────────────
  const startPlacement = (mode: 'add-tx' | 'add-rx') => {
    setWorkspace('planning');
    setPlacementMode(mode);
  };

  const placeDevice = (mode: Exclude<PlacementMode, 'none'>, enu: ENUVector) => {
    if (mode === 'move-tx' || mode === 'move-rx') {
      if (mode === 'move-tx') handleTxUpdate(positionDevice(tx, enu, anchor));
      else handleRxUpdate(positionDevice(rx, enu, anchor));
      setPlacementMode('none');
      return;
    }
    const suffix = crypto.getRandomValues(new Uint32Array(2)).join('-');
    if (mode === 'add-tx') {
      const added = positionDevice({ ...tx, id: `tx_${suffix}`, name: nextDeviceName(txs, 'Tx') }, enu, anchor);
      setTxs(prev => [...prev, added]);
      setActiveTxId(added.id);
    } else {
      const added = positionDevice({ ...rx, id: `rx_${suffix}`, name: nextDeviceName(rxs, 'Rx') }, enu, anchor);
      setRxs(prev => [...prev, added]);
      setActiveRxId(added.id);
    }
  };
  const removeTx = (id: string) => {
    if (txs.length <= 1) return;
    const remaining = txs.filter((t) => t.id !== id);
    setTxs(remaining);
    setFronthaul(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
    if (activeTxId === id) setActiveTxId(remaining[0].id);
  };
  const removeRx = (id: string) => {
    if (rxs.length <= 1) return;
    const remaining = rxs.filter((r) => r.id !== id);
    setRxs(remaining);
    setTrajectories(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
    if (activeRxId === id) setActiveRxId(remaining[0].id);
  };

  const handleTxUpdate = (updatedTx: Transmitter) => {
    setTxs(prev => prev.map(t => t.id === updatedTx.id ? updatedTx : t));
  };

  const handleRxUpdate = (updatedRx: Receiver) => {
    setRxs(prev => prev.map(r => r.id === updatedRx.id ? updatedRx : r));
  };

  const handleAnchorChange = (nextAnchor: GeoAnchor) => {
    setAnchor(nextAnchor);
    setMapAnchor(nextAnchor);
    setTxs(prev => prev.map(device => positionDevice(device, device.enu, nextAnchor)));
    setRxs(prev => prev.map(device => positionDevice(device, device.enu, nextAnchor)));
    setTrajectories((prev: Record<string, TrajectoryPoint[]>) => Object.fromEntries(Object.entries(prev).map(([id, points]) => [
      id, points.map(point => ({ ...point, ...enuToLatLon(point.enu, nextAnchor) })),
    ])));
  };

  const useStarterScene = () => {
    gisRequest.current++;
    setGisLoading(false);
    setDownloadProgress(['', '']);
    handleAnchorChange(INITIAL_ANCHOR);
    setBuildings(PRELOADED_BUILDINGS);
  };

  // OVERPASS GIS DOWNLOAD PIPELINE
  const handleDownloadOSM = async (bounds: L.LatLngBounds) => {
    const request = ++gisRequest.current;
    const selectedAnchor = mapAnchor;
    setGisLoading(true);
    setDownloadProgress(['Sending the area query to Overpass…', '正在向 Overpass 查询所选区域…']);
    try {
      const south = bounds.getSouth();
      const west = bounds.getWest();
      const north = bounds.getNorth();
      const east = bounds.getEast();

      // fetchOSMBuildings reports which mirror it is on; the local parse/compile
      // message comes after the network is done, so a stalled mirror can never
      // look like slow XML compilation again.
      const loadedBuildings = await fetchOSMBuildings(
        south, west, north, east, selectedAnchor, message => {
          if (request === gisRequest.current) setDownloadProgress(message);
        },
      );
      if (request !== gisRequest.current) return;

      if (loadedBuildings.length === 0) {
        setDownloadProgress(['No buildings found in this area. Keeping the current scene.', '所选区域未找到建筑，保留当前场景。']);
        return;
      }

      handleAnchorChange(selectedAnchor);
      setBuildings(loadedBuildings);
      setDownloadProgress([`Imported ${loadedBuildings.length} map features.`, `已导入 ${loadedBuildings.length} 个地图要素。`]);
    } catch (e: any) {
      if (request !== gisRequest.current) return;
      const detail = e instanceof Error ? ` (${e.message})` : '';
      setDownloadProgress([`Map download failed${detail}`, `地图下载失败${detail}`]);
    } finally {
      if (request === gisRequest.current) setGisLoading(false);
    }
  };

  // How multiple transmitters collapse into each waypoint's KPIs (best-server vs
  // total power); the rays drawn are the union of all Tx in either case.
  const [mobilityCombineMode, setMobilityCombineMode] = useState<MobilityCombineMode>(
    () => AUTOSAVED_PROJECT?.mobility.combineMode ?? 'best_server',
  );
  // A3 handover parameters (applied on the next Run Mobility) + the backend's
  // hysteresis/TTT association analysis for the last run.
  const [handoverConfig, setHandoverConfig] = useState<HandoverConfig>(
    () => AUTOSAVED_PROJECT?.mobility.handover ?? { hysteresisDb: 3, timeToTriggerMs: 160 },
  );
  const [mobilitySpeedKmh, setMobilitySpeedKmh] = useState(
    () => AUTOSAVED_PROJECT?.mobility.speedKmh ?? 30,
  );
  const [mobilityIntervalMs, setMobilityIntervalMs] = useState(
    () => AUTOSAVED_PROJECT?.mobility.intervalMs ?? 100,
  );
  const [autosaveStatus, setAutosaveStatus] = useState<'saving' | 'saved' | 'error'>('saving');
  const resettingRef = useRef(false);

  const projectState = React.useMemo<StudioProjectState>(() => ({
    scene: { anchor, buildings },
    devices: {
      transmitters: txs,
      receivers: rxs,
      activeTxId,
      activeRxId,
      fronthaulMbpsByTxId,
    },
    csi: csiSettings,
    solver: {
      carrierFrequencyGhz: freqGhz,
      maxDepth,
      options: solverOptions,
      materialConfigs,
    },
    coverage: {
      metric: coverageMetric,
      bandwidthMhz: coverageBandwidthMhz,
      noiseFigureDb: coverageNoiseFigureDb,
      heightM: coverageHeight,
      gridStepM: coverageRes,
      samplesPerTx: coverageSamplesPerTx,
      seed: radioMapSeed,
    },
    mobility: {
      trajectoriesByRxId,
      combineMode: mobilityCombineMode,
      handover: handoverConfig,
      speedKmh: mobilitySpeedKmh,
      intervalMs: mobilityIntervalMs,
    },
    display: {
      workspace,
      activeMode,
      showOutlines,
      showRaysOnHeatmap,
      radioMapColormap: rmColormap,
      radioMapAutoRange: rmAutoRange,
      radioMapVmin: rmVmin,
      radioMapVmax: rmVmax,
    },
  }), [
    anchor, buildings, txs, rxs, activeTxId, activeRxId, fronthaulMbpsByTxId, csiSettings, freqGhz, maxDepth,
    solverOptions, materialConfigs, coverageMetric, coverageBandwidthMhz,
    coverageNoiseFigureDb, coverageHeight, coverageRes, coverageSamplesPerTx,
    radioMapSeed, trajectoriesByRxId, mobilityCombineMode, handoverConfig,
    mobilitySpeedKmh, mobilityIntervalMs, workspace, activeMode, showOutlines,
    showRaysOnHeatmap, rmColormap, rmAutoRange, rmVmin, rmVmax,
  ]);

  // Persist only editable inputs and display choices. Solver outputs are
  // intentionally omitted because they become stale whenever an input changes.
  useEffect(() => {
    setAutosaveStatus('saving');
    const timeout = window.setTimeout(() => {
      // A reset clears storage and reloads; a debounced write landing in that
      // window would restore the state the user just discarded.
      if (resettingRef.current) return;
      try {
        saveAutosavedProject(projectState);
        setAutosaveStatus('saved');
      } catch (error) {
        console.warn('Could not autosave the SionnaRTStudio project.', error);
        setAutosaveStatus('error');
      }
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [projectState]);

  // Discard the autosave and reload. Every state hook seeds itself from the
  // module-level AUTOSAVED_PROJECT snapshot, so a reload is what actually
  // returns the studio to its defaults.
  const handleResetProject = () => {
    const confirmed = window.confirm(t(
      'Reset the studio to its defaults?\n\n'
      + 'This discards the autosaved project: scene geometry, every transmitter '
      + 'and receiver, solver and material settings, trajectory, and coverage '
      + 'controls. Exported files are not affected.\n\n'
      + 'Export the project first if you want to keep it.',
      '恢复实验台默认设置？\n\n这会清除自动保存的场景、收发设备、求解和材质设置、轨迹及覆盖参数。已导出的文件仍可使用。\n\n如需保留当前项目，请先导出。',
    ));
    if (!confirmed) return;
    resettingRef.current = true;
    clearAutosavedProject();
    window.location.reload();
  };


  const handleImportProject = (text: string) => {
    const imported = parseProjectDocument(text).state;
    csiRequest.current++;
    setCsiRunning(null);
    setCsiResult(null);
    setCsiSelection(null);
    setCsiIssue(null);
    setPreviewSource('csi');
    gisRequest.current++;
    setGisLoading(false);
    setDownloadProgress(['', '']);
    setAnchor(imported.scene.anchor);
    setMapAnchor(imported.scene.anchor);
    setBuildings(imported.scene.buildings);
    setTxs(imported.devices.transmitters);
    setRxs(imported.devices.receivers);
    setActiveTxId(imported.devices.activeTxId);
    setActiveRxId(imported.devices.activeRxId);
    setFronthaul(imported.devices.fronthaulMbpsByTxId);
    setCsiSettings(imported.csi);
    setFreqGhz(imported.solver.carrierFrequencyGhz);
    setMaxDepth(imported.solver.maxDepth);
    setSolverOptions(imported.solver.options);
    setMaterialConfigs(imported.solver.materialConfigs);
    setCoverageMetric(imported.coverage.metric);
    setCoverageBandwidthMhz(imported.coverage.bandwidthMhz);
    setCoverageNoiseFigureDb(imported.coverage.noiseFigureDb);
    setCoverageHeight(imported.coverage.heightM);
    setCoverageRes(imported.coverage.gridStepM);
    setCoverageSamplesPerTx(imported.coverage.samplesPerTx);
    setRadioMapSeed(imported.coverage.seed);
    setTrajectories(imported.mobility.trajectoriesByRxId);
    setMobilityCombineMode(imported.mobility.combineMode);
    setHandoverConfig(imported.mobility.handover);
    setMobilitySpeedKmh(imported.mobility.speedKmh);
    setMobilityIntervalMs(imported.mobility.intervalMs);
    setWorkspace(imported.display.workspace);
    setActiveMode(imported.display.activeMode);
    setShowOutlines(imported.display.showOutlines);
    setShowRaysOnHeatmap(imported.display.showRaysOnHeatmap);
    setRmColormap(imported.display.radioMapColormap);
    setRmAutoRange(imported.display.radioMapAutoRange);
    setRmVmin(imported.display.radioMapVmin);
    setRmVmax(imported.display.radioMapVmax);

    setPlacementMode('none');
    setPaths([]);
    setMetrics(EMPTY_METRICS);
    setMatrix({});
    setMatrixRaysVisible(false);
    setRadioMap(null);
    setSolveError(null);
  };

  const [csiResult, setCsiResult] = useState<{ run: CsiRun; key: string } | null>(null);
  const [csiRunning, setCsiRunning] = useState<CsiRunMode | null>(null);
  const [csiIssue, setCsiIssue] = useState<LocalizedText | null>(null);
  const [csiSelection, setCsiSelection] = useState<CsiSelection | null>(null);
  const [csiLink, setCsiLink] = useState<CsiLinkPreview | null>(null);
  const [csiLinkLoading, setCsiLinkLoading] = useState(false);
  const [csiLinkError, setCsiLinkError] = useState('');
  const csiRequest = useRef(0);

  const csiGrid = React.useMemo(() => ({
    numSubcarriers: csiSettings.numSubcarriers,
    subcarrierSpacing: csiSettings.subcarrierSpacingKhz * 1000,
    normalizeDelays: csiSettings.normalizeDelays,
  }), [csiSettings]);
  const csiCommon = React.useMemo(() => ({
    txs, buildings, freqGhz, maxDepth, options: solverOptions, materials: materialList,
    systemBandwidthMhz: coverageBandwidthMhz, noiseFigureDb: coverageNoiseFigureDb, ...csiGrid,
  }), [txs, buildings, freqGhz, maxDepth, solverOptions, materialList, coverageBandwidthMhz, coverageNoiseFigureDb, csiGrid]);
  const sharedCsiKey = React.useMemo(() => JSON.stringify([anchor, csiCommon]), [anchor, csiCommon]);
  const keyForCsi = (mode: CsiRunMode, rxId: string) => mode === 'static'
    ? sharedCsiKey + JSON.stringify(rxs)
    : sharedCsiKey + JSON.stringify([
        rxs.find(device => device.id === rxId),
        Object.hasOwn(trajectoriesByRxId, rxId) ? trajectoriesByRxId[rxId] : EMPTY_TRACK,
        mobilitySpeedKmh, mobilityIntervalMs, mobilityCombineMode, handoverConfig,
      ]);
  const currentCsiKey = useRef(keyForCsi);
  currentCsiKey.current = keyForCsi;
  const csiRun = csiResult?.run ?? null;
  const csiStale = !!csiResult && csiResult.key !== keyForCsi(csiResult.run.mode, csiResult.run.rxIds[0]);
  const currentRunId = csiStale ? null : csiRun?.runId;

  useEffect(() => {
    setCsiLink(null);
    setCsiLinkError('');
    setCsiLinkLoading(false);
    if (!currentRunId || !csiSelection) return;
    let current = true;
    setCsiLinkLoading(true);
    inspectCsiLink(currentRunId, csiSelection).then(
      link => { if (current) setCsiLink(link); },
      error => { if (current) setCsiLinkError(error instanceof Error ? error.message : String(error)); },
    ).finally(() => { if (current) setCsiLinkLoading(false); });
    return () => { current = false; };
  }, [currentRunId, csiSelection]);

  const sameArrays = (devices: (Receiver | Transmitter)[]) =>
    devices.every(device => device.antennaArraySize.every((value, i) => value === devices[0].antennaArraySize[i]));
  const unavailableReason = !backendOnline ? t('Solver is offline.', '求解器离线。') : undefined;
  const txArrayReason = sameArrays(txs) ? undefined : t(
    'This CSI tensor needs matching AP array sizes. Static mixed-array CIR is available in advanced export.',
    '统一 CSI 张量要求各 AP 阵列等尺寸。静态混合阵列可使用高级导出中的逐链路 CIR。',
  );
  const staticDisabledReason = unavailableReason ?? txArrayReason ?? (sameArrays(rxs) ? undefined : t(
    'This CSI tensor needs matching UE array sizes. Use the advanced per-link CIR export for mixed arrays.',
    '统一 CSI 张量要求各 UE 阵列等尺寸。混合阵列可使用高级逐链路 CIR 导出。',
  ));
  const route = React.useMemo(
    () => sampleTrajectory(trajectoryPoints, mobilityIntervalMs, mobilitySpeedKmh),
    [trajectoryPoints, mobilityIntervalMs, mobilitySpeedKmh],
  );
  const trajectoryDisabledReason = unavailableReason ?? txArrayReason ?? (route.waypoints.length < 2
    ? t('Draw a nonzero trajectory for the selected UE in Planning.', '请先在规划页为所选 UE 绘制一条有长度的轨迹。') : undefined);

  const handleCsiRun = async (mode: CsiRunMode) => {
    if (csiRunning || (mode === 'static' ? staticDisabledReason : trajectoryDisabledReason)) return;
    const request = ++csiRequest.current;
    const key = keyForCsi(mode, rx.id);
    setCsiRunning(mode);
    setCsiIssue(null);
    setActiveMode('link');
    try {
      const run = await createCsiRun({
        ...csiCommon, mode, rxs: mode === 'static' ? rxs : [rx],
        ...(mode === 'trajectory' ? {
          ...route, speedKmh: mobilitySpeedKmh, combineMode: mobilityCombineMode, handover: handoverConfig,
        } : {}),
      });
      if (request !== csiRequest.current) return;
      if (key !== currentCsiKey.current(mode, rx.id)) {
        setCsiIssue(['Inputs changed during tracing. Run CSI again with the current settings.', '追踪期间输入已改变，请使用当前配置重新计算 CSI。']);
        return;
      }
      setCsiResult({ run, key });
      setPreviewSource('csi');
      setCsiSelection({ txId: run.txIds.includes(tx.id) ? tx.id : run.txIds[0], rxId: run.rxIds.includes(rx.id) ? rx.id : run.rxIds[0], sampleIndex: 0 });
    } catch (error) {
      if (request !== csiRequest.current) return;
      const detail = error instanceof Error ? error.message : String(error);
      setCsiIssue([`CSI calculation failed (${detail})`, `CSI 计算失败（${detail}）`]);
    } finally {
      if (request === csiRequest.current) setCsiRunning(null);
    }
  };

  const coverageInputs = React.useMemo(() => ({
    txs, buildings, anchor, freqGhz, maxDepth, solverOptions, materialList,
    coverageMetric, coverageBandwidthMhz, coverageNoiseFigureDb, coverageHeight, coverageRes,
    coverageSamplesPerTx, radioMapSeed,
  }), [
    txs, buildings, anchor, freqGhz, maxDepth, solverOptions, materialList,
    coverageMetric, coverageBandwidthMhz, coverageNoiseFigureDb, coverageHeight, coverageRes,
    coverageSamplesPerTx, radioMapSeed,
  ]);
  const currentCoverageInputs = useRef(coverageInputs);
  currentCoverageInputs.current = coverageInputs;
  useEffect(() => { setRadioMap(null); }, [coverageInputs]);

  // Coverage uses RadioMapSolver and the strongest server across all Tx.
  const handleRunHeatmap = async (resolution: number, height: number, samplesPerTx: number, seed: number) => {
    setLoadingHeatmap(true);
    setSolveError(null);
    try {
      const grid = await solveRadioMap(
        txs, buildings, freqGhz, resolution, height, maxDepth, solverOptions, materialList,
        {
          metric: coverageMetric,
          bandwidthHz: coverageBandwidthMhz * 1e6,
          noiseFigureDb: coverageNoiseFigureDb,
          samplesPerTx,
          seed,
        },
      );
      if (coverageInputs !== currentCoverageInputs.current) return;
      setRadioMap(grid);
      setBackendOnline(true);
    } catch (err: any) {
      if (coverageInputs !== currentCoverageInputs.current) return;
      console.error(err);
      const detail = err instanceof Error ? ` (${err.message})` : '';
      setSolveError([`Coverage map failed${detail}`, `覆盖图求解失败${detail}`]);
      checkBackend().then(setBackendOnline); // a solve error != backend offline
    } finally {
      setLoadingHeatmap(false);
    }
  };

  const openWorkspace = (next: StudioWorkspace) => {
    setPlacementMode('none');
    setWorkspace(next);
  };
  const previewing = workspace === 'preview';
  const showingCsi = previewSource === 'csi' && !!csiRun;
  const showingCsiSelection = previewing && showingCsi && currentRunId && csiSelection;
  const trajectoryView = showingCsiSelection && activeMode !== 'heatmap' && csiRun?.mode === 'trajectory';
  const previewPosition = trajectoryView && csiSelection
    ? csiRun?.rxPositions[csiSelection.sampleIndex]?.[0] : undefined;
  const viewedTx = showingCsiSelection ? txs.find(device => device.id === showingCsiSelection.txId) ?? tx : tx;
  const viewedRx = showingCsiSelection ? rxs.find(device => device.id === showingCsiSelection.rxId) ?? rx : rx;
  const previewPaths = showingCsi ? (csiStale ? EMPTY_PATHS : csiLink?.paths ?? EMPTY_PATHS) : paths;
  const shownPaths = previewing ? previewPaths : EMPTY_PATHS;
  const rfControls = {
    tx, rx, onTxUpdate: handleTxUpdate, onRxUpdate: handleRxUpdate, freqGhz, setFreqGhz,
    maxDepth, setMaxDepth, solverOptions, setSolverOptions,
  };
  const exportDevices = txs.map(device => [device.id, Object.hasOwn(fronthaulMbpsByTxId, device.id)
    ? fronthaulMbpsByTxId[device.id] : null] as const);
  const currentFronthaul = Object.fromEntries(exportDevices);
  const nextButton = 'btn-signal cursor-pointer rounded px-3 py-2 text-sm font-semibold';

  return (
    <div id="sionna-rt-studio-app-frame" className="min-h-screen md:h-screen md:overflow-hidden text-[var(--text-hi)] flex flex-col font-sans">
      <TopNav backendOnline={backendOnline} />
      <main className={`flex-1 md:min-h-0 grid grid-cols-1 gap-4 p-4 w-full ${workspace === 'export' ? '' : 'md:grid-cols-[minmax(290px,37%)_minmax(0,1fr)] lg:grid-cols-[400px_minmax(0,1fr)]'}`}>
        <aside hidden={workspace === 'export'} className="min-w-0 md:min-h-0 md:overflow-y-auto md:pr-1">
          <div className="flex flex-col gap-4">
            {workspace === 'scene' && <>
              <div className="panel p-4 flex flex-wrap items-center justify-between gap-2">
                <h1 className="panel-title">{t('Scene setup', '仿真场景')}</h1>
                <button type="button" className={nextButton} onClick={() => openWorkspace('planning')}>
                  {t('Continue to Planning', '下一步 · 规划')}
                </button>
                <button id="btn-use-starter-scene" type="button" className="text-sm text-[var(--accent-deep)] cursor-pointer underline underline-offset-2" onClick={useStarterScene}>
                  {t('Use the built-in street scene', '使用内置街区')}
                </button>
              </div>
              <MapSelector
                anchor={mapAnchor} setAnchor={setMapAnchor}
                tx={tx} rx={rx} txs={txs} rxs={rxs}
                onTxUpdate={handleTxUpdate} onRxUpdate={handleRxUpdate}
                onDownloadOSM={handleDownloadOSM} onResetProject={handleResetProject}
                isLoading={gisLoading} downloadProgress={downloadProgress}
                trajectoryPoints={EMPTY_TRACK} editableDevices={false}
              />
              <SolverControls
                {...rfControls} section="scene"
                bandwidthMhz={coverageBandwidthMhz} onBandwidthChange={setCoverageBandwidthMhz}
                noiseFigureDb={coverageNoiseFigureDb} onNoiseFigureChange={setCoverageNoiseFigureDb}
                csiSettings={csiSettings} onCsiSettingsChange={setCsiSettings}
              />
              <details className="panel p-3">
                <summary className="cursor-pointer font-semibold">{t('Geometry and radio materials', '几何与无线材质')}</summary>
                <GeographyPanel buildings={buildings} anchor={anchor} materialIds={materialIds}
                  materialConfigs={materialList} onMaterialChange={updateMaterial} />
              </details>
            </>}
            {workspace === 'planning' && <>
              <div className="panel p-4 flex flex-wrap items-center justify-between gap-2">
                <h1 className="panel-title">{t('Devices and routes', '设备与轨迹规划')}</h1>
                <button type="button" className={nextButton} onClick={() => openWorkspace('preview')}>
                  {t('Continue to Preview', '下一步 · 预览')}
                </button>
              </div>
              <DevicePanel
                txs={txs} rxs={rxs} activeTxId={activeTxId} activeRxId={activeRxId}
                onSelectTx={(id) => handleSelectPair(id, activeRxId)}
                onSelectRx={(id) => handleSelectPair(activeTxId, id)}
                onAddTx={() => startPlacement('add-tx')} onAddRx={() => startPlacement('add-rx')}
                onRemoveTx={removeTx} onRemoveRx={removeRx}
              />
              <PlanningControls
                tx={tx} rx={rx} anchor={anchor} trajectoryPoints={trajectoryPoints}
                fronthaulMbps={currentFronthaul[tx.id]}
                onFronthaulChange={(value) => setFronthaul(prev => ({ ...prev, [tx.id]: value }))}
                speedKmh={mobilitySpeedKmh} intervalMs={mobilityIntervalMs}
                onSpeedChange={setMobilitySpeedKmh} onIntervalChange={setMobilityIntervalMs}
                onClearTrajectory={() => setTrajectoryPoints([])} onTrajectoryChange={setTrajectoryPoints}
              />
              <SolverControls {...rfControls} section="planning" />
            </>}
            {previewing && <>
              <div className="panel flex gap-2 p-2" aria-label={t('Preview type', '预览类型')}>
                <button id="btn-preview-csi" type="button" aria-pressed={activeMode !== 'heatmap'}
                  className={activeMode !== 'heatmap' ? nextButton : 'px-3 py-2 text-sm cursor-pointer'} onClick={() => setActiveMode('link')}>
                  {t('Links and CSI', '链路与 CSI')}
                </button>
                <button id="btn-preview-coverage" type="button" aria-pressed={activeMode === 'heatmap'}
                  className={activeMode === 'heatmap' ? nextButton : 'px-3 py-2 text-sm cursor-pointer'} onClick={() => setActiveMode('heatmap')}>
                  {t('Coverage', '覆盖图')}
                </button>
              </div>
              {activeMode !== 'heatmap' ? <>
                <CsiPreviewPanel
                  run={csiRun} stale={csiStale} running={csiRunning}
                  error={csiIssue ? t(...csiIssue) : ''}
                  staticDisabledReason={staticDisabledReason} trajectoryDisabledReason={trajectoryDisabledReason}
                  trajectoryReceiverName={rx.name}
                  onRun={handleCsiRun} selection={csiSelection}
                  onSelect={selection => {
                    setPreviewSource('csi');
                    setCsiSelection(selection);
                  }}
                  link={csiLink} linkLoading={csiLinkLoading} linkError={csiLinkError}
                  onOpenExport={() => openWorkspace('export')}
                />
                <details className="panel p-3 text-sm">
                  <summary className="cursor-pointer font-semibold">{t('Trajectory metrics and A3 options', '轨迹指标与 A3 设置')}</summary>
                  <div className="grid gap-2 pt-3">
                    <label className="flex justify-between gap-2">
                      {t('Power metric', '功率统计')}
                      <select value={mobilityCombineMode} onChange={event => setMobilityCombineMode(event.target.value as MobilityCombineMode)}>
                        <option value="best_server">{t('Strongest AP', '最强 AP')}</option>
                        <option value="sum">{t('Sum power', '功率相加')}</option>
                      </select>
                    </label>
                    <label className="flex justify-between gap-2">
                      {t('Hysteresis (dB)', '迟滞（dB）')}
                      <input type="range" min="0" max="15" step="0.5" value={handoverConfig.hysteresisDb}
                        onChange={event => setHandoverConfig({ ...handoverConfig, hysteresisDb: Number(event.target.value) })} />
                      <span>{handoverConfig.hysteresisDb.toFixed(1)}</span>
                    </label>
                    <label className="flex justify-between gap-2">
                      {t('Time-to-trigger (ms)', '触发时间（ms）')}
                      <select value={handoverConfig.timeToTriggerMs}
                        onChange={event => setHandoverConfig({ ...handoverConfig, timeToTriggerMs: Number(event.target.value) })}>
                        {[0, 40, 80, 160, 320, 480, 640, 1024].map(ms => <option key={ms} value={ms}>{ms}</option>)}
                      </select>
                    </label>
                  </div>
                </details>
                <details className="panel p-3">
                  <summary className="cursor-pointer font-semibold">{t('Advanced static link analysis', '高级静态链路分析')}</summary>
                  <LinkPanel txs={txs} rxs={rxs} activeTxId={activeTxId} activeRxId={activeRxId}
                    matrix={matrix} matrixLoading={matrixLoading} matrixProgress={matrixProgress}
                    onSolveMatrix={handleSolveMatrix} onSelectPair={handleSelectPair}
                    paths={paths} metrics={metrics} onSolve={handleSolve} solving={solving}
                    solveError={solveError} backendOnline={backendOnline} />
                  <AnalysisPanel tx={tx} rx={rx} paths={paths} metrics={metrics}
                    freqGhz={freqGhz} radioMap={radioMap} buildings={buildings} maxDepth={maxDepth}
                    solverOptions={solverOptions} materials={materialList} backendOnline={backendOnline} />
                </details>
              </> : <CoveragePanel
                txCount={txs.length} backendOnline={backendOnline}
                onRunHeatmap={handleRunHeatmap} heatmapLoading={loadingHeatmap} radioMap={radioMap}
                coverageMetric={coverageMetric} setCoverageMetric={setCoverageMetric}
                coverageBandwidthMhz={coverageBandwidthMhz} coverageNoiseFigureDb={coverageNoiseFigureDb}
                coverageHeight={coverageHeight} setCoverageHeight={setCoverageHeight}
                coverageRes={coverageRes} setCoverageRes={setCoverageRes}
                samplesPerTx={coverageSamplesPerTx} setSamplesPerTx={setCoverageSamplesPerTx}
                radioMapSeed={radioMapSeed} setRadioMapSeed={setRadioMapSeed}
                showRaysOnHeatmap={showRaysOnHeatmap} setShowRaysOnHeatmap={setShowRaysOnHeatmap}
                rmColormap={rmColormap} setRmColormap={setRmColormap}
                rmAutoRange={rmAutoRange} setRmAutoRange={setRmAutoRange}
                rmVmin={rmVmin} setRmVmin={setRmVmin} rmVmax={rmVmax} setRmVmax={setRmVmax}
                solveError={solveError}
              />}
            </>}
          </div>
        </aside>

        <section className={workspace === 'export' ? 'hidden' : 'min-w-0 min-h-[420px] md:min-h-0 flex flex-col'}>
          <ThreeStudio
            buildings={buildings} anchor={anchor} tx={viewedTx} rx={viewedRx} txs={txs} rxs={rxs}
            activeTxId={viewedTx.id} activeRxId={viewedRx.id}
            paths={shownPaths} matrixPaths={previewing && !showingCsi ? matrixPaths : undefined}
            showRaysOnHeatmap={showRaysOnHeatmap} radioMap={previewing ? radioMap : null}
            rmColormap={rmColormap} rmAutoRange={rmAutoRange} rmVmin={rmVmin} rmVmax={rmVmax}
            onPlaceDevice={placeDevice} editing={workspace === 'planning'} visible={workspace !== 'export'}
            activeMode={trajectoryView ? 'playback' : previewing && activeMode === 'heatmap' ? 'heatmap' : 'link'}
            placementMode={workspace === 'planning' ? placementMode : 'none'} setPlacementMode={setPlacementMode}
            showOutlines={showOutlines} setShowOutlines={setShowOutlines}
            mobilityRxPosition={previewPosition ? { x: previewPosition[0], y: previewPosition[1], z: previewPosition[2] } : null}
            trajectoryPoints={workspace === 'planning' || trajectoryView
              ? (Object.hasOwn(trajectoriesByRxId, viewedRx.id) ? trajectoriesByRxId[viewedRx.id] : EMPTY_TRACK) : EMPTY_TRACK}
            setTrajectoryPoints={setTrajectoryPoints}
          />
        </section>

        {workspace === 'export' && (
          <section className="min-w-0 md:min-h-0 md:overflow-y-auto">
            <ExportPanel
              buildings={buildings} anchor={anchor} paths={paths}
              txs={txs} rxs={rxs} tx={tx} rx={rx} freqGhz={freqGhz} maxDepth={maxDepth}
              solverOptions={solverOptions} radioMap={radioMap} materials={materialList}
              projectState={projectState} autosaveStatus={autosaveStatus}
              onImportProject={handleImportProject} onResetProject={handleResetProject}
              csiRun={csiRun} csiStale={csiStale} csiGrid={csiGrid} fronthaulMbpsByTxId={currentFronthaul}
              onOpenPreview={() => openWorkspace('preview')}
            />
          </section>
        )}
      </main>
      <WorkflowNav activeWorkspace={workspace} onSelect={openWorkspace} />
    </div>
  );
}
