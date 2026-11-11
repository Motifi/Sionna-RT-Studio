import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChevronDown, Copy, Crosshair, Eye, EyeOff, FileBox, FilePlus2, Layers3, Map as MapIcon,
  MapPin, Move, Pentagon, Plus, Search, ShieldCheck, Square, SquareStack,
  Trash2, TriangleAlert, Undo2, X,
} from 'lucide-react';
import type { SceneInspection, SceneObjectReport } from '../api';
import { useI18n } from '../i18n';
import { withFootprint, type SceneEditor, type SceneLayer, type SceneTool } from '../sceneEditor';
import type { BuildingFootprint, GeoAnchor } from '../types';

const layers: SceneLayer[] = ['building', 'infrastructure', 'terrain', 'water'];
const materials = ['itu_concrete', 'itu_brick', 'itu_glass', 'itu_metal', 'itu_wood',
  'itu_medium_dry_ground', 'itu_wet_ground'];
const button = 'btn-quiet inline-flex min-h-8 items-center justify-center gap-1.5 px-2.5 py-1 text-xs whitespace-nowrap cursor-pointer disabled:cursor-not-allowed';
const activeButton = 'border-[var(--accent)]! bg-[var(--accent-soft)]! text-[var(--accent-deep)]!';
const field = 'rounded-lg border border-[var(--line)] bg-[var(--ink-750)] px-2.5 py-1.5 min-w-0 w-full text-sm';
const menu = 'absolute left-0 top-full z-30 mt-1.5 w-max min-w-44 max-w-[calc(100vw_-_2rem)] rounded-lg border border-[var(--line)] bg-[var(--ink-800)] p-1 shadow-lg';
const menuItem = 'flex min-h-8 w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm cursor-pointer hover:bg-[var(--ink-750)]';
const summary = button + ' list-none [&::-webkit-details-marker]:hidden';
type Translate = ReturnType<typeof useI18n>['t'];

function layerLabel(layer: SceneLayer, t: Translate) {
  return {
    building: t('Physical objects', '物理对象'),
    infrastructure: t('Roads', '道路'),
    terrain: t('Landscape', '绿地'),
    water: t('Water', '水体'),
  }[layer];
}

function objectLabel(object: BuildingFootprint, t: Translate) {
  if (object.name) return object.name;
  if (object.category !== 'building') return object.id;
  const kind = object.kind === 'wall' ? t('Wall', '墙')
    : object.kind === 'mesh' ? t('Mesh', '网格') : t('Building', '建筑');
  return `${kind} ${object.source === 'manual' ? object.id.slice(0, 6) : object.id}`;
}

function statusLabel(status: SceneObjectReport['status'], t: Translate) {
  return {
    physical: t('In solver', '参与求解'),
    visual: t('Display only', '仅显示'),
    skipped: t('Skipped', '已跳过'),
  }[status];
}

function ReportStatus({ report }: { report: SceneObjectReport }) {
  const { t } = useI18n();
  const colors = {
    physical: 'text-[var(--ok)]',
    visual: 'text-[var(--text-mid)]',
    skipped: 'text-[var(--bad)]',
  };
  return <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs ${colors[report.status]}`}>
    {report.issues.length > 0 && <TriangleAlert size={12} aria-hidden="true" />}
    {statusLabel(report.status, t)}
  </span>;
}

interface ToolbarProps {
  editor: SceneEditor;
  onOpenBlank: () => void;
  onUseStarter: () => void;
  osmImport: ReactNode;
  meshImport: ReactNode;
  onToggleInspection: () => void;
  compactControls?: ReactNode;
}

type ImportSource = 'osm' | 'mesh';

export function SceneToolbar({
  editor, onOpenBlank, onUseStarter, osmImport, meshImport, onToggleInspection, compactControls,
}: ToolbarProps) {
  const { t } = useI18n();
  const sourceMenu = useRef<HTMLDetailsElement>(null);
  const drawingMenu = useRef<HTMLDetailsElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [activeImport, setActiveImport] = useState<ImportSource | null>(null);
  const [openedImports, setOpenedImports] = useState({ osm: false, mesh: false });

  useEffect(() => {
    const dismissMenus = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      for (const dropdown of [sourceMenu.current, drawingMenu.current]) {
        if (dropdown?.open && !dropdown.contains(event.target)) dropdown.open = false;
      }
    };
    document.addEventListener('pointerdown', dismissMenus);
    return () => document.removeEventListener('pointerdown', dismissMenus);
  }, []);

  useEffect(() => {
    if (editor.tool === 'select') return;
    const cancelDrawing = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !dialog.current?.open) editor.chooseTool('select');
    };
    document.addEventListener('keydown', cancelDrawing);
    return () => document.removeEventListener('keydown', cancelDrawing);
  }, [editor]);

  useLayoutEffect(() => {
    if (activeImport && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      closeButton.current?.focus();
    }
  }, [activeImport]);

  const closeMenu = (element: HTMLDetailsElement | null, restoreFocus = true) => {
    if (!element) return;
    element.open = false;
    if (restoreFocus) element.querySelector('summary')?.focus();
  };

  const closeOnEscape = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.stopPropagation();
      closeMenu(event.currentTarget);
    }
  };

  const startSource = (action: () => void) => {
    closeMenu(sourceMenu.current);
    action();
  };

  const openImport = (source: ImportSource) => {
    closeMenu(sourceMenu.current, false);
    setOpenedImports(previous => previous[source] ? previous : { ...previous, [source]: true });
    setActiveImport(source);
  };

  const chooseDrawingTool = (tool: SceneTool) => {
    closeMenu(drawingMenu.current);
    editor.setSolverMesh(false);
    if (editor.hiddenLayers.includes('building')) {
      editor.setHiddenLayers(editor.hiddenLayers.filter(layer => layer !== 'building'));
    }
    editor.chooseTool(tool);
  };

  const tools = [
    { tool: 'rectangle', label: t('Rectangle', '矩形建筑'), Icon: Square },
    { tool: 'polygon', label: t('Polygon', '多边形建筑'), Icon: Pentagon },
    { tool: 'wall', label: t('Wall', '墙'), Icon: SquareStack },
  ] as const;
  const instructions = {
    select: '',
    rectangle: editor.draft.length === 0 ? t('Click the first corner on the ground.', '在地面点击第一个角点。')
      : t('Click the opposite corner.', '点击对角点。'),
    polygon: t('Click each vertex. Finish when you have at least three.', '依次点击顶点，至少放置三个后即可完成。'),
    wall: editor.draft.length === 0 ? t('Click the first endpoint on the ground.', '在地面点击第一个端点。')
      : t('Click the second endpoint.', '点击第二个端点。'),
    move: t('Click the new position of the first vertex.', '点击首个顶点的新位置。'),
  };

  return <div className="flex min-w-0 flex-col gap-2">
    <div role="toolbar" aria-label={t('Scene tools', '场景工具')} className="flex flex-wrap items-center gap-1.5">
      <details ref={sourceMenu} onKeyDown={closeOnEscape} className="relative">
        <summary className={summary}><Layers3 size={15} aria-hidden="true" />{t('Scene Source', '场景来源')}<ChevronDown size={12} aria-hidden="true" /></summary>
        <div className={menu}>
          <button type="button" className={menuItem} onClick={() => startSource(onOpenBlank)}>
            <FilePlus2 size={15} aria-hidden="true" />{t('Start blank scene', '从空白场景开始')}
          </button>
          <button id="btn-use-starter-scene" type="button" className={menuItem} onClick={() => startSource(onUseStarter)}>
            <Layers3 size={15} aria-hidden="true" />{t('Use the built-in street scene', '使用内置街区')}
          </button>
          <button type="button" aria-haspopup="dialog" className={menuItem} onClick={() => openImport('osm')}>
            <MapIcon size={15} aria-hidden="true" />{t('Import OpenStreetMap', '导入 OpenStreetMap')}
          </button>
          <button type="button" aria-haspopup="dialog" className={menuItem} onClick={() => openImport('mesh')}>
            <FileBox size={15} aria-hidden="true" />{t('Import physical meshes', '导入物理网格')}
          </button>
        </div>
      </details>
      <details ref={drawingMenu} onKeyDown={closeOnEscape} className="relative">
        <summary className={`${summary} ${editor.tool !== 'select' && editor.tool !== 'move' ? activeButton : ''}`}>
          <Plus size={15} aria-hidden="true" />{t('Add Geometry', '添加几何')}<ChevronDown size={12} aria-hidden="true" />
        </summary>
        <div className={menu}>
          {tools.map(({ tool, label, Icon }) => <button type="button" key={tool} className={menuItem} onClick={() => chooseDrawingTool(tool)}>
            <Icon size={15} aria-hidden="true" />{label}
          </button>)}
        </div>
      </details>
      <button type="button" className={button} disabled={!editor.canUndo} onClick={editor.undo}>
        <Undo2 size={15} aria-hidden="true" />{t('Undo', '撤销')}
      </button>
      {compactControls}
      <button type="button" aria-pressed={editor.solverMesh} className={`${button} ${editor.solverMesh ? activeButton : ''}`}
        onClick={onToggleInspection}>
        <ShieldCheck size={15} aria-hidden="true" />{t('Solver Check', '求解检查')}
      </button>
    </div>
    {editor.tool !== 'select' && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--ink-750)] px-2.5 py-1.5 text-xs">
      <p role="status" className="flex-1 text-[var(--text-mid)]">{instructions[editor.tool]}</p>
      {editor.tool === 'polygon' && <button type="button" className="btn-signal cursor-pointer px-2.5 py-1 disabled:cursor-not-allowed"
        disabled={editor.draft.length < 3} onClick={editor.finish}>{t('Finish polygon', '完成多边形')}</button>}
      <button type="button" className={button} onClick={() => editor.chooseTool('select')}>{t('Cancel', '取消')}</button>
    </div>}
    <dialog ref={dialog} aria-labelledby={dialogTitle} onClose={() => {
      setActiveImport(null);
      sourceMenu.current?.querySelector('summary')?.focus();
    }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--ink-800)] p-0 text-[var(--text-hi)] shadow-xl backdrop:bg-black/35">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--ink-800)] px-4 py-3">
        <h2 id={dialogTitle} className="panel-title">{activeImport === 'osm' ? t('Import OpenStreetMap', '导入 OpenStreetMap')
          : t('Import physical meshes', '导入物理网格')}</h2>
        <button ref={closeButton} type="button" className={button} aria-label={t('Close', '关闭')} onClick={() => dialog.current?.close()}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {openedImports.osm && <div hidden={activeImport !== 'osm'} className="p-4">{osmImport}</div>}
      {openedImports.mesh && <div hidden={activeImport !== 'mesh'} className="p-4">{meshImport}</div>}
    </dialog>
  </div>;
}

interface ObjectsProps {
  editor: SceneEditor;
  objects: BuildingFootprint[];
  inspection: SceneInspection | null;
}

export function SceneObjectList({ editor, objects, inspection, onSelect }: ObjectsProps & { onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const title = useId();
  const reports = useMemo(() => new Map(inspection?.objects.map(report => [report.id, report])), [inspection]);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return layers.map(layer => ({
      layer,
      matches: objects.filter(object => object.category === layer &&
        [objectLabel(object, t), object.id, object.type, object.material].join(' ').toLowerCase().includes(needle)),
    }));
  }, [objects, query, t]);

  return <section aria-labelledby={title} className="panel flex min-h-0 flex-col overflow-hidden">
    <div className="space-y-2.5 border-b border-[var(--line)] p-3">
      <h2 id={title} className="panel-title">{t('Scene objects', '场景对象')}</h2>
      <label className="relative block">
        <span className="sr-only">{t('Find object', '查找对象')}</span>
        <Search size={15} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-mid)]" />
        <input type="search" className={`${field} pl-8`} placeholder={t('Find object', '查找对象')}
          value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <div role="group" aria-label={t('Visible layers', '可见图层')} className="grid grid-cols-2 gap-1.5">
        {layers.map(layer => {
          const visible = !editor.hiddenLayers.includes(layer);
          const Icon = visible ? Eye : EyeOff;
          return <button type="button" key={layer} aria-pressed={visible}
            className={`flex min-h-8 min-w-0 items-center gap-1.5 rounded-md border border-[var(--line)] px-2 py-1 text-left text-xs cursor-pointer hover:bg-[var(--ink-750)] ${visible ? '' : 'text-[var(--text-lo)]'}`}
            onClick={() => editor.setHiddenLayers(visible ? [...editor.hiddenLayers, layer] : editor.hiddenLayers.filter(value => value !== layer))}>
            <Icon size={14} aria-hidden="true" className="shrink-0" />
            {layerLabel(layer, t)}
          </button>;
        })}
      </div>
    </div>
    <div className="min-h-0 max-h-[26rem] overflow-y-auto overscroll-contain md:max-h-none">
      {groups.map(({ layer, matches }) => matches.length > 0 && <div key={layer} className="border-b border-[var(--line-soft)] last:border-b-0">
        <h3 className="sticky top-0 z-1 flex items-center justify-between gap-2 bg-[var(--ink-750)] px-3 py-1.5 text-xs font-semibold text-[var(--text-mid)]">
          {layerLabel(layer, t)}
          <span className="readout">{matches.length}</span>
        </h3>
        <ul className="p-1">
          {matches.map(object => {
            const label = objectLabel(object, t);
            const report = reports.get(object.id);
            return <li key={object.id}>
              <button type="button" aria-current={editor.selected?.id === object.id ? 'true' : undefined} title={label}
                className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm cursor-pointer hover:bg-[var(--ink-750)] aria-[current=true]:bg-[var(--accent-soft)] aria-[current=true]:text-[var(--accent-deep)]"
                onClick={() => onSelect(object.id)}>
                <span className="truncate">{label}</span>
                {report ? <ReportStatus report={report} /> : (
                  <span className="shrink-0 text-xs text-[var(--text-mid)]">
                    {object.category === 'building' ? t('Awaiting check', '待检查') : statusLabel('visual', t)}
                  </span>
                )}
              </button>
            </li>;
          })}
        </ul>
      </div>)}
      {groups.every(group => group.matches.length === 0) && <p className="px-3 py-4 text-sm text-[var(--text-mid)]">
        {objects.length === 0 ? t('Add or import geometry to populate the scene.', '添加或导入几何对象以构建场景。')
          : t('No objects match your search.', '没有匹配的对象。')}
      </p>}
    </div>
  </section>;
}

function Coordinate({ label, value, onCommit, min }: {
  label: string; value: number; onCommit: (value: number) => void; min?: number;
}) {
  const displayed = Number(value.toFixed(4));
  return <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">{label}
    <input key={value} className={field} type="number" step="any" min={min} defaultValue={displayed}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      onBlur={event => {
        const next = event.currentTarget.valueAsNumber;
        if (Number.isFinite(next) && next !== displayed && (min === undefined || next >= min)) onCommit(next);
        else event.currentTarget.value = String(displayed);
      }} />
  </label>;
}

function AdvancedGeometry({ object, editor, anchor }: { object: BuildingFootprint; editor: SceneEditor; anchor: GeoAnchor }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const provenance = {
    template: t('Built-in scene', '内置场景'), osm: 'OpenStreetMap', manual: t('Manual', '手动'),
    import: t('Mesh import', '网格导入'), tag: t('Source tag', '来源标签'), levels: t('Floor count', '楼层数'), estimated: t('Estimated', '估算'),
  };
  const vertices = object.enuPoints;
  const updateVertices = (points: BuildingFootprint['enuPoints']) => editor.update(withFootprint(object, points, anchor));

  return <details className="panel-flush px-2.5 py-2 text-xs" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold">{t('Advanced geometry', '高级几何')}</summary>
    {open && <div className="mt-2 space-y-2">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[var(--text-mid)]">
        <dt>{t('Object ID', '对象编号')}</dt><dd className="readout break-all">{object.id}</dd>
        {object.source && <><dt>{t('Source', '来源')}</dt><dd>{provenance[object.source]}</dd></>}
        {object.heightSource && <><dt>{t('Height source', '高度来源')}</dt><dd>{provenance[object.heightSource]}</dd></>}
        {object.materialSource && <><dt>{t('Material source', '材质来源')}</dt><dd>{provenance[object.materialSource]}</dd></>}
        {object.mesh && <><dt>{t('Mesh triangles', '网格三角形')}</dt><dd className="readout">{object.mesh.triangles.length / 3}</dd></>}
      </dl>
      {object.category === 'building' && object.kind !== 'mesh' && <>
        <h3 className="font-semibold">{object.kind === 'wall' ? t('Wall endpoints (ENU m)', '墙端点（ENU 米）')
          : t('Footprint vertices (ENU m)', '轮廓顶点（ENU 米）')}</h3>
        <div className="space-y-1.5">
          {vertices.map((point, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-1">
            {(['x', 'y'] as const).map(axis => <div key={axis} className="min-w-0">
              <Coordinate label={`${index + 1} ${axis === 'x' ? 'E' : 'N'}`} value={point[axis]}
                onCommit={value => updateVertices(vertices.map((p, i) => i === index ? { ...p, [axis]: value } : p))} />
            </div>)}
            {object.kind !== 'wall' && <button type="button" className={button} aria-label={t(`Remove vertex ${index + 1}`, `删除顶点 ${index + 1}`)}
              disabled={vertices.length <= 3} onClick={() => updateVertices(vertices.filter((_, i) => i !== index))}>−</button>}
          </div>)}
        </div>
        {object.kind !== 'wall' && vertices.length >= 2 && <button type="button" className={button} onClick={() => {
          const [a, b] = vertices;
          updateVertices([a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 }, ...vertices.slice(1)]);
        }}>{t('Insert vertex after 1', '在顶点 1 后插入')}</button>}
      </>}
      {object.rawTags && Object.keys(object.rawTags).length > 0 && <details>
        <summary className="cursor-pointer font-semibold">{t('Original tags', '原始标签')}</summary>
        <dl className="mt-1 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-2 gap-y-1 break-words">
          {Object.entries(object.rawTags).map(([key, value]) => <div key={key} className="contents">
            <dt className="text-[var(--text-mid)]">{key}</dt><dd>{value}</dd>
          </div>)}
        </dl>
      </details>}
    </div>}
  </details>;
}

function SolverReport({ inspection, error, objects, onLocate }: {
  inspection: SceneInspection | null; error: string; objects: BuildingFootprint[]; onLocate: (id: string) => void;
}) {
  const { t } = useI18n();
  if (error) return <p role="status" className="break-words rounded-lg border border-[var(--line)] bg-[var(--accent-soft)] p-2.5 text-xs text-[var(--bad)]">{error}</p>;
  if (!inspection) return <p role="status" className="text-sm text-[var(--text-mid)]">{t('Checking solver geometry…', '正在检查求解几何…')}</p>;

  const totals = { physical: 0, visual: 0, skipped: 0 };
  const issues: SceneObjectReport[] = [];
  for (const report of inspection.objects) {
    totals[report.status]++;
    if (report.issues.length || report.status === 'skipped') issues.push(report);
  }
  const byId = new Map(objects.map(object => [object.id, object]));

  return <div className="space-y-2.5">
    <dl className="grid grid-cols-3 gap-1 text-center text-xs">
      {(Object.keys(totals) as Array<keyof typeof totals>).map(status => <div key={status} className="panel-flush px-1.5 py-2">
        <dt className="text-[var(--text-mid)]">{statusLabel(status, t)}</dt>
        <dd className="readout text-base font-semibold">{totals[status]}</dd>
      </div>)}
    </dl>
    <p title={inspection.sceneId} className="text-xs text-[var(--text-mid)]">
      {t('Solver scene ID', '求解场景 ID')} <span className="readout text-[var(--text-hi)]">{inspection.sceneId.slice(0, 12)}</span>
    </p>
    {issues.length === 0 ? <p className="text-sm text-[var(--ok)]">{t('No issues reported.', '求解器未报告问题。')}</p>
      : <ul className="space-y-2">
        {issues.map(report => {
          const object = byId.get(report.id);
          const label = object ? objectLabel(object, t) : report.id;
          return <li key={report.id} className="panel-flush space-y-1 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <strong className="min-w-0 truncate text-xs" title={label}>{label}</strong>
              <button type="button" className={button} aria-label={t(`Locate ${label}`, `定位 ${label}`)}
                onClick={() => onLocate(report.id)}><MapPin size={13} aria-hidden="true" />{t('Locate', '定位')}</button>
            </div>
            <ReportStatus report={report} />
            {report.issues.length > 0 && <ul className="space-y-1 break-words text-xs text-[var(--text-mid)]">
              {report.issues.map((issue, index) => <li key={index}>{issue}</li>)}
            </ul>}
          </li>;
        })}
      </ul>}
  </div>;
}

interface InspectorProps extends ObjectsProps {
  anchor: GeoAnchor;
  inspectionError: string;
  onLocate: (id: string) => void;
  materialLibrary: ReactNode;
}

export function SceneInspector({ editor, objects, anchor, inspection, inspectionError, onLocate, materialLibrary }: InspectorProps) {
  const { t } = useI18n();
  const title = useId();
  const selected = editor.selected;
  const report = inspection?.objects.find(item => item.id === selected?.id);
  const selectedIssues = editor.solverMesh ? [] : (report?.issues ?? selected?.importIssues ?? []);

  return <section aria-labelledby={title} className="panel min-h-0 overflow-y-auto overscroll-contain">
    <h2 id={title} className="panel-title border-b border-[var(--line)] px-3 py-2.5">
      {editor.solverMesh ? t('Solver Check', '求解检查') : t('Inspector', '属性')}
    </h2>
    <div className="space-y-3 p-3">
      {editor.solverMesh && <SolverReport inspection={inspection} error={inspectionError} objects={objects} onLocate={onLocate} />}
      {selected ? <div key={selected.id} className={`space-y-2.5 ${editor.solverMesh ? 'border-t border-[var(--line)] pt-3' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h3 className="truncate text-sm font-semibold" title={objectLabel(selected, t)}>{objectLabel(selected, t)}</h3>
          {report && <ReportStatus report={report} />}
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={button} onClick={() => onLocate(selected.id)}>
            <Crosshair size={14} aria-hidden="true" />{t('Locate', '定位')}
          </button>
          <button type="button" className={button} disabled={selected.enuPoints.length === 0} aria-pressed={editor.tool === 'move'}
            onClick={() => {
              editor.setSolverMesh(false);
              if (editor.hiddenLayers.includes(selected.category)) {
                editor.setHiddenLayers(editor.hiddenLayers.filter(layer => layer !== selected.category));
              }
              editor.chooseTool('move');
            }}><Move size={14} aria-hidden="true" />{t('Move', '移动')}</button>
          <button type="button" className={button} onClick={editor.duplicate}><Copy size={14} aria-hidden="true" />{t('Duplicate', '复制')}</button>
          <button type="button" className={button + ' text-[var(--bad)]!'} onClick={editor.remove}>
            <Trash2 size={14} aria-hidden="true" />{t('Delete', '删除')}
          </button>
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">{t('Object name', '对象名称')}
          <input type="text" className={field} key={selected.name} defaultValue={selected.name ?? ''}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            onBlur={event => {
              if (event.currentTarget.value !== (selected.name ?? '')) editor.update({ ...selected, name: event.currentTarget.value });
            }} />
        </label>
        {selected.category === 'building' && <>
          <div className="grid grid-cols-2 gap-2">
            {selected.kind !== 'mesh' && <Coordinate label={t('Height (m)', '高度（米）')} value={selected.height} min={0.01}
              onCommit={height => editor.update({ ...selected, height, heightSource: 'manual' })} />}
            <Coordinate label={t('Base elevation (m)', '底部标高（米）')} value={selected.baseZ ?? 0}
              onCommit={baseZ => editor.update({ ...selected, baseZ })} />
          </div>
          <label className="flex flex-col gap-1 text-xs font-medium">{t('Radio material', '无线材质')}
            <select className={field} value={selected.material} onChange={event => editor.update({
              ...selected, material: event.currentTarget.value, materialSource: 'manual',
            })}>
              {!materials.includes(selected.material) && <option>{selected.material}</option>}
              {materials.map(material => <option key={material}>{material}</option>)}
            </select>
          </label>
          {report?.material && <p className="text-xs text-[var(--text-mid)]">
            {t('Material used by solver', '求解器实际使用的材质')} <span className="readout">{report.material}</span>
          </p>}
        </>}
        <AdvancedGeometry object={selected} editor={editor} anchor={anchor} />
        {selectedIssues.length > 0 && <ul className="space-y-1 break-words text-xs text-[var(--warn)]">
          {selectedIssues.map((issue, index) => <li key={index}>{issue}</li>)}
        </ul>}
      </div> : !editor.solverMesh && <p className="text-sm text-[var(--text-mid)]">
        {t('Select a scene object to edit its properties.', '选择场景对象以编辑属性。')}
      </p>}
      <details className="panel-flush px-2.5 py-2">
        <summary className="cursor-pointer text-sm font-semibold">{t('Material library', '材质库')}</summary>
        <div className="mt-2">{materialLibrary}</div>
      </details>
    </div>
  </section>;
}
