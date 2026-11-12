import { Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';
import type { SimulationJob } from '../lib/simulationJobs';

interface SimulationJobStatusProps {
  job: SimulationJob<unknown> | null;
  onCancel?: () => void;
  onRetry?: () => void;
}

export function SimulationJobStatus({ job, onCancel, onRetry }: SimulationJobStatusProps) {
  const { t } = useI18n();
  if (!job) return null;
  const busy = job.status === 'queued' || job.status === 'running' || job.status === 'cancelling';
  const failed = job.status === 'failed';
  const retryable = failed || job.status === 'cancelled';
  const stage = {
    waiting: t('Waiting for the solver…', '正在等待求解器…'),
    preparing: t('Preparing the scene and devices…', '正在准备场景和设备…'),
    tracing: t('Tracing radio paths…', '正在追踪无线传播路径…'),
    processing: t('Processing results…', '正在处理结果…'),
    saving: t('Preparing the saved run…', '正在写入运行记录…'),
    finished: t('Completed', '已完成'),
  }[job.stage];

  const label = {
    queued: job.queuePosition === null ? t('Queued', '已排队') :
      t(`Queued · position ${job.queuePosition}`, `已排队 · 第 ${job.queuePosition} 位`),
    running: stage,
    cancelling: t('Stopping at the next safe point…', '正在等待当前计算到达可安全停止的位置…'),
    succeeded: t('Completed', '已完成'),
    failed: t('Simulation failed', '仿真失败'),
    cancelled: t('Cancelled', '已取消'),
  }[job.status];

  return (
    <div className="rounded border border-[var(--line)] bg-[var(--ink-750)] p-2 text-xs text-slate-700">
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="flex items-center gap-1.5 font-semibold">
          {busy && <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" />}
          {label}
        </p>
        {job.canCancel && onCancel && (
          <button type="button" className="btn-quiet cursor-pointer px-2 py-1 font-semibold" onClick={onCancel}>
            {t('Cancel', '取消')}
          </button>
        )}
        {retryable && onRetry && (
          <button type="button" className="btn-quiet cursor-pointer px-2 py-1 font-semibold" onClick={onRetry}>
            {t('Retry same inputs', '用相同参数重试')}
          </button>
        )}
      </div>
      {failed && job.error && <p role="alert" className="mt-1 break-words text-[var(--bad)]">{job.error}</p>}
    </div>
  );
}
