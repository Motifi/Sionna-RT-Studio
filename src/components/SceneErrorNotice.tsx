import { useI18n } from '../i18n';
import { sceneErrorLabel, type SceneOperation } from '../lib/sceneErrorLabels';

export function SceneErrorNotice({ error, operation, className }: {
  error: string; operation: SceneOperation; className?: string;
}) {
  const { t } = useI18n();
  const { text, detail } = sceneErrorLabel(error, operation, t);
  if (!text) return null;
  return <div className={`break-words text-xs ${className ?? ''}`}>
    <p role="alert" className="text-[var(--bad)]">{text}</p>
    {detail && <details className="mt-1 text-[var(--text-mid)]">
      <summary className="cursor-pointer">{t('Technical details', '技术详情')}</summary>
      <p>{detail}</p>
    </details>}
  </div>;
}
