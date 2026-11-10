import React, { useEffect, useState } from 'react';
import { Cable, Route } from 'lucide-react';
import { useI18n } from '../i18n';
import type { GeoAnchor, Receiver, TrajectoryPoint, Transmitter } from '../types';
import { enuToLatLon } from '../utils';
import { NumberField } from './NumberField';

interface PlanningControlsProps {
  tx: Transmitter;
  rx: Receiver;
  fronthaulMbps: number | null;
  onFronthaulChange: (value: number | null) => void;
  trajectoryPoints: readonly TrajectoryPoint[];
  speedKmh: number;
  intervalMs: number;
  onSpeedChange: (value: number) => void;
  onIntervalChange: (value: number) => void;
  onClearTrajectory: () => void;
  anchor?: GeoAnchor;
  onTrajectoryChange?: (points: TrajectoryPoint[]) => void;
}

const inputClass = 'w-full rounded border border-[var(--line)] bg-white px-2 py-1.5 text-[14px] text-slate-900 focus:outline-none focus:border-[var(--accent)]';
const buttonClass = 'rounded border border-[var(--line)] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-[var(--ink-750)] disabled:opacity-50';

export function PlanningControls({
  tx,
  rx,
  fronthaulMbps,
  onFronthaulChange,
  trajectoryPoints,
  speedKmh,
  intervalMs,
  onSpeedChange,
  onIntervalChange,
  onClearTrajectory,
  anchor,
  onTrajectoryChange,
}: PlanningControlsProps) {
  const { t } = useI18n();
  const [fronthaulDraft, setFronthaulDraft] = useState(() => String(fronthaulMbps ?? ''));

  useEffect(() => {
    setFronthaulDraft(String(fronthaulMbps ?? ''));
  }, [tx.id, fronthaulMbps]);

  const commitFronthaul = (field: HTMLInputElement) => {
    const value = field.valueAsNumber;
    if (field.validity.badInput || (field.value !== '' && (!Number.isFinite(value) || value < 0))) {
      setFronthaulDraft(String(fronthaulMbps ?? ''));
      return;
    }
    const committed = field.value === '' ? null : value;
    setFronthaulDraft(String(committed ?? ''));
    onFronthaulChange(committed);
  };

  const generateLoop = () => {
    if (!anchor || !onTrajectoryChange) return;
    const vertices = Array.from({ length: 12 }, (_, index) => {
      const angle = index * Math.PI / 6;
      const enu = { x: tx.enu.x + 120 * Math.cos(angle), y: tx.enu.y + 120 * Math.sin(angle), z: 0 };
      return { ...enuToLatLon(enu, anchor), enu };
    });
    onTrajectoryChange([...vertices, vertices[0]]);
  };

  return (
    <div className="flex flex-col gap-3">
      <section className="panel flex flex-col gap-2 p-4" aria-labelledby="planning-fronthaul-heading">
        <h3 id="planning-fronthaul-heading" className="panel-title flex items-center gap-2">
          <Cable className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
          {t('AP fronthaul', 'AP 前传')}
        </h3>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-slate-700">
          {tx.name} · {t('Capacity (Mb/s)', '容量（Mb/s）')}
          <input
            id="input-ap-fronthaul"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            placeholder={t('Not set', '未设置')}
            className={inputClass}
            value={fronthaulDraft}
            onChange={(event) => {
              if (!event.currentTarget.validity.badInput) setFronthaulDraft(event.currentTarget.value);
            }}
            onBlur={(event) => commitFronthaul(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            aria-describedby="planning-fronthaul-note"
          />
        </label>
        <p id="planning-fronthaul-note" className="text-[11px] leading-relaxed text-slate-600">
          {t('Leave empty for an unspecified capacity. The experiment manifest records this value.',
            '留空表示未设置。容量随实验清单导出。')}
        </p>
      </section>

      <section className="panel flex flex-col gap-2.5 p-4" aria-labelledby="planning-route-heading">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <h3 id="planning-route-heading" className="panel-title flex items-center gap-2">
            <Route className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
            {t('UE trajectory', 'UE 轨迹')}
          </h3>
          <span id="planning-waypoint-count" className="readout text-[12px] text-slate-700">
            {rx.name} · {t(`${trajectoryPoints.length} points`, `${trajectoryPoints.length} 个控制点`)}
          </span>
        </div>
        <p className="text-[12px] leading-relaxed text-slate-600">
          {t('Use Draw trajectory in the 3D view to add points for the selected UE.',
            '在 3D 视图选择「绘制轨迹」，为当前选中的 UE 添加控制点。')}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-700">
            {t('Speed (km/h)', '速度（km/h）')}
            <NumberField id="input-trajectory-speed" min={0.36} max={120} step="any" value={speedKmh}
              onChange={onSpeedChange} className={inputClass} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-slate-700">
            {t('Sample interval (ms)', '采样间隔（ms）')}
            <NumberField id="input-trajectory-interval" integer min={25} max={500} value={intervalMs}
              onChange={onIntervalChange} className={inputClass} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {anchor && onTrajectoryChange && (
            <button type="button" id="btn-gen-trajectory" onClick={generateLoop} className={buttonClass}>
              {t('Generate loop path', '生成环形轨迹')}
            </button>
          )}
          <button type="button" id="btn-clear-planned-route" onClick={onClearTrajectory}
            disabled={trajectoryPoints.length === 0} className={buttonClass}>
            {t('Clear points', '清除控制点')}
          </button>
        </div>
      </section>
    </div>
  );
}
