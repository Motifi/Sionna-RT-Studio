import { useEffect, useRef, useState } from 'react';
import { listCsiRuns, readCsiRun, type CsiHistoryEntry, type CsiHistoryRun } from '../api';
import { useI18n } from '../i18n';
import { formatCsiBytes } from '../lib/csiSize';

export function useCsiHistory(projectId: string, online: boolean) {
  const [listing, setListing] = useState<{ projectId: string; runs: CsiHistoryEntry[] }>();
  const [listError, setListError] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [selected, setSelected] = useState<CsiHistoryRun>();
  const [pendingId, setPendingId] = useState('');
  const [refreshCount, setRefreshCount] = useState(0);
  const request = useRef(0);
  const refresh = () => {
    setSelectionError('');
    setRefreshCount(count => count + 1);
  };

  useEffect(() => {
    let active = true;
    setListError('');
    if (online) {
      listCsiRuns(projectId).then(
        runs => { if (active) setListing({ projectId, runs }); },
        error => { if (active) setListError(error instanceof Error ? error.message : String(error)); },
      );
    }
    return () => { active = false; };
  }, [online, projectId, refreshCount]);

  const close = () => {
    request.current++;
    setSelected(undefined);
    setPendingId('');
    setSelectionError('');
  };

  const open = async (runId: string) => {
    if (!runId) {
      close();
      return;
    }
    const key = ++request.current;
    setSelectionError('');
    setPendingId(runId);
    try {
      const run = await readCsiRun(projectId, runId);
      if (key === request.current) setSelected(run);
    } catch (error) {
      if (key === request.current) setSelectionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (key === request.current) setPendingId('');
    }
  };

  return {
    runs: listing?.projectId === projectId ? listing.runs : [],
    loading: online && listing?.projectId !== projectId && !listError,
    selected, pendingId, error: selectionError || listError, open, close, refresh,
  };
}

export function CsiHistoryPicker({ history, id, online }: {
  history: ReturnType<typeof useCsiHistory>;
  id: string;
  online: boolean;
}) {
  const { t, locale } = useI18n();
  const current = history.pendingId || history.selected?.run.runId || '';
  return (
    <section className="panel mb-2 grid gap-2 p-3 text-sm" aria-labelledby={`${id}-label`}>
      <div className="flex items-center justify-between gap-2">
        <label id={`${id}-label`} htmlFor={id} className="font-semibold">{t('CSI run history', 'CSI 运行历史')}</label>
        {history.selected && (
          <button type="button" id={id === 'select-csi-history' ? 'btn-close-csi-history' : undefined}
            className="btn-quiet rounded px-2 py-1 text-xs" onClick={history.close}>
            {t('Back to current project', '返回当前项目')}
          </button>
        )}
      </div>
      <select id={id} value={current} onChange={event => void history.open(event.target.value)}
        disabled={!online || history.runs.length === 0}
        className="min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-xs">
        <option value="">{t('Current project', '当前项目')}</option>
        {history.runs.map(run => (
          <option key={run.runId} value={run.runId}>
            {new Date(run.createdAtUtc).toLocaleString(locale)} · {run.mode === 'static'
              ? t('Static', '静态') : t('Trajectory', '轨迹')} · {formatCsiBytes(run.uncompressedBytes)} · {run.runId.slice(0, 8)}
          </option>
        ))}
      </select>
      {history.pendingId || history.loading ? <p role="status" className="text-xs">{t('Reading runs…', '正在读取运行记录…')}</p>
        : history.error ? <div className="flex flex-wrap items-center gap-2 text-xs">
          <p role="alert" className="text-red-700">{history.error}</p>
          <button type="button" className="underline" onClick={history.refresh}>{t('Refresh', '刷新')}</button>
        </div> : history.selected ? <p role="status" className="text-xs">{t('Viewing a saved simulation snapshot.', '正在查看已保存的仿真快照。')}</p>
          : online && !history.runs.length && <p className="text-xs">{t('No saved runs for this project on this device.', '此设备上还没有此项目的运行记录。')}</p>}
    </section>
  );
}
