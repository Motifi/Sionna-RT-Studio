import type { BuildingFootprint, GeoAnchor, Receiver, TrajectoryPoint, Transmitter } from './types';
import { enuToLatLon } from './utils';

// The offline street layout is fictional. This anchor locates its local ENU origin.
export const STARTER_ANCHOR: GeoAnchor = { latitude: 38.9226, longitude: -77.0194 };

type Point = readonly [east: number, north: number];

function rectangle(west: number, south: number, east: number, north: number): Point[] {
  return [[west, south], [east, south], [east, north], [west, north]];
}

function feature(
  id: string, name: string, footprint: Point[], properties: Pick<
    BuildingFootprint, 'category' | 'type' | 'height' | 'material' | 'kind'
  >,
): BuildingFootprint {
  const enuPoints = footprint.map(([x, y]) => ({ x, y, z: 0 }));
  return {
    id: `starter-${id}`, name, source: 'template', ...properties, enuPoints,
    points: enuPoints.map(point => enuToLatLon(point, STARTER_ANCHOR)),
  };
}

function building(id: string, name: string, footprint: Point[], height: number, material: string) {
  return feature(id, name, footprint, { category: 'building', type: 'building', kind: 'building', height, material });
}

function road(id: string, name: string, footprint: Point[], type: 'avenue' | 'lane' | 'junction') {
  return feature(id, name, footprint, { category: 'infrastructure', type, height: 0.12, material: 'itu_dry_ground' });
}

function park(id: string, name: string, footprint: Point[]) {
  return feature(id, name, footprint, { category: 'terrain', type: 'park', height: 0.08, material: 'itu_dry_ground' });
}

export const STARTER_BUILDINGS: BuildingFootprint[] = [
  building('library', 'Library', [[-55, 12], [-10, 12], [-10, 37], [-28, 37], [-28, 55], [-55, 55]], 22, 'itu_concrete'),
  building('workshop', 'Workshop', rectangle(-88, 13, -61, 38), 12, 'itu_brick'),
  building('archives', 'Archives', rectangle(-75, 48, -59, 71), 15, 'itu_concrete'),
  building('exchange', 'Exchange', [[11, 12], [40, 12], [46, 18], [46, 41], [11, 41]], 32, 'itu_glass'),
  building('research-lab', 'Research Lab', [[52, 13], [91, 13], [91, 32], [76, 32], [76, 45], [52, 45]], 19, 'itu_concrete'),
  building('studio', 'Studio', rectangle(12, 48, 37, 69), 14, 'itu_brick'),
  building('residences', 'Residences', [[-41, -53], [-12, -53], [-12, -15], [-34, -15], [-41, -22]], 26, 'itu_brick'),
  building('hotel', 'Hotel', [[11, -46], [48, -46], [48, -20], [39, -20], [39, -14], [11, -14]], 28, 'itu_glass'),
  building('depot', 'Depot', rectangle(56, -44, 87, -22), 9, 'itu_concrete'),
  building('market-hall', 'Market Hall', [[-81, -43], [-47, -43], [-47, -18], [-59, -18], [-63, -14], [-81, -14]], 11, 'itu_brick'),
  building('market-annex', 'Market Annex', rectangle(-75, -66, -51, -48), 16, 'itu_concrete'),
  feature('garden-wall', 'Garden Wall', [[45, 57], [72, 57]], {
    category: 'building', type: 'wall', kind: 'wall', height: 3.2, material: 'itu_concrete',
  }),
  road('junction', 'Junction', rectangle(-5, -7, 5, 7), 'junction'),
  // Each approach starts at the junction so crossings align with the sidewalks.
  road('avenue-west', 'Campus Avenue', [[-5, 0], [-112, 0]], 'avenue'),
  road('avenue-east', 'Campus Avenue', [[5, 0], [112, 0]], 'avenue'),
  road('lane-north', 'Library Lane', [[0, 7], [0, 86]], 'lane'),
  road('lane-south', 'Library Lane', [[0, -7], [0, -82]], 'lane'),
  park('north-garden', 'North Garden', rectangle(45, 59, 91, 78)),
  park('market-garden', 'Market Garden', rectangle(-106, -61, -85, -14)),
];

function waypoint(x: number, y: number): TrajectoryPoint {
  const enu = { x, y, z: 0 };
  return { enu, ...enuToLatLon(enu, STARTER_ANCHOR) };
}

function position(x: number, y: number) {
  const { enu, lat, lon } = waypoint(x, y);
  return { enu, latitude: lat, longitude: lon };
}

export const STARTER_AP: Transmitter = {
  id: 'tx_1', name: 'AP 1', ...position(-33, -8.25),
  height: 8, powerDbm: 30, antennaArraySize: [8, 8],
  beamsteeringAzimuth: 90, beamsteeringElevation: -7,
};

export const STARTER_UE: Receiver = {
  id: 'rx_1', name: 'UE 1', ...position(32, -8.25), height: 1.5, antennaArraySize: [1, 1],
};

export const STARTER_ROUTE: TrajectoryPoint[] = [
  waypoint(STARTER_UE.enu.x, STARTER_UE.enu.y),
  waypoint(6.4, -8.25),
  waypoint(6.4, 43),
];
