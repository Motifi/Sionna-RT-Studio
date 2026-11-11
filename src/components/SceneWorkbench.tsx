import { useState } from 'react';
import type { SceneInspection } from '../api';
import { useI18n } from '../i18n';
import { withFootprint, type SceneEditor, type SceneLayer, type SceneTool } from '../sceneEditor';
import type { BuildingFootprint, GeoAnchor } from '../types';

const layers: SceneLayer[] = ['building', 'infrastructure', 'terrain', 'water'];
const materials = ['itu_concrete', 'itu_brick', 'itu_glass', 'itu_metal', 'itu_wood',
  'itu_medium_dry_ground', 'itu_wet_ground'];
const button = 'rounded border border-[var(--line)] px-2 py-1 text-xs cursor-pointer disabled:opacity-45 aria-pressed:bg-slate-200';
const field = 'rounded border border-[var(--line)] bg-transparent px-2 py-1 min-w-0 w-full';

interface Props {
  editor: SceneEditor;
  objects: BuildingFootprint[];
  anchor: GeoAnchor;
  inspection: SceneInspection | null;
  inspectionError: string;
}

function Coordinate({ label, value, onCommit, min }: {
  label: string; value: number; onCommit: (value: number) => void; min?: number;
}) {
  return <label className="text-xs">{label}
    <input key={value} className={field} type="number" step="any" min={min} defaultValue={Number(value.toFixed(4))}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      onBlur={event => {
        const next = event.currentTarget.valueAsNumber;
        if (Number.isFinite(next) && next !== Number(value.toFixed(4)) && (min === undefined || next >= min)) {
          onCommit(next);
        } else {
          event.currentTarget.value = String(Number(value.toFixed(4)));
        }
      }} />
  </label>;
}

export function SceneWorkbench({ editor, objects, anchor, inspection, inspectionError }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const selected = editor.selected;
  const reports = new Map(inspection?.objects.map(report => [report.id, report]));
  const toolNames: Record<SceneTool, string> = {
    select: t('Select', '选择'), rectangle: t('Rectangle', '矩形建筑'), polygon: t('Polygon', '多边形建筑'),
    wall: t('Wall', '墙'), move: t('Move', '移动'),
  };
  const layerNames = {
    building: t('Physical objects', '物理对象'), infrastructure: t('Roads', '道路'),
    terrain: t('Landscape', '绿地'), water: t('Water', '水体'),
  };
  const label = (object: BuildingFootprint) => object.name || (object.source === 'manual'
    ? (object.kind === 'wall' ? t('Wall', '墙') : t('Building', '建筑')) + ' ' + object.id.slice(0, 6)
    : object.id);
  const options = objects.filter(object => label(object).toLowerCase().includes(query.trim().toLowerCase()));
  const report = selected && reports.get(selected.id);
  const status = (object: BuildingFootprint) => {
    if (object.category !== 'building') return t('Display only', '仅显示');
    const state = reports.get(object.id)?.status;
    if (state === 'physical') return t('In solver', '参与求解');
    if (state === 'skipped') return t('Skipped', '已跳过');
    return t('Awaiting inspection', '待检查');
  };

  return (
    <section className="panel p-4 space-y-3">
      <h2 className="panel-title">{t('Scene editor', '场景编辑')}</h2>
      <div className="flex flex-wrap gap-1">
        <button className={button} aria-pressed={!editor.solverMesh} onClick={() => editor.setSolverMesh(false)}>{t('Appearance', '普通外观')}</button>
        <button className={button} aria-pressed={editor.solverMesh} onClick={() => editor.setSolverMesh(true)}>{t('Solver mesh', '求解网格')}</button>
        <button className={button} aria-pressed={editor.top} onClick={() => editor.setTop(!editor.top)}>{t('Top view', '俯视')}</button>
        <button className={button} disabled={!editor.canUndo} onClick={editor.undo}>{t('Undo', '撤销')}</button>
      </div>
      <div className="flex flex-wrap gap-1">
        {(Object.keys(toolNames) as SceneTool[]).map(tool =>
          <button key={tool} className={button} aria-pressed={editor.tool === tool}
            disabled={tool === 'move' && !selected?.enuPoints.length} onClick={() => editor.chooseTool(tool)}>{toolNames[tool]}</button>,
        )}
      </div>
      {editor.tool !== 'select' && <div className="flex flex-wrap gap-2 items-center text-xs">
        <span>{editor.tool === 'move' ? t('Click the new position of the first vertex.', '点击首个顶点的新位置。')
          : editor.tool === 'polygon' ? t('Click vertices, then finish.', '依次点击顶点，然后完成。')
          : t('Click two points on the ground.', '在地面点击两个点。')}</span>
        {editor.tool === 'polygon' && <button className={button} disabled={editor.draft.length < 3} onClick={editor.finish}>{t('Finish polygon', '完成多边形')}</button>}
        <button className={button} onClick={() => editor.chooseTool('select')}>{t('Cancel', '取消')}</button>
      </div>}
      <div className="flex flex-wrap gap-2 text-xs">
        {layers.map(layer => <label key={layer} className="flex gap-1 items-center">
          <input type="checkbox" checked={!editor.hiddenLayers.includes(layer)} onChange={event =>
            editor.setHiddenLayers(event.target.checked ? editor.hiddenLayers.filter(value => value !== layer) : [...editor.hiddenLayers, layer])} />
          {layerNames[layer]}
        </label>)}
      </div>
      <label className="block text-xs">{t('Find object', '查找对象')}
        <input className={field} value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <select className={field} aria-label={t('Scene objects', '场景对象')} size={Math.max(2, Math.min(6, options.length))}
        value={selected?.id ?? ''} onChange={event => { editor.select(event.target.value); editor.chooseTool('select'); }}>
        {options.map(object => <option key={object.id} value={object.id}>
          {label(object)} · {status(object)}{object.materialSource === 'estimated' ? t(' · estimated material', ' · 估算材质') : ''}{reports.get(object.id)?.issues.length ? ' ⚠' : ''}
        </option>)}
      </select>
      {inspection && <p className="text-xs text-[var(--text-lo)]" title={inspection.sceneId}>
        {t('Solver ground · concrete · scene', '求解地面 · 混凝土 · 场景')} {inspection.sceneId.slice(0, 12)}
      </p>}
      {inspectionError && <p role="status" className="text-xs text-[var(--bad)]">{inspectionError}</p>}
      {selected && <div key={selected.id} className="space-y-2">
        <div className="text-xs">{status(selected)}{report?.material ? ` · ${report.material}` : ''}</div>
        <div className="flex gap-1">
          <button className={button} onClick={editor.duplicate}>{t('Duplicate', '复制')}</button>
          <button className={button} onClick={editor.remove}>{t('Delete', '删除')}</button>
        </div>
        <label className="block text-xs">{t('Object name', '对象名称')}
          <input className={field} key={selected.name} defaultValue={selected.name ?? ''}
            onBlur={event => { if (event.target.value !== (selected.name ?? '')) editor.update({ ...selected, name: event.target.value }); }} />
        </label>
        {selected.category === 'building' && <>
          <div className="grid grid-cols-2 gap-2">
            {selected.kind !== 'mesh' && <Coordinate label={t('Height (m)', '高度（米）')} value={selected.height} min={0.01}
              onCommit={height => editor.update({ ...selected, height, heightSource: 'manual' })} />}
            <Coordinate label={t('Base elevation (m)', '底部标高（米）')} value={selected.baseZ ?? 0}
              onCommit={baseZ => editor.update({ ...selected, baseZ })} />
          </div>
          <label className="block text-xs">{t('Radio material', '无线材质')}
            <select className={field} value={selected.material} onChange={event => editor.update({ ...selected, material: event.target.value, materialSource: 'manual' })}>
              {!materials.includes(selected.material) && <option>{selected.material}</option>}
              {materials.map(material => <option key={material}>{material}</option>)}
            </select>
          </label>
          {selected.kind !== 'mesh' && <details>
            <summary className="cursor-pointer text-xs">{t('Footprint vertices · ENU meters', '轮廓顶点 · ENU 米')}</summary>
            {selected.enuPoints.map((point, index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-1">
              {(['x', 'y'] as const).map(axis => <div key={axis}><Coordinate label={`${index + 1} ${axis === 'x' ? 'E' : 'N'}`} value={point[axis]}
                onCommit={value => editor.update(withFootprint(selected, selected.enuPoints.map((p, i) => i === index ? { ...p, [axis]: value } : p), anchor))} /></div>)}
              <button className={button} aria-label={t('Remove vertex', '删除顶点')} disabled={selected.kind === 'wall' || selected.enuPoints.length <= 3}
                onClick={() => editor.update(withFootprint(selected, selected.enuPoints.filter((_, i) => i !== index), anchor))}>−</button>
            </div>)}
            {selected.kind !== 'wall' && selected.enuPoints.length >= 2 && <button className={button} onClick={() => {
              const [a, b] = selected.enuPoints;
              editor.update(withFootprint(selected, [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 }, ...selected.enuPoints.slice(1)], anchor));
            }}>{t('Insert vertex after 1', '在顶点 1 后插入')}</button>}
          </details>}
        </>}
        {selected.source && <p className="text-xs">
          {t('Source', '来源')} {selected.source} · {t('Height', '高度')} {selected.heightSource ?? '—'} · {t('Material', '材质')} {selected.materialSource ?? '—'}
        </p>}
        {selected.rawTags && <details className="text-xs">
          <summary>{t('Original tags', '原始标签')}</summary>
          {Object.entries(selected.rawTags).map(([key, value]) => <p key={key} className="break-all">{key} = {value}</p>)}
        </details>}
        {(report?.issues ?? selected.importIssues ?? []).map((issue, index) => <p key={index} className="text-xs text-[var(--bad)]">{issue}</p>)}
      </div>}
    </section>
  );
}
