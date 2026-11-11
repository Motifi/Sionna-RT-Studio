import type { Color } from 'three';
import type { CoverageMetric, RadioMapCell, RadioMapGrid } from '../types';
import { sampleColormap, type ColormapName } from './colormaps';

export interface CoverageDisplayRange {
  min: number;
  max: number;
  autoStretch: boolean;
}

export function coverageCellValue(cell: RadioMapCell, metric: CoverageMetric): number | null {
  const value = metric === 'sinr' ? cell.sinr : cell.powerDbm;
  return value != null && Number.isFinite(value) && value > -200 ? value : null;
}

export function coverageDisplayRange(
  radioMap: RadioMapGrid,
  autoRange: boolean,
  vmin: number,
  vmax: number,
): CoverageDisplayRange | null {
  const metric = radioMap.metric ?? 'power';
  const autoStretch = autoRange || metric === 'sinr';
  let min = Infinity;
  let max = -Infinity;
  for (const cell of radioMap.cells) {
    const value = coverageCellValue(cell, metric);
    if (value === null) continue;
    if (!autoStretch) return { min: Math.min(vmin, vmax), max: Math.max(vmin, vmax), autoStretch };
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Number.isFinite(min) ? { min, max, autoStretch } : null;
}

export function setCoverageColor(
  colormap: ColormapName,
  value: number,
  { min, max, autoStretch }: CoverageDisplayRange,
  out: Color,
): Color {
  const span = max - min > 1e-6 ? max - min : 1;
  const fraction = (value - min) / span;
  const stretched = autoStretch ? (fraction - 0.5) * 1.7 + 0.5 : fraction;
  const t = Math.min(1, Math.max(0, stretched));
  const [r, g, b] = sampleColormap(colormap, autoStretch ? t ** 0.78 : t);
  out.setRGB(r, g, b);
  if (autoStretch) {
    const { h, s, l } = out.getHSL({ h: 0, s: 0, l: 0 });
    out.setHSL(h, Math.min(1, s * 1.3), l);
  }
  return out;
}
