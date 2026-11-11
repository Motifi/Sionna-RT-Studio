import { useState, type FormEvent } from 'react';
import { importMesh, type MeshImportResult } from '../api';
import { useI18n } from '../i18n';
import type { BuildingFootprint } from '../types';

interface Props {
  online: boolean;
  onImport: (objects: BuildingFootprint[], replace: boolean) => void;
}

const field = 'min-h-9 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--ink-750)] px-2.5 py-1.5 text-sm';
const materials = ['itu_concrete', 'itu_brick', 'itu_glass', 'itu_wood', 'itu_metal'];

export function MeshImportPanel({ online, onImport }: Props) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [axes, setAxes] = useState('enu');
  const [scale, setScale] = useState('1');
  const [material, setMaterial] = useState('itu_concrete');
  const [replace, setReplace] = useState(false);
  const [review, setReview] = useState<MeshImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const numericScale = Number(scale);
  const canInspect = online && file !== null && numericScale >= 0.000001 && numericScale <= 1_000_000;

  const clearReview = () => {
    setReview(null);
    setError('');
    setAppliedCount(null);
  };

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!canInspect || !file || busy) return;
    clearReview();
    setBusy(true);
    try {
      setReview(await importMesh(file, axes, numericScale, material));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-3">
    <p className="text-sm text-[var(--text-mid)]">{t(
      'PLY, OBJ or a Mitsuba ZIP with one scene XML and referenced meshes. Meshes are saved with the project.',
      '支持 PLY、OBJ，或包含一份场景 XML 和引用网格的 Mitsuba ZIP。网格随项目保存。',
    )}</p>
    <form onSubmit={inspect}>
      <fieldset disabled={busy} className="grid gap-3 text-xs sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 font-medium sm:col-span-2">{t('Mesh file', '网格文件')}
          <input type="file" accept=".ply,.obj,.zip" className={field + ' file:mr-2 file:cursor-pointer file:font-semibold'}
            onChange={event => { setFile(event.target.files?.[0] ?? null); clearReview(); }} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 font-medium">{t('Source coordinate axes', '源坐标轴')}
          <select className={field} value={axes} onChange={event => { setAxes(event.target.value); clearReview(); }}>
            <option value="enu">{t('Z up · X east, Y north', 'Z 朝上 · X 东，Y 北')}</option>
            <option value="y-up">{t('Y up · X east, −Z north', 'Y 朝上 · X 东，−Z 北')}</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 font-medium">{t('Meters per source unit', '每源单位对应的米数')}
          <input type="number" step="any" min="0.000001" max="1000000" className={field} value={scale}
            onChange={event => { setScale(event.target.value); clearReview(); }} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 font-medium">{t('Default radio material', '默认无线材质')}
          <select className={field} value={material} onChange={event => { setMaterial(event.target.value); clearReview(); }}>
            {materials.map(id => <option key={id}>{id}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 font-medium">{t('Import mode', '导入方式')}
          <select className={field} value={replace ? 'replace' : 'merge'} onChange={event => setReplace(event.target.value === 'replace')}>
            <option value="merge">{t('Merge new objects', '合并新对象')}</option>
            <option value="replace">{t('Replace scene', '替换场景')}</option>
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <button type="submit" className="btn-quiet min-h-9 cursor-pointer px-3 py-1.5 text-sm disabled:cursor-not-allowed"
            disabled={!canInspect || busy}>{busy ? t('Inspecting…', '检查中…') : t('Inspect import', '检查导入')}</button>
          {!online && <p className="text-[var(--text-mid)]">{t('Mesh conversion requires the local solver service.', '网格转换需要本机求解服务。')}</p>}
        </div>
      </fieldset>
    </form>
    {error && <p role="alert" className="rounded-lg bg-[var(--accent-soft)] p-2.5 text-xs text-[var(--bad)]">{error}</p>}
    {review && <div className="panel-flush space-y-2.5 p-3 text-xs">
      <p className="font-semibold">{t('Vertices', '顶点')} <span className="readout">{review.vertexCount}</span>
        {' · '}{t('Triangles', '三角形')} <span className="readout">{review.triangleCount}</span></p>
      <ul className="max-h-40 divide-y divide-[var(--line)] overflow-y-auto">
        {review.objects.map(object => <li key={object.id} className="space-y-1 break-words py-2">
          <p className="font-semibold">{object.name || object.id} · {object.material}</p>
          {object.rawTags?.boundsMinENU && object.rawTags.boundsMaxENU && <p className="readout text-[var(--text-mid)]">
            ENU m {object.rawTags.boundsMinENU} → {object.rawTags.boundsMaxENU}
          </p>}
          {object.importIssues?.map((issue, index) => <p key={index} className="text-[var(--warn)]">{issue}</p>)}
        </li>)}
      </ul>
      {review.issues.map((issue, index) => <p key={index} className="text-[var(--warn)]">{issue}</p>)}
      <button type="button" className="btn-signal min-h-9 cursor-pointer px-3 py-1.5 text-sm" onClick={() => {
        onImport(review.objects, replace);
        setAppliedCount(review.objects.length);
        setReview(null);
      }}>{t('Apply mesh import', '应用网格导入')}</button>
    </div>}
    {appliedCount !== null && <p role="status" className="text-sm text-[var(--ok)]">
      {t(`Imported ${appliedCount} mesh ${appliedCount === 1 ? 'object' : 'objects'}.`, `已导入 ${appliedCount} 个网格对象。`)}
    </p>}
  </div>;
}
