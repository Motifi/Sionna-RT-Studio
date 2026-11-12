import type { LocalizedText } from '../i18n';
import type { BuildingFootprint } from '../types';
import { radioMaterialLabel } from './radioLabels';

type Translate = (...text: LocalizedText) => string;
type SceneObject = Pick<BuildingFootprint, 'id' | 'name' | 'source' | 'geometrySource' | 'buildingSpec' | 'floor' | 'type'>;

const starterNames = new Map<string, LocalizedText>([
  ['starter-library', ['Library', '图书馆']],
  ['starter-workshop', ['Workshop', '工坊']],
  ['starter-archives', ['Archives', '档案馆']],
  ['starter-exchange', ['Exchange', '交易中心']],
  ['starter-research-lab', ['Research Lab', '研究实验楼']],
  ['starter-studio', ['Studio', '工作室']],
  ['starter-residences', ['Residences', '住宅楼']],
  ['starter-hotel', ['Hotel', '酒店']],
  ['starter-depot', ['Depot', '仓库']],
  ['starter-market-hall', ['Market Hall', '市场大厅']],
  ['starter-market-annex', ['Market Annex', '市场附楼']],
  ['starter-garden-wall', ['Garden Wall', '花园围墙']],
  ['starter-junction', ['Junction', '交叉路口']],
  ['starter-avenue-west', ['Campus Avenue', '校园大道']],
  ['starter-avenue-east', ['Campus Avenue', '校园大道']],
  ['starter-lane-north', ['Library Lane', '图书馆路']],
  ['starter-lane-south', ['Library Lane', '图书馆路']],
  ['starter-north-garden', ['North Garden', '北花园']],
  ['starter-market-garden', ['Market Garden', '市场花园']],
]);

const foundryTitle: LocalizedText = ['Foundry Avenue', '铸造大道'];
const terrainSource: LocalizedText = ['Synthetic continuous ENU terrain', '合成连续 ENU 地形'];
const sidewalkSource: LocalizedText = ['Synthetic sloped concrete sidewalk', '合成坡面混凝土人行道'];
const envelopeSource: LocalizedText = ['Synthetic building envelope with decorative glazing', '带装饰玻璃的合成建筑围护结构'];
const treeSource: LocalizedText = ['Synthetic canopy ellipsoid for segment attenuation', '用于路径衰减的树冠椭球模型'];

const foundryObjects = new Map<string, { name: LocalizedText; geometry: LocalizedText }>([
  ['avenue', { name: foundryTitle, geometry: ['Synthetic sloped pavement', '合成坡道路面'] }],
  ['sidewalk-north', { name: ['North sidewalk', '北侧人行道'], geometry: sidewalkSource }],
  ['sidewalk-south', { name: ['South sidewalk', '南侧人行道'], geometry: sidewalkSource }],
  ['ground-north-west', { name: ['North West ground', '西北地面'], geometry: terrainSource }],
  ['ground-exchange', { name: ['Exchange ground', '交易中心地面'], geometry: terrainSource }],
  ['ground-north-east', { name: ['North East ground', '东北地面'], geometry: terrainSource }],
  ['ground-south-park', { name: ['South Park ground', '南侧公园地面'], geometry: terrainSource }],
  ['ground-south-east', { name: ['South East ground', '东南地面'], geometry: terrainSource }],
  ['street-markings', {
    name: ['Crosswalk, lane markings and curbs', '斑马线、车道标线和路缘'],
    geometry: ['Procedural street detail', '自动生成的道路细节'],
  }],
  ['courtyard-paving', {
    name: ['Park paths and studio forecourt', '公园步道和工作室前庭'],
    geometry: ['Procedural landscape paving', '自动生成的景观铺装'],
  }],
  ['street-fixtures', {
    name: ['Lighting, benches and bollards', '路灯、长椅和路桩'],
    geometry: ['Procedural streetscape detail', '自动生成的街道设施'],
  }],
  ['exchange-slab', {
    name: ['Exchange · entry slab', '交易中心 · 入口楼板'],
    geometry: ['Synthetic concrete slab', '合成混凝土楼板'],
  }],
  ['exchange-shell', {
    name: ['Exchange · stone façade', '交易中心 · 石材外立面'],
    geometry: ['Synthetic façade piers and exterior walls', '合成立面墙柱和外墙'],
  }],
  ['exchange-ramp', {
    name: ['Exchange · entrance ramp', '交易中心 · 入口坡道'],
    geometry: ['Synthetic concrete ramp from sidewalk to lobby slab', '连接人行道与大厅楼板的合成混凝土坡道'],
  }],
  ['exchange-entry-glass', {
    name: ['Exchange · glazing and open entry', '交易中心 · 玻璃与开放入口'],
    geometry: ['Synthetic single-sided RF glazing panels with an open doorway', '带开放门洞的合成单面玻璃射频网格'],
  }],
  ['exchange-partitions', {
    name: ['Exchange · lobby and rooms', '交易中心 · 大厅与房间'],
    geometry: ['Synthetic full-height masonry partitions and door openings', '带门洞的合成通高砌体隔墙'],
  }],
  ['exchange-fittings', {
    name: ['Exchange · reception desk and furnishings', '交易中心 · 前台与家具'],
    geometry: ['Procedural interior fixtures', '自动生成的室内设施'],
  }],
  ['exchange-upper', {
    name: ['Exchange · second-floor slab and partitions', '交易中心 · 二层楼板与隔墙'],
    geometry: ['Synthetic second-floor slab, exterior and interior walls', '合成二层楼板、外墙和内墙'],
  }],
  ['exchange-upper-glass', {
    name: ['Exchange · upper curtain wall', '交易中心 · 二层玻璃幕墙'],
    geometry: ['Synthetic curtain glazing', '合成玻璃幕墙'],
  }],
  ['exchange-roof', {
    name: ['Exchange · roof and rooftop equipment', '交易中心 · 屋顶与屋面设备'],
    geometry: ['Synthetic roof slab with decorative rooftop equipment', '带装饰设备的合成屋面板'],
  }],
  ['warehouse', { name: ['Kiln Warehouse', '窑厂仓库'], geometry: envelopeSource }],
  ['workshop', { name: ['Foundry Workshop', '铸造工坊'], geometry: envelopeSource }],
  ['design-center', { name: ['Design Center', '设计中心'], geometry: envelopeSource }],
  ['studio-annex', { name: ['Studio Annex', '工作室附楼'], geometry: envelopeSource }],
  ['park-pavilion', { name: ['Park Pavilion', '公园展亭'], geometry: envelopeSource }],
]);

const buildingParts = new Map<string, LocalizedText>([
  ['generated_facade', ['Façade', '外立面']],
  ['generated_glazing', ['Windows', '窗户']],
  ['generated_trim', ['Window and door frames', '门窗框']],
  ['generated_slab', ['Floor slab', '楼板']],
  ['generated_partition', ['Rooms and corridor', '房间与走廊']],
  ['generated_stair', ['Stairs and landing', '楼梯与平台']],
  ['generated_entry', ['Entrance canopy', '入口雨篷']],
  ['generated_roof_equipment', ['Rooftop equipment', '屋面设备']],
]);

function foundryObject(object: SceneObject) {
  const builtIn = foundryObjects.get(object.id);
  if (builtIn && object.geometrySource === builtIn.geometry[0]) return builtIn;
  const tree = /^tree-(0[1-9]|1[01])$/.exec(object.id);
  if (tree && object.geometrySource === treeSource[0]) {
    const number = Number(tree[1]);
    const name: LocalizedText = number <= 3
      ? [`Avenue tree ${number}`, `行道树 ${number}`]
      : [`Courtyard tree ${number}`, `庭院树 ${number}`];
    return { name, geometry: treeSource };
  }
}

export function sceneFloorLabel(floor: string, t: Translate): string {
  if (floor === 'Roof') return t(floor, '屋顶');
  const level = /^(\d+)F$/.exec(floor);
  return level ? t(floor, `${level[1]} 层`) : floor;
}

export function sceneNameLabel(name: string, objects: readonly SceneObject[], t: Translate): string {
  return name === foundryTitle[0] && objects.some(object => foundryObject(object))
    ? t(...foundryTitle)
    : name;
}

export function sceneObjectName(object: SceneObject, t: Translate): string | undefined {
  const builtIn = object.source === 'template' ? starterNames.get(object.id) : foundryObject(object)?.name;
  if (builtIn && object.name === builtIn[0]) return t(...builtIn);

  const { buildingSpec, floor, type, name } = object;
  if (buildingSpec && floor) {
    const part = floor === 'Roof' && type === 'generated_slab' ? ['Roof deck', '屋面板'] as const
      : floor === 'Roof' && type === 'generated_facade' ? ['Parapet', '女儿墙'] as const
      : buildingParts.get(type);
    if (part && name === `${buildingSpec.name} · ${floor} · ${part[0]}`) {
      return `${buildingSpec.name} · ${sceneFloorLabel(floor, t)} · ${t(...part)}`;
    }
  }
  return name;
}

export function sceneGeometrySourceLabel(object: SceneObject, t: Translate): string | undefined {
  const source = object.geometrySource;
  const foundry = foundryObject(object);
  if (foundry) return t(...foundry.geometry);
  if (object.buildingSpec?.layout === 'office' && source === 'Procedural office building') {
    return t(source, '自动生成的办公楼');
  }
  if (object.buildingSpec?.layout === 'apartments' && source === 'Procedural apartments building') {
    return t(source, '自动生成的公寓楼');
  }
  return source;
}

const sceneIssues = new Map<string, string>([
  ['Building needs three vertices and a positive height.', '建筑至少需要三个顶点，高度必须大于零。'],
  ['Invalid polygon repaired.', '已修复无效的多边形。'],
  ['Only the largest polygon was retained.', '已保留面积最大的多边形。'],
  ['No polygon with at least 0.5 m² remains.', '没有面积达到 0.5 平方米的多边形。'],
  ['Building extrusion raised to the 1 m minimum.', '建筑拉伸高度已调整为最低值 1 米。'],
  ['Mesh contains no triangles.', '网格没有三角形。'],
  ['Wall needs two endpoints and a positive height.', '墙需要两个端点，高度必须大于零。'],
  ['Wall endpoints are less than 1 cm apart.', '墙的两个端点相距不足 1 厘米。'],
  ["Mesh coordinates exceed the solver's float32 range.", '网格坐标超出求解器的单精度浮点数范围。'],
  ['Mesh has no nondegenerate triangles at solver precision.', '按求解精度处理后，网格没有有效的三角形。'],
  ['Ground requires a triangle mesh.', '地面需要三角网格。'],
  ['Foliage requires an attenuation volume.', '树冠需要用于计算衰减的体积模型。'],
  ['Some referenced OSM nodes are missing.', '缺少部分引用的 OSM 节点。'],
  ['Unrecognized OSM height; using levels or an estimated height.', '无法识别 OSM 高度，已根据楼层数计算或使用估计高度。'],
  ['Unmapped OSM material; using an estimate.', '没有对应的 OSM 材质，已使用估计材质。'],
  ['Imported the ITU preset; XML material overrides need review.', '已导入 ITU 预设，需核对 XML 中的自定义材质参数。'],
  ['Studio will generate the ground plane for the resulting scene.', 'Studio 会为导入的场景生成地面。'],
]);

export function sceneIssueLabel(issue: string, t: Translate): string {
  const translated = sceneIssues.get(issue);
  if (translated) return t(issue, translated);
  const unknownMaterial = /^Unknown radio material (.+); using concrete\.$/.exec(issue);
  if (unknownMaterial) return t(issue, `未知射频材质 ${unknownMaterial[1]}，已改用混凝土。`);
  const frequency = /^(.+) is undefined at (\S+) GHz; using concrete\.$/.exec(issue);
  if (frequency) return t(issue, `${radioMaterialLabel(frequency[1], t)}在 ${frequency[2]} GHz 下无定义，已改用混凝土。`);
  const removed = /^Removed (\d+) degenerate triangle\(s\) at solver precision\.$/.exec(issue);
  if (removed) return t(issue, `已按求解精度移除 ${removed[1]} 个退化三角形。`);
  const triangulation = /^Polygon triangulation failed: (.+)$/.exec(issue);
  if (triangulation) return t(issue, `无法将多边形划分为三角形（${triangulation[1]}）。`);
  const skippedShape = /^Skipped shape (.+) of type (.+)\.$/.exec(issue);
  if (skippedShape) return t(issue, `已跳过类型为 ${skippedShape[2]} 的形状 ${skippedShape[1]}。`);
  const unsupportedMaterial = /^No supported ITU material mapping for (.+); using the selected preset\.$/.exec(issue);
  if (unsupportedMaterial) return t(issue, `对象 ${unsupportedMaterial[1]} 的 ITU 材质无法映射，已改用所选预设。`);
  return issue;
}
