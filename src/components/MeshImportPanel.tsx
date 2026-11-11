import { useState } from 'react';
import { importMesh, type MeshImportResult } from '../api';
import { useI18n } from '../i18n';
import type { BuildingFootprint } from '../types';

interface Props {
  online: boolean;
  onImport: (objects: BuildingFootprint[], replace: boolean) => void;
}

const field = 'w-full rounded border border-[var(--line)] px-2 py-1';

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
  const inspect = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setReview(await importMesh(file, axes, Number(scale), material));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return <details className="panel p-3">
    <summary className="cursor-pointer font-semibold">{t('Import physical meshes', '导入物理网格')}</summary>
    <p className="mt-2 text-xs text-[var(--text-lo)]">{t(
      'PLY, OBJ or a Mitsuba ZIP with one scene XML and referenced meshes. Meshes are embedded in the project.',
      '支持 PLY、OBJ，或包含一份场景 XML 和引用网格的 Mitsuba ZIP。网格随项目文件保存。',
    )}</p>
    <fieldset disabled={busy} className="mt-2 space-y-2 text-xs">
      <label className="block">{t('Mesh file', '网格文件')}
        <input type="file" accept=".ply,.obj,.zip" className={field}
          onChange={event => { setFile(event.target.files?.[0] ?? null); setReview(null); }} />
      </label>
      <label className="block">{t('Source coordinate axes', '源坐标轴')}
        <select className={field} value={axes} onChange={event => { setAxes(event.target.value); setReview(null); }}>
          <option value="enu">{t('Z up · X east, Y north', 'Z 朝上 · X 东，Y 北')}</option>
          <option value="y-up">{t('Y up · X east, −Z north', 'Y 朝上 · X 东，−Z 北')}</option>
        </select>
      </label>
      <label className="block">{t('Meters per source unit', '每源单位对应的米数')}
        <input type="number" step="any" min="0.000001" max="1000000" className={field} value={scale}
          onChange={event => { setScale(event.target.value); setReview(null); }} />
      </label>
      <label className="block">{t('Default radio material', '默认无线材质')}
        <select className={field} value={material} onChange={event => { setMaterial(event.target.value); setReview(null); }}>
          {['itu_concrete', 'itu_brick', 'itu_glass', 'itu_wood', 'itu_metal'].map(id => <option key={id}>{id}</option>)}
        </select>
      </label>
      <label className="block">{t('Import mode', '导入方式')}
        <select className={field} value={replace ? 'replace' : 'merge'} onChange={event => setReplace(event.target.value === 'replace')}>
          <option value="merge">{t('Merge new objects', '合并新对象')}</option>
          <option value="replace">{t('Replace scene', '替换场景')}</option>
        </select>
      </label>
      <button className="btn-signal rounded px-2 py-1 disabled:opacity-50"
        disabled={!online || !file || !(Number(scale) >= 0.000001 && Number(scale) <= 1_000_000)}
        onClick={inspect}>{busy ? t('Inspecting…', '检查中…') : t('Inspect import', '检查导入')}</button>
      {!online && <p>{t('Mesh conversion requires the local solver service.', '网格转换需要本机求解服务。')}</p>}
    </fieldset>
    {error && <p role="alert" className="mt-2 text-xs text-[var(--bad)]">{error}</p>}
    {review && <div className="mt-2 space-y-2 text-xs">
      <p>{t('Vertices', '顶点')} {review.vertexCount} · {t('Triangles', '三角形')} {review.triangleCount}</p>
      <ul className="max-h-40 overflow-y-auto">
        {review.objects.map(object => <li key={object.id} className="mb-2">
          <p>{object.name} · {object.material}</p>
          <p>ENU m {object.rawTags?.boundsMinENU} → {object.rawTags?.boundsMaxENU}</p>
          {object.importIssues?.map(issue => <p key={issue}>{issue}</p>)}
        </li>)}
      </ul>
      {review.issues.map(issue => <p key={issue}>{issue}</p>)}
      <button className="btn-signal rounded px-2 py-1" onClick={() => { onImport(review.objects, replace); setReview(null); }}>
        {t('Apply mesh import', '应用网格导入')}
      </button>
    </div>}
  </details>;
}
