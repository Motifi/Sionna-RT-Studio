import { HandoverConfig } from './api';
import { ColormapName } from './lib/colormaps';
import {
  BuildingFootprint,
  BuildingSpec,
  CoverageMetric,
  CoverageRegion,
  GeoAnchor,
  MaterialConfig,
  MobilityCombineMode,
  Receiver,
  SceneVisual,
  SolverOptions,
  TrajectoryPoint,
  Transmitter,
  WaypointFrame,
} from './types';

export const PROJECT_SCHEMA_VERSION = 5;
// Keep the existing key to migrate old localStorage autosaves.
export const PROJECT_STORAGE_KEY = 'sionna-rt-studio.project.v1';
const PROJECT_BACKUP_KEY = `${PROJECT_STORAGE_KEY}.pre-v5`;
const PROJECT_DATABASE = 'sionna-rt-studio';
const PROJECT_STORE = 'projects';

export type StudioWorkspace = 'scene' | 'planning' | 'preview' | 'export';
export type StudioMode = 'link' | 'heatmap' | 'playback';
export type ProjectAutosaveStatus = 'saving' | 'saved' | 'error' | 'disabled';
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
    coordinateFrame: 'ENU_m';
    anchor: GeoAnchor;
    buildings: BuildingFootprint[];
    hiddenLayers?: BuildingFootprint['category'][];
    name?: string;
    visual?: SceneVisual;
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
    region?: CoverageRegion | null;
    floorId?: string | null;
    thresholdDb?: number | null;
    bandwidthMhz: number;
    noiseFigureDb: number;
    heightM: number;
    gridStepM: number;
    samplesPerTx: number;
    seed: number;
  };
  mobility: {
    trajectoriesByRxId: Record<string, TrajectoryPoint[]>;
    waypointFrameByRxId?: Record<string, WaypointFrame>;
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
  projectId: string;
  savedAtUtc: string;
  state: StudioProjectState;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isVector = (value: unknown): value is { x: number; y: number; z: number } =>
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);

const isAnchor = (value: unknown): value is GeoAnchor =>
  isRecord(value) && isFiniteNumber(value.latitude) && isFiniteNumber(value.longitude) &&
  (value.elevation === undefined || isFiniteNumber(value.elevation)) &&
  (value.verticalDatum === undefined || typeof value.verticalDatum === 'string');

const isSceneVisual = (value: unknown): value is SceneVisual =>
  isRecord(value) && typeof value.glb === 'string' && value.glb.length >= 16 &&
  value.glb.length <= 24 * 1024 * 1024 && value.glb.startsWith('Z2xURg') &&
  Array.isArray(value.bindings) && value.bindings.length <= 4096 &&
  value.bindings.every(binding => isRecord(binding) && typeof binding.id === 'string' && isVector(binding.origin)) &&
  new Set(value.bindings.map(binding => binding.id)).size === value.bindings.length;

const isFoliage = (value: unknown): boolean =>
  isRecord(value) && isVector(value.center) && isVector(value.radii) &&
  Math.min(value.radii.x, value.radii.y, value.radii.z) > 0 &&
  isFiniteNumber(value.attenuationDbPerM) && value.attenuationDbPerM >= 0;

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
  (value.heightReference === undefined || value.heightReference === 'roof' || value.heightReference === 'ground' || value.heightReference === 'enu') &&
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
  (value.heightReference === undefined || value.heightReference === 'roof' || value.heightReference === 'ground' || value.heightReference === 'enu') &&
  isVector(value.enu) &&
  isArraySize(value.antennaArraySize);

const isBuildingSpec = (value: unknown): value is BuildingSpec =>
  isRecord(value) && typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.id) &&
  typeof value.name === 'string' && value.name.trim().length > 0 && Array.from(value.name.trim()).length <= 120 &&
  [value.east, value.north, value.baseZ].every(coordinate => isFiniteNumber(coordinate) && Math.abs(coordinate) <= 100_000) &&
  isFiniteNumber(value.length) && value.length >= 8 && value.length <= 150 &&
  isFiniteNumber(value.width) && value.width >= 8 && value.width <= 150 &&
  isFiniteNumber(value.height) && value.height >= 3 && value.height <= 120 &&
  (value.rotationDeg === undefined || isFiniteNumber(value.rotationDeg)) &&
  (value.floors === undefined || (isFiniteNumber(value.floors) && Number.isInteger(value.floors) && value.floors >= 1 && value.floors <= 30 &&
    value.height / value.floors >= 2.7 - 1e-9 && value.height / value.floors <= 6 + 1e-9)) &&
  (value.layout === 'office' || value.layout === 'apartments');

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
  typeof value.material === 'string' &&
  (value.kind === undefined || ['building', 'wall', 'mesh'].includes(String(value.kind))) &&
  (value.rfRole === undefined || ['surface', 'ground', 'foliage', 'visual'].includes(String(value.rfRole))) &&
  (value.rfRole !== 'ground' || value.kind === 'mesh') &&
  (value.rfRole === 'foliage' ? isFoliage(value.foliage) : value.foliage === undefined) &&
  (value.floor === undefined || typeof value.floor === 'string') &&
  (value.geometrySource === undefined || typeof value.geometrySource === 'string') &&
  (value.buildingSpec === undefined || (isBuildingSpec(value.buildingSpec) && value.id.startsWith(`${value.buildingSpec.id}--`))) &&
  (value.baseZ === undefined || isFiniteNumber(value.baseZ)) &&
  (value.source === undefined || ['template', 'osm', 'manual', 'import'].includes(String(value.source))) &&
  (value.heightSource === undefined || ['tag', 'levels', 'estimated', 'manual'].includes(String(value.heightSource))) &&
  (value.materialSource === undefined || ['tag', 'estimated', 'manual'].includes(String(value.materialSource))) &&
  (value.rawTags === undefined || (isRecord(value.rawTags) && Object.values(value.rawTags).every(tag => typeof tag === 'string'))) &&
  (value.importIssues === undefined || (Array.isArray(value.importIssues) && value.importIssues.every(issue => typeof issue === 'string'))) &&
  (value.kind === 'mesh'
    ? isRecord(value.mesh) && Array.isArray(value.mesh.vertices) && Array.isArray(value.mesh.triangles) &&
      value.mesh.vertices.length >= 9 && value.mesh.vertices.length % 3 === 0 &&
      value.mesh.vertices.every(isFiniteNumber) && value.mesh.triangles.length >= 3 && value.mesh.triangles.length % 3 === 0 &&
      value.mesh.triangles.every(index => Number.isInteger(index) && index >= 0 && index < (value.mesh as { vertices: number[] }).vertices.length / 3)
    : value.mesh === undefined);

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

const isCoverageRegion = (value: unknown): value is CoverageRegion =>
  isRecord(value) && isFiniteNumber(value.minX) && isFiniteNumber(value.maxX) &&
  isFiniteNumber(value.minY) && isFiniteNumber(value.maxY);

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

  return scene.coordinateFrame === 'ENU_m' && isAnchor(scene.anchor) &&
    (scene.name === undefined || typeof scene.name === 'string') &&
    (scene.visual === undefined || isSceneVisual(scene.visual)) &&
    Array.isArray(scene.buildings) &&
    scene.buildings.every(isBuilding) &&
    new Set(scene.buildings.map(object => object.id)).size === scene.buildings.length &&
    (scene.hiddenLayers === undefined || (Array.isArray(scene.hiddenLayers) &&
      scene.hiddenLayers.every(layer => ['building', 'infrastructure', 'terrain', 'water'].includes(layer)))) &&
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
    (coverage.region == null || isCoverageRegion(coverage.region)) &&
    (coverage.floorId == null || (typeof coverage.floorId === 'string' && coverage.floorId.length > 0)) &&
    (coverage.thresholdDb == null || isFiniteNumber(coverage.thresholdDb)) &&
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
    (mobility.waypointFrameByRxId === undefined || (isRecord(mobility.waypointFrameByRxId) &&
      Object.entries(mobility.waypointFrameByRxId).every(([id, frame]) =>
        receivers.some(rx => rx.id === id) && frame === 'ENU_m',
      ))) &&
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

export function newProjectId(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  // getRandomValues is also available when the web app is served over LAN HTTP.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createProjectDocument(state: StudioProjectState, projectId = newProjectId()): StudioProjectDocument {
  return {
    format: 'SionnaRTStudio Project',
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
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
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3 &&
      parsed.schemaVersion !== 4 && parsed.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`Unsupported project schema version: ${String(parsed.schemaVersion)}.`);
  }
  let state = parsed.schemaVersion === 1 ? migrateV1(parsed.state) : parsed.state;
  if (parsed.schemaVersion < 3 && isRecord(state) && isRecord(state.scene)) {
    state = { ...state, scene: { ...state.scene, coordinateFrame: 'ENU_m' } };
  }
  if (typeof parsed.savedAtUtc !== 'string' || !isProjectState(state)) {
    throw new Error('The project file is incomplete or contains invalid settings.');
  }
  const projectId = parsed.schemaVersion === PROJECT_SCHEMA_VERSION ? parsed.projectId : newProjectId();
  if (typeof projectId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)) {
    throw new Error('The project ID is invalid.');
  }
  return { format: 'SionnaRTStudio Project', schemaVersion: PROJECT_SCHEMA_VERSION, projectId, savedAtUtc: parsed.savedAtUtc, state };
}

export class UnreadableAutosaveError extends Error {
  constructor(cause: unknown) {
    super('The local autosave could not be read.', { cause });
    this.name = 'UnreadableAutosaveError';
  }
}

export class FutureAutosaveError extends Error {
  constructor() {
    super('This autosave was created by a newer version of Studio.');
    this.name = 'FutureAutosaveError';
  }
}

function parseStoredProject(value: unknown) {
  try {
    const original: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (isRecord(original) && original.format === 'SionnaRTStudio Project' &&
        typeof original.schemaVersion === 'number' && Number.isInteger(original.schemaVersion) &&
        original.schemaVersion > PROJECT_SCHEMA_VERSION) {
      throw new FutureAutosaveError();
    }
    return {
      project: parseProjectDocument(original),
      oldSchema: isRecord(original) && original.schemaVersion !== PROJECT_SCHEMA_VERSION,
    };
  } catch (error) {
    if (error instanceof FutureAutosaveError) throw error;
    throw new UnreadableAutosaveError(error);
  }
}

function isUnreadableAutosave(value: unknown) {
  if (value === null) return false;
  try {
    parseStoredProject(value);
    return false;
  } catch (error) {
    if (error instanceof UnreadableAutosaveError) return true;
    if (error instanceof FutureAutosaveError) return false;
    throw error;
  }
}

// All operations in this page enter the database in the order they were
// requested. In particular a reset must complete after any in-flight save.
let pendingStorageOperation: Promise<unknown> = Promise.resolve();

function queueStorageOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = pendingStorageOperation.then(operation);
  pendingStorageOperation = next.catch(() => undefined);
  return next;
}

function openProjectDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(PROJECT_DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(PROJECT_STORE);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('The project database is blocked by another window.'));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
}

async function projectTransaction<T>(
  run: (store: IDBObjectStore, setResult: (value: T) => void, reject: (error: unknown) => void) => void,
): Promise<T> {
  const database = await openProjectDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(PROJECT_STORE, 'readwrite', { durability: 'strict' });
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error('The project transaction was interrupted.'));
      run(transaction.objectStore(PROJECT_STORE), value => { result = value; }, reject);
    });
  } finally {
    database.close();
  }
}

export function loadAutosavedProject(): Promise<StudioProjectDocument | null> {
  return queueStorageOperation(async () => {
    let migrated: { raw: string; oldSchema: boolean } | undefined;
    const saved = await projectTransaction<StudioProjectDocument | null>((store, setResult, reject) => {
      const request = store.get(PROJECT_STORAGE_KEY);
      request.onsuccess = () => {
        try {
          // Read and migrate under the same IndexedDB transaction so other
          // windows see the persisted ID on their first open.
          const fromLegacy = request.result === undefined;
          const raw = fromLegacy ? window.localStorage.getItem(PROJECT_STORAGE_KEY) : null;
          const original = fromLegacy ? raw : request.result;
          if (original === null) {
            setResult(null);
            return;
          }
          const { project, oldSchema } = parseStoredProject(original);
          if (oldSchema) store.put(original, PROJECT_BACKUP_KEY);
          if (oldSchema || fromLegacy) store.put(project, PROJECT_STORAGE_KEY);
          if (raw !== null) migrated = { raw, oldSchema };
          setResult(project);
        } catch (error) {
          reject(error);
        }
      };
    });
    if (migrated) {
      removeLegacyAutosave(migrated.raw);
      try {
        const backupKey = `${PROJECT_STORAGE_KEY}.pre-v3`;
        if (migrated.oldSchema && !window.localStorage.getItem(backupKey)) {
          window.localStorage.setItem(backupKey, migrated.raw);
        }
      } catch (error) {
        console.warn('Could not update the legacy project backup.', error);
      }
    }
    return saved;
  });
}

export function saveAutosavedProject(state: StudioProjectState, projectId?: string): Promise<void> {
  return queueStorageOperation(() => projectTransaction<void>(store => {
    store.put(createProjectDocument(state, projectId), PROJECT_STORAGE_KEY);
  }));
}

function removeLegacyAutosave(expected?: string) {
  try {
    if (expected === undefined || window.localStorage.getItem(PROJECT_STORAGE_KEY) === expected) {
      window.localStorage.removeItem(PROJECT_STORAGE_KEY);
    }
  } catch (error) {
    console.warn('Could not remove the legacy autosave.', error);
  }
}

export function replaceUnreadableAutosave(state: StudioProjectState, projectId?: string): Promise<boolean> {
  return queueStorageOperation(async () => {
    const replacement = parseProjectDocument(createProjectDocument(state, projectId));
    let replacedLegacy: string | null = null;
    const replaced = await projectTransaction<boolean>((store, setResult, reject) => {
      const request = store.get(PROJECT_STORAGE_KEY);
      request.onsuccess = () => {
        try {
          const fromLegacy = request.result === undefined;
          const raw = fromLegacy ? window.localStorage.getItem(PROJECT_STORAGE_KEY) : null;
          const current = fromLegacy ? raw : request.result;
          // A healthy autosave may have been restored or written by another
          // window since startup. Recheck within the replacement transaction.
          const unreadable = isUnreadableAutosave(current);
          if (unreadable) {
            store.put(replacement, PROJECT_STORAGE_KEY);
            replacedLegacy = raw;
          }
          setResult(unreadable);
        } catch (error) {
          reject(error);
        }
      };
    });
    if (replaced && replacedLegacy !== null) removeLegacyAutosave(replacedLegacy);
    return replaced;
  });
}

export function clearAutosavedProject(): Promise<void> {
  return queueStorageOperation(async () => {
    // Record the reset before removing the old fallback. An interrupted
    // transaction leaves the previous project available in either store.
    await projectTransaction<void>(store => {
      store.put(null, PROJECT_STORAGE_KEY);
    });
    removeLegacyAutosave();
  });
}
