import { HandoverConfig } from './api';
import { ColormapName } from './lib/colormaps';
import {
  BuildingFootprint,
  CoverageMetric,
  GeoAnchor,
  MaterialConfig,
  MobilityCombineMode,
  Receiver,
  SolverOptions,
  TrajectoryPoint,
  Transmitter,
} from './types';

export const PROJECT_SCHEMA_VERSION = 2;
// Keep the existing storage key so an upgrade can read and migrate the autosave.
export const PROJECT_STORAGE_KEY = 'sionna-rt-studio.project.v1';

export type StudioWorkspace = 'scene' | 'planning' | 'preview' | 'export';
export type StudioMode = 'link' | 'heatmap' | 'playback';
export interface StudioCsiSettings {
  numSubcarriers: number;
  subcarrierSpacingKhz: number;
  normalizeDelays: boolean;
}

export const DEFAULT_CSI_SETTINGS: StudioCsiSettings = {
  numSubcarriers: 1024,
  subcarrierSpacingKhz: 30,
  normalizeDelays: true,
};

export interface StudioProjectState {
  scene: {
    anchor: GeoAnchor;
    buildings: BuildingFootprint[];
  };
  devices: {
    transmitters: Transmitter[];
    receivers: Receiver[];
    activeTxId: string;
    activeRxId: string;
    fronthaulMbpsByTxId: Record<string, number | null>;
  };
  solver: {
    carrierFrequencyGhz: number;
    maxDepth: number;
    options: SolverOptions;
    materialConfigs: Record<string, MaterialConfig>;
  };
  csi: StudioCsiSettings;
  coverage: {
    metric: CoverageMetric;
    bandwidthMhz: number;
    noiseFigureDb: number;
    heightM: number;
    gridStepM: number;
    samplesPerTx: number;
    seed: number;
  };
  mobility: {
    trajectoriesByRxId: Record<string, TrajectoryPoint[]>;
    combineMode: MobilityCombineMode;
    handover: HandoverConfig;
    speedKmh: number;
    intervalMs: number;
  };
  display: {
    workspace: StudioWorkspace;
    activeMode: StudioMode;
    showOutlines: boolean;
    showRaysOnHeatmap: boolean;
    radioMapColormap: ColormapName;
    radioMapAutoRange: boolean;
    radioMapVmin: number;
    radioMapVmax: number;
  };
}

export interface StudioProjectDocument {
  format: 'SionnaRTStudio Project';
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  savedAtUtc: string;
  state: StudioProjectState;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isVector = (value: unknown): boolean =>
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);

const isAnchor = (value: unknown): value is GeoAnchor =>
  isRecord(value) && isFiniteNumber(value.latitude) && isFiniteNumber(value.longitude);

const isArraySize = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((entry) => Number.isInteger(entry) && (entry as number) > 0);

const isTransmitter = (value: unknown): value is Transmitter =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  isFiniteNumber(value.latitude) &&
  isFiniteNumber(value.longitude) &&
  isFiniteNumber(value.height) &&
  isVector(value.enu) &&
  isFiniteNumber(value.powerDbm) &&
  isArraySize(value.antennaArraySize) &&
  isFiniteNumber(value.beamsteeringAzimuth) &&
  isFiniteNumber(value.beamsteeringElevation);

const isReceiver = (value: unknown): value is Receiver =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  isFiniteNumber(value.latitude) &&
  isFiniteNumber(value.longitude) &&
  isFiniteNumber(value.height) &&
  isVector(value.enu) &&
  isArraySize(value.antennaArraySize);

const isBuilding = (value: unknown): value is BuildingFootprint =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (value.name === undefined || typeof value.name === 'string') &&
  Array.isArray(value.points) &&
  value.points.every((point) =>
    isRecord(point) && isFiniteNumber(point.lat) && isFiniteNumber(point.lon),
  ) &&
  Array.isArray(value.enuPoints) &&
  value.enuPoints.every(isVector) &&
  isFiniteNumber(value.height) &&
  ['building', 'infrastructure', 'terrain', 'water'].includes(String(value.category)) &&
  typeof value.type === 'string' &&
  typeof value.material === 'string';

const isTrajectoryPoint = (value: unknown): value is TrajectoryPoint =>
  isRecord(value) &&
  isFiniteNumber(value.lat) &&
  isFiniteNumber(value.lon) &&
  isVector(value.enu);

const isSolverOptions = (value: unknown): value is SolverOptions => {
  if (!isRecord(value)) return false;
  const booleanKeys = [
    'los',
    'specularReflection',
    'diffuseReflection',
    'refraction',
    'diffraction',
    'edgeDiffraction',
  ];
  return booleanKeys.every((key) => typeof value[key] === 'boolean') &&
    ['iso', 'dipole', 'hw_dipole', 'tr38901'].includes(String(value.txPattern)) &&
    ['iso', 'dipole', 'hw_dipole', 'tr38901'].includes(String(value.rxPattern)) &&
    ['V', 'H', 'VH', 'cross'].includes(String(value.txPolarization)) &&
    ['V', 'H', 'VH', 'cross'].includes(String(value.rxPolarization)) &&
    isFiniteNumber(value.pathSamplesPerSource) &&
    isFiniteNumber(value.pathSeed);
};

const isMaterialConfig = (value: unknown): value is MaterialConfig =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  isFiniteNumber(value.scatteringCoefficient) &&
  isFiniteNumber(value.xpdCoefficient) &&
  ['none', 'lambertian', 'directive', 'backscattering'].includes(String(value.scatteringPattern)) &&
  (value.relativePermittivity == null || isFiniteNumber(value.relativePermittivity)) &&
  (value.conductivity == null || isFiniteNumber(value.conductivity)) &&
  (value.thickness == null || isFiniteNumber(value.thickness));

const isProjectState = (value: unknown): value is StudioProjectState => {
  if (!isRecord(value)) return false;
  const { scene, devices, solver, csi, coverage, mobility, display } = value;
  if (
    !isRecord(scene) ||
    !isRecord(devices) ||
    !isRecord(solver) ||
    !isRecord(csi) ||
    !isRecord(coverage) ||
    !isRecord(mobility) ||
    !isRecord(display)
  ) return false;

  const transmitters = devices.transmitters;
  const receivers = devices.receivers;
  const materialConfigs = solver.materialConfigs;

  return isAnchor(scene.anchor) &&
    Array.isArray(scene.buildings) &&
    scene.buildings.every(isBuilding) &&
    Array.isArray(transmitters) &&
    transmitters.length > 0 &&
    transmitters.every(isTransmitter) &&
    Array.isArray(receivers) &&
    receivers.length > 0 &&
    receivers.every(isReceiver) &&
    typeof devices.activeTxId === 'string' &&
    transmitters.some((tx) => tx.id === devices.activeTxId) &&
    typeof devices.activeRxId === 'string' &&
    receivers.some((rx) => rx.id === devices.activeRxId) &&
    isRecord(devices.fronthaulMbpsByTxId) &&
    Object.entries(devices.fronthaulMbpsByTxId).every(([id, capacity]) =>
      transmitters.some(tx => tx.id === id) && (capacity === null || (isFiniteNumber(capacity) && capacity >= 0)),
    ) &&
    isFiniteNumber(solver.carrierFrequencyGhz) &&
    isFiniteNumber(solver.maxDepth) &&
    isSolverOptions(solver.options) &&
    isRecord(materialConfigs) &&
    Object.values(materialConfigs).every(isMaterialConfig) &&
    isFiniteNumber(csi.numSubcarriers) && Number.isInteger(csi.numSubcarriers) && csi.numSubcarriers > 0 &&
    isFiniteNumber(csi.subcarrierSpacingKhz) && csi.subcarrierSpacingKhz > 0 &&
    typeof csi.normalizeDelays === 'boolean' &&
    ['power', 'sinr'].includes(String(coverage.metric)) &&
    isFiniteNumber(coverage.bandwidthMhz) &&
    isFiniteNumber(coverage.noiseFigureDb) &&
    isFiniteNumber(coverage.heightM) &&
    isFiniteNumber(coverage.gridStepM) &&
    isFiniteNumber(coverage.samplesPerTx) &&
    isFiniteNumber(coverage.seed) &&
    isRecord(mobility.trajectoriesByRxId) &&
    Object.entries(mobility.trajectoriesByRxId).every(([id, points]) =>
      receivers.some(rx => rx.id === id) && Array.isArray(points) && points.every(isTrajectoryPoint),
    ) &&
    ['best_server', 'sum'].includes(String(mobility.combineMode)) &&
    isRecord(mobility.handover) &&
    isFiniteNumber(mobility.handover.hysteresisDb) &&
    isFiniteNumber(mobility.handover.timeToTriggerMs) &&
    isFiniteNumber(mobility.speedKmh) &&
    isFiniteNumber(mobility.intervalMs) &&
    ['scene', 'planning', 'preview', 'export'].includes(String(display.workspace)) &&
    ['link', 'heatmap', 'playback'].includes(String(display.activeMode)) &&
    typeof display.showOutlines === 'boolean' &&
    typeof display.showRaysOnHeatmap === 'boolean' &&
    ['viridis', 'plasma', 'inferno', 'turbo'].includes(String(display.radioMapColormap)) &&
    typeof display.radioMapAutoRange === 'boolean' &&
    isFiniteNumber(display.radioMapVmin) &&
    isFiniteNumber(display.radioMapVmax);
};

function migrateV1(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.devices) || !isRecord(value.mobility) || !isRecord(value.display)) {
    return value;
  }
  const { trajectoryPoints, ...mobility } = value.mobility;
  const { activeNavTab, ...display } = value.display;
  const workspaces = new Map<string, StudioWorkspace>([
    ['3d_scene', 'planning'], ['geography', 'scene'], ['analysis', 'preview'], ['export', 'export'],
  ]);
  return {
    ...value,
    devices: { ...value.devices, fronthaulMbpsByTxId: {} },
    csi: { ...DEFAULT_CSI_SETTINGS },
    mobility: { ...mobility, trajectoriesByRxId: { [String(value.devices.activeRxId)]: trajectoryPoints } },
    display: { ...display, workspace: workspaces.get(String(activeNavTab)) },
  };
}

export function createProjectDocument(state: StudioProjectState): StudioProjectDocument {
  return {
    format: 'SionnaRTStudio Project',
    schemaVersion: PROJECT_SCHEMA_VERSION,
    savedAtUtc: new Date().toISOString(),
    state,
  };
}

export function parseProjectDocument(value: string | unknown): StudioProjectDocument {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.format !== 'SionnaRTStudio Project') {
    throw new Error('This is not a SionnaRTStudio project file.');
  }
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schema version: ${String(parsed.schemaVersion)}.`);
  }
  const state = parsed.schemaVersion === 1 ? migrateV1(parsed.state) : parsed.state;
  if (typeof parsed.savedAtUtc !== 'string' || !isProjectState(state)) {
    throw new Error('The project file is incomplete or contains invalid settings.');
  }
  return { format: 'SionnaRTStudio Project', schemaVersion: PROJECT_SCHEMA_VERSION, savedAtUtc: parsed.savedAtUtc, state };
}

export function loadAutosavedProject(): StudioProjectDocument | null {
  try {
    const saved = window.localStorage.getItem(PROJECT_STORAGE_KEY);
    return saved ? parseProjectDocument(saved) : null;
  } catch (error) {
    console.warn('Could not restore the autosaved SionnaRTStudio project.', error);
    return null;
  }
}

export function saveAutosavedProject(state: StudioProjectState): void {
  window.localStorage.setItem(
    PROJECT_STORAGE_KEY,
    JSON.stringify(createProjectDocument(state)),
  );
}

export function clearAutosavedProject(): void {
  window.localStorage.removeItem(PROJECT_STORAGE_KEY);
}
