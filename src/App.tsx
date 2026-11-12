/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Activity, List, RadioTower, Settings2, SlidersHorizontal, Waves } from 'lucide-react';
import { GeoAnchor, Transmitter, Receiver, BuildingFootprint, PropagationPath, RadioMapGrid, ChannelMetrics, MatrixCell, SolverOptions, DEFAULT_SOLVER_OPTIONS, MaterialConfig, CoverageMetric, MobilityCombineMode, TrajectoryPoint, defaultMaterialConfig } from './types';
import { ColormapName } from './lib/colormaps';
import { antennaPortCount, FULL_CSI_SIZE_LIMIT, estimateCsiSize } from './lib/csiSize';
import { isRadioSurface, terrainHeight } from './lib/sceneGeometry';
import { MeshImportPanel } from './components/MeshImportPanel';
import { BuildingGeneratorDialog } from './components/BuildingGeneratorDialog';
import { SceneInspector, SceneObjectList, SceneToolbar } from './components/SceneWorkbench';
import { physicalSceneInputs, useSceneEditor, withFootprint } from './sceneEditor';
import { ThreeStudio } from './components/ThreeStudio';
import { TopNav } from './components/TopNav';
import { WorkflowNav } from './components/WorkflowNav';
import { MapSelector } from './components/MapSelector';
import { CsiGridControls, DeviceRfControls, SolverControls } from './components/SolverControls';
import { LinkPanel } from './components/LinkPanel';
import { CoverageLegend, CoveragePanel } from './components/CoveragePanel';
import { FronthaulControl, RouteControls, TrajectorySimulationControls } from './components/PlanningControls';
import { CsiPreviewPanel } from './components/CsiPreviewPanel';
import { CsiHistoryPicker, useCsiHistory } from './components/CsiHistory';
import { GeographyPanel } from './components/GeographyPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
import { ExportPanel } from './components/ExportPanel';
import { SimulationDownloads } from './components/SimulationDownloads';
import { DevicePanel } from './components/DevicePanel';
import type { BuildingSpec, PlacementMode, ENUVector, SceneVisual, SolverRoof, CoveragePreflight, CoverageRegion } from './types';
import { useI18n, type LocalizedText } from './i18n';
import {
  createIdSuffix,
  latLonToENU,
  enuToLatLon,
  fetchOSMBuildings,
  getWaypointPosition,
} from './utils';
import { ApiRequestError, solveLink, readCoveragePreflight, readBackendHealth, inspectScene, inspectCsiLink, importScenePackage, readSolverRoofs, generateBuilding } from './api';
import type { BackendHealth, SceneInspection, CsiRun, CsiRunMode, CsiRunOutput, CsiSelection, CsiLinkPreview, CsiRunRequest, CoverageJobRequest, HandoverConfig } from './api';
import {
  clearAutosavedProject,
  loadAutosavedProject,
  newProjectId,
  parseProjectDocument,
  replaceUnreadableAutosave,
  saveAutosavedProject,
  StudioProjectState,
  DEFAULT_CSI_SETTINGS,
  FutureAutosaveError,
  UnreadableAutosaveError,
} from './project';
import type { ProjectAutosaveStatus, StudioProjectDocument, StudioWorkspace } from './project';
import { STARTER_ANCHOR, STARTER_AP, STARTER_BUILDINGS, STARTER_ROUTE, STARTER_UE } from './starterScene';
import { URBAN_DEMO, urbanDeployment } from './urbanDemo';
import { deviceAtRunPosition, sampleTrajectory, trajectorySampling } from './lib/trajectory';
import { compareCoverage, type CoverageSnapshot } from './lib/coverageComparison';
import { startCsiJob, startCoverageJob, type SimulationJob } from './lib/simulationJobs';
import { useSimulationTask } from './lib/useSimulationTask';
import { ExperimentPresets } from './components/ExperimentPresets';
import { SimulationJobStatus } from './components/SimulationJobStatus';
import { starterExperiment, type ExperimentPreset } from './lib/experimentPresets';
import type { WaypointFrame } from './types';

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
type CoverageSceneSnapshot = CoverageSnapshot & {
  anchor: GeoAnchor;
  scene: {
    buildings: BuildingFootprint[];
    txs: Transmitter[];
    rxs: Receiver[];
    visual?: SceneVisual;
    name?: string;
    roofs?: SolverRoof[];
  };
};

type SimulationTask = 'csi' | 'coverage' | 'diagnostics';
type CompactDock = 'objects' | 'inspector' | 'closed';

const SIMULATION_TASKS = [
  { id: 'csi', en: 'CSI', zh: 'CSI', icon: Waves },
  { id: 'coverage', en: 'Coverage', zh: '覆盖', icon: RadioTower },
  { id: 'diagnostics', en: 'Link diagnostics', zh: '链路诊断', icon: Activity },
] as const;

function positionDevice<T extends Transmitter | Receiver>(device: T, enu: ENUVector, anchor: GeoAnchor): T {
  const { lat, lon } = enuToLatLon(enu, anchor);
  return { ...device, enu, latitude: lat, longitude: lon };
}

function nextDeviceName(devices: (Transmitter | Receiver)[], prefix: 'AP' | 'UE') {
  const names = new Set(devices.map(device => device.name));
  let index = devices.length + 1;
  while (names.has(`${prefix} ${index}`)) index += 1;
  return `${prefix} ${index}`;
}

function warnUnsavedProject(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = 'Unsaved project changes';
}

export default function App() {
  const { t } = useI18n();
  const [initialProject, setInitialProject] = useState<StudioProjectDocument | null | undefined>();
  const [loadFailure, setLoadFailure] = useState<'unreadable' | 'future' | 'storage' | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [temporary, setTemporary] = useState(false);

  useEffect(() => {
    let current = true;
    loadAutosavedProject().then(project => {
      if (current) setInitialProject(project);
    }).catch(error => {
      if (!current) return;
      console.warn('Could not restore the autosaved SionnaRTStudio project.', error);
      setLoadFailure(error instanceof UnreadableAutosaveError ? 'unreadable'
        : error instanceof FutureAutosaveError ? 'future' : 'storage');
    });
    return () => { current = false; };
  }, [loadAttempt]);

  if (initialProject !== undefined || temporary) {
    return <StudioApp initialProject={initialProject?.state ?? null} initialProjectId={initialProject?.projectId} startTemporary={temporary}
      unreadableAutosave={loadFailure === 'unreadable'} />;
  }

  return (
    <main className="min-h-screen grid place-content-center gap-3 p-4 text-center text-[var(--text-hi)]">
      {loadFailure ? <>
        <p role="alert">{loadFailure === 'unreadable'
          ? t('The local autosave could not be read. Open a temporary project to replace it.', '无法读取本地自动存档。可以打开临时项目并替换存档。')
          : loadFailure === 'future'
            ? t('This autosave was created by a newer version of Studio.', '此自动存档由较新版本的实验台创建。')
            : t('Could not open the local project storage.', '无法打开本地项目存储。')}</p>
        <button className="btn-signal mx-auto rounded px-3 py-2" onClick={() => {
          setLoadFailure(null);
          setLoadAttempt(attempt => attempt + 1);
        }}>{t('Retry opening project', '重试打开项目')}</button>
        <button className="mx-auto text-sm underline underline-offset-2" onClick={() => setTemporary(true)}>
          {t('Open a temporary project', '打开临时项目')}
        </button>
      </> : <p role="status">{t('Opening project…', '正在打开项目…')}</p>}
    </main>
  );
}

function StudioApp({ initialProject, initialProjectId, startTemporary, unreadableAutosave }: {
  initialProject: StudioProjectState | null;
  initialProjectId?: string;
  startTemporary: boolean;
  unreadableAutosave: boolean;
}) {
  const { t } = useI18n();
  const [temporary, setTemporary] = useState(startTemporary);
  const [projectId, setProjectId] = useState(() => initialProjectId ?? newProjectId());
  const [anchor, setAnchor] = useState<GeoAnchor>(
    () => initialProject?.scene.anchor ?? STARTER_ANCHOR,
  );
  const [mapAnchor, setMapAnchor] = useState(anchor);

  // ── Multiple transmitters & receivers ───────────────────────────────────
  // The arrays hold every device; `activeTxId`/`activeRxId` mark the one the
  // sliders, map drag and 3D drag currently edit. `tx`/`rx` below are derived
  // from those, so all single-device UI keeps working on the active device.
  const [txs, setTxs] = useState<Transmitter[]>(() => initialProject?.devices.transmitters ?? [STARTER_AP]);
  const [rxs, setRxs] = useState<Receiver[]>(() => initialProject?.devices.receivers ?? [STARTER_UE]);
  const [activeTxId, setActiveTxId] = useState(
    () => initialProject?.devices.activeTxId ?? STARTER_AP.id,
  );
  const [activeRxId, setActiveRxId] = useState(
    () => initialProject?.devices.activeRxId ?? STARTER_UE.id,
  );
  const [fronthaulMbpsByTxId, setFronthaul] = useState<Record<string, number | null>>(
    () => initialProject?.devices.fronthaulMbpsByTxId ?? {},
  );

  const tx = txs.find((t) => t.id === activeTxId) ?? txs[0];
  const rx = rxs.find((r) => r.id === activeRxId) ?? rxs[0];

  const [buildings, setBuildings] = useState<BuildingFootprint[]>(
    () => initialProject?.scene.buildings ?? STARTER_BUILDINGS,
  );
  const [sceneVisual, setSceneVisual] = useState<SceneVisual | undefined>(() => initialProject?.scene.visual);
  const [sceneName, setSceneName] = useState<string | undefined>(() => initialProject?.scene.name);
  const [sceneFloor, setSceneFloor] = useState<string>();
  const [packageLoading, setPackageLoading] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(!initialProject);
  const [selectedPreset, setSelectedPreset] = useState<ExperimentPreset | null>(null);
  const [presetMode, setPresetMode] = useState<{ mode: CsiRunMode }>();
  const [packageError, setPackageError] = useState('');
  const [buildingDialog, setBuildingDialog] = useState<{ spec: BuildingSpec; editing: boolean }>();
  const [buildingBusy, setBuildingBusy] = useState(false);
  const [buildingError, setBuildingError] = useState('');
  const buildingRequest = useRef(0);
  const sceneFloors = React.useMemo(() => {
    const floors = new Set<string>();
    for (const object of buildings) if (object.floor) floors.add(object.floor);
    return Array.from(floors).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [buildings]);
  const [freqGhz, setFreqGhz] = useState(
    () => initialProject?.solver.carrierFrequencyGhz ?? 28.0,
  ); // Default to mmWave
  const [maxDepth, setMaxDepth] = useState(
    () => initialProject?.solver.maxDepth ?? 3,
  ); // Sionna RT max interaction depth

  // Ray-interaction switches + Tx antenna pattern/polarization (sionna-rt-gui style).
  const [solverOptions, setSolverOptions] = useState<SolverOptions>(
    () => initialProject?.solver.options ?? DEFAULT_SOLVER_OPTIONS,
  );
  const [csiSettings, setCsiSettings] = useState(() => initialProject?.csi ?? DEFAULT_CSI_SETTINGS);

  // Radio map display (colormap + manual range), like sionna-rt-gui's map panel.
  const [rmColormap, setRmColormap] = useState<ColormapName>(
    () => initialProject?.display.radioMapColormap ?? 'viridis',
  );
  const [rmAutoRange, setRmAutoRange] = useState(
    () => initialProject?.display.radioMapAutoRange ?? true,
  );
  const [rmVmin, setRmVmin] = useState(
    () => initialProject?.display.radioMapVmin ?? -120,
  );
  const [rmVmax, setRmVmax] = useState(
    () => initialProject?.display.radioMapVmax ?? -50,
  );

  const [workspace, setWorkspace] = useState<StudioWorkspace>(
    () => initialProject?.display.workspace ?? 'scene',
  );

  const [simulationTask, setSimulationTask] = useState<SimulationTask>(
    () => initialProject?.display.activeMode === 'heatmap' ? 'coverage' : 'csi',
  );
  const simulationSidebar = useRef<HTMLElement>(null);
  const simulationScrollPositions = useRef<Partial<Record<SimulationTask, number>>>({});
  const activeMode = simulationTask === 'coverage' ? 'heatmap' : 'link';
  const [visitedDiagnostics, setVisitedDiagnostics] = useState(false);
  const [downloadTask, setDownloadTask] = useState<'coverage' | 'diagnostics' | null>(null);
  const [sceneDock, setSceneDock] = useState<CompactDock>('objects');
  const [deviceDock, setDeviceDock] = useState<CompactDock>('objects');
  const [deploymentSelection, setDeploymentSelection] = useState<'tx' | 'rx'>('tx');
  const [showSceneDevices, setShowSceneDevices] = useState(false);
  const [focusObject, setFocusObject] = useState<{ id: string }>();
  const [placementMode, setPlacementMode] = useState<PlacementMode>('none');
  const [showOutlines, setShowOutlines] = useState(
    () => initialProject?.display.showOutlines ?? true,
  );
  const [showRaysOnHeatmap, setShowRaysOnHeatmap] = useState(
    () => initialProject?.display.showRaysOnHeatmap ?? false,
  ); // overlay rays on coverage

  // Coverage Map State
  const [coverageIssue, setCoverageIssue] = useState<LocalizedText | null>(null);
  // Interference-aware coverage controls (Sionna RadioMapSolver rss/sinr).
  const [coverageMetric, setCoverageMetric] = useState<CoverageMetric>(
    () => initialProject?.coverage.metric ?? 'power',
  );
  const [coverageRegion, setCoverageRegion] = useState<CoverageRegion | null>(() => initialProject?.coverage.region ?? null);
  const [coverageFloorId, setCoverageFloorId] = useState<string | null>(() => initialProject?.coverage.floorId ?? null);
  const [coverageThreshold, setCoverageThreshold] = useState<number | null>(() => initialProject?.coverage.thresholdDb ?? null);
  const [coverageBaseline, setCoverageBaseline] = useState<CoverageSceneSnapshot | null>(null);
  const [coverageView, setCoverageView] = useState<'baseline' | 'current'>('current');
  const [coverageBandwidthMhz, setCoverageBandwidthMhz] = useState(
    () => initialProject?.coverage.bandwidthMhz ?? 100,
  );
  const [coverageNoiseFigureDb, setCoverageNoiseFigureDb] = useState(
    () => initialProject?.coverage.noiseFigureDb ?? 7,
  );
  const [coverageHeight, setCoverageHeight] = useState(
    () => initialProject?.coverage.heightM ?? 1.5,
  );
  const [coverageRes, setCoverageRes] = useState(
    () => initialProject?.coverage.gridStepM ?? 8,
  );
  const [coverageSamplesPerTx, setCoverageSamplesPerTx] = useState(
    () => initialProject?.coverage.samplesPerTx ?? 1_000_000,
  );
  const [radioMapSeed, setRadioMapSeed] = useState(
    () => initialProject?.coverage.seed ?? 42,
  );

  // Per-material scattering / EM overrides, keyed by material id, sent with solves.
  const [materialConfigs, setMaterialConfigs] = useState<Record<string, MaterialConfig>>(
    () => initialProject?.solver.materialConfigs ?? {},
  );
  const materialIds = React.useMemo(
    () => Array.from(new Set(['itu_concrete', ...buildings.filter(isRadioSurface).map(b => b.material),
      ...Object.keys(materialConfigs)])).sort(),
    [buildings, materialConfigs],
  );
  const materialIdsKey = JSON.stringify(materialIds);
  const materialList = React.useMemo<MaterialConfig[]>(
    () => (JSON.parse(materialIdsKey) as string[]).map(id => Object.hasOwn(materialConfigs, id)
      ? materialConfigs[id] : defaultMaterialConfig(id)),
    [materialIdsKey, materialConfigs],
  );
  const updateMaterial = (cfg: MaterialConfig) => {
    editor.commit(buildings, anchor, () => setMaterialConfigs(materialConfigs));
    setMaterialConfigs(prev => ({ ...prev, [cfg.id]: cfg }));
  };

  // GIS Data Fetcher States
  const [gisLoading, setGisLoading] = useState(false);
  const gisRequest = useRef(0);
  const [downloadMessage, setDownloadProgress] = useState<LocalizedText>(['', '']);
  const downloadProgress = t(...downloadMessage);

  // Trajectory points state
  const [trajectoriesByRxId, setTrajectories] = useState<Record<string, TrajectoryPoint[]>>(
    () => initialProject?.mobility.trajectoriesByRxId ?? { [STARTER_UE.id]: STARTER_ROUTE },
  );
  const [waypointFrameByRxId, setWaypointFrames] = useState<Record<string, WaypointFrame>>(
    () => initialProject?.mobility.waypointFrameByRxId ?? {},
  );
  const trajectoryPoints = Object.hasOwn(trajectoriesByRxId, rx.id) ? trajectoriesByRxId[rx.id] : EMPTY_TRACK;
  const setTrajectoryPoints = (points: TrajectoryPoint[], frame?: WaypointFrame) => {
    setTrajectories(prev => ({ ...prev, [rx.id]: points }));
    setWaypointFrames(prev => {
      if (frame) return { ...prev, [rx.id]: frame };
      if (!Object.hasOwn(prev, rx.id)) return prev;
      const next = { ...prev };
      delete next[rx.id];
      return next;
    });
  };

  // PROPAGATION LINK PHYSICS SOLVER — real Sionna RT on the backend, run on demand.
  const [paths, setPaths] = useState<PropagationPath[]>([]);
  const [metrics, setMetrics] = useState<ChannelMetrics>(EMPTY_METRICS);
  const [solving, setSolving] = useState(false);
  const [solveIssue, setSolveError] = useState<LocalizedText | null>(null);
  const solveError = solveIssue ? t(...solveIssue) : '';
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const backendOnline = !!health;
  useEffect(() => {
    let cancelled = false;
    let busy = false;
    const probe = async () => {
      if (busy) return;
      busy = true;
      const result = await readBackendHealth();
      if (!cancelled) setHealth(result);
      busy = false;
    };
    void probe();
    const id = window.setInterval(probe, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);
  const geometryKey = React.useMemo(() => JSON.stringify(physicalSceneInputs(buildings)), [buildings]);
  // All-pairs link matrix (Tx × Rx), keyed `${txId}|${rxId}`.
  const [matrix, setMatrix] = useState<Record<string, MatrixCell>>({});
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixProgress, setMatrixProgress] = useState('');
  // Whether the 3D scene overlays ALL matrix rays. True right after Solve All
  // Pairs; false once the user focuses a single pair (cell click / Solve Link),
  // so a fresh single-link solve isn't drowned out by every pair's rays.
  const [matrixRaysVisible, setMatrixRaysVisible] = useState(false);
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
    geometryKey,
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
    try {
      const res = await solveLink(tx, rx, buildings, freqGhz, maxDepth, solverOptions, materialList);
      if (revision !== sceneRevision.current || activePair.current.txId !== tx.id || activePair.current.rxId !== rx.id) return;
      setPaths(res.paths);
      setMetrics(res.metrics);
      setMatrixRaysVisible(false); // focus the 3D scene on this single link
    } catch (e: any) {
      if (revision !== sceneRevision.current || activePair.current.txId !== tx.id || activePair.current.rxId !== rx.id) return;
      const detail = e instanceof Error ? ` (${e.message})` : '';
      setSolveError([`Link solve failed${detail}`, `链路求解失败${detail}`]);
    } finally {
      setSolving(false);
    }
  };

  // Solve every Tx → Rx pair (serial GPU ray traces, scene is cached).
  const handleSolveMatrix = async () => {
    const revision = sceneRevision.current;
    setMatrixLoading(true);
    setSolveError(null);
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
    } catch (e: any) {
      if (revision !== sceneRevision.current) return;
      const detail = e instanceof Error ? ` (${e.message})` : '';
      setSolveError([`Link matrix solve failed${detail}`, `链路矩阵求解失败${detail}`]);
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
    setActiveTxId(txId);
    setActiveRxId(rxId);
    const cell = matrix[`${txId}|${rxId}`];
    if (!cell && txId === activeTxId && rxId === activeRxId) return;
    setSolveError(null);
    setPaths(cell?.paths ?? []);
    setMetrics(cell?.metrics ?? EMPTY_METRICS);
    setMatrixRaysVisible(false);
  };

  // ── Device list management (add / remove / select) ──────────────────────
  const startPlacement = (mode: PlacementMode) => {
    if (mode === 'add-tx' || mode === 'add-rx') {
      setDeploymentSelection(mode === 'add-tx' ? 'tx' : 'rx');
    }
    setPlacementMode(mode);
  };

  const selectDevice = (kind: 'tx' | 'rx', id: string) => {
    setPlacementMode('none');
    setDeploymentSelection(kind);
    setDeviceDock('inspector');
    if (kind === 'tx') handleSelectPair(id, activeRxId);
    else handleSelectPair(activeTxId, id);
  };

  const placeDevice = (mode: Exclude<PlacementMode, 'none'>, enu: ENUVector, absoluteHeight?: number) => {
    const place = <T extends Receiver | Transmitter>(device: T): T => positionDevice(absoluteHeight === undefined
      ? device : { ...device, heightReference: 'enu', height: absoluteHeight }, enu, anchor);
    if (mode === 'move-tx' || mode === 'move-rx') {
      if (mode === 'move-tx') handleTxUpdate(place(tx));
      else handleRxUpdate(place(rx));
      setPlacementMode('none');
      return;
    }
    const suffix = createIdSuffix();
    if (mode === 'add-tx') {
      const added = place({ ...tx, id: `tx_${suffix}`, name: nextDeviceName(txs, 'AP') });
      setTxs(prev => [...prev, added]);
      setActiveTxId(added.id);
      setDeploymentSelection('tx');
    } else {
      const added = place({ ...rx, id: `rx_${suffix}`, name: nextDeviceName(rxs, 'UE') });
      setRxs(prev => [...prev, added]);
      setActiveRxId(added.id);
      setDeploymentSelection('rx');
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
    setWaypointFrames(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
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

  const sceneEditRevision = useRef(buildings);
  sceneEditRevision.current = buildings;
  const startBuilding = (first: ENUVector, opposite: ENUVector) => {
    const east = Number(((first.x + opposite.x) / 2).toFixed(2));
    const north = Number(((first.y + opposite.y) / 2).toFixed(2));
    const baseZ = Number((terrainHeight({ x: east, y: north }, buildings) ?? 0).toFixed(3));
    setBuildingError('');
    setBuildingDialog({ editing: false, spec: {
      id: `building-${createIdSuffix()}`, name: t('New building', '新建建筑'), east, north, baseZ,
      length: Number(Math.abs(first.x - opposite.x).toFixed(2)),
      width: Number(Math.abs(first.y - opposite.y).toFixed(2)), height: 12, rotationDeg: 0, layout: 'office',
    } });
  };
  const editor = useSceneEditor(buildings, anchor, setBuildings, handleAnchorChange, initialProject?.scene.hiddenLayers, startBuilding);
  const closeBuildingDialog = () => {
    buildingRequest.current++;
    setBuildingDialog(undefined);
    setBuildingBusy(false);
    setBuildingError('');
  };
  const editGeneratedBuilding = (spec: BuildingSpec) => {
    setBuildingError('');
    setBuildingDialog({ editing: true, spec });
  };
  const removeGeneratedBuilding = (id: string) => {
    editor.commit(buildings.filter(object => object.buildingSpec?.id !== id));
    editor.select(null);
    editor.chooseTool('select');
    setFocusObject(undefined);
  };
  const applyBuilding = async (spec: BuildingSpec) => {
    if (buildingBusy) return;
    const request = ++buildingRequest.current;
    setBuildingBusy(true);
    setBuildingError('');
    try {
      const generated = await generateBuilding(spec);
      if (request !== buildingRequest.current) return;
      if (sceneEditRevision.current !== buildings) {
        setBuildingError('The scene changed. Apply again to use the current scene.');
        return;
      }
      const previous = new Map<string, BuildingFootprint>(buildings
        .filter(object => object.buildingSpec?.id === spec.id).map(object => [object.id, object]));
      const otherObjects = buildings.filter(object => object.buildingSpec?.id !== spec.id);
      const otherIds = new Set(otherObjects.map(object => object.id));
      if (generated.objects.some(object => otherIds.has(object.id))) {
        setBuildingError('A generated object ID conflicts with the current scene.');
        return;
      }
      const objects = generated.objects.map(object => {
        const old = previous.get(object.id);
        const materialOverride = old?.materialSource === 'manual'
          ? { material: old.material, materialSource: 'manual' as const } : {};
        return withFootprint({ ...object, ...materialOverride, buildingSpec: generated.spec }, object.enuPoints, anchor);
      });
      const nextFloor = buildingDialog?.editing && objects.some(object => object.floor === sceneFloor) ? sceneFloor : undefined;
      const selected = objects.find(object => object.id === editor.selected?.id && (!nextFloor || object.floor === nextFloor))
        ?? objects.find(object => object.type === 'generated_facade' && (!nextFloor || object.floor === nextFloor))
        ?? objects.find(object => !nextFloor || object.floor === nextFloor);
      const retainedBindings = sceneVisual?.bindings.filter(binding => !previous.has(binding.id));
      const replaceVisual = sceneVisual && retainedBindings && retainedBindings.length < sceneVisual.bindings.length;
      editor.commit([...otherObjects, ...objects], anchor, () => {
        setSceneFloor(sceneFloor);
        if (replaceVisual) setSceneVisual(sceneVisual);
        editor.setHiddenLayers(editor.hiddenLayers);
      });
      if (replaceVisual) setSceneVisual(retainedBindings.length ? { ...sceneVisual, bindings: retainedBindings } : undefined);
      editor.chooseTool('select');
      editor.setSolverMesh(false);
      editor.setTop(false);
      editor.setHiddenLayers(editor.hiddenLayers.filter(layer => layer !== 'building'));
      editor.select(selected?.id ?? null);
      setSceneFloor(nextFloor);
      setFocusObject(selected ? { id: selected.id } : undefined);
      closeBuildingDialog();
    } catch (error) {
      if (request === buildingRequest.current) setBuildingError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === buildingRequest.current) setBuildingBusy(false);
    }
  };
  const selectedSceneObjectId = editor.selected?.id;
  useEffect(() => {
    if (selectedSceneObjectId) setSceneDock('inspector');
  }, [selectedSceneObjectId]);
  const [osmMode, setOsmMode] = useState<'replace' | 'merge'>('replace');
  const [inspection, setInspection] = useState<{ input: object; result: SceneInspection } | null>(null);
  const [inspectionIssue, setInspectionIssue] = useState('');
  const inspectionInput = React.useMemo(() => ({ buildings, freqGhz, materialList }), [buildings, freqGhz, materialList]);
  const currentInspection = backendOnline && inspection?.input === inspectionInput ? inspection.result : null;
  const [roofInspection, setRoofInspection] = useState<{ buildings: BuildingFootprint[]; roofs: SolverRoof[] } | null>(null);
  const solverRoofs = roofInspection?.buildings === buildings ? roofInspection.roofs : undefined;
  useEffect(() => {
    if (!backendOnline) return;
    let current = true;
    let retryTimer: number | undefined;
    let retryDelay = 1_000;
    const refresh = () => {
      readSolverRoofs(buildings).then(
        roofs => { if (current) setRoofInspection({ buildings, roofs }); },
        () => {
          if (!current) return;
          retryTimer = window.setTimeout(refresh, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 10_000);
        },
      );
    };
    refresh();
    return () => { current = false; window.clearTimeout(retryTimer); };
  }, [backendOnline, buildings]);

  useEffect(() => {
    if (!backendOnline || workspace !== 'scene') return;
    let cancelled = false;
    setInspectionIssue('');
    const timer = window.setTimeout(() => {
      inspectScene(inspectionInput.buildings, inspectionInput.freqGhz, inspectionInput.materialList).then(
        result => { if (!cancelled) setInspection({ input: inspectionInput, result }); },
        error => { if (!cancelled) setInspectionIssue(error instanceof Error ? error.message : String(error)); },
      );
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [backendOnline, workspace, inspectionInput]);

  const replaceSceneGeometry = (objects: BuildingFootprint[], nextAnchor = anchor, restore?: () => void) => {
    closeBuildingDialog();
    editor.commit(objects, nextAnchor, () => {
      setSceneVisual(sceneVisual);
      setSceneName(sceneName);
      setSceneFloor(sceneFloor);
      setCoverageFloorId(coverageFloorId);
      restore?.();
    });
    setCoverageFloorId(null);
    setSceneVisual(undefined);
    setSceneName(undefined);
    setSceneFloor(undefined);
  };

  const openBlankScene = () => {
    gisRequest.current++;
    setGisLoading(false);
    setPackageLoading(false);
    setPackageError('');
    setDownloadProgress(['', '']);
    replaceSceneGeometry([]);
    editor.select(null);
    editor.chooseTool('select');
    editor.setSolverMesh(false);
    setSceneDock('objects');
    setFocusObject(undefined);
  };

  const useStarterScene = (restore?: () => void) => {
    gisRequest.current++;
    setGisLoading(false);
    setPackageLoading(false);
    setPackageError('');
    setDownloadProgress(['', '']);
    replaceSceneGeometry(STARTER_BUILDINGS, STARTER_ANCHOR, restore);
    editor.select(null);
    editor.chooseTool('select');
    editor.setSolverMesh(false);
    setSceneDock('objects');
    setFocusObject(undefined);
  };

  const selectSceneObject = (id: string | null) => {
    editor.chooseTool('select');
    editor.select(id);
    if (id) setSceneDock('inspector');
  };

  const locateSceneObject = (id: string) => {
    selectSceneObject(id);
    const object = buildings.find(building => building.id === id);
    if (object) {
      editor.setHiddenLayers(editor.hiddenLayers.filter(layer => layer !== object.category));
      if (sceneFloor && object.floor && object.floor !== sceneFloor) setSceneFloor(object.floor);
      setFocusObject({ id });
    }
  };

  const toggleSceneInspection = () => {
    editor.chooseTool('select');
    editor.setSolverMesh(!editor.solverMesh);
    if (!editor.solverMesh) {
      editor.setTop(false);
      setSceneDock('inspector');
    }
  };

  // OVERPASS GIS DOWNLOAD PIPELINE
  const handleDownloadOSM = async (bounds: L.LatLngBounds) => {
    const request = ++gisRequest.current;
    const selectedAnchor = mapAnchor;
    setPackageLoading(false);
    setPackageError('');
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

      if (sceneEditRevision.current !== buildings) {
        setDownloadProgress(['Scene changed during download. Import again to apply the map.', '下载期间场景已修改。请重新导入地图。']);
        return;
      }
      if (loadedBuildings.length === 0) {
        setDownloadProgress(['No buildings found in this area. Keeping the current scene.', '所选区域未找到建筑，保留当前场景。']);
        return;
      }

      if (osmMode === 'merge') {
        const known = new Set(buildings.map(object => object.id));
        const added = loadedBuildings.filter(object => !known.has(object.id)).map(object =>
          withFootprint(object, object.points.map(p => latLonToENU(p.lat, p.lon, anchor)), anchor),
        );
        editor.commit([...buildings, ...added]);
        setDownloadProgress([`Merged ${added.length} new map features.`, `已合并 ${added.length} 个新地图要素。`]);
        return;
      }
      replaceSceneGeometry(loadedBuildings, selectedAnchor);
      editor.select(null);
      editor.chooseTool('select');
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
    () => initialProject?.mobility.combineMode ?? 'best_server',
  );
  // A3 handover parameters (applied on the next Run Mobility) + the backend's
  // hysteresis/TTT association analysis for the last run.
  const [handoverConfig, setHandoverConfig] = useState<HandoverConfig>(
    () => initialProject?.mobility.handover ?? { hysteresisDb: 3, timeToTriggerMs: 160 },
  );
  const [mobilitySpeedKmh, setMobilitySpeedKmh] = useState(
    () => initialProject?.mobility.speedKmh ?? 30,
  );
  const [mobilityIntervalMs, setMobilityIntervalMs] = useState(
    () => initialProject?.mobility.intervalMs ?? 100,
  );
  const [autosaveStatus, setAutosaveStatus] = useState<ProjectAutosaveStatus>(
    temporary ? 'disabled' : initialProject ? 'saved' : 'saving',
  );
  const [saveAttempt, setSaveAttempt] = useState(0);
  const saveImmediately = useRef(false);
  const resettingRef = useRef(false);
  const replacingAutosave = useRef(false);
  const [recoveryError, setRecoveryError] = useState<LocalizedText | null>(null);

  const projectState = React.useMemo<StudioProjectState>(() => ({
    scene: { coordinateFrame: 'ENU_m', anchor, buildings, hiddenLayers: editor.hiddenLayers, name: sceneName, visual: sceneVisual },
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
      region: coverageRegion, floorId: coverageFloorId, thresholdDb: coverageThreshold,
      bandwidthMhz: coverageBandwidthMhz,
      noiseFigureDb: coverageNoiseFigureDb,
      heightM: coverageHeight,
      gridStepM: coverageRes,
      samplesPerTx: coverageSamplesPerTx,
      seed: radioMapSeed,
    },
    mobility: {
      trajectoriesByRxId,
      waypointFrameByRxId,
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
    anchor, buildings, editor.hiddenLayers, sceneName, sceneVisual, txs, rxs, activeTxId, activeRxId, fronthaulMbpsByTxId, csiSettings, freqGhz, maxDepth,
    solverOptions, materialConfigs, coverageMetric, coverageRegion, coverageFloorId, coverageThreshold, coverageBandwidthMhz,
    coverageNoiseFigureDb, coverageHeight, coverageRes, coverageSamplesPerTx,
    radioMapSeed, trajectoriesByRxId, waypointFrameByRxId, mobilityCombineMode, handoverConfig,
    mobilitySpeedKmh, mobilityIntervalMs, workspace, activeMode, showOutlines,
    showRaysOnHeatmap, rmColormap, rmAutoRange, rmVmin, rmVmax,
  ]);
  const lastSavedProject = useRef(initialProject || temporary ? projectState : null);
  const latestProjectState = useRef(projectState);
  useLayoutEffect(() => { latestProjectState.current = projectState; }, [projectState]);

  // Persist only editable inputs and display choices. Solver outputs are
  // intentionally omitted because they become stale whenever an input changes.
  useLayoutEffect(() => {
    if (temporary || projectState === lastSavedProject.current) return;
    let current = true;
    let started = false;
    const save = () => {
      if (started || resettingRef.current) return;
      started = true;
      saveAutosavedProject(projectState, projectId).then(() => {
        if (!current || resettingRef.current) return;
        lastSavedProject.current = projectState;
        setAutosaveStatus('saved');
      }).catch(error => {
        if (!current || resettingRef.current) return;
        console.warn('Could not autosave the SionnaRTStudio project.', error);
        setAutosaveStatus('error');
      });
    };
    setAutosaveStatus('saving');
    const timeout = saveImmediately.current ? undefined : window.setTimeout(save, 500);
    if (saveImmediately.current) {
      saveImmediately.current = false;
      save();
    }
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') save();
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('sionna-studio-flush-project', save);
    return () => {
      current = false;
      window.clearTimeout(timeout);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('sionna-studio-flush-project', save);
    };
  }, [projectState, projectId, saveAttempt, temporary]);

  const projectChanged = projectState !== lastSavedProject.current;
  const projectSaveState = autosaveStatus === 'disabled'
    ? projectChanged ? 'error' : 'saved'
    : autosaveStatus === 'saved' && projectChanged ? 'saving' : autosaveStatus;
  useLayoutEffect(() => {
    document.documentElement.dataset.projectSaveState = projectSaveState;
    if (projectSaveState !== 'saved') window.addEventListener('beforeunload', warnUnsavedProject);
    return () => window.removeEventListener('beforeunload', warnUnsavedProject);
  }, [projectSaveState]);

  const retryAutosave = () => {
    saveImmediately.current = true;
    setSaveAttempt(attempt => attempt + 1);
  };

  const handleReplaceUnreadableAutosave = async () => {
    if (!temporary || !unreadableAutosave || replacingAutosave.current) return;
    if (!window.confirm(t(
      'Replace the unreadable autosave with this project and resume autosaving?',
      '用当前项目替换无法读取的自动存档，并恢复自动保存？',
    ))) return;
    replacingAutosave.current = true;
    setRecoveryError(null);
    window.addEventListener('beforeunload', warnUnsavedProject);
    document.documentElement.dataset.projectSaveState = 'saving';
    setAutosaveStatus('saving');
    try {
      const replaced = await replaceUnreadableAutosave(projectState, projectId);
      if (!replaced) {
        setRecoveryError(['The local autosave changed. Export this temporary project before reopening Studio.',
          '本地自动存档已变更。请先导出临时项目，再重新打开实验台。']);
        setAutosaveStatus('disabled');
        return;
      }
      lastSavedProject.current = projectState;
      saveImmediately.current = latestProjectState.current !== projectState;
      setTemporary(false);
      setAutosaveStatus('saved');
    } catch (error) {
      console.warn('Could not replace the unreadable autosave.', error);
      setRecoveryError(['Could not replace the autosave. Your temporary project is still open.',
        '无法替换自动存档，当前临时项目仍可使用。']);
      setAutosaveStatus('disabled');
    } finally {
      replacingAutosave.current = false;
    }
  };

  const saveImportedProject = () => {
    // Protect closing as soon as the import is applied and bypass the usual
    // editing delay when the new project state is ready.
    window.addEventListener('beforeunload', warnUnsavedProject);
    document.documentElement.dataset.projectSaveState = temporary && !replacingAutosave.current ? 'error' : 'saving';
    if (!temporary) {
      saveImmediately.current = true;
      setAutosaveStatus('saving');
    }
  };

  const handleResetProject = async () => {
    if (resettingRef.current || replacingAutosave.current) return;
    const confirmed = window.confirm(temporary ? t(
      'Discard this temporary project and reopen Studio?',
      '放弃当前临时项目并重新打开实验台？',
    ) : t(
      'Reset the studio to its defaults?\n\n'
      + 'This discards the autosaved project: scene geometry, every transmitter '
      + 'and receiver, solver and material settings, trajectory, and coverage '
      + 'controls. Exported files are not affected.\n\n'
      + 'Export the project first if you want to keep it.',
      '恢复实验台默认设置？\n\n这会清除自动保存的场景、收发设备、求解和材质设置、轨迹及覆盖参数。已导出的文件仍可使用。\n\n如需保留当前项目，请先导出。',
    ));
    if (!confirmed) return;
    if (temporary) {
      window.removeEventListener('beforeunload', warnUnsavedProject);
      window.location.reload();
      return;
    }
    resettingRef.current = true;
    try {
      await clearAutosavedProject();
      window.removeEventListener('beforeunload', warnUnsavedProject);
      window.location.reload();
    } catch (error) {
      console.warn('Could not clear the autosaved SionnaRTStudio project.', error);
      resettingRef.current = false;
      retryAutosave();
      window.alert(t('Could not reset the local project.', '无法重置本地项目。'));
    }
  };


  const handleImportProject = (text: string) => {
    const document = parseProjectDocument(text);
    const imported = document.state;
    setProjectId(document.projectId);
    closeBuildingDialog();
    saveImportedProject();
    simulationScrollPositions.current = {};
    if (simulationSidebar.current) simulationSidebar.current.scrollTop = 0;
    csiTask.reset();
    setCsiResult(null);
    setLiveCsiSelection(null);
    setHistorySelection(undefined);
    history.close();
    setCsiIssue(null);
    setCsiReceiverId(null);
    setExpiredRunId(null);
    gisRequest.current++;
    setGisLoading(false);
    setPackageLoading(false);
    setPackageError('');
    setDownloadProgress(['', '']);
    setAnchor(imported.scene.anchor);
    setMapAnchor(imported.scene.anchor);
    setBuildings(imported.scene.buildings);
    setSceneVisual(imported.scene.visual);
    setSceneName(imported.scene.name);
    setSceneFloor(undefined);
    editor.reset();
    editor.setSolverMesh(false);
    editor.setTop(false);
    editor.setHiddenLayers(imported.scene.hiddenLayers ?? []);
    setFocusObject(undefined);
    setSceneDock('objects');
    setDeviceDock('objects');
    setDeploymentSelection('tx');
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
    setCoverageRegion(imported.coverage.region ?? null);
    setCoverageFloorId(imported.coverage.floorId ?? null);
    setCoverageThreshold(imported.coverage.thresholdDb ?? null);
    setCoverageBaseline(null);
    setCoverageView('current');
    setSelectedPreset(null);
    setCoverageBandwidthMhz(imported.coverage.bandwidthMhz);
    setCoverageNoiseFigureDb(imported.coverage.noiseFigureDb);
    setCoverageHeight(imported.coverage.heightM);
    setCoverageRes(imported.coverage.gridStepM);
    setCoverageSamplesPerTx(imported.coverage.samplesPerTx);
    setRadioMapSeed(imported.coverage.seed);
    setTrajectories(imported.mobility.trajectoriesByRxId);
    setWaypointFrames(imported.mobility.waypointFrameByRxId ?? {});
    setMobilityCombineMode(imported.mobility.combineMode);
    setHandoverConfig(imported.mobility.handover);
    setMobilitySpeedKmh(imported.mobility.speedKmh);
    setMobilityIntervalMs(imported.mobility.intervalMs);
    setWorkspace(imported.display.workspace);
    setSimulationTask(imported.display.activeMode === 'heatmap' ? 'coverage' : 'csi');
    setVisitedDiagnostics(false);
    setDownloadTask(null);
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
    coverageTask.reset();
    setCoverageResult(null);
    setCoverageIssue(null);
    setSolveError(null);
  };

  const restoreExperimentInputs = (before: StudioProjectState) => {
    setTxs(before.devices.transmitters);
    setRxs(before.devices.receivers);
    setActiveTxId(before.devices.activeTxId);
    setActiveRxId(before.devices.activeRxId);
    setFronthaul(before.devices.fronthaulMbpsByTxId);
    setTrajectories(before.mobility.trajectoriesByRxId);
    setWaypointFrames(before.mobility.waypointFrameByRxId ?? {});
    setMobilitySpeedKmh(before.mobility.speedKmh);
    setMobilityIntervalMs(before.mobility.intervalMs);
    setFreqGhz(before.solver.carrierFrequencyGhz);
    setMaxDepth(before.solver.maxDepth);
    setSolverOptions(before.solver.options);
    setCsiSettings(before.csi);
    setCoverageMetric(before.coverage.metric);
    setCoverageHeight(before.coverage.heightM);
    setCoverageRes(before.coverage.gridStepM);
    setCoverageSamplesPerTx(before.coverage.samplesPerTx);
    setCoverageRegion(before.coverage.region ?? null);
    setCoverageFloorId(before.coverage.floorId ?? null);
    setCoverageThreshold(before.coverage.thresholdDb ?? null);
    setSelectedPreset(null);
  };

  const loadScenePackage = async (file?: File) => {
    const request = ++gisRequest.current;
    setGisLoading(false);
    setDownloadProgress(['', '']);
    setPackageLoading(true);
    setPackageError('');
    try {
      let source: Blob;
      if (file) {
        source = file;
      } else {
        const response = await fetch(URBAN_DEMO);
        if (!response.ok) throw new Error('The bundled urban scene could not be read.');
        source = await response.blob();
      }
      const imported = await importScenePackage(source);
      if (request !== gisRequest.current) return false;
      if (sceneEditRevision.current !== buildings) {
        setPackageError('The scene changed during import. Open the package again.');
        return false;
      }
      const before = latestProjectState.current;
      const objects = imported.objects.map(object => withFootprint(object, object.enuPoints, imported.anchor));
      closeBuildingDialog();
      saveImportedProject();
      editor.commit(objects, imported.anchor, () => {
        setSceneName(before.scene.name);
        setSceneVisual(before.scene.visual);
        setSceneFloor(sceneFloor);
        editor.setHiddenLayers(before.scene.hiddenLayers ?? []);
        setMaterialConfigs(before.solver.materialConfigs);
        if (!file) restoreExperimentInputs(before);
        else setCoverageFloorId(before.coverage.floorId ?? null);
      });
      setSceneName(imported.name);
      setSceneVisual(imported.visual);
      setSceneFloor(undefined);
      setCoverageFloorId(null);
      setMaterialConfigs(Object.fromEntries(imported.materials.map(material => [material.id, material])));
      editor.setHiddenLayers([]);
      editor.select(null);
      editor.chooseTool('select');
      editor.setSolverMesh(false);
      editor.setTop(false);
      setSceneDock('objects');
      setFocusObject(undefined);
      if (!file) {
        const { aps, ue, route } = urbanDeployment(imported.anchor);
        setTxs(aps);
        setRxs([ue]);
        setActiveTxId(aps[0].id);
        setActiveRxId(ue.id);
        setFronthaul({});
        setTrajectories({ [ue.id]: route });
        setWaypointFrames({});
        setMobilitySpeedKmh(5);
        setMobilityIntervalMs(500);
        setFreqGhz(28);
        setMaxDepth(3);
        setSolverOptions({ ...DEFAULT_SOLVER_OPTIONS, refraction: true, pathSamplesPerSource: 100_000 });
        setCsiSettings(DEFAULT_CSI_SETTINGS);
        setCoverageHeight(1.5);
        setCoverageRes(8);
        setCoverageSamplesPerTx(100_000);
        setCoverageRegion(null);
        setCoverageThreshold(null);
      }
      return true;
    } catch (error) {
      if (request === gisRequest.current) setPackageError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (request === gisRequest.current) setPackageLoading(false);
    }
  };

  const [csiResult, setCsiResult] = useState<{ run: CsiRun; key: string; projectId?: string } | null>(null);
  const history = useCsiHistory(projectId, backendOnline && !temporary);
  const [historySelection, setHistorySelection] = useState<{ runId: string; selection: CsiSelection }>();
  const [csiOutput, setCsiOutput] = useState<CsiRunOutput>('cir_cfr');
  const csiTask = useSimulationTask<CsiRunRequest, CsiRun>(startCsiJob);
  const [submittedCsiMode, setSubmittedCsiMode] = useState<CsiRunMode>('static');
  const csiRunning = csiTask.busy ? submittedCsiMode : null;
  const [csiIssue, setCsiIssue] = useState<LocalizedText | null>(null);
  const [csiReceiverId, setCsiReceiverId] = useState<string | null>(null);
  const [expiredRunId, setExpiredRunId] = useState<string | null>(null);
  const [liveCsiSelection, setLiveCsiSelection] = useState<CsiSelection | null>(null);
  const [loadedCsiLink, setLoadedCsiLink] = useState<{
    runId: string; selection: CsiSelection; link: CsiLinkPreview;
  } | null>(null);
  const [csiLinkLoading, setCsiLinkLoading] = useState(false);
  const [csiLinkError, setCsiLinkError] = useState('');

  const csiGrid = React.useMemo(() => ({
    numSubcarriers: csiSettings.numSubcarriers,
    subcarrierSpacing: csiSettings.subcarrierSpacingKhz * 1000,
    normalizeDelays: csiSettings.normalizeDelays,
  }), [csiSettings]);
  const csiCommon = React.useMemo(() => ({
    txs, buildings, anchor, freqGhz, maxDepth, options: solverOptions, materials: materialList,
    systemBandwidthMhz: coverageBandwidthMhz, noiseFigureDb: coverageNoiseFigureDb, ...csiGrid,
  }), [txs, buildings, anchor, freqGhz, maxDepth, solverOptions, materialList, coverageBandwidthMhz, coverageNoiseFigureDb, csiGrid]);
  const sharedCsiKey = React.useMemo(() => JSON.stringify([
    anchor, geometryKey, txs, freqGhz, maxDepth, solverOptions, materialList,
    coverageBandwidthMhz, coverageNoiseFigureDb, csiGrid,
  ]), [anchor, geometryKey, txs, freqGhz, maxDepth, solverOptions, materialList,
    coverageBandwidthMhz, coverageNoiseFigureDb, csiGrid]);
  const keyForCsi = (mode: CsiRunMode, rxId: string) => mode === 'static'
    ? sharedCsiKey + JSON.stringify(rxs)
    : sharedCsiKey + JSON.stringify([
        rxs.find(device => device.id === rxId),
        Object.hasOwn(trajectoriesByRxId, rxId) ? trajectoriesByRxId[rxId] : EMPTY_TRACK,
        waypointFrameByRxId[rxId], mobilitySpeedKmh, mobilityIntervalMs, mobilityCombineMode, handoverConfig,
      ]);
  const currentCsiKey = useRef(keyForCsi);
  currentCsiKey.current = keyForCsi;
  const historicalRun = history.selected?.run;
  const csiRun = historicalRun ?? csiResult?.run ?? null;
  const csiProjectId = historicalRun ? projectId : csiResult?.projectId;
  const csiSelection = React.useMemo(() => {
    if (!historicalRun) return liveCsiSelection;
    if (historySelection?.runId === historicalRun.runId) return historySelection.selection;
    return { txId: historicalRun.txIds[0], rxId: historicalRun.rxIds[0], sampleIndex: 0 };
  }, [historicalRun, historySelection, liveCsiSelection]);
  const selectCsiSample = React.useCallback((selection: CsiSelection) => {
    if (historicalRun) setHistorySelection({ runId: historicalRun.runId, selection });
    else setLiveCsiSelection(selection);
  }, [historicalRun]);
  const csiStale = !historicalRun && !!csiResult && csiResult.key !== keyForCsi(csiResult.run.mode, csiResult.run.rxIds[0]);
  const csiExpired = !!csiRun && csiRun.runId === expiredRunId;
  const currentRunId = csiStale || csiExpired ? null : csiRun?.runId;

  const csiLink = loadedCsiLink && loadedCsiLink.runId === currentRunId && loadedCsiLink.selection === csiSelection
    ? loadedCsiLink.link : null;
  useEffect(() => {
    setLoadedCsiLink(null);
    setCsiLinkError('');
    setCsiLinkLoading(false);
    if (!currentRunId || !csiSelection) return;
    let current = true;
    setCsiLinkLoading(true);
    inspectCsiLink(currentRunId, csiSelection, csiProjectId).then(
      link => { if (current) setLoadedCsiLink({ runId: currentRunId, selection: csiSelection, link }); },
      error => {
        if (!current) return;
        if (error instanceof ApiRequestError && error.status === 404) setExpiredRunId(currentRunId);
        else setCsiLinkError(error instanceof Error ? error.message : String(error));
      },
    ).finally(() => { if (current) setCsiLinkLoading(false); });
    return () => { current = false; };
  }, [currentRunId, csiSelection, csiProjectId]);

  const sameArrays = (devices: (Receiver | Transmitter)[]) =>
    devices.every(device => device.antennaArraySize.every((value, i) => value === devices[0].antennaArraySize[i]));
  const txArraysMatch = sameArrays(txs);
  const rxArraysMatch = sameArrays(rxs);
  const unavailableReason = !backendOnline ? t('Solver is offline.', '求解器离线。') : undefined;
  const txArrayReason = txArraysMatch ? undefined : t(
    'This CSI tensor needs matching AP array sizes. Generate per-link CIR for mixed arrays in Link diagnostics.',
    '统一 CSI 张量要求各 AP 阵列等尺寸。混合阵列可在链路诊断生成逐链路 CIR。',
  );
  const trajectoryReceiver = rxs.find(device => device.id === csiReceiverId) ?? rx;
  const simulationRoute = Object.hasOwn(trajectoriesByRxId, trajectoryReceiver.id) ? trajectoriesByRxId[trajectoryReceiver.id] : EMPTY_TRACK;
  const routeFrame = Object.hasOwn(waypointFrameByRxId, trajectoryReceiver.id) ? waypointFrameByRxId[trajectoryReceiver.id] : undefined;
  const route = React.useMemo(() => {
    const absolute = routeFrame === 'ENU_m' || trajectoryReceiver.heightReference === 'enu';
    return sampleTrajectory(simulationRoute, mobilityIntervalMs, mobilitySpeedKmh, absolute,
      absolute ? undefined : point => getWaypointPosition(point, trajectoryReceiver, buildings, solverRoofs));
  }, [simulationRoute, mobilityIntervalMs, mobilitySpeedKmh, routeFrame, trajectoryReceiver, buildings, solverRoofs]);
  const trajectoryTimes = !historicalRun && !csiStale && !csiExpired
    && csiRun?.mode === 'trajectory' && csiRun.rxIds[0] === trajectoryReceiver.id
    ? csiRun.timeSeconds : route.timeSeconds;
  const txPorts = antennaPortCount(tx.antennaArraySize, solverOptions.txPolarization);
  const rxPorts = antennaPortCount(rx.antennaArraySize, solverOptions.rxPolarization);
  const staticEstimate = txArraysMatch && rxArraysMatch
    ? estimateCsiSize([1, rxs.length, rxPorts, txs.length, txPorts, csiGrid.numSubcarriers])
    : null;
  const trajectoryEstimate = txArraysMatch && route.timeSeconds.length > 1
    ? estimateCsiSize([route.timeSeconds.length, 1, antennaPortCount(trajectoryReceiver.antennaArraySize, solverOptions.rxPolarization),
        txs.length, txPorts, csiGrid.numSubcarriers])
    : null;
  const tooLargeReason = (bytes: number | undefined) => csiOutput === 'cir_cfr' && (bytes ?? 0) > FULL_CSI_SIZE_LIMIT
    ? t('The CFR alone exceeds the limit. Try CIR only with these settings.', '仅 CFR 就超过上限。可保留当前设置，试用「仅 CIR」。')
    : undefined;
  const staticDisabledReason = unavailableReason ?? txArrayReason ?? (!rxArraysMatch
    ? t(
        'This CSI tensor needs matching UE array sizes. Generate per-link CIR for mixed arrays in Link diagnostics.',
        '统一 CSI 张量要求各 UE 阵列等尺寸。混合阵列可在链路诊断生成逐链路 CIR。',
      )
    : tooLargeReason(staticEstimate?.cfrBytes));
  const trajectoryDisabledReason = unavailableReason ?? txArrayReason ?? (route.waypoints.length < 2
    ? t('Draw a route with at least two distinct points for this UE.', '请为这个 UE 绘制至少包含两个不同控制点的轨迹。')
    : tooLargeReason(trajectoryEstimate?.cfrBytes));

  const handleCsiRun = (mode: CsiRunMode) => {
    if (csiTask.busy || (mode === 'static' ? staticDisabledReason : trajectoryDisabledReason)) return;
    const receiver = mode === 'trajectory' ? trajectoryReceiver : rx;
    const key = keyForCsi(mode, receiver.id);
    const runProjectId = temporary ? undefined : projectId;
    history.close();
    setSubmittedCsiMode(mode);
    setCsiIssue(null);
    const input: CsiRunRequest = {
      ...csiCommon, projectId: runProjectId, fronthaulMbpsByTxId: currentFronthaul,
      mode, output: csiOutput, rxs: mode === 'static' ? rxs : [receiver],
      ...(mode === 'trajectory' ? {
        waypoints: route.waypoints, waypointFrame: routeFrame, deriveTimeFromSpeed: true,
        speedKmh: mobilitySpeedKmh, combineMode: mobilityCombineMode, handover: handoverConfig,
      } : {}),
    };
    void csiTask.run(input, run => {
      if (runProjectId) history.refresh();
      if (key !== currentCsiKey.current(mode, receiver.id)) {
        setCsiIssue(runProjectId
          ? ['Inputs changed during tracing. The completed run is in CSI run history.', '追踪期间输入已改变，已完成的结果可在 CSI 运行历史中查看。']
          : ['Inputs changed during tracing. Run CSI again with the current settings.', '追踪期间输入已改变，请使用当前配置重新计算 CSI。']);
        return;
      }
      setCsiResult({ run, key, projectId: runProjectId });
      setExpiredRunId(null);
      setLiveCsiSelection({ txId: run.txIds.includes(tx.id) ? tx.id : run.txIds[0], rxId: run.rxIds.includes(receiver.id) ? receiver.id : run.rxIds[0], sampleIndex: 0 });
    });
  };

  const coverageInput = React.useMemo<CoverageJobRequest>(() => ({
    txs, buildings, freqGhz, gridSize: coverageRes, gridHeight: coverageHeight, maxDepth,
    options: solverOptions, materials: materialList, metric: coverageMetric,
    bandwidthHz: coverageBandwidthMhz * 1e6, noiseFigureDb: coverageNoiseFigureDb,
    samplesPerTx: coverageSamplesPerTx, seed: radioMapSeed,
    region: coverageRegion, floorId: coverageFloorId, coverageThresholdDb: coverageThreshold,
  }), [
    txs, buildings, freqGhz, maxDepth, solverOptions, materialList, coverageMetric, coverageBandwidthMhz,
    coverageNoiseFigureDb, coverageHeight, coverageRes, coverageSamplesPerTx, radioMapSeed,
    coverageRegion, coverageFloorId, coverageThreshold,
  ]);
  const currentCoverageInput = useRef(coverageInput);
  currentCoverageInput.current = coverageInput;
  const coverageTask = useSimulationTask<CoverageJobRequest, RadioMapGrid>(startCoverageJob);
  const [coverageResult, setCoverageResult] = useState<{ input: CoverageJobRequest; snapshot: CoverageSceneSnapshot } | null>(null);
  const [coveragePlan, setCoveragePlan] = useState<{ input: CoverageJobRequest; data: CoveragePreflight | null; error?: string }>();
  const preflightForInput = coveragePlan?.input === coverageInput ? coveragePlan : undefined;
  const preflight = preflightForInput?.data ?? null;
  const validCoverageRegion = !coverageRegion || (coverageRegion.minX < coverageRegion.maxX && coverageRegion.minY < coverageRegion.maxY);
  const coverageSnapshot = coverageResult?.snapshot ?? null;
  const coverageStale = !!coverageResult && coverageResult.input !== coverageInput;
  const radioMap = coverageStale ? null : coverageSnapshot?.grid ?? null;

  useEffect(() => {
    if (!backendOnline || workspace !== 'preview' || simulationTask !== 'coverage' || !validCoverageRegion) return;
    let active = true;
    const timer = window.setTimeout(() => {
      readCoveragePreflight(coverageInput).then(
        data => { if (active) setCoveragePlan({ input: coverageInput, data }); },
        error => { if (active) setCoveragePlan({ input: coverageInput, data: null, error: error instanceof Error ? error.message : String(error) }); },
      );
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [backendOnline, workspace, simulationTask, coverageInput, validCoverageRegion]);

  const handleRunHeatmap = () => {
    if (coverageTask.busy || !backendOnline || !preflight || preflight.issues.length) return;
    setCoverageIssue(null);
    const { buildings: _objects, ...settings } = coverageInput;
    const provenance = { ...settings, sceneName, anchor };
    const scene = { buildings, txs, rxs, visual: sceneVisual, name: sceneName, roofs: solverRoofs };
    void coverageTask.run(coverageInput, grid => {
      if (currentCoverageInput.current !== coverageInput) {
        setCoverageIssue(['Inputs changed during calculation. Showing the completed coverage snapshot.',
          '计算期间输入已变化，当前显示已完成的覆盖快照。']);
      }
      setCoverageResult({ input: coverageInput, snapshot: { grid, anchor, scene, provenance: { ...provenance, sceneId: grid.sceneId } } });
      setCoverageView('current');
    });
  };

  const comparison = React.useMemo(() => {
    if (!coverageBaseline || !coverageSnapshot || coverageBaseline === coverageSnapshot) return null;
    const a = coverageBaseline.anchor;
    const b = coverageSnapshot.anchor;
    if (a && b && (a.latitude !== b.latitude || a.longitude !== b.longitude ||
        a.elevation !== b.elevation || a.verticalDatum !== b.verticalDatum)) return null;
    const threshold = coverageThreshold ?? coverageSnapshot.grid.stats?.thresholdDb ??
      (coverageSnapshot.grid.metric === 'sinr' ? 0 : -90);
    return compareCoverage(coverageBaseline.grid, coverageSnapshot.grid, threshold);
  }, [coverageBaseline, coverageSnapshot, coverageThreshold]);
  const shownCoverageSnapshot = (coverageView === 'baseline' ? coverageBaseline : null) ?? coverageSnapshot;
  const shownCoverageMap = shownCoverageSnapshot?.grid ?? null;
  const floorForCoverage = shownCoverageMap?.floorId
    ? shownCoverageSnapshot?.scene.buildings.find(object => object.id === shownCoverageMap.floorId)?.floor : undefined;
  const coverageRange = comparison?.range;
  const coverageAutoRange = coverageRange ? false : shownCoverageMap?.metric === 'sinr' || rmAutoRange;
  const coverageVmin = coverageRange?.min ?? rmVmin;
  const coverageVmax = coverageRange?.max ?? rmVmax;

  const rememberSimulationScroll = () => {
    if (workspace === 'preview' && simulationSidebar.current) {
      simulationScrollPositions.current[simulationTask] = simulationSidebar.current.scrollTop;
    }
  };

  const openWorkspace = (next: StudioWorkspace) => {
    if (next === workspace) return;
    rememberSimulationScroll();
    if (workspace === 'scene') editor.chooseTool('select');
    setPlacementMode('none');
    setDownloadTask(null);
    setWorkspace(next);
  };

  const openSimulation = (task: SimulationTask, openDownloads = false) => {
    if (task !== simulationTask) rememberSimulationScroll();
    openWorkspace('preview');
    setSimulationTask(task);
    if (task === 'diagnostics') setVisitedDiagnostics(true);
    setDownloadTask(openDownloads && task !== 'csi' ? task : null);
  };

  const loadExperimentPreset = async (id: ExperimentPreset) => {
    history.close();
    setSelectedPreset(null);
    if (id === 'trajectory') {
      if (!await loadScenePackage()) return;
      setCsiSettings({ ...DEFAULT_CSI_SETTINGS, numSubcarriers: 64, normalizeDelays: false });
      setPresetMode({ mode: 'trajectory' });
    } else {
      const before = latestProjectState.current;
      useStarterScene(() => {
        restoreExperimentInputs(before);
        setMaterialConfigs(before.solver.materialConfigs);
        editor.setHiddenLayers(before.scene.hiddenLayers ?? []);
      });
      const setup = starterExperiment(id);
      setMaterialConfigs({});
      editor.setHiddenLayers([]);
      setTxs([setup.tx]);
      setRxs([setup.rx]);
      setActiveTxId(setup.tx.id);
      setActiveRxId(setup.rx.id);
      setFronthaul({});
      setTrajectories({});
      setWaypointFrames({});
      setFreqGhz(setup.frequencyGhz);
      setMaxDepth(setup.maxDepth);
      setSolverOptions(setup.options);
      setCsiSettings(setup.csi);
      setCoverageMetric('power');
      setCoverageRegion(setup.coverageRegion);
      setCoverageThreshold(setup.coverageThresholdDb);
      setCoverageHeight(1.5);
      setCoverageRes(setup.coverageGridM);
      setCoverageSamplesPerTx(100_000);
      setPresetMode({ mode: 'static' });
    }
    setCsiOutput('cir_cfr');
    setCsiReceiverId(null);
    setSelectedPreset(id);
    openSimulation(id === 'coverage' ? 'coverage' : 'csi');
  };

  const openDeploymentRoute = () => {
    openWorkspace('planning');
    selectDevice('rx', trajectoryReceiver.id);
  };

  const previewing = workspace === 'preview';
  const deploying = workspace === 'planning';
  const editingScene = workspace === 'scene';
  const showingCsi = previewing && simulationTask === 'csi';
  const showingCoverage = previewing && simulationTask === 'coverage';
  const showingDiagnostics = previewing && simulationTask === 'diagnostics';
  const csiPaths = currentRunId ? csiLink?.paths ?? EMPTY_PATHS : EMPTY_PATHS;
  const hasDiagnosticRays = matrixPaths.length > 0 || paths.length > 0;
  const hasSavedRays = hasDiagnosticRays || csiPaths.length > 0;
  const liveCoverageView = showingCoverage && coverageView === 'current' && !!radioMap;
  const overlayCsi = !historicalRun && liveCoverageView && showRaysOnHeatmap && !hasDiagnosticRays && csiPaths.length > 0;
  const showingCsiSelection = (showingCsi || overlayCsi) && currentRunId ? csiSelection : null;
  const selectedTrajectorySample = !!showingCsiSelection && csiRun?.mode === 'trajectory';
  const trajectoryView = showingCsi && selectedTrajectorySample;
  const previewPositions = selectedTrajectorySample ? csiRun?.rxPositions : undefined;
  const previewIndex = showingCsiSelection?.sampleIndex ?? 0;
  const previewPosition = previewPositions?.[previewIndex]?.[0];
  const nextPosition = previewPositions?.[previewIndex + 1]?.[0];
  const headingStart = nextPosition ? previewPosition : previewPositions?.[previewIndex - 1]?.[0];
  const headingEnd = nextPosition ?? previewPosition;
  const headingEast = headingStart && headingEnd ? headingEnd[0] - headingStart[0] : 0;
  const headingNorth = headingStart && headingEnd ? headingEnd[1] - headingStart[1] : 0;
  const previewHeading = headingEast || headingNorth ? Math.atan2(headingEast, -headingNorth) : 0;
  const historicalSnapshot = showingCsi ? history.selected : undefined;
  const coverageViewport = showingCoverage ? shownCoverageSnapshot : null;
  const archivedBuildings = React.useMemo(() => historicalSnapshot?.snapshot.buildings
    .map(object => ({ ...object, points: object.points ?? [] })), [historicalSnapshot]);
  const viewedAnchor = historicalSnapshot ? historicalSnapshot.snapshot.anchor ?? STARTER_ANCHOR : coverageViewport?.anchor ?? anchor;
  const positionedRun = showingCsiSelection ? csiRun : null;
  const inputTxs = historicalSnapshot?.snapshot.txs ?? coverageViewport?.scene.txs ?? txs;
  const inputRxs = historicalSnapshot?.snapshot.rxs ?? coverageViewport?.scene.rxs ?? rxs;
  const viewedTxs = React.useMemo(() => positionedRun
    ? inputTxs.map(device => deviceAtRunPosition(device, positionedRun.txPositions[positionedRun.txIds.indexOf(device.id)]))
    : inputTxs, [inputTxs, positionedRun]);
  const viewedRxs = React.useMemo(() => positionedRun
    ? inputRxs.map(device => deviceAtRunPosition(device, positionedRun.rxPositions[0]?.[positionedRun.rxIds.indexOf(device.id)]))
    : inputRxs, [inputRxs, positionedRun]);
  const sampledTrack = React.useMemo(() => positionedRun?.mode === 'trajectory'
    ? positionedRun.rxPositions.map(([[x, y, z]]) => {
      const enu = { x, y, z };
      return { enu, ...enuToLatLon(enu, viewedAnchor) };
    }) : EMPTY_TRACK, [positionedRun, viewedAnchor]);
  const viewedTx = viewedTxs.find(device => device.id === (showingCsiSelection?.txId ?? tx.id)) ?? viewedTxs[0];
  const viewedRx = viewedRxs.find(device => device.id === (showingCsiSelection?.rxId ?? rx.id)) ?? viewedRxs[0];
  const shownPaths = showingCsiSelection ? csiPaths
    : showingDiagnostics || liveCoverageView ? paths : EMPTY_PATHS;
  const currentFronthaul = Object.fromEntries(txs.map(({ id }) =>
    [id, Object.hasOwn(fronthaulMbpsByTxId, id) ? fronthaulMbpsByTxId[id] : null]));
  const downloadProps = { tx, rx, txs, rxs, buildings, paths, radioMap, freqGhz, maxDepth, solverOptions,
    materials: materialList, csiGrid, backendOnline };
  const activeDock = editingScene ? sceneDock : deviceDock;
  const setDock = editingScene ? setSceneDock : setDeviceDock;
  const compactControls = (
    <div className="studio-compact-only gap-1" role="group" aria-label={t('Side panels', '侧栏')}>
      <button type="button" className="studio-tool" aria-pressed={activeDock === 'objects'}
        onClick={() => setDock(activeDock === 'objects' ? 'closed' : 'objects')}>
        <List aria-hidden="true" className="h-4 w-4" />
        {editingScene ? t('Objects', '对象') : t('Devices', '设备')}
      </button>
      <button type="button" className="studio-tool" aria-pressed={activeDock === 'inspector'}
        onClick={() => setDock(activeDock === 'inspector' ? 'closed' : 'inspector')}>
        <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
        {editingScene && editor.solverMesh ? t('Report', '检查报告') : t('Properties', '属性')}
      </button>
    </div>
  );

  useLayoutEffect(() => {
    if (previewing && simulationSidebar.current) {
      simulationSidebar.current.scrollTop = simulationScrollPositions.current[simulationTask] ?? 0;
    }
  }, [previewing, simulationTask]);

  const renderTaskStatus = (task: {
    job: SimulationJob<unknown> | null;
    cancel: () => void;
    retry: () => void;
    canRetry: boolean;
    reconnecting: boolean;
    error: string;
  }) => (
    <>
      <SimulationJobStatus job={task.job} onCancel={task.cancel} onRetry={task.canRetry ? task.retry : undefined} />
      {task.reconnecting && <p role="status" className="text-xs text-slate-600">
        {t('Reconnecting to the same task…', '正在重新连接同一个任务…')}
      </p>}
      {task.error && <div role="alert" className="space-y-1 text-xs text-red-700">
        <p>{task.error}</p>
        {task.canRetry && <button type="button" onClick={task.retry} className="underline">
          {t('Retry with the same inputs', '使用相同输入重试')}
        </button>}
      </div>}
    </>
  );

  return (
    <div id="sionna-rt-studio-app-frame" className="studio-frame text-[var(--text-hi)]">
      <TopNav health={health} autosaveStatus={autosaveStatus} onRetryAutosave={retryAutosave}
        projectState={projectState} projectId={projectId} onImportProject={handleImportProject} onResetProject={handleResetProject}
        onReplaceUnreadableAutosave={unreadableAutosave ? handleReplaceUnreadableAutosave : undefined}
        recoveryError={recoveryError ? t(...recoveryError) : undefined} />
      <main className="studio-main" data-workspace={workspace} data-dock={activeDock}>
        {editingScene && <>
          <div className="studio-toolbar">
            <SceneToolbar editor={editor} onOpenBlank={openBlankScene} onUseStarter={useStarterScene}
              onUseUrbanDemo={() => void loadScenePackage()} onOpenExperiments={() => {
                setPresetsOpen(true);
                openSimulation('csi');
              }} onImportPackage={file => void loadScenePackage(file)}
              packageBusy={packageLoading} packageError={packageError} sceneName={sceneName} sceneObjects={buildings}
              floors={sceneFloors} sceneFloor={sceneFloors.includes(sceneFloor ?? '') ? sceneFloor : undefined}
              onSelectFloor={setSceneFloor}
              compactControls={compactControls} onToggleInspection={toggleSceneInspection}
              osmImport={<MapSelector anchor={mapAnchor} setAnchor={setMapAnchor} onDownloadOSM={handleDownloadOSM}
                mode={osmMode} onModeChange={setOsmMode} isLoading={gisLoading} downloadProgress={downloadProgress} />}
              meshImport={<MeshImportPanel online={backendOnline} onImport={(objects, replace) => {
                if (!replace && objects.length === 0) return;
                gisRequest.current++;
                setGisLoading(false);
                setPackageLoading(false);
                setPackageError('');
                const imported = objects.map(object => withFootprint(object, object.enuPoints, anchor));
                saveImportedProject();
                if (replace) replaceSceneGeometry(imported);
                else editor.commit([...buildings, ...imported]);
                selectSceneObject(imported[0]?.id ?? null);
              }} />} />
          </div>
          <aside className="studio-objects" aria-label={t('Scene objects', '场景对象')}>
            <SceneObjectList editor={editor} objects={buildings} inspection={currentInspection} onSelect={selectSceneObject} />
          </aside>
          <aside className="studio-inspector" aria-label={t('Scene properties', '场景属性')}>
            <SceneInspector editor={editor} objects={buildings} anchor={anchor} inspection={currentInspection}
              inspectionError={!backendOnline
                ? t('The solver is offline. Scene editing is available.', '求解器离线，仍可继续编辑场景。')
                : inspectionIssue}
              onLocate={locateSceneObject} onEditGeneratedBuilding={editGeneratedBuilding}
              onRemoveGeneratedBuilding={removeGeneratedBuilding} materialIds={materialIds}
              materialLibrary={<GeographyPanel materialIds={materialIds} materialConfigs={materialList} onMaterialChange={updateMaterial} />} />
          </aside>
        </>}

        {deploying && <>
          <div className="studio-toolbar flex items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5">
            <h1 className="flex items-center gap-2 text-sm font-semibold">
              <RadioTower aria-hidden="true" className="h-4 w-4 text-[var(--accent-deep)]" />
              {t('Device deployment', '设备部署')}
            </h1>
            {compactControls}
          </div>
          <aside className="studio-objects" aria-label={t('Devices', '设备')}>
            <DevicePanel txs={txs} rxs={rxs} activeTxId={activeTxId} activeRxId={activeRxId}
              selectedKind={deploymentSelection}
              onSelectTx={id => selectDevice('tx', id)} onSelectRx={id => selectDevice('rx', id)}
              onRemoveTx={removeTx} onRemoveRx={removeRx} />
          </aside>
          <aside className="studio-inspector space-y-2" aria-label={t('Selected device properties', '所选设备属性')}>
            <DeviceRfControls tx={tx} rx={rx} onTxUpdate={handleTxUpdate} onRxUpdate={handleRxUpdate} kind={deploymentSelection} buildings={buildings} solverRoofs={solverRoofs} />
            {deploymentSelection === 'tx'
              ? <div key={tx.id}>
                  <FronthaulControl value={currentFronthaul[tx.id]} onChange={value =>
                    setFronthaul(prev => ({ ...prev, [tx.id]: value }))} />
                </div>
              : <RouteControls tx={tx} rx={rx} anchor={anchor} trajectoryPoints={trajectoryPoints}
                  waypointFrame={Object.hasOwn(waypointFrameByRxId, rx.id) ? waypointFrameByRxId[rx.id] : undefined} onTrajectoryChange={setTrajectoryPoints} />}
          </aside>
        </>}

        {previewing && (
          <div className="studio-toolbar flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5">
            <div className="flex flex-wrap gap-1" role="group" aria-label={t('Simulation task', '仿真任务')}>
              {SIMULATION_TASKS.map(({ id, en, zh, icon: Icon }) => (
                <button key={id} id={`btn-preview-${id}`} type="button" className="studio-tool"
                  aria-pressed={simulationTask === id} onClick={() => openSimulation(id)}>
                  <Icon aria-hidden="true" className="h-4 w-4" /> {t(en, zh)}
                </button>
              ))}
            </div>
            {showingCsi && historicalRun ? (
              <p id="csi-history-radio-settings" className="ml-auto readout text-xs text-slate-600">
                {t('Saved settings', '归档设置')} · {historicalRun.carrierFrequencyGhz} GHz
                {historicalRun.systemBandwidthMhz != null && ` · ${historicalRun.systemBandwidthMhz} MHz`}
              </p>
            ) : (
              <details className="relative ml-auto">
                <summary id="simulation-settings-trigger" className="studio-tool list-none [&::-webkit-details-marker]:hidden">
                  <Settings2 aria-hidden="true" className="h-4 w-4" />
                  {t('Shared settings', '共享设置')}
                  <span className="readout ml-1 text-xs font-normal text-slate-600">{freqGhz} GHz · {coverageBandwidthMhz} MHz</span>
                </summary>
                <div className="absolute right-0 z-20 mt-1 max-h-[65dvh] w-[min(380px,calc(100vw-28px))] overflow-y-auto rounded-xl bg-white shadow-lg">
                  <SolverControls freqGhz={freqGhz} setFreqGhz={setFreqGhz} maxDepth={maxDepth} setMaxDepth={setMaxDepth}
                    solverOptions={solverOptions} setSolverOptions={setSolverOptions}
                    bandwidthMhz={coverageBandwidthMhz} onBandwidthChange={setCoverageBandwidthMhz}
                    noiseFigureDb={coverageNoiseFigureDb} onNoiseFigureChange={setCoverageNoiseFigureDb} />
                </div>
              </details>
            )}
          </div>
        )}

        <section className="studio-viewport" hidden={workspace === 'export'} aria-label={t('3D viewport', '三维视口')}>
          <ThreeStudio
            sceneEditor={editingScene ? editor : undefined}
            onSelectSceneObject={selectSceneObject} focusObject={editingScene ? focusObject : undefined}
            physicalMeshes={editingScene && editor.solverMesh ? currentInspection?.meshes : undefined}
            solverCheck={editingScene && editor.solverMesh}
            solverObjects={editingScene && editor.solverMesh ? currentInspection?.objects : undefined}
            sceneName={historicalSnapshot ? t('Saved CSI scene', 'CSI 运行快照') : coverageViewport ? coverageViewport.scene.name : sceneName}
            sceneVisual={historicalSnapshot ? undefined : coverageViewport ? coverageViewport.scene.visual : sceneVisual}
            sceneFloor={showingCoverage && floorForCoverage ? floorForCoverage
              : !historicalSnapshot && sceneFloors.includes(sceneFloor ?? '') ? sceneFloor : undefined}
            solverRoofs={historicalSnapshot ? undefined : coverageViewport ? coverageViewport.scene.roofs : solverRoofs}
            buildings={archivedBuildings ?? coverageViewport?.scene.buildings ?? buildings} anchor={viewedAnchor}
            tx={viewedTx} rx={viewedRx} txs={viewedTxs} rxs={viewedRxs}
            paths={shownPaths} matrixPaths={showingDiagnostics || liveCoverageView ? matrixPaths : undefined}
            showRaysOnHeatmap={showRaysOnHeatmap && liveCoverageView} radioMap={showingCoverage ? shownCoverageMap : null}
            rmColormap={rmColormap} rmAutoRange={coverageAutoRange} rmVmin={coverageVmin} rmVmax={coverageVmax}
            onPlaceDevice={placeDevice} onSelectDevice={selectDevice} deploymentSelection={deploymentSelection}
            editing={deploying} visible={workspace !== 'export'}
            showDevices={!editingScene || showSceneDevices} onToggleSceneDevices={() => setShowSceneDevices(visible => !visible)}
            activeMode={trajectoryView ? 'playback' : showingCoverage ? 'heatmap' : 'link'}
            placementMode={deploying ? placementMode : 'none'} setPlacementMode={startPlacement}
            showOutlines={showOutlines} setShowOutlines={setShowOutlines}
            mobilityRxPosition={previewPosition ? { x: previewPosition[0], y: previewPosition[1], z: previewPosition[2] } : null}
            mobilityRxHeading={previewHeading}
            trajectoryPoints={trajectoryView ? sampledTrack : deploying ? trajectoryPoints : EMPTY_TRACK}
            waypointFrame={trajectoryView ? 'ENU_m'
              : Object.hasOwn(waypointFrameByRxId, viewedRx.id) ? waypointFrameByRxId[viewedRx.id] : undefined}
            setTrajectoryPoints={setTrajectoryPoints}
          />
          {showingCoverage && shownCoverageMap && (
            <div className="pointer-events-none absolute bottom-2 right-2 z-10">
              <CoverageLegend radioMap={shownCoverageMap} colormap={rmColormap} autoRange={coverageAutoRange} vmin={coverageVmin} vmax={coverageVmax} />
            </div>
          )}
        </section>

        <aside ref={simulationSidebar} className="studio-results" hidden={!previewing}
          aria-label={t('Simulation controls and results', '仿真设置与结果')}>
          {simulationTask !== 'diagnostics' && <ExperimentPresets open={presetsOpen} setOpen={setPresetsOpen}
            selected={selectedPreset} busy={packageLoading} disabled={!backendOnline} error={packageError}
            onLoad={id => void loadExperimentPreset(id)} />}
          <div hidden={simulationTask !== 'csi'}>
            {!temporary && <CsiHistoryPicker history={history} id="select-csi-history" online={backendOnline} />}
            <CsiPreviewPanel
              run={csiRun} stale={csiStale} expired={csiExpired} running={csiRunning} active={showingCsi} historical={!!historicalRun}
              error={csiIssue ? t(...csiIssue) : ''}
              presetMode={presetMode} jobStatus={renderTaskStatus(csiTask)}
              sampling={trajectorySampling(trajectoryTimes, mobilityIntervalMs)}
              staticDisabledReason={staticDisabledReason} trajectoryDisabledReason={trajectoryDisabledReason}
              mixedArrays={{ static: !txArraysMatch || !rxArraysMatch, trajectory: !txArraysMatch }}
              staticEstimate={staticEstimate} trajectoryEstimate={trajectoryEstimate}
              trajectoryReceiver={<label className="flex items-center justify-between gap-2 text-sm">
                {t('Moving UE', '移动 UE')}
                <select id="select-csi-trajectory-rx" value={trajectoryReceiver.id}
                  onChange={event => setCsiReceiverId(event.target.value)}
                  className="rounded border border-[var(--line)] bg-white px-2 py-1">
                  {rxs.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
                </select>
              </label>}
              gridControls={<details className="rounded border border-[var(--line)] bg-[var(--ink-750)] p-2 text-sm">
                <summary id="csi-grid-settings-trigger" className="cursor-pointer font-semibold">{t('Frequency grid and delay', '频率网格与时延')}</summary>
                <CsiGridControls settings={csiSettings} onChange={setCsiSettings} bandwidthMhz={coverageBandwidthMhz} />
              </details>}
              trajectoryControls={<TrajectorySimulationControls speedKmh={mobilitySpeedKmh} intervalMs={mobilityIntervalMs}
                combineMode={mobilityCombineMode} handover={handoverConfig} onSpeedChange={setMobilitySpeedKmh}
                onIntervalChange={setMobilityIntervalMs} onCombineChange={setMobilityCombineMode} onHandoverChange={setHandoverConfig} />}
              output={csiOutput} onOutputChange={output => {
                setCsiOutput(output);
                setCsiIssue(null);
              }}
              onRun={handleCsiRun} selection={csiSelection} onSelect={selectCsiSample}
              link={csiLink} linkLoading={csiLinkLoading} linkError={csiLinkError}
              onOpenTrajectory={route.waypoints.length < 2 ? openDeploymentRoute : undefined}
              onOpenDiagnostics={() => openSimulation('diagnostics', true)}
              onOpenExport={() => openWorkspace('export')}
            />
          </div>
          <div hidden={simulationTask !== 'coverage'} className="space-y-2">
            <CoveragePanel
              txCount={txs.length} backendOnline={backendOnline}
              onRunHeatmap={handleRunHeatmap} heatmapLoading={coverageTask.busy} radioMap={shownCoverageMap} stale={coverageStale}
              buildings={buildings} coverageRegion={coverageRegion} setCoverageRegion={setCoverageRegion}
              coverageFloorId={coverageFloorId} setCoverageFloorId={setCoverageFloorId}
              coverageThreshold={coverageThreshold} setCoverageThreshold={setCoverageThreshold}
              preflight={preflight} preflightLoading={backendOnline && validCoverageRegion && !preflightForInput} preflightError={preflightForInput?.error}
              coverageSnapshot={coverageSnapshot} coverageBaseline={coverageBaseline} setCoverageBaseline={next => {
                setCoverageBaseline(next === coverageSnapshot ? coverageSnapshot : null);
                setCoverageView('current');
              }}
              coverageComparison={comparison} coverageView={coverageView} setCoverageView={setCoverageView}
              jobStatus={renderTaskStatus(coverageTask)}
              coverageMetric={coverageMetric} setCoverageMetric={metric => {
                setCoverageMetric(metric);
                setCoverageThreshold(null);
              }}
              coverageBandwidthMhz={coverageBandwidthMhz} coverageNoiseFigureDb={coverageNoiseFigureDb}
              coverageHeight={coverageHeight} setCoverageHeight={setCoverageHeight}
              coverageRes={coverageRes} setCoverageRes={setCoverageRes}
              samplesPerTx={coverageSamplesPerTx} setSamplesPerTx={setCoverageSamplesPerTx}
              radioMapSeed={radioMapSeed} setRadioMapSeed={setRadioMapSeed}
              showRaysOnHeatmap={showRaysOnHeatmap} setShowRaysOnHeatmap={setShowRaysOnHeatmap} hasSavedRays={liveCoverageView && hasSavedRays}
              rmColormap={rmColormap} setRmColormap={setRmColormap}
              rmAutoRange={rmAutoRange} setRmAutoRange={setRmAutoRange}
              rmVmin={rmVmin} setRmVmin={setRmVmin} rmVmax={rmVmax} setRmVmax={setRmVmax}
              solveError={coverageIssue ? t(...coverageIssue) : ''}
            />
            <SimulationDownloads {...downloadProps} kind="coverage" expanded={downloadTask === 'coverage'} />
          </div>
          {visitedDiagnostics && (
            <div hidden={simulationTask !== 'diagnostics'} className="space-y-2">
              <LinkPanel txs={txs} rxs={rxs} activeTxId={activeTxId} activeRxId={activeRxId}
                matrix={matrix} matrixLoading={matrixLoading} matrixProgress={matrixProgress}
                onSolveMatrix={handleSolveMatrix} onSelectPair={handleSelectPair}
                paths={paths} metrics={metrics} hasResult={metrics !== EMPTY_METRICS} onSolve={handleSolve} solving={solving}
                solveError={solveError} backendOnline={backendOnline} />
              <SimulationDownloads {...downloadProps} kind="diagnostics" expanded={downloadTask === 'diagnostics'} />
              <details className="panel p-3">
                <summary className="cursor-pointer text-sm font-semibold">{t('Advanced link analysis', '高级链路分析')}</summary>
                <div className="pt-2">
                  <AnalysisPanel tx={tx} rx={rx} paths={paths} metrics={metrics}
                    freqGhz={freqGhz} radioMap={radioMap} buildings={buildings} maxDepth={maxDepth}
                    solverOptions={solverOptions} materials={materialList} backendOnline={backendOnline} />
                </div>
              </details>
            </div>
          )}
        </aside>

        <section className="studio-export" hidden={workspace !== 'export'}>
          <ExportPanel {...downloadProps} anchor={anchor}
            historyPicker={!temporary && <CsiHistoryPicker history={history} id="select-export-csi-history" online={backendOnline} />}
            csiProjectId={csiProjectId} historical={!!historicalRun}
            csiRun={csiRun} csiStale={csiStale} csiExpired={csiExpired} onCsiExpired={setExpiredRunId}
            fronthaulMbpsByTxId={currentFronthaul} onOpenPreview={() => openSimulation('csi')}
            onOpenDiagnostics={() => openSimulation('diagnostics', true)} onOpenCoverage={() => openSimulation('coverage', true)} />
        </section>
      </main>
      <WorkflowNav activeWorkspace={workspace} onSelect={openWorkspace} />
      {buildingDialog && <BuildingGeneratorDialog
        initial={buildingDialog.spec} editing={buildingDialog.editing} busy={buildingBusy} error={buildingError}
        onApply={spec => void applyBuilding(spec)} onCancel={closeBuildingDialog} />}
    </div>
  );
}
