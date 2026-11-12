import type { LocalizedText } from '../i18n';

type Translate = (...text: LocalizedText) => string;

const materialLabels: Readonly<Record<string, LocalizedText>> = {
  itu_vacuum: ['Vacuum', '真空'],
  itu_concrete: ['Concrete', '混凝土'],
  itu_brick: ['Brick', '砖'],
  itu_glass: ['Glass', '玻璃'],
  itu_metal: ['Metal', '金属'],
  itu_wood: ['Wood', '木材'],
  itu_asphalt_concrete: ['Asphalt concrete', '沥青混凝土'],
  itu_plasterboard: ['Plasterboard', '石膏板'],
  itu_clear_acrylic: ['Clear acrylic', '透明亚克力'],
  itu_ceiling_board: ['Ceiling board', '吊顶板'],
  itu_chipboard: ['Chipboard', '刨花板'],
  itu_plywood: ['Plywood', '胶合板'],
  itu_marble: ['Marble', '大理石'],
  itu_floorboard: ['Floorboard', '地板板材'],
  itu_vinyl_tile: ['Vinyl tile', '乙烯基地砖'],
  itu_carpet_tile: ['Carpet tile', '方块地毯'],
  itu_dry_ground: ['Dry ground (legacy)', '干燥地面（旧版预设）'],
  itu_very_dry_ground: ['Very dry ground', '极干地面'],
  itu_medium_dry_ground: ['Medium-dry ground', '中等干燥地面'],
  itu_wet_ground: ['Wet ground', '湿润地面'],
  ground_plane: ['Ground plane', '地面平面'],
};

export function radioMaterialLabel(id: string, t: Translate): string {
  return Object.hasOwn(materialLabels, id) ? t(...materialLabels[id]) : id;
}
