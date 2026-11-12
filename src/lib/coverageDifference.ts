import type { CoverageMetric, RadioMapGrid } from '../types';
import { coverageCellValue } from './coverageDisplay';

export function coverageDifferenceRaster(
  baseline: RadioMapGrid, current: RadioMapGrid, metric: CoverageMetric,
) {
  const firstNorth = current.cells[0]?.y;
  const nextRow = current.cells.findIndex(cell => cell.y !== firstNorth);
  const columns = nextRow > 0 ? nextRow : current.cells.length;
  const rows = columns ? current.cells.length / columns : 0;
  const northUpDeltas: (number | null)[] = [];
  let maxAbsDb = 0;
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col;
      const before = coverageCellValue(baseline.cells[index], metric);
      const after = coverageCellValue(current.cells[index], metric);
      const delta = before === null || after === null ? null : after - before;
      if (delta !== null) maxAbsDb = Math.max(maxAbsDb, Math.abs(delta));
      northUpDeltas.push(delta);
    }
  }
  return { columns, rows, maxAbsDb, northUpDeltas };
}

export function coverageDifferenceColor(delta: number, maxAbsDb: number) {
  const neutral = [247, 247, 247];
  const end = delta < 0 ? [33, 102, 172] : [178, 24, 43];
  const fraction = maxAbsDb > 0 ? Math.min(1, Math.abs(delta) / maxAbsDb) : 0;
  return neutral.map((value, index) => Math.round(value + (end[index] - value) * fraction));
}

export function coverageDifferenceCanvas(
  baseline: RadioMapGrid, current: RadioMapGrid, metric: CoverageMetric, title: string, direction: string,
): HTMLCanvasElement | null {
  const { columns, rows, maxAbsDb, northUpDeltas } = coverageDifferenceRaster(baseline, current, metric);
  if (!columns || !rows) return null;
  const longest = Math.max(columns, rows);
  const scale = longest > 1600 ? 1600 / longest : Math.max(1, Math.floor(640 / longest));
  const width = Math.max(1, Math.round(columns * scale));
  const height = Math.max(1, Math.round(rows * scale));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(340, width + 32);
  canvas.height = height + 116;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const raster = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y + 0.5) * rows / height);
    for (let x = 0; x < width; x++) {
      const col = Math.floor((x + 0.5) * columns / width);
      const delta = northUpDeltas[row * columns + col];
      if (delta === null) continue;
      const offset = (y * width + x) * 4;
      raster.data.set([...coverageDifferenceColor(delta, maxAbsDb), 255], offset);
    }
  }
  const left = Math.round((canvas.width - width) / 2);
  const top = 48;
  context.putImageData(raster, left, top);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, top - 1);
  context.fillRect(0, top + height + 1, canvas.width, canvas.height - top - height - 1);
  context.strokeStyle = '#94a3b8';
  context.strokeRect(left - 0.5, top - 0.5, width + 1, height + 1);
  context.fillStyle = '#1e293b';
  context.font = 'bold 15px sans-serif';
  context.fillText(title, 16, 21);
  context.font = '12px sans-serif';
  context.fillText(direction, 16, 38);
  const legendWidth = Math.min(420, canvas.width - 32);
  const legendLeft = (canvas.width - legendWidth) / 2;
  const legendTop = top + height + 16;
  for (let i = 0; i < legendWidth; i++) {
    const value = maxAbsDb * (2 * i / (legendWidth - 1) - 1);
    context.fillStyle = `rgb(${coverageDifferenceColor(value, maxAbsDb).join(',')})`;
    context.fillRect(legendLeft + i, legendTop, 1, 12);
  }
  context.fillStyle = '#1e293b';
  context.textAlign = 'center';
  context.fillText('0 dB', canvas.width / 2, legendTop + 31);
  if (maxAbsDb > 0) {
    const limit = Number(maxAbsDb.toPrecision(3));
    context.textAlign = 'left';
    context.fillText(`−${limit} dB`, legendLeft, legendTop + 31);
    context.textAlign = 'right';
    context.fillText(`+${limit} dB`, legendLeft + legendWidth, legendTop + 31);
  }
  return canvas;
}
