import type { Receiver, SolverOptions } from '../types';

const MIB = 1024 * 1024;
// Keep in sync with the backend raw array limits in backend/csi_runs.py.
export const FULL_CSI_SIZE_LIMIT = 256 * MIB;
export const CIR_SIZE_LIMIT = 512 * MIB;

export type CsiShape = [
  samples: number, ues: number, rxPorts: number, aps: number, txPorts: number, subcarriers: number,
];

export interface CsiSizeEstimate {
  shape: CsiShape;
  cfrBytes: number;
  cirBytesPerPath: number;
}

export function antennaPortCount(
  [columns, rows]: Receiver['antennaArraySize'],
  polarization: SolverOptions['txPolarization'],
) {
  const portsPerElement = polarization === 'VH' || polarization === 'cross' ? 2 : 1;
  return columns * rows * portsPerElement;
}

export function estimateCsiSize(shape: CsiShape): CsiSizeEstimate {
  const [samples, ues, rxPorts, aps, txPorts, subcarriers] = shape;
  const links = samples * ues * aps;
  const coefficientBytes = links * rxPorts * txPorts * 8; // complex64 per port pair
  return {
    shape,
    cfrBytes: coefficientBytes * subcarriers,
    cirBytesPerPath: coefficientBytes + links * 5, // float32 delay and Boolean mask
  };
}

export function formatCsiBytes(bytes: number): string {
  const mib = bytes / MIB;
  return mib > 0 && mib < 0.01
    ? '<0.01 MiB'
    : `${mib.toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
}
