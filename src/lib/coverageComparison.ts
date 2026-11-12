import type { CoverageMetric, GeoAnchor, RadioMapGrid } from '../types';
import { coverageCellValue } from './coverageDisplay';
import type { ColormapName } from './colormaps';

export interface CoverageSnapshot {
  grid: RadioMapGrid;
  anchor?: GeoAnchor;
  provenance: unknown;
}

interface CoverageSummary {
  sampledCells: number;
  finiteCells: number;
  p5: number | null;
  servedPercent: number | null;
}

export interface CoverageComparison {
  metric: CoverageMetric;
  unit: 'dBm' | 'dB';
  thresholdDb: number;
  range: { min: number; max: number } | null;
  baseline: CoverageSummary;
  current: CoverageSummary;
  p5Db: number | null;
  servedPercentPoints: number | null;
  matchedCells: number;
}

function alignedGrid(baseline: RadioMapGrid, current: RadioMapGrid): boolean {
  const tolerance = Math.max(1e-6, baseline.gridSize * 1e-5);
  const same = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  if (
    (baseline.metric ?? 'power') !== (current.metric ?? 'power') ||
    baseline.cells.length !== current.cells.length ||
    !same(baseline.gridSize, current.gridSize) ||
    !same(baseline.minX, current.minX) || !same(baseline.maxX, current.maxX) ||
    !same(baseline.minY, current.minY) || !same(baseline.maxY, current.maxY)
  ) return false;
  return baseline.cells.every(({ x, y, z, sampled }, index) => {
    const cell = current.cells[index];
    return (sampled ?? true) === (cell.sampled ?? true) &&
      same(x, cell.x) && same(y, cell.y) && same(z, cell.z);
  });
}

function summarize(values: number[], threshold: number, sampledCells: number): CoverageSummary {
  const finiteCells = values.length;
  if (!finiteCells) return { sampledCells, finiteCells, p5: null, servedPercent: sampledCells ? 0 : null };
  values.sort((a, b) => a - b);
  const index = (finiteCells - 1) * 0.05;
  const lower = Math.floor(index);
  const p5 = values[lower] + (values[Math.ceil(index)] - values[lower]) * (index - lower);
  const served = values.filter(value => value >= threshold).length;
  return { sampledCells, finiteCells, p5, servedPercent: 100 * served / sampledCells };
}

function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

export function compareCoverage(
  baseline: RadioMapGrid,
  current: RadioMapGrid,
  threshold = current.stats?.thresholdDb ?? (current.metric === 'sinr' ? 0 : -90),
): CoverageComparison | null {
  if (!alignedGrid(baseline, current)) return null;
  const metric = current.metric ?? 'power';
  const baselineValues: number[] = [];
  const currentValues: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  let matchedCells = 0;
  let sampledCells = 0;
  for (let index = 0; index < current.cells.length; index++) {
    if (current.cells[index].sampled !== false) sampledCells++;
    const before = coverageCellValue(baseline.cells[index], metric);
    const after = coverageCellValue(current.cells[index], metric);
    if (before !== null) {
      baselineValues.push(before);
      min = Math.min(min, before);
      max = Math.max(max, before);
    }
    if (after !== null) {
      currentValues.push(after);
      min = Math.min(min, after);
      max = Math.max(max, after);
    }
    if (before !== null && after !== null) matchedCells++;
  }
  const before = summarize(baselineValues, threshold, sampledCells);
  const after = summarize(currentValues, threshold, sampledCells);
  return {
    metric, unit: metric === 'sinr' ? 'dB' : 'dBm', thresholdDb: threshold,
    range: Number.isFinite(min) ? { min, max } : null,
    baseline: before, current: after, matchedCells,
    p5Db: difference(before.p5, after.p5),
    servedPercentPoints: difference(before.servedPercent, after.servedPercent),
  };
}

export function coverageComparisonExport(
  baseline: CoverageSnapshot,
  current: CoverageSnapshot,
  comparison: CoverageComparison,
  colormap: ColormapName,
) {
  const { metric, unit, thresholdDb, range, p5Db, servedPercentPoints, matchedCells } = comparison;
  return {
    schemaVersion: 1, coordinateFrame: 'ENU_m', metric, unit, thresholdDb, colormap, colorRange: range,
    baseline: { provenance: baseline.provenance, summary: comparison.baseline, raster: baseline.grid },
    current: { provenance: current.provenance, summary: comparison.current, raster: current.grid },
    differences: {
      p5Db, servedPercentPoints, matchedCells,
      cells: current.grid.cells.map((cell, index) => ({
        x: cell.x, y: cell.y, z: cell.z,
        deltaDb: difference(coverageCellValue(baseline.grid.cells[index], metric), coverageCellValue(cell, metric)),
      })),
    },
  };
}
