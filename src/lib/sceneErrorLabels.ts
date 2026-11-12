import type { LocalizedText } from '../i18n';

type Translate = (...text: LocalizedText) => string;
export type SceneOperation = 'package' | 'building' | 'mesh' | 'inspection';

const operationErrors: Record<SceneOperation, string> = {
  package: '无法读取场景包。请检查 ZIP 文件和场景配置。',
  building: '无法生成建筑。请检查尺寸和位置后重试。',
  mesh: '无法检查网格。请确认文件格式、坐标和比例。',
  inspection: '无法检查场景的求解几何。',
};

const errorTranslations: Record<string, string> = {
  'The bundled urban scene could not be read.': '无法读取内置城市场景。',
  'The scene changed during import. Open the package again.': '导入期间场景已修改，请重新打开场景包。',
  'The scene changed. Apply again to use the current scene.': '场景已变化。请再次提交以应用到当前场景。',
  'A generated object ID conflicts with the current scene.': '生成的对象编号与当前场景冲突。',
  'Invalid or unsupported scene ZIP.': '场景 ZIP 无效或格式不受支持。',
  'The ZIP must contain scene.json at its root.': 'ZIP 的根目录中必须包含 scene.json。',
  'Scene package exceeds 32 MiB.': '场景包大小不能超过 32 MiB。',
  'Expanded scene package is too large.': '场景包解压后的体积过大。',
  'Scene package contains an unsafe path.': '场景包内有不安全的文件路径。',
  'Scene object IDs must be unique.': '场景对象编号必须唯一。',
  'The visual GLB file is missing from the package.': '场景包中缺少用于显示的 GLB 文件。',
  'All GLB buffers and textures must be embedded.': 'GLB 的缓冲数据和纹理必须内嵌。',
  'Mesh upload exceeds 32 MiB.': '网格文件大小不能超过 32 MiB。',
  'Choose PLY, OBJ or a Mitsuba ZIP.': '请选择 PLY、OBJ 或 Mitsuba ZIP 文件。',
  'Choose a supported radio material.': '请选择受支持的射频材质。',
  'Mesh must contain triangles.': '网格必须包含三角面。',
  'Scene package needs exactly one Mitsuba XML scene.': '场景包必须包含且只包含一个 Mitsuba 场景 XML 文件。',
  'Package has no supported PLY or OBJ shapes.': '场景包中没有受支持的 PLY 或 OBJ 网格。',
};

export function sceneErrorLabel(raw: string, operation: SceneOperation, t: Translate): { text: string; detail?: string } {
  if (!raw || t('en', 'zh') === 'en') return { text: raw };
  if (Object.hasOwn(errorTranslations, raw)) return { text: errorTranslations[raw] };
  if (/^[^A-Za-z]*[\u3400-\u9fff]/.test(raw)) return { text: raw };

  const timeout = raw.match(/^timed out after (\d+)s$/);
  if (timeout) return { text: `请求在 ${timeout[1]} 秒后超时。请重试。` };
  if (/^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource)\.?$/.test(raw)) {
    return { text: '无法连接本机求解服务。请确认服务已启动后重试。', detail: raw };
  }
  if (raw.includes('Building height divided by floors must be 2.7–6 meters.')) {
    return { text: '建筑高度和楼层数需满足每层 2.7–6 米。' };
  }
  if (raw.includes('Building name must not be empty.')) return { text: '请输入建筑名称。' };
  if (operation === 'building' && /^(east|north|baseZ): /.test(raw)) {
    return { text: '请在「位置与朝向」中输入有效的东向、北向坐标和底部标高。', detail: raw };
  }
  return { text: operationErrors[operation], detail: raw };
}
