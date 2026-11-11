import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Loader2, Pause, Play, Waves } from 'lucide-react';
import type { CsiLinkPreview, CsiRun, CsiRunMode, CsiRunOutput, CsiSelection } from '../api';
import { useI18n } from '../i18n';
import { CIR_SIZE_LIMIT, FULL_CSI_SIZE_LIMIT, formatCsiBytes, type CsiSizeEstimate } from '../lib/csiSize';

interface CsiPreviewPanelProps {
  run: CsiRun | null;
  stale: boolean;
  expired?: boolean;
  running: CsiRunMode | null;
  error: string;
  staticDisabledReason?: string;
  trajectoryDisabledReason?: string;
  trajectoryReceiverName?: string;
  trajectoryReceiver?: ReactNode;
  gridControls?: ReactNode;
  trajectoryControls?: ReactNode;
  mixedArrays?: Record<CsiRunMode, boolean>;
  staticEstimate: CsiSizeEstimate | null;
  trajectoryEstimate: CsiSizeEstimate | null;
  output: CsiRunOutput;
  onOutputChange: (output: CsiRunOutput) => void;
  onRun: (mode: CsiRunMode) => void;
  selection: CsiSelection | null;
  onSelect: (selection: CsiSelection) => void;
  link: CsiLinkPreview | null;
  linkLoading: boolean;
  linkError?: string;
  onOpenExport?: () => void;
  onOpenDiagnostics?: () => void;
  onOpenTrajectory?: () => void;
  active?: boolean;
}

function FrequencyResponse({ link }: { link: CsiLinkPreview }) {
  const { t } = useI18n();
  const points = link.frequenciesHz.map((frequency, index) => ({ frequency, db: link.magnitudeDb[index] }));
  const defined = points.filter(({ db }) => db != null && Number.isFinite(db));
  if (!defined.length) {
    return <p className="text-xs text-slate-600">{t('This link has zero channel gain at the selected sample.', '所选时刻的链路信道增益为零。')}</p>;
  }

  const firstHz = points[0].frequency;
  const lastHz = points[points.length - 1].frequency;
  const frequenciesSpan = lastHz - firstHz;
  const highDb = Math.ceil(Math.max(...defined.map(({ db }) => db!)) / 5) * 5;
  const lowDb = Math.min(highDb - 10, Math.floor(Math.min(...defined.map(({ db }) => db!)) / 5) * 5);
  const x = (frequency: number) => frequenciesSpan ? 42 + (frequency - firstHz) / frequenciesSpan * 250 : 167;
  const y = (db: number) => 12 + (highDb - db) / (highDb - lowDb) * 86;
  const d = points.map(({ frequency, db }, index) => {
    if (db == null || !Number.isFinite(db)) return '';
    const previous = points[index - 1]?.db;
    return `${previous != null && Number.isFinite(previous) ? 'L' : 'M'}${x(frequency)},${y(db)}`;
  }).join(' ');
  const displayFrequency = (frequency: number) => (frequency / 1e6).toFixed(2);

  return (
    <figure className="rounded border border-[var(--line)] bg-[#f5f3ec] px-3 pt-3 pb-2">
      <figcaption className="mb-1 text-xs font-semibold text-slate-800">
        {t('Subcarrier response · mean |H|² (dB)', '子载波响应 · 平均 |H|²（dB）')}
      </figcaption>
      <svg id="csi-frequency-response" role="img" aria-label={t('Channel gain versus frequency offset', '信道增益随频偏变化的曲线')} viewBox="0 0 306 125" className="h-32 w-full">
        {[highDb, (highDb + lowDb) / 2, lowDb].map((db) => (
          <g key={db}>
            <line x1="42" y1={y(db)} x2="292" y2={y(db)} stroke="#ded9cc" />
            <text x="36" y={y(db) + 3} textAnchor="end" fontSize="9" fill="#6b6862">{db}</text>
          </g>
        ))}
        <path d={d} stroke="#4a727e" strokeWidth="2" fill="none" />
        {defined.length === 1 && <circle cx={x(defined[0].frequency)} cy={y(defined[0].db!)} r="3" fill="#4a727e" />}
        {frequenciesSpan ? (
          <>
            <text x="42" y="114" fontSize="9" fill="#6b6862">{displayFrequency(firstHz)}</text>
            <text x="292" y="114" textAnchor="end" fontSize="9" fill="#6b6862">{displayFrequency(lastHz)}</text>
          </>
        ) : <text x="167" y="114" textAnchor="middle" fontSize="9" fill="#6b6862">{displayFrequency(firstHz)}</text>}
      </svg>
      <p className="text-center text-[11px] text-slate-600">{t('Frequency offset from carrier (MHz)', '相对载频的频偏（MHz）')}</p>
    </figure>
  );
}

export function CsiPreviewPanel({
  run, stale, expired, running, error, staticDisabledReason, trajectoryDisabledReason, trajectoryReceiverName,
  trajectoryReceiver, gridControls, trajectoryControls, mixedArrays,
  staticEstimate, trajectoryEstimate, output, onOutputChange,
  onRun, selection, onSelect, link, linkLoading, linkError, onOpenExport, onOpenDiagnostics, onOpenTrajectory, active = true,
}: CsiPreviewPanelProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<CsiRunMode>('static');
  const [playingRunId, setPlayingRunId] = useState<string | null>(null);
  const sampleIndex = selection?.sampleIndex ?? 0;
  const sampleCount = run?.timeSeconds.length ?? 0;
  const unavailable = stale || expired;
  const resultDisabled = unavailable || !!running;
  const canPlay = active && !resultDisabled && run?.mode === 'trajectory' && !!selection && sampleCount > 1;
  const playing = canPlay && playingRunId === run.runId && sampleIndex < sampleCount - 1;
  const isTrajectory = mode === 'trajectory';
  const estimate = isTrajectory ? trajectoryEstimate : staticEstimate;
  const disabledReason = isTrajectory ? trajectoryDisabledReason : staticDisabledReason;
  const estimateId = `csi-size-estimate-${mode}`;
  const disabledReasonId = `csi-run-disabled-${mode}`;
  const runDescription = [estimate && estimateId, disabledReason && disabledReasonId].filter(Boolean).join(' ');

  useEffect(() => {
    if (!canPlay) setPlayingRunId(null);
  }, [canPlay]);

  useEffect(() => {
    if (!playing || !run || !selection) return;
    const delayMs = (run.timeSeconds[sampleIndex + 1] - run.timeSeconds[sampleIndex]) * 1000;
    const timer = window.setTimeout(() => onSelect({ ...selection, sampleIndex: sampleIndex + 1 }), Math.max(45, delayMs));
    return () => window.clearTimeout(timer);
  }, [playing, run, sampleIndex, selection, onSelect]);

  const seek = (index: number) => {
    setPlayingRunId(null);
    if (selection) onSelect({ ...selection, sampleIndex: index });
  };

  const togglePlayback = () => {
    if (!canPlay || !run || !selection) return;
    if (playing) {
      setPlayingRunId(null);
      return;
    }
    if (sampleIndex >= sampleCount - 1) onSelect({ ...selection, sampleIndex: 0 });
    setPlayingRunId(run.runId);
  };

  const staticLinks = new Map(run?.links.map(({ txId, rxId, metrics }) => [JSON.stringify([txId, rxId]), metrics]));
  const trajectoryLinks = new Map(run?.steps?.[sampleIndex]?.perTx?.map((item) => [item.txId, item]));
  const hasMatrix = !!run && !!selection;

  return (
    <section id="csi-preview-panel" className="panel flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Waves size={16} className="text-[var(--accent)]" aria-hidden="true" />
        <h3 className="panel-title">{t('CSI simulation', 'CSI 仿真')}</h3>
      </div>

      <div role="group" aria-label={t('CSI run mode', 'CSI 仿真模式')}
        className="grid grid-cols-2 gap-1 rounded-md border border-[var(--line)] bg-[var(--ink-750)] p-1">
        {([
          ['static', t('Static links', '静态链路')],
          ['trajectory', t('UE trajectory', 'UE 轨迹')],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            id={`btn-csi-mode-${value}`}
            type="button"
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value);
              setPlayingRunId(null);
            }}
            className={`rounded border px-2 py-1.5 text-xs font-semibold transition cursor-pointer ${
              mode === value
                ? 'border-[var(--line)] bg-white text-slate-900'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {isTrajectory && (trajectoryReceiver || (trajectoryReceiverName && (
        <p className="text-xs text-slate-700">{t(`Moving UE · ${trajectoryReceiverName}`, `移动 UE · ${trajectoryReceiverName}`)}</p>
      )))}
      {gridControls}
      {isTrajectory && trajectoryControls}

      <div className="grid gap-1">
        <label htmlFor="select-csi-output" className="text-xs font-semibold text-slate-800">
          {t('Data to save', '保存的数据')}
        </label>
        <select
          id="select-csi-output"
          value={output}
          disabled={!!running}
          aria-describedby="csi-output-hint"
          onChange={event => onOutputChange(event.target.value === 'cir' ? 'cir' : 'cir_cfr')}
          className="w-full min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm"
        >
          <option value="cir_cfr">{t('CIR + full CFR', 'CIR + 完整 CFR')}</option>
          <option value="cir">{t('CIR only (reconstruct CFR as needed)', '仅 CIR（按需重建 CFR）')}</option>
        </select>
        <p id="csi-output-hint" className="text-[11px] leading-normal text-slate-600">
          {t(
            `Uncompressed limits · CIR + CFR ${formatCsiBytes(FULL_CSI_SIZE_LIMIT)} · CIR only ${formatCsiBytes(CIR_SIZE_LIMIT)}`,
            `未压缩数据上限 · CIR + CFR ${formatCsiBytes(FULL_CSI_SIZE_LIMIT)} · 仅 CIR ${formatCsiBytes(CIR_SIZE_LIMIT)}`,
          )}
        </p>
      </div>
      <div className="grid gap-2">
        {estimate && (
          <div id={estimateId} className="space-y-0.5 rounded border border-[var(--line)] bg-[var(--ink-750)] px-2.5 py-2 text-[11px] leading-normal text-slate-600">
            <p>
              <span className="readout font-semibold text-slate-800">
                CFR [{estimate.shape.join(' × ')}] · {formatCsiBytes(estimate.cfrBytes)}
              </span>{' '}
              {output === 'cir' ? t('if stored', '如保存 CFR') : t('uncompressed', '未压缩')}
            </p>
            <p>{t('Time × UE × Rx port × AP × Tx port × subcarrier', '时刻 × UE × Rx 端口 × AP × Tx 端口 × 子载波')}</p>
            <p>{t(
              `CIR adds ${formatCsiBytes(estimate.cirBytesPerPath)} per slot on the path axis.`,
              `CIR 路径维每增加 1，数据量增加 ${formatCsiBytes(estimate.cirBytesPerPath)}。`,
            )}</p>
          </div>
        )}
        <button
          id={`btn-run-csi-${mode}`}
          type="button"
          onClick={() => { setPlayingRunId(null); onRun(mode); }}
          disabled={!!running || !!disabledReason}
          aria-describedby={runDescription || undefined}
          className="btn-signal flex w-full items-center justify-center gap-2 px-3 py-2 text-sm cursor-pointer disabled:cursor-not-allowed"
        >
          {running && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
          {running
            ? running === 'trajectory' ? t('Tracing UE trajectory…', '正在追踪 UE 轨迹…') : t('Tracing static links…', '正在追踪静态链路…')
            : isTrajectory ? t('Run trajectory CSI', '计算轨迹 CSI') : t('Run static CSI', '计算静态 CSI')}
        </button>
        {disabledReason && (
          <p id={disabledReasonId} className="text-xs leading-normal text-slate-600">{disabledReason}</p>
        )}
        {disabledReason && mixedArrays?.[mode] && onOpenDiagnostics && (
          <button id="btn-open-csi-diagnostics" type="button" onClick={onOpenDiagnostics}
            className="flex w-fit items-center gap-1 text-xs font-semibold text-[var(--accent-deep)] hover:underline cursor-pointer">
            {t('Open link diagnostics', '打开链路诊断')} <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
        {isTrajectory && onOpenTrajectory && (
          <button id="btn-open-csi-trajectory" type="button" onClick={onOpenTrajectory}
            className="flex w-fit items-center gap-1 text-xs font-semibold text-[var(--accent-deep)] hover:underline cursor-pointer">
            {t('Draw a trajectory for this UE', '为这个 UE 绘制轨迹')} <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>}

      {hasMatrix && (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 border-t border-[var(--line)] pt-3">
            <h4 className="text-sm font-semibold text-slate-900">{run.mode === 'static' ? t('Static CSI result', '静态 CSI 结果') : t('Trajectory CSI result', '轨迹 CSI 结果')}</h4>
            <span className="text-[11px] text-slate-600">{run.txIds.length} AP · {run.rxIds.length} UE</span>
          </div>
          {unavailable && (
            <p role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">
              {expired
                ? t('This run expired in the solver cache. Run the simulation again to inspect or export its CSI.', '求解器缓存中的此结果已过期。请重新运行仿真以查看链路详情或导出 CSI。')
                : t('Inputs changed since this run. Run the simulation again to update CSI.', '输入已变化。请重新运行仿真以更新 CSI。')}
            </p>
          )}
          <p id="csi-run-output" className="text-[11px] text-slate-600">
            {run.output === 'cir' ? t('CIR only · CFR reconstructed from paths', '仅 CIR · CFR 由路径重建') : t('CIR + full CFR', 'CIR + 完整 CFR')}
            {' · '}{formatCsiBytes(run.uncompressedBytes)} {t('uncompressed', '未压缩')}
          </p>
          {run.mode === 'trajectory' && (
            <div className="flex flex-col gap-2 rounded border border-[var(--line)] p-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  id="btn-play-csi-trajectory"
                  onClick={togglePlayback}
                  disabled={!canPlay}
                  aria-label={playing ? t('Pause trajectory', '暂停轨迹') : t('Play trajectory', '播放轨迹')}
                  className="rounded border border-[var(--line)] p-1.5 text-[var(--accent-deep)] disabled:opacity-50"
                >
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <label htmlFor="input-csi-time" className="text-xs font-semibold">
                  {t('Sample', '采样时刻')} {sampleIndex + 1}/{sampleCount}
                </label>
                <output htmlFor="input-csi-time" className="ml-auto readout text-xs">{run.timeSeconds[sampleIndex]?.toFixed(3)} s</output>
              </div>
              <input
                id="input-csi-time"
                type="range"
                min={0}
                max={Math.max(0, sampleCount - 1)}
                value={sampleIndex}
                onChange={(event) => seek(Number(event.target.value))}
                disabled={resultDisabled || sampleCount <= 1}
                className="w-full accent-[var(--accent)]"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-700">
              AP
              <select id="select-csi-tx" value={selection.txId} onChange={(event) => onSelect({ ...selection, txId: event.target.value })} disabled={resultDisabled} className="min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm">
                {run.txIds.map((id, index) => <option key={id} value={id}>{run.txNames[index] ?? id}</option>)}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs font-semibold text-slate-700">
              UE
              <select id="select-csi-rx" value={selection.rxId} onChange={(event) => onSelect({ ...selection, rxId: event.target.value })} disabled={resultDisabled} className="min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm">
                {run.rxIds.map((id, index) => <option key={id} value={id}>{run.rxNames[index] ?? id}</option>)}
              </select>
            </label>
          </div>

          <div className="overflow-x-auto rounded border border-[var(--line)]">
            <table id="csi-link-matrix" className="w-full border-collapse text-xs">
              <caption className="bg-[#f5f3ec] px-2 py-1.5 text-left font-semibold">{t('AP × UE received power (dBm)', 'AP × UE 接收功率（dBm）')}</caption>
              <thead><tr><th scope="col" className="p-1 text-left">AP</th>{run.rxIds.map((id, index) => <th key={id} scope="col" className="whitespace-nowrap p-1">{run.rxNames[index] ?? id}</th>)}</tr></thead>
              <tbody>
                {run.txIds.map((txId, txIndex) => (
                  <tr key={txId}>
                    <th scope="row" className="whitespace-nowrap border-t border-[var(--line)] px-1.5 text-left">{run.txNames[txIndex] ?? txId}</th>
                    {run.rxIds.map((rxId, rxIndex) => {
                      const staticMetrics = staticLinks.get(JSON.stringify([txId, rxId]));
                      const movingMetrics = trajectoryLinks.get(txId);
                      const paths = run.mode === 'trajectory' ? movingMetrics?.numPaths : staticMetrics?.numPaths;
                      const power = run.mode === 'trajectory' ? movingMetrics?.receivedPowerDbm : staticMetrics?.totalRxPowerDbm;
                      const active = selection.txId === txId && selection.rxId === rxId;
                      return (
                        <td key={rxId} className="border-t border-[var(--line)] p-0.5 text-center">
                          <button
                            type="button"
                            aria-pressed={active}
                            aria-label={`${run.txNames[txIndex] ?? txId} → ${run.rxNames[rxIndex] ?? rxId}`}
                            onClick={() => onSelect({ txId, rxId, sampleIndex })}
                            disabled={resultDisabled}
                            className={`w-full whitespace-nowrap rounded px-1.5 py-1 readout ${active ? 'bg-[#ebe7dc] font-bold text-slate-900' : 'text-slate-700 hover:bg-[#f5f3ec]'}`}
                          >
                            {paths && power != null ? power.toFixed(1) : '—'}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {linkLoading && !unavailable && <p role="status" className="text-xs text-slate-600">{t('Loading the selected link…', '正在读取所选链路…')}</p>}
          {linkError && !unavailable && <p role="alert" className="text-xs text-red-700">{linkError}</p>}
          {link && !linkLoading && !unavailable && (
            <>
              <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-700">
                <span>{link.metrics.numPaths ? link.metrics.losStatus : t('No resolved path', '无可解析路径')}</span>
                {link.metrics.numPaths > 0 && <span className="readout font-semibold">{link.metrics.totalRxPowerDbm.toFixed(1)} dBm</span>}
                <span>{t(`${link.metrics.numPaths} paths`, `${link.metrics.numPaths} 条路径`)}</span>
              </div>
              <FrequencyResponse link={link} />
            </>
          )}

          {run.mode === 'trajectory' && run.handover && (
            <details className="rounded border border-[var(--line)] bg-[#f5f3ec] p-2.5">
              <summary className="cursor-pointer text-xs font-semibold text-slate-800">
                {t(`A3 handovers · ${run.handover.handoverCount}`, `A3 切换 · ${run.handover.handoverCount} 次`)}
              </summary>
              <p className="mt-2 text-[11px] text-slate-600">{t(`${run.handover.pingPongCount} ping-pong events`, `${run.handover.pingPongCount} 次乒乓切换`)}</p>
              <ul className="mt-1 max-h-36 space-y-1 overflow-y-auto text-xs">
                {run.handover.events.map((event) => (
                  <li key={`${event.stepIndex}-${event.toTxId}`}>
                    <button type="button" onClick={() => seek(event.stepIndex)} disabled={resultDisabled} className="w-full rounded border border-[var(--line)] bg-white px-2 py-1 text-left disabled:opacity-50">
                      <span className="mr-1 readout">{event.timeS.toFixed(3)} s</span>
                      {event.fromTxName} → {event.toTxName}{event.pingPong ? t(' · ping-pong', ' · 乒乓') : ''}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!resultDisabled && onOpenExport && (
            <button type="button" onClick={onOpenExport} className="flex items-center justify-end gap-1 text-xs font-semibold text-[var(--accent-deep)] hover:underline">
              {t('Go to Export', '前往导出')} <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}
        </>
      )}
    </section>
  );
}
