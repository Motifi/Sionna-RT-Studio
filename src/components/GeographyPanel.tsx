/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { useI18n } from '../i18n';
import { radioMaterialLabel } from '../lib/radioLabels';
import { defaultMaterialConfig, type MaterialConfig, type ScatteringPattern } from '../types';

interface GeographyPanelProps {
  materialIds: string[];
  materialConfigs: MaterialConfig[];
  onMaterialChange: (cfg: MaterialConfig) => void;
}

const field = 'min-h-8 w-full min-w-0 rounded-md border border-[var(--line)] bg-[var(--ink-800)] px-2 py-1 text-sm';

export function GeographyPanel({ materialIds, materialConfigs, onMaterialChange }: GeographyPanelProps) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState('');
  const id = materialIds.includes(selectedId) ? selectedId : materialIds[0];
  if (!id) return <p className="text-xs text-[var(--text-mid)]">{t('No radio materials in this scene.', '当前场景没有射频材质。')}</p>;
  const cfg = materialConfigs.find(material => material.id === id) ?? defaultMaterialConfig(id);

  return <div className="space-y-2.5 text-xs">
    <label className="flex flex-col gap-1 font-medium">{t('Scene material', '场景材质')}
      <select className={field} value={id} onChange={event => setSelectedId(event.target.value)}>
        {materialIds.map(materialId => <option key={materialId} value={materialId} title={materialId}>
          {radioMaterialLabel(materialId, t)}
        </option>)}
      </select>
    </label>
    <div key={id} className="space-y-2.5">
      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between gap-2 font-medium">
          {t('Scattering coefficient', '散射系数')}<span className="readout">{cfg.scatteringCoefficient.toFixed(2)}</span>
        </span>
        <input type="range" min="0" max="1" step="0.05" className="w-full cursor-ew-resize accent-[var(--accent)]"
          value={cfg.scatteringCoefficient}
          onChange={event => onMaterialChange({ ...cfg, scatteringCoefficient: event.target.valueAsNumber })} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between gap-2 font-medium">
          XPD<span className="readout">{cfg.xpdCoefficient.toFixed(2)}</span>
        </span>
        <input type="range" min="0" max="1" step="0.05" className="w-full cursor-ew-resize accent-[var(--accent)]"
          value={cfg.xpdCoefficient}
          onChange={event => onMaterialChange({ ...cfg, xpdCoefficient: event.target.valueAsNumber })} />
      </label>
      <label className="flex flex-col gap-1 font-medium">{t('Radio slab thickness (m)', '无线薄层厚度（米）')}
        <input type="number" min="0" step="any" className={field} key={cfg.thickness ?? 'default'}
          defaultValue={cfg.thickness ?? ''} placeholder={t('ITU preset', 'ITU 预设')}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          onBlur={event => {
            const input = event.currentTarget;
            const value = input.valueAsNumber;
            if (input.validity.badInput || (input.value && (!Number.isFinite(value) || value < 0))) {
              input.value = String(cfg.thickness ?? '');
              return;
            }
            const thickness = input.value ? value : undefined;
            if (thickness !== (cfg.thickness ?? undefined)) onMaterialChange({ ...cfg, thickness });
          }} />
      </label>
      <label className="flex flex-col gap-1 font-medium">{t('Scattering pattern', '散射方向图')}
        <select className={field} value={cfg.scatteringPattern}
          onChange={event => onMaterialChange({ ...cfg, scatteringPattern: event.target.value as ScatteringPattern })}>
          <option value="none">{t('None (specular only)', '仅镜面反射')}</option>
          <option value="lambertian">{t('Lambertian', '朗伯散射')}</option>
          <option value="directive">{t('Directive', '定向散射')}</option>
          <option value="backscattering">{t('Backscattering', '后向散射')}</option>
        </select>
      </label>
    </div>
  </div>;
}
