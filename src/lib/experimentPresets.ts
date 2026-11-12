import { STARTER_AP, STARTER_UE } from '../starterScene';
import { DEFAULT_SOLVER_OPTIONS, type CoverageRegion, type Receiver, type Transmitter } from '../types';
import { DEFAULT_CSI_SETTINGS } from '../project';

export type ExperimentPreset = 'static' | 'trajectory' | 'coverage';

const REGION: CoverageRegion = { minX: -48, maxX: 48, minY: -24, maxY: 24 };

export function starterExperiment(preset: 'static' | 'coverage') {
  const tx: Transmitter = {
    ...STARTER_AP, height: 1.5, heightReference: 'enu', antennaArraySize: [1, 1],
    beamsteeringAzimuth: 90, beamsteeringElevation: 0,
  };
  const rx: Receiver = { ...STARTER_UE, heightReference: 'enu' };
  return {
    tx, rx, frequencyGhz: 3.5, maxDepth: preset === 'static' ? 0 : 1,
    options: { ...DEFAULT_SOLVER_OPTIONS, txPattern: 'iso' as const, pathSamplesPerSource: 100_000 },
    csi: { ...DEFAULT_CSI_SETTINGS, numSubcarriers: 64, normalizeDelays: false },
    coverageRegion: preset === 'coverage' ? REGION : null,
    coverageGridM: 8, coverageThresholdDb: preset === 'coverage' ? -90 : null,
  };
}
