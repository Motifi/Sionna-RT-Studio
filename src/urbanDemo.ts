import type { ENUVector, GeoAnchor, Receiver, TrajectoryPoint, Transmitter } from './types';
import { enuToLatLon } from './utils';

export const URBAN_DEMO = new URL('../assets/urban-scene.zip', import.meta.url).href;

export function urbanDeployment(anchor: GeoAnchor): { aps: Transmitter[]; ue: Receiver; route: TrajectoryPoint[] } {
  const position = (enu: ENUVector) => {
    const { lat, lon } = enuToLatLon(enu, anchor);
    return { enu, latitude: lat, longitude: lon };
  };
  const street: Transmitter = {
    id: 'tx_urban', name: 'Street AP', ...position({ x: -56, y: -8.5, z: 0 }),
    height: 5.4, powerDbm: 30, antennaArraySize: [4, 4],
    beamsteeringAzimuth: 80, beamsteeringElevation: -5,
  };
  const lobby: Transmitter = {
    id: 'tx_lobby', name: 'Lobby AP', ...position({ x: 18, y: 16, z: 0 }),
    height: 3.8, heightReference: 'enu', powerDbm: 30, antennaArraySize: [4, 4],
    beamsteeringAzimuth: 27, beamsteeringElevation: -8,
  };
  const route = [
    [-47, -8.5], [-19, -8.5], [16, -8.5], [16, 11], [16, 19], [24, 19], [24, 25],
  ].map(([x, y]) => {
    const enu = { x, y, z: 0 };
    return { enu, ...enuToLatLon(enu, anchor) };
  });
  const ue: Receiver = {
    id: 'rx_urban', name: 'Walking UE', ...position(route[0].enu), height: 1.5, antennaArraySize: [1, 1],
  };
  return { aps: [street, lobby], ue, route };
}
