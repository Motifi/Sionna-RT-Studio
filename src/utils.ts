/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Coordinate math, OSM (Overpass) fetching/parsing, and file exporters.
 * All RF solving happens on the Sionna RT backend (see api.ts).
 */

import { GeoAnchor, ENUVector, BuildingFootprint, SolverRoof, Transmitter, PropagationPath, RadioMapGrid, ChannelGridConfig, WaypointFrame } from './types';
import { hasTerrainMesh, radioRole, terrainHeight } from './lib/sceneGeometry';

// Coordinate Math Constants
const M_LAT = 110574;

export function latLonToENU(lat: number, lon: number, anchor: GeoAnchor): ENUVector {
  const latRefRad = (anchor.latitude * Math.PI) / 180;
  const mLon = Math.cos(latRefRad) * 111320;
  const x = (lon - anchor.longitude) * mLon;
  const y = (lat - anchor.latitude) * M_LAT;
  return { x, y, z: 0 };
}

export function enuToLatLon(enu: ENUVector, anchor: GeoAnchor): { lat: number; lon: number } {
  const latRefRad = (anchor.latitude * Math.PI) / 180;
  const mLon = Math.cos(latRefRad) * 111320;
  const lon = anchor.longitude + enu.x / mLon;
  const lat = anchor.latitude + enu.y / M_LAT;
  return { lat, lon };
}

type HorizontalPoint = Pick<ENUVector, 'x' | 'y'>;

const coordinateBits = new DataView(new ArrayBuffer(8));
const implicitMantissaBit = 1n << 52n;

function exactCoordinate(value: number): bigint {
  // Express the IEEE-754 double in units of 2^-1074, including subnormals.
  coordinateBits.setFloat64(0, value);
  const bits = coordinateBits.getBigUint64(0);
  const exponent = (bits >> 52n) & 0x7ffn;
  const fraction = bits & (implicitMantissaBit - 1n);
  const magnitude = exponent === 0n ? fraction : (implicitMantissaBit | fraction) << (exponent - 1n);
  return bits >> 63n ? -magnitude : magnitude;
}

function orientationSign(a: HorizontalPoint, b: HorizontalPoint, p: HorizontalPoint): number {
  const left = (b.x - a.x) * (p.y - a.y);
  const right = (b.y - a.y) * (p.x - a.x);
  const determinant = left - right;
  const errorBound = Math.max(4 * Number.EPSILON * (Math.abs(left) + Math.abs(right)), 4 * Number.MIN_VALUE);
  if (Number.isFinite(determinant) && Math.abs(determinant) > errorBound) return Math.sign(determinant);

  // Repaired edges can sit within the floating-point error of the query point.
  // Use the exact sign to distinguish true boundaries from nearby points.
  const ax = exactCoordinate(a.x), ay = exactCoordinate(a.y);
  const exact = (exactCoordinate(b.x) - ax) * (exactCoordinate(p.y) - ay) -
    (exactCoordinate(b.y) - ay) * (exactCoordinate(p.x) - ax);
  if (exact === 0n) return 0;
  return exact > 0n ? 1 : -1;
}

// Match the solver's strict containment rule: roof mounting excludes the boundary.
export function isPointInPolygon(
  pt: HorizontalPoint,
  poly: HorizontalPoint[],
  includeBoundary = false,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (pt.y < Math.min(a.y, b.y) || pt.y > Math.max(a.y, b.y)) continue;
    if (a.y === b.y) {
      if (pt.x >= Math.min(a.x, b.x) && pt.x <= Math.max(a.x, b.x)) return includeBoundary;
      continue;
    }
    const side = orientationSign(a, b, pt);
    if (side === 0) return includeBoundary;
    if ((a.y > pt.y) !== (b.y > pt.y) && (side > 0) === (b.y > a.y)) inside = !inside;
  }
  return inside;
}

function footprintArea(vertices: ENUVector[]): number {
  const origin = vertices[0];
  let twiceArea = 0;
  for (let i = 1; i < vertices.length - 1; i++) {
    const a = vertices[i], b = vertices[i + 1];
    twiceArea += (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }
  return Math.abs(twiceArea) / 2;
}

export function getDeviceElevation(
  device: Pick<Transmitter, 'enu' | 'height' | 'heightReference'>,
  buildings: BuildingFootprint[],
  solverRoofs?: SolverRoof[],
): number | undefined {
  if (device.heightReference === 'enu') return device.height;
  const ground = terrainHeight(device.enu, buildings);
  if (device.heightReference === 'ground') {
    if (ground === undefined && hasTerrainMesh(buildings)) return undefined;
    return (ground ?? 0) + device.height;
  }
  let roof = ground ?? 0;
  if (solverRoofs) {
    for (const { topZ, rings } of solverRoofs) {
      if (topZ > roof && isPointInPolygon(device.enu, rings[0]) &&
        !rings.some((ring, index) => index > 0 && isPointInPolygon(device.enu, ring, true))) {
        roof = topZ;
      }
    }
    return roof + device.height;
  }
  // Keep local placement usable while the solver is unavailable or updating.
  for (const building of buildings) {
    if (building.category !== 'building' || radioRole(building) !== 'surface' || (building.kind ?? 'building') !== 'building' ||
      building.height <= 0 || building.enuPoints.length < 3) continue;
    const top = (building.baseZ ?? 0) + Math.max(building.height, 1);
    if (top > roof && isPointInPolygon(device.enu, building.enuPoints) && footprintArea(building.enuPoints) >= 0.5) {
      roof = top;
    }
  }
  return roof + device.height;
}

export function getWaypointPosition(
  enu: ENUVector,
  receiver: Pick<Transmitter, 'height' | 'heightReference'>,
  buildings: BuildingFootprint[],
  solverRoofs?: SolverRoof[],
  frame?: WaypointFrame,
): ENUVector | undefined {
  if (frame === 'ENU_m') return enu;
  const height = getDeviceElevation({ ...receiver, enu }, buildings, solverRoofs);
  if (height === undefined) return undefined;
  return { ...enu, z: receiver.heightReference === 'enu' ? height + enu.z : height };
}

export function createIdSuffix(): string {
  return crypto.getRandomValues(new Uint32Array(4)).join('-');
}

// Free space path loss: FSPL = 20 * log10(d) + 20 * log10(f_GHz) + 32.44
// (display-only — the Analysis panel's link-budget card and FSPL curves).
export function calculatePathLoss(distance: number, freqGhz: number): number {
  if (distance < 0.1) return 0;
  return 20 * Math.log10(distance) + 20 * Math.log10(freqGhz) + 32.44;
}

// Raw OSM `material` / `building:material` tags (e.g. brick, glass, stone) aren't
// our `itu_*` ids. Map the common ones so they survive to the Sionna scene instead
// of silently falling back to concrete on the backend. Returns null for unknown
// values so callers fall back to the type-based default.
const OSM_MATERIAL_ALIASES: Record<string, string> = {
  concrete: 'itu_concrete', cement: 'itu_concrete', stone: 'itu_concrete',
  brick: 'itu_brick', brickwork: 'itu_brick',
  glass: 'itu_glass',
  metal: 'itu_metal', steel: 'itu_metal',
  wood: 'itu_wood', timber: 'itu_wood',
};

export function normalizeOsmMaterial(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (raw.startsWith('itu_')) return raw;
  return OSM_MATERIAL_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function getBuildingAttributes(type: string, id: string): { height: number; material: string } {
  // Simple deterministic jitter based on ID hash
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const jitter = ((Math.abs(hash) % 100) / 100) * 3 - 1.5; // -1.5m to +1.5m jitter

  let baseHeight = 8.0;
  let material = 'itu_concrete';

  switch (type.toLowerCase()) {
    case 'house':
    case 'detached':
    case 'residential':
      baseHeight = 6.5;
      material = 'itu_brick';
      break;
    case 'apartments':
    case 'terrace':
      baseHeight = 15.0;
      material = 'itu_concrete';
      break;
    case 'office':
    case 'commercial':
      baseHeight = 22.0;
      material = 'itu_glass';
      break;
    case 'retail':
    case 'supermarket':
      baseHeight = 10.0;
      material = 'itu_glass';
      break;
    case 'school':
    case 'university':
    case 'hospital':
      baseHeight = 14.5;
      material = 'itu_concrete';
      break;
    case 'industrial':
    case 'warehouse':
      baseHeight = 12.0;
      material = 'itu_metal';
      break;
    default:
      baseHeight = 9.0;
      material = 'itu_concrete';
  }

  return {
    height: Math.max(3.0, baseHeight + jitter),
    material,
  };
}

// ── Bounded network requests ─────────────────────────────────────────────────

/** Thrown when a request outlives its budget, so callers can say "timed out"
 *  rather than reporting a generic abort. */
export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Run a request under a deadline and abort it if the deadline passes.
 *
 * `run` receives the signal and is expected to pass it to `fetch` *and* to do
 * its body read inside the callback. Both halves matter: a server can complete
 * the response headers and then stall mid-body, and a timeout that only covers
 * `fetch()` would hang forever on the `.json()`. Everything the callback awaits
 * is inside the budget.
 *
 * Uses AbortController rather than `AbortSignal.timeout()` — the latter needs
 * Safari 16+, and this is the one path a first-run Mac user hits.
 */
export async function withRequestTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    // Distinguish "we gave up" from "the caller/page aborted us".
    if (controller.signal.aborted && !parentSignal?.aborted) throw new RequestTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

// ── Overpass API fetch & parsing ─────────────────────────────────────────────

export interface OsmBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OverpassData {
  elements?: any[];
}

// Overpass mirrors, tried in order. Both serve the full planet — a regional
// extract (e.g. overpass.osm.ch, Switzerland only) must never go in this list:
// it answers 200 with an empty `elements` array outside its region, which reads
// as "no buildings here" rather than as a failure.
//
// A mirror that accepts the connection and then goes silent is the failure mode
// that matters, so every request below is bounded by OSM_FETCH_TIMEOUT_MS.
export const OSM_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
] as const;

/** Per-mirror ceiling. Overpass runs the query under `[out:json][timeout:25]`,
 *  so a healthy-but-busy server still fits; past this it is not coming back. */
export const OSM_FETCH_TIMEOUT_MS = 30_000;

interface OsmClassification {
  category: BuildingFootprint['category'];
  type: string;
  height: number;
  material: string;
  levels?: number;
  name?: string;
  heightSource?: BuildingFootprint['heightSource'];
  materialSource?: BuildingFootprint['materialSource'];
}

// Classify a tagged OSM element into a scene feature (or null if not rendered).
function classifyOsmTags(tags: Record<string, string>, elemId: string | number): OsmClassification | null {
  if (tags.building) {
    // Guard parseFloat/parseInt: tags like height="12'6\"" produce NaN, which
    // would serialize to null and fail backend validation.
    const tagged = Number(tags.height?.trim().replace(/\s*m$/i, ''));
    const tagHeight = Number.isFinite(tagged) && tagged > 0 ? tagged : undefined;
    const levelsRaw = Number(tags['building:levels']);
    const levels = Number.isFinite(levelsRaw) && levelsRaw > 0 ? levelsRaw : undefined;
    const attrs = getBuildingAttributes(tags.building, String(elemId));
    const taggedMaterial = normalizeOsmMaterial(tags['building:material'] || tags.material);
    return {
      category: 'building',
      type: tags.building,
      height: tagHeight ?? (levels === undefined ? attrs.height : levels * 3.5),
      heightSource: tagHeight !== undefined ? 'tag' : levels === undefined ? 'estimated' : 'levels',
      material: taggedMaterial ?? attrs.material,
      materialSource: taggedMaterial ? 'tag' : 'estimated',
      levels,
    };
  }
  if (tags.highway) {
    const name = tags.name?.trim() || tags.ref?.trim() || undefined;
    return {
      category: 'infrastructure',
      type: tags.highway,
      height: 0.1,
      material: 'itu_dry_ground',
      name,
    };
  }
  if (
    tags.leisure === 'park' ||
    tags.landuse === 'grass' ||
    tags.landuse === 'forest' ||
    tags.landuse === 'meadow' ||
    tags.natural === 'wood' ||
    tags.natural === 'scrub'
  ) {
    return {
      category: 'terrain',
      type: tags.leisure || tags.landuse || tags.natural || 'vegetation',
      height: 0.05,
      material: 'itu_dry_ground',
    };
  }
  if (tags.natural === 'water' || tags.water) {
    return { category: 'water', type: tags.natural || tags.water || 'water', height: 0.02, material: 'itu_dry_ground' };
  }
  return null;
}

// Stitch a multipolygon relation's outer ways (node-id lists) into closed rings.
// Ways arrive in arbitrary order/direction; connect them by shared endpoints.
function stitchRings(ways: number[][]): number[][] {
  const remaining = ways.map((w) => [...w]);
  const rings: number[][] = [];
  while (remaining.length > 0) {
    const ring = remaining.shift()!;
    let extended = true;
    while (ring[0] !== ring[ring.length - 1] && extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const w = remaining[i];
        const end = ring[ring.length - 1];
        if (w[0] === end) {
          ring.push(...w.slice(1));
        } else if (w[w.length - 1] === end) {
          ring.push(...[...w].reverse().slice(1));
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    // Keep only rings that actually closed (open chains are dropped).
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

/** Build the exact Overpass query used by both the browser and paper freezer. */
export function buildOsmOverpassQuery(bounds: OsmBounds, timeoutSeconds = 25): string {
  const { south, west, north, east } = bounds;
  return `[out:json][timeout:${timeoutSeconds}];
(
  way["building"](${south},${west},${north},${east});
  relation["building"](${south},${west},${north},${east});
  way["highway"](${south},${west},${north},${east});
  way["leisure"="park"](${south},${west},${north},${east});
  way["landuse"~"grass|forest|meadow|orchard"](${south},${west},${north},${east});
  way["natural"~"wood|scrub|water"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;`;
}

export async function fetchOSMBuildings(
  south: number,
  west: number,
  north: number,
  east: number,
  anchor: GeoAnchor,
  onProgress?: (message: readonly [english: string, chinese: string]) => void,
): Promise<BuildingFootprint[]> {
  const bounds = { south, west, north, east };
  const query = buildOsmOverpassQuery(bounds);

  let lastError = 'no Overpass endpoint responded';
  for (const [index, endpoint] of OSM_OVERPASS_ENDPOINTS.entries()) {
    const host = new URL(endpoint).host;
    onProgress?.([
      `Querying Overpass (mirror ${index + 1} of ${OSM_OVERPASS_ENDPOINTS.length}: ${host})...`,
      `正在查询 Overpass（镜像 ${index + 1}/${OSM_OVERPASS_ENDPOINTS.length}，${host}）…`,
    ]);
    try {
      // Timeout spans the body read too — a mirror can accept the POST and then
      // never answer, which is what used to wedge the download indefinitely.
      const data = await withRequestTimeout(OSM_FETCH_TIMEOUT_MS, async (signal) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({ data: query }),
          signal,
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return await response.json() as OverpassData;
      });
      return parseOsmElements(data, bounds, anchor);
    } catch (error) {
      lastError = `${host}: ${error instanceof Error ? error.message : String(error)}`;
      onProgress?.([
        `Mirror ${host} failed; trying the next one…`,
        `镜像 ${host} 请求失败，正在切换…`,
      ]);
    }
  }
  throw new Error(`Failed to fetch OSM data from configured Overpass mirrors (${lastError})`);
}

/**
 * Convert an Overpass response into the exact feature objects consumed by the
 * renderer and backend. This is intentionally pure so benchmark/reproduction
 * scripts import production logic instead of maintaining a drifting clone.
 */
export function parseOsmElements(
  data: OverpassData,
  bounds: OsmBounds,
  anchor: GeoAnchor,
): BuildingFootprint[] {
  const { south, west, north, east } = bounds;
  const elements: any[] = data.elements ?? [];

  // Index nodes and every way's node-id list (skeleton ways carry the geometry
  // of multipolygon relation members).
  const nodes: { [id: string]: { lat: number; lon: number } } = {};
  const wayNodeIds: { [id: string]: number[] } = {};
  for (const elem of elements) {
    if (elem.type === 'node') {
      nodes[elem.id] = { lat: elem.lat, lon: elem.lon };
    } else if (elem.type === 'way' && Array.isArray(elem.nodes)) {
      wayNodeIds[elem.id] = elem.nodes;
    }
  }

  const buildings: BuildingFootprint[] = [];

  const pushFeature = (id: string, nodeIds: number[], cls: OsmClassification, rawTags: Record<string, string>, importIssues: string[] = []) => {
    const polyPoints: { lat: number; lon: number }[] = [];
    for (const nodeId of nodeIds) {
      const n = nodes[nodeId];
      if (n) polyPoints.push(n);
    }
    // Streets need >= 2 points; closed footprints normally have >= 3.
    if (polyPoints.length < 2 && cls.category !== 'building') return;
    if (polyPoints.length !== nodeIds.length) importIssues.push('Some referenced OSM nodes are missing.');
    if (cls.category === 'building' && cls.heightSource !== 'tag' && rawTags.height) {
      importIssues.push('Unrecognized OSM height; using levels or an estimated height.');
    }
    if (cls.category === 'building' && cls.materialSource === 'estimated' && (rawTags['building:material'] || rawTags.material)) {
      importIssues.push('Unmapped OSM material; using an estimate.');
    }

    // Buildings keep their true footprint — clamping border-straddling
    // buildings to the bbox used to squash them into degenerate prisms.
    // Roads/terrain/water (visual layers) are clamped to keep the scene bounded.
    const points = cls.category === 'building'
      ? polyPoints
      : polyPoints.map((p) => ({
          lat: Math.max(south, Math.min(north, p.lat)),
          lon: Math.max(west, Math.min(east, p.lon)),
        }));

    buildings.push({
      id,
      name: cls.name,
      source: 'osm',
      heightSource: cls.heightSource,
      materialSource: cls.materialSource,
      rawTags,
      importIssues,
      points,
      enuPoints: points.map((p) => latLonToENU(p.lat, p.lon, anchor)),
      height: cls.height,
      levels: cls.levels,
      category: cls.category,
      type: cls.type,
      material: cls.material,
    });
  };

  // Tagged ways (buildings, roads, parks, water).
  for (const elem of elements) {
    if (elem.type !== 'way' || !elem.tags) continue;
    const cls = classifyOsmTags(elem.tags, elem.id);
    if (!cls) continue;
    pushFeature(`osm_${elem.id}`, elem.nodes ?? [], cls, elem.tags);
  }

  // Multipolygon building relations: assemble each outer ring into a footprint
  // (previously these were fetched but silently dropped).
  for (const elem of elements) {
    if (elem.type !== 'relation' || !elem.tags?.building || !Array.isArray(elem.members)) continue;
    const cls = classifyOsmTags(elem.tags, elem.id);
    if (!cls) continue;
    const outerWays = elem.members
      .filter((m: any) => m.type === 'way' && (m.role === 'outer' || !m.role))
      .map((m: any) => wayNodeIds[m.ref])
      .filter((w: number[] | undefined): w is number[] => Array.isArray(w) && w.length >= 2);
    const rings = stitchRings(outerWays);
    const hasHoles = elem.members.some((member: { role: string }) => member.role === 'inner');
    (rings.length ? rings : [[]]).forEach((ring, ri) => {
      const issues = hasHoles ? ['Interior rings were omitted.'] : [];
      if (!ring.length) issues.push('No closed exterior ring could be assembled.');
      pushFeature(`osm_rel_${elem.id}_${ri}`, ring, cls, elem.tags, issues);
    });
  }

  return buildings;
}

// Generate an explicitly labeled coverage-derived channel-grid proxy.
//
// IMPORTANT: this is a *synthetic* H, NOT a Sionna ray-traced channel. Per cell
// the magnitude is taken from the best-server coverage power and the per-subcarrier
// phase is a deterministic function of the cell coordinate — a lightweight,
// reproducible stand-in for ML scaffolding. For a true ray-traced channel use the
// CIR/CFR export (paths.cir() / paths.cfr()) on the Export tab.
export function exportCoverageChannelGrid(
  tx: Transmitter,
  grid: RadioMapGrid,
  config: ChannelGridConfig,
  freqGhz: number
): string {
  if (grid.metric && grid.metric !== 'power') {
    throw new Error('Coverage proxy requires a received-power radio map');
  }
  const data = {
    metadata: {
      creator: 'SionnaRTStudio',
      timestamp: new Date().toISOString(),
      carrier_frequency_ghz: freqGhz,
      tx_power_dbm: tx.powerDbm,
      // Be explicit about fidelity so downstream users don't mistake this for a
      // ray-traced channel matrix.
      synthetic: true,
      schema: 'sionna_rt_studio_channel_grid_v1',
      dataset_kind: 'coverage_power_proxy',
      source_metric: grid.metric ?? 'power',
      source_solver_method: grid.solverMethod,
      source_floor_id: grid.floorId,
      source_scene_id: grid.sceneId,
      h_model: 'magnitude = best-server coverage power; phase = deterministic f(cell x,y). Not Sionna paths.cfr().',
      antenna_configuration: {
        tx_array: tx.antennaArraySize,
        // RadioMapSolver uses its documented ideal dual-polarized isotropic
        // map
        // receiver rather than scene.rx_array. This proxy is scalar for the
        // same reason; use the ray-traced channel-grid export for physical Rx
        // array ports.
        rx_array: [1, 1],
        receiver_model: 'Sionna RadioMap ideal dual-polarized isotropic receiver; configured scene.rx_array not applied',
        subcarriers: config.numSubcarriers,
        bandwidth_mhz: config.bandwidthMhz,
      },
    },
    dataset: grid.cells.map((cell, idx) => {
      // Voltage magnitude from the cell's coverage power (RSS), shared across
      // subcarriers; the phase below is deterministic per coordinate (reproducible).
      const amplitude = cell.sampled === false ? 0 : Math.pow(10, cell.powerDbm / 20);
      const subcarriers_data = Array.from({ length: config.numSubcarriers }).map((_, scIdx) => {
        const freqOffset = (scIdx - config.numSubcarriers / 2) * (config.bandwidthMhz / config.numSubcarriers);
        // Deterministic (not random) phase from the cell coordinate.
        const geomPhase = (Math.PI * 2 * (cell.x * scIdx + cell.y * (scIdx + 1))) % (Math.PI * 2);
        return {
          subcarrier_index: scIdx,
          frequency_offset_mhz: freqOffset,
          h_real: amplitude * Math.cos(geomPhase),
          h_imag: amplitude * Math.sin(geomPhase),
        };
      });

      return {
        receiver_index: idx,
        sampled: cell.sampled !== false,
        coordinate_enu_m: [cell.x, cell.y, cell.z],
        los_status: cell.isLos ? 1 : 0, // geometric visibility from the serving transmitter
        received_power_dbm: cell.powerDbm,
        h_matrix: subcarriers_data,
      };
    }),
  };

  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// GIS / 3D / propagation exporters used by the EXPORT navigation panel.
// ---------------------------------------------------------------------------

type Position2D = [number, number];

function samePosition(a: Position2D, b: Position2D): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function signedTurn(a: Position2D, b: Position2D, c: Position2D): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function meshConvexHull({ vertices, triangles }: NonNullable<BuildingFootprint['mesh']>): Position2D[] {
  const sorted = Array.from(new Set(triangles), (index): Position2D => [vertices[3 * index], vertices[3 * index + 1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const points = sorted.filter((point, i) => i === 0 || !samePosition(point, sorted[i - 1]));
  if (points.length <= 2) return points;

  // Andrew's monotone chain also reduces a collinear projection to its endpoints.
  const halfHull = (ordered: Position2D[]) => {
    const hull: Position2D[] = [];
    for (const point of ordered) {
      while (hull.length >= 2 && signedTurn(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) {
        hull.pop();
      }
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  const lower = halfHull(points);
  const upper = halfHull(points.reverse());
  return [...lower, ...upper];
}

function geoJsonGeometry(coordinates: Position2D[], linear: boolean) {
  const positions = coordinates.filter((position, i) => i === 0 || !samePosition(position, coordinates[i - 1]));
  if (positions.length === 0) return null;
  const first = positions[0];
  if (positions.length === 1) return { type: 'Point', coordinates: first };
  if (!linear && samePosition(first, positions[positions.length - 1])) positions.pop();

  if (!linear && positions.length >= 3) {
    const area = positions.reduce((sum, point, i) => sum + signedTurn(first, point, positions[i + 1] ?? first), 0);
    if (area !== 0) {
      positions.push(first);
      if (area < 0) positions.reverse();
      return { type: 'Polygon', coordinates: [positions] };
    }
  }
  return { type: 'LineString', coordinates: positions };
}

// Compile scene footprints (+ anchor metadata) into a GeoJSON FeatureCollection.
export function exportGeoJSON(buildings: BuildingFootprint[], anchor: GeoAnchor): string {
  const geographicPosition = (point: ENUVector): Position2D => {
    const { lon, lat } = enuToLatLon(point, anchor);
    return [lon, lat];
  };
  const features = buildings.map((b) => {
    const mesh = b.kind === 'mesh' ? b.mesh : undefined;
    const positions = mesh
      ? meshConvexHull(mesh).map(([x, y]) => geographicPosition({ x, y, z: 0 }))
      : b.points?.length
        ? b.points.map((p): Position2D => [p.lon, p.lat])
        : b.enuPoints.map(geographicPosition);
    const linear = !mesh && (b.kind === 'wall' || b.category === 'infrastructure');

    return {
      type: 'Feature',
      properties: {
        id: b.id,
        name: b.name,
        height: b.height,
        category: b.category,
        type: b.type,
        material: b.material,
        levels: b.levels,
      },
      geometry: geoJsonGeometry(positions, linear),
    };
  });

  const geoJson = {
    type: 'FeatureCollection',
    metadata: {
      anchor_latitude: anchor.latitude,
      anchor_longitude: anchor.longitude,
      exported_at: new Date().toISOString(),
      generator: 'SionnaRTStudio Digital-Twin Suite',
    },
    features,
  };

  return JSON.stringify(geoJson, null, 2);
}

// Generate Wavefront OBJ geometry in ENU meters.
export function exportOBJ3D(buildings: BuildingFootprint[]): string {
  let objText = `# SionnaRTStudio 3D Digital Twin Model OBJ Export\n`;
  objText += `# Generated at: ${new Date().toISOString()}\n`;
  objText += `# Bounding element count: ${buildings.length}\n\n`;

  let vertexOffset = 1;

  for (const b of buildings) {
    if (b.kind !== 'mesh' && b.enuPoints.length < 2) continue;

    objText += `g ${b.id}_${b.category}_${b.type || 'generic'}\n`;
    const baseZ = b.baseZ ?? 0;
    const topZ = baseZ + b.height;

    if (b.kind === 'mesh' && b.mesh) {
      const { vertices, triangles } = b.mesh;
      for (let i = 0; i < vertices.length; i += 3) {
        objText += `v ${vertices[i]} ${vertices[i + 1]} ${vertices[i + 2] + baseZ}\n`;
      }
      for (let i = 0; i < triangles.length; i += 3) {
        objText += `f ${vertexOffset + triangles[i]} ${vertexOffset + triangles[i + 1]} ${vertexOffset + triangles[i + 2]}\n`;
      }
      vertexOffset += vertices.length / 3;
    } else if (b.category === 'building' && b.kind === 'wall') {
      if (b.enuPoints.length !== 2 || b.height <= 0) continue;
      const [start, end] = b.enuPoints;
      if (Math.hypot(start.x - end.x, start.y - end.y) < 0.01) continue;
      objText += `v ${start.x} ${start.y} ${baseZ}\n`;
      objText += `v ${end.x} ${end.y} ${baseZ}\n`;
      objText += `v ${end.x} ${end.y} ${topZ}\n`;
      objText += `v ${start.x} ${start.y} ${topZ}\n`;
      objText += `f ${vertexOffset} ${vertexOffset + 1} ${vertexOffset + 2}\n`;
      objText += `f ${vertexOffset} ${vertexOffset + 2} ${vertexOffset + 3}\n`;
      vertexOffset += 4;
    } else if (b.category === 'building' && b.enuPoints.length >= 3) {
      const n = b.enuPoints.length;

      for (const p of b.enuPoints) {
        objText += `v ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${baseZ}\n`;
      }
      for (const p of b.enuPoints) {
        objText += `v ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${topZ}\n`;
      }

      // 1. Bottom face
      objText += `f `;
      for (let i = n; i >= 1; i--) {
        objText += `${vertexOffset + i - 1} `;
      }
      objText += `\n`;

      // 2. Top face
      objText += `f `;
      for (let i = 1; i <= n; i++) {
        objText += `${vertexOffset + n + i - 1} `;
      }
      objText += `\n`;

      // 3. Side walls
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const v1 = vertexOffset + i;
        const v2 = vertexOffset + next;
        const v3 = vertexOffset + n + next;
        const v4 = vertexOffset + n + i;
        objText += `f ${v1} ${v2} ${v3} ${v4}\n`;
      }

      vertexOffset += 2 * n;
    } else if ((b.category === 'terrain' || b.category === 'water') && b.enuPoints.length >= 3) {
      const n = b.enuPoints.length;
      const z = b.category === 'water' ? 0.02 : 0.05;

      for (const p of b.enuPoints) {
        objText += `v ${p.x.toFixed(3)} ${p.y.toFixed(3)} ${z.toFixed(3)}\n`;
      }

      objText += `f `;
      for (let i = 1; i <= n; i++) {
        objText += `${vertexOffset + i - 1} `;
      }
      objText += `\n`;

      vertexOffset += n;
    } else if (b.category === 'infrastructure') {
      const n = b.enuPoints.length;
      for (const p of b.enuPoints) {
        objText += `v ${p.x.toFixed(3)} ${p.y.toFixed(3)} 0.100\n`;
      }
      objText += `l `;
      for (let i = 0; i < n; i++) {
        objText += `${vertexOffset + i} `;
      }
      objText += `\n`;
      vertexOffset += n;
    }
    objText += `\n`;
  }

  return objText;
}

// Compile a detailed CSV spreadsheet representation of the active propagation paths
export function exportPropagationCSV(paths: PropagationPath[]): string {
  let csv = `Path_ID,Path_Type,Reflection_Order,Total_Distance_m,Path_Loss_dB,Received_Power_dBm,Delay_ns,Vertices_ENU\n`;
  for (const p of paths) {
    const ptsStr = p.points
      .map((pt) => `${pt.x.toFixed(2)}:${pt.y.toFixed(2)}:${pt.z.toFixed(2)}`)
      .join(' | ');
    csv += `"${p.id}","${p.type}",${p.order},${p.distance.toFixed(2)},${p.pathLossDb.toFixed(2)},${p.receivedPowerDbm.toFixed(2)},${p.delayNs.toFixed(2)},"${ptsStr}"\n`;
  }
  return csv;
}
