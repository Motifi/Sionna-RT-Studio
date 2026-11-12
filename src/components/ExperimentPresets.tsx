import { useI18n, type LocalizedText } from '../i18n';
import type { ExperimentPreset } from '../lib/experimentPresets';

const presets: { id: ExperimentPreset; name: LocalizedText; outcome: LocalizedText }[] = [
  {
    id: 'static', name: ['Static CSI', '静态 CSI'],
    outcome: [
      'One 3.5 GHz line-of-sight link. Check the 216.82 ns direct-path delay and export the CSI ZIP.',
      '一条 3.5 GHz 直视链路。核对 216.82 ns 的直达径时延，然后导出 CSI ZIP。',
    ],
  },
  {
    id: 'trajectory', name: ['Street to lobby', '街道到大厅'],
    outcome: [
      'Follow one UE past two APs. Play the samples and inspect each AP’s received power.',
      '让一个 UE 沿街道进入大厅。播放样点并检查两个 AP 的接收功率。',
    ],
  },
  {
    id: 'coverage', name: ['Street coverage', '街区覆盖'],
    outcome: [
      'Calculate a 12 × 6 power grid and check P5 and the percentage at or above −90 dBm.',
      '计算 12 × 6 接收功率栅格，检查 P5 和达到 −90 dBm 的比例。',
    ],
  },
];

export function ExperimentPresets({ open, setOpen, selected, busy, disabled, error, onLoad }: {
  open: boolean;
  setOpen: (open: boolean) => void;
  selected: ExperimentPreset | null;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onLoad: (id: ExperimentPreset) => void;
}) {
  const { t } = useI18n();
  return (
    <details id="experiment-presets" open={open} onToggle={event => setOpen(event.currentTarget.open)}
      className="panel mb-2 rounded-lg p-3 text-sm">
      <summary className="cursor-pointer font-semibold">{t('Example experiments', '示例实验')}</summary>
      <p className="mt-2 text-xs text-slate-600">
        {t('Loading an example replaces the scene and deployment. Use Scene Undo to restore them.',
          '载入示例会替换当前场景和部署，可在场景中撤销。')}
      </p>
      <ul className="mt-2 grid gap-2">
        {presets.map(({ id, name, outcome }) => (
          <li key={id} className="grid gap-1 rounded border border-[var(--line)] p-2">
            <button id={`btn-load-example-${id}`} type="button" disabled={busy || (id === 'trajectory' && disabled)}
              aria-pressed={selected === id} onClick={() => onLoad(id)} className="btn-quiet w-fit rounded px-2 py-1 text-xs font-semibold">
              {t(...name)}
            </button>
            <p className="text-xs leading-relaxed text-slate-700">{t(...outcome)}</p>
          </li>
        ))}
      </ul>
      {busy && <p role="status" className="mt-2 text-xs">{t('Loading the offline scene…', '正在载入离线场景…')}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    </details>
  );
}
