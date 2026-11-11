import { useI18n } from '../i18n';
import type { ChannelGridConfig } from '../types';
import { NumberField } from './NumberField';

export function GridFrequencyFields({
  config,
  onChange,
  disabled,
}: {
  config: ChannelGridConfig;
  onChange: (config: ChannelGridConfig) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const fieldClass = 'min-w-0 rounded border border-[var(--line)] bg-white px-2 py-1.5 text-sm text-[var(--text-hi)]';

  return (
    <div className="grid max-w-sm grid-cols-2 gap-2">
      <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--text-mid)]">
        {t('Subcarriers', '子载波数')}
        <NumberField
          integer min={1} max={8192}
          value={config.numSubcarriers}
          onChange={(numSubcarriers) => onChange({ ...config, numSubcarriers })}
          disabled={disabled}
          className={fieldClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--text-mid)]">
        {t('Bandwidth (MHz)', '带宽（MHz）')}
        <NumberField
          integer min={1} max={2000}
          value={config.bandwidthMhz}
          onChange={(bandwidthMhz) => onChange({ ...config, bandwidthMhz })}
          disabled={disabled}
          className={fieldClass}
        />
      </label>
    </div>
  );
}
