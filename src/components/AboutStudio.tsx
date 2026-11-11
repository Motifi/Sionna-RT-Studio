import { useEffect, useState } from 'react';
import { readUpdateStatus, type BackendHealth, type UpdateStatus } from '../api';
import { useI18n } from '../i18n';

export function AboutStudio({ health }: { health: BackendHealth | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<UpdateStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!open || !health?.desktop) return;
    let cancelled = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const status = await readUpdateStatus();
        if (!cancelled) { setResult(status); setUnavailable(false); }
      } catch {
        if (!cancelled) setUnavailable(true);
      } finally {
        busy = false;
      }
    };
    void poll();
    const id = window.setInterval(poll, 1250);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [open, health?.desktop]);

  const check = async () => {
    setSubmitting(true);
    try {
      setResult(await readUpdateStatus(true));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    } finally {
      setSubmitting(false);
    }
  };
  const messages = {
    not_checked: t('Waiting for first check', '等待首次检查'),
    available: t('Update available', '有可用更新'),
    up_to_date: t('Up to date', '已是最新稳定版'),
    no_stable_release: t('No stable release found', '未找到稳定版'),
    no_compatible_asset: t('No compatible installer for this OS and architecture', '没有适用于当前系统版本和架构的安装包'),
    offline: t('Could not reach GitHub', '无法连接 GitHub'),
    timeout: t('GitHub request timed out', 'GitHub 请求超时'),
    http_error: t('GitHub returned an error', 'GitHub 返回错误'),
    invalid_response: t('GitHub release metadata is invalid', 'GitHub 发行元数据无效'),
  };
  return <details className="relative" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="text-xs cursor-pointer">{t('About', '关于')}</summary>
    <div className="absolute right-0 top-8 w-80 max-w-[85vw] rounded border border-[var(--line)] bg-[var(--page)] p-3 text-xs space-y-2 shadow-lg">
      <p className="font-semibold">Sionna RT Studio {health?.appVersion ? `v${health.appVersion}` : ''}</p>
      {health?.desktop ? <>
        <p role="status">{unavailable ? t('Update service is unavailable', '更新服务不可用')
          : result?.checking || submitting ? t('Checking stable release…', '正在检查稳定版…')
            : result ? messages[result.status] : t('Reading update status…', '正在读取更新状态…')}</p>
        {result?.checkedAt && <p>{t('Last checked', '最近检查')} · {new Date(result.checkedAt).toLocaleString()}</p>}
        <button className="btn-signal rounded px-2 py-1 disabled:opacity-50" disabled={submitting || result?.checking} onClick={check}>
          {t('Check for updates', '检查更新')}
        </button>
        {result?.version && <p>{t('Stable release', '稳定版')} · v{result.version}</p>}
        {result?.notes && <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words">{result.notes}</p>}
        {result?.asset && <div className="space-y-1">
          <p className="break-all">{result.asset.name} · {(result.asset.size / 1024 ** 2).toFixed(1)} MiB</p>
          <p>{t('Minimum OS version', '最低系统版本')} · {result.asset.minimumOs}</p>
          <a className="underline text-[var(--accent-deep)]" href={result.asset.url} rel="noreferrer">
            {t('Download for manual installation', '下载安装包并手动安装')}
          </a>
        </div>}
        <a className="block underline text-[var(--accent-deep)]" href={result?.releaseUrl ?? result?.releasesUrl ?? 'https://github.com/Motifi/Sionna-RT-Studio/releases'} rel="noreferrer">
          {t('GitHub releases', 'GitHub 发行记录')}
        </a>
      </> : <p>{t('The desktop app checks stable releases.', '桌面版支持检查稳定版。')}</p>}
    </div>
  </details>;
}
