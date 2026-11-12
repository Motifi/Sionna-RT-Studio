import { useId, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { Building2, LoaderCircle, X } from 'lucide-react';
import { useI18n } from '../i18n';
import type { BuildingSpec } from '../types';
import { SceneErrorNotice } from './SceneErrorNotice';

interface BuildingGeneratorDialogProps {
  initial: BuildingSpec;
  editing: boolean;
  busy: boolean;
  error: string;
  onApply: (spec: BuildingSpec) => void;
  onCancel: () => void;
}

const labelClass = 'flex min-w-0 flex-col gap-1 text-xs font-semibold';
const fieldClass = 'min-w-0 w-full rounded-lg border border-[var(--line)] bg-[var(--ink-750)] px-2.5 py-1.5 text-sm font-normal';

interface DimensionFieldProps {
  name: 'length' | 'width' | 'height' | 'floors' | 'rotationDeg' | 'baseZ' | 'east' | 'north';
  label: string;
  initial?: number;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  descriptionId?: string;
  inputRef?: Ref<HTMLInputElement>;
}

function DimensionField({ name, label, initial, min, max, step, placeholder, descriptionId, inputRef }: DimensionFieldProps) {
  return <label className={labelClass}>
    {label}
    <input ref={inputRef} id={`building-${name}`} name={name} className={fieldClass}
      type="number" inputMode={step === 1 ? 'numeric' : 'decimal'} defaultValue={initial} required={name !== 'floors'}
      min={min} max={max} step={step ?? 'any'} placeholder={placeholder} aria-describedby={descriptionId} />
  </label>;
}

export function BuildingGeneratorDialog({ initial, editing, busy, error, onApply, onCancel }: BuildingGeneratorDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const heightInput = useRef<HTMLInputElement>(null);
  const positionFields = useRef<HTMLDetailsElement>(null);
  const titleId = useId();
  const floorsHelpId = useId();
  const [validationError, setValidationError] = useState('');

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    heightInput.current?.focus();
    return () => { element.close(); };
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const invalid = event.currentTarget.querySelector<HTMLInputElement>('input:invalid');
    if (invalid) {
      if (positionFields.current?.contains(invalid)) positionFields.current.open = true;
      const label = invalid.labels?.[0]?.textContent?.trim() ?? invalid.name;
      const { validity, min, max } = invalid;
      setValidationError(validity.rangeUnderflow || validity.rangeOverflow
        ? t(`Enter ${label} between ${min} and ${max}.`, `「${label}」需在 ${min} 至 ${max} 之间。`)
        : validity.stepMismatch
          ? t(`Enter a whole number for ${label}.`, `「${label}」需填写整数。`)
          : t(`Enter a valid value for ${label}.`, `请填写有效的「${label}」。`));
      invalid.focus();
      return;
    }
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name')).trim();
    if (!name) {
      setValidationError(t('Enter a building name.', '请输入建筑名称。'));
      event.currentTarget.querySelector<HTMLInputElement>('#building-name')?.focus();
      return;
    }
    const height = Number(values.get('height'));
    const floors = values.get('floors') === '' ? undefined : Number(values.get('floors'));
    if (floors !== undefined && (height < floors * 2.7 - 1e-9 || height > floors * 6 + 1e-9)) {
      setValidationError(t('Height and floor count must allow 2.7–6 m per floor.', '建筑高度和楼层数需满足每层 2.7–6 米。'));
      heightInput.current?.focus();
      return;
    }
    setValidationError('');
    onApply({
      id: initial.id, name, height, floors,
      layout: values.get('layout') === 'apartments' ? 'apartments' : 'office',
      length: Number(values.get('length')), width: Number(values.get('width')),
      rotationDeg: Number(values.get('rotationDeg')), baseZ: Number(values.get('baseZ')),
      east: Number(values.get('east')), north: Number(values.get('north')),
    });
  };

  return <dialog ref={dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onCancel(); }}
    className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--ink-800)] p-0 text-[var(--text-hi)] shadow-xl backdrop:bg-black/35">
    <form id="building-generator-form" aria-busy={busy} noValidate onSubmit={submit}
      onChange={() => { if (validationError) setValidationError(''); }}>
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--ink-800)] px-4 py-3">
        <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
          <Building2 size={17} aria-hidden="true" />
          {editing ? t('Edit building parameters', '编辑建筑参数') : t('Generate building', '生成建筑')}
        </h2>
        <button type="button" aria-label={t('Close', '关闭')} onClick={onCancel}
          className="btn-quiet cursor-pointer rounded-lg p-1.5">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="space-y-3 p-4">
        <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
          <label className={labelClass}>
            {t('Building name', '建筑名称')}
            <input id="building-name" name="name" type="text" className={fieldClass} defaultValue={initial.name}
              required maxLength={120} />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <DimensionField name="length" label={t('Length (m)', '长（米）')} initial={initial.length} min={8} max={150} />
            <DimensionField name="width" label={t('Width (m)', '宽（米）')} initial={initial.width} min={8} max={150} />
            <DimensionField name="height" label={t('Height (m)', '高（米）')} initial={initial.height} min={3} max={120}
              inputRef={heightInput} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>
              {t('Building use', '建筑用途')}
              <select id="building-layout" name="layout" className={fieldClass} defaultValue={initial.layout}>
                <option value="office">{t('Office', '办公楼')}</option>
                <option value="apartments">{t('Apartments', '公寓楼')}</option>
              </select>
            </label>
            <DimensionField name="floors" label={t('Floors', '楼层数')} initial={initial.floors} min={1} max={30} step={1}
              placeholder={t('Automatic', '自动')} descriptionId={floorsHelpId} />
          </div>
          <p id={floorsHelpId} className="text-xs text-[var(--text-mid)]">
            {t('Leave floors blank to estimate from the height and building use.', '楼层数可留空，按高度和建筑用途自动估算。')}
          </p>
          <details ref={positionFields} className="panel-flush rounded-lg px-2.5 py-2">
            <summary className="cursor-pointer text-xs font-semibold">{t('Position and orientation', '位置与朝向')}</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <DimensionField name="east" label={t('Center east (m)', '中心东向坐标（米）')} initial={initial.east} />
              <DimensionField name="north" label={t('Center north (m)', '中心北向坐标（米）')} initial={initial.north} />
              <DimensionField name="baseZ" label={t('Base elevation (m)', '底部标高（米）')} initial={initial.baseZ} />
              <DimensionField name="rotationDeg" label={t('Rotation (°)', '旋转角（度）')} initial={initial.rotationDeg ?? 0} />
            </div>
            <p className="mt-2 text-xs text-[var(--text-mid)]">
              {t('At 0°, the long axis points east. Positive angles turn it toward north.', '旋转角为 0° 时，长度方向朝东。正角度向北旋转。')}
            </p>
          </details>
        </fieldset>
        {editing && <p className="text-xs text-[var(--text-mid)]">
          {t('Applying these parameters regenerates the building geometry.', '应用参数后会重新生成整栋建筑的几何。')}
        </p>}
        {validationError ? <p role="alert" className="break-words text-xs text-[var(--bad)]">{validationError}</p>
          : <SceneErrorNotice error={error} operation="building" />}
      </div>
      <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] bg-[var(--ink-800)] px-4 py-3">
        <button type="button" className="btn-quiet cursor-pointer px-3 py-1.5 text-xs" onClick={onCancel}>
          {t('Cancel', '取消')}
        </button>
        <button id="btn-apply-building-generator" type="submit" disabled={busy}
          className="btn-signal inline-flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-60">
          {busy && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
          {busy ? t('Generating…', '正在生成…') : editing ? t('Regenerate', '重新生成') : t('Generate', '生成')}
        </button>
      </footer>
    </form>
  </dialog>;
}
