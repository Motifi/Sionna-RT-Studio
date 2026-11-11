import { useEffect, useState } from 'react';
import { Cable, Route } from 'lucide-react';
import type { HandoverConfig } from '../api';
import { useI18n } from '../i18n';
import type { GeoAnchor, MobilityCombineMode, Receiver, TrajectoryPoint, Transmitter } from '../types';
import { enuToLatLon } from '../utils';
import { NumberField } from './NumberField';

const inputClass = 'w-full rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-[var(--accent)]';

interface FronthaulControlProps {
  value: number | null;
  onChange: (value: number | null) => void;
}

export function FronthaulControl({ value, onChange }: FronthaulControlProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => String(value ?? ''));

  useEffect(() => { setDraft(String(value ?? '')); }, [value]);

  const commit = (field: HTMLInputElement) => {
    const number = field.valueAsNumber;
    if (field.validity.badInput || (field.value !== '' && (!Number.isFinite(number) || number < 0))) {
      setDraft(String(value ?? ''));
      return;
    }
    const next = field.value === '' ? null : number;
    setDraft(String(next ?? ''));
    onChange(next);
  };

  return (
    <details className="panel p-3">
      <summary className="cursor-pointer font-semibold">
        <Cable aria-hidden="true" className="mr-1.5 inline h-4 w-4 text-[var(--accent-deep)]" />
        {t('Experiment metadata', '实验元数据')}
      </summary>
      <label className="mt-3 block space-y-1 text-sm">
        <span>{t('AP fronthaul capacity (Mb/s)', 'AP 前传容量（Mb/s）')}</span>
        <input id="input-ap-fronthaul" type="number" inputMode="decimal" min={0} step="any"
          placeholder={t('Not set', '未设置')} value={draft} className={inputClass}
          onChange={event => { if (!event.currentTarget.validity.badInput) setDraft(event.currentTarget.value); }}
          onBlur={event => commit(event.currentTarget)}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          aria-describedby="planning-fronthaul-note" />
      </label>
      <p id="planning-fronthaul-note" className="mt-2 text-xs text-slate-600">
        {t('Capacity is recorded in the experiment manifest.', '前传容量随实验清单导出。')}
      </p>
    </details>
  );
}

interface RouteControlsProps {
  tx: Transmitter;
  rx: Receiver;
  anchor: GeoAnchor;
  trajectoryPoints: readonly TrajectoryPoint[];
  onTrajectoryChange: (points: TrajectoryPoint[]) => void;
}

export function RouteControls({ tx, rx, anchor, trajectoryPoints, onTrajectoryChange }: RouteControlsProps) {
  const { t } = useI18n();

  const generateLoop = () => {
    const vertices = Array.from({ length: 12 }, (_, index) => {
      const angle = index * Math.PI / 6;
      const enu = { x: tx.enu.x + 120 * Math.cos(angle), y: tx.enu.y + 120 * Math.sin(angle), z: 0 };
      return { ...enuToLatLon(enu, anchor), enu };
    });
    onTrajectoryChange([...vertices, vertices[0]]);
  };

  return (
    <section className="panel space-y-3 p-3" aria-labelledby="planning-route-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="planning-route-heading" className="flex items-center gap-2 font-semibold">
          <Route aria-hidden="true" className="h-4 w-4 text-[var(--accent-deep)]" />
          {t('UE route', 'UE 轨迹')}
        </h3>
        <span id="planning-waypoint-count" className="readout text-xs text-slate-600">
          {t(`${trajectoryPoints.length} points`, `${trajectoryPoints.length} 个控制点`)}
        </span>
      </div>
      {trajectoryPoints.length === 0 && (
        <p className="text-xs text-slate-600">
          {t('Use Draw route in the 3D view to add waypoints.', '使用三维视图中的「绘制轨迹」添加控制点。')}
        </p>
      )}
      {rx.heightReference === 'enu' && trajectoryPoints.length > 0 &&
        <details className="text-xs">
          <summary className="cursor-pointer">{t('Waypoint offsets from UE elevation (m)', '控制点相对 UE 的标高偏移（米）')}</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {trajectoryPoints.map((point, index) => <label key={index}>
              {index + 1}
              <NumberField value={point.enu.z} className={inputClass} step="any"
                onChange={z => onTrajectoryChange(trajectoryPoints.map((entry, i) =>
                  i === index ? { ...entry, enu: { ...entry.enu, z } } : entry,
                ))} />
            </label>)}
          </div>
        </details>}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" id="btn-gen-trajectory" onClick={generateLoop} className="studio-tool"
          title={t(`Generate a loop around ${tx.name}`, `围绕 ${tx.name} 生成环形轨迹`)}>
          {t('Generate loop', '生成环形轨迹')}
        </button>
        <button type="button" id="btn-clear-planned-route" onClick={() => onTrajectoryChange([])}
          disabled={trajectoryPoints.length === 0} className="studio-tool">
          {t('Clear route', '清除轨迹')}
        </button>
      </div>
    </section>
  );
}

interface TrajectorySimulationControlsProps {
  speedKmh: number;
  intervalMs: number;
  combineMode: MobilityCombineMode;
  handover: HandoverConfig;
  onSpeedChange: (value: number) => void;
  onIntervalChange: (value: number) => void;
  onCombineChange: (value: MobilityCombineMode) => void;
  onHandoverChange: (value: HandoverConfig) => void;
}

export function TrajectorySimulationControls({
  speedKmh, intervalMs, combineMode, handover, onSpeedChange, onIntervalChange, onCombineChange, onHandoverChange,
}: TrajectorySimulationControlsProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs">
          <span>{t('Speed (km/h)', '速度（km/h）')}</span>
          <NumberField id="input-trajectory-speed" min={0.36} max={120} step="any" value={speedKmh}
            onChange={onSpeedChange} className={inputClass} />
        </label>
        <label className="space-y-1 text-xs">
          <span>{t('Sample interval (ms)', '采样间隔（ms）')}</span>
          <NumberField id="input-trajectory-interval" integer min={25} max={500} value={intervalMs}
            onChange={onIntervalChange} className={inputClass} />
        </label>
      </div>
      <details className="rounded border border-[var(--line)] bg-[var(--ink-750)] p-2 text-xs">
        <summary className="cursor-pointer font-semibold">{t('Power and A3 handover', '功率统计与 A3 切换')}</summary>
        <div className="mt-2 space-y-2">
          <label className="flex items-center justify-between gap-2">
            {t('Power metric', '功率统计')}
            <select className="rounded border border-[var(--line)] bg-white px-2 py-1" value={combineMode}
              onChange={event => onCombineChange(event.target.value as MobilityCombineMode)}>
              <option value="best_server">{t('Strongest AP', '最强 AP')}</option>
              <option value="sum">{t('Sum power', '功率相加')}</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            {t('Hysteresis (dB)', '迟滞（dB）')}
            <input className="min-w-0" type="range" min="0" max="15" step="0.5" value={handover.hysteresisDb}
              onChange={event => onHandoverChange({ ...handover, hysteresisDb: Number(event.target.value) })} />
            <span className="readout">{handover.hysteresisDb.toFixed(1)}</span>
          </label>
          <label className="flex items-center justify-between gap-2">
            {t('Time-to-trigger (ms)', '触发时间（ms）')}
            <select className="rounded border border-[var(--line)] bg-white px-2 py-1" value={handover.timeToTriggerMs}
              onChange={event => onHandoverChange({ ...handover, timeToTriggerMs: Number(event.target.value) })}>
              {[0, 40, 80, 160, 320, 480, 640, 1024].map(ms => <option key={ms} value={ms}>{ms}</option>)}
            </select>
          </label>
        </div>
      </details>
    </div>
  );
}
