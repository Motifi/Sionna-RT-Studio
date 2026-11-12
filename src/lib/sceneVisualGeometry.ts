import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BuildingFootprint, ENUVector, SceneVisual } from '../types';

interface VisualBinding {
  node: THREE.Object3D;
  position: THREE.Vector3;
  origin: ENUVector;
}

export interface LoadedSceneVisual {
  root: THREE.Group;
  bindings: Map<string, VisualBinding>;
  ids: Map<THREE.Object3D, string>;
  incomplete: boolean;
  dispose: () => void;
}

export function isSceneObjectVisible(
  object: Pick<BuildingFootprint, 'category' | 'floor'>,
  hiddenLayers?: readonly BuildingFootprint['category'][],
  floor?: string,
) {
  return !hiddenLayers?.includes(object.category) &&
    (floor === undefined || object.floor === undefined || object.floor === floor);
}

export function positionVisualObject(binding: VisualBinding, object: Pick<BuildingFootprint, 'enuPoints' | 'baseZ'>) {
  const { node, position, origin } = binding;
  const anchor = object.enuPoints[0] ?? origin;
  node.position.set(
    position.x + anchor.x - origin.x,
    position.y + (object.baseZ ?? 0) - origin.z,
    position.z - (anchor.y - origin.y),
  );
}

const GLB_BYTES_LIMIT = 16 * 1024 * 1024;
const ACCESSOR_BYTES_LIMIT = 64 * 1024 * 1024;
const UNBACKED_ACCESSOR_BYTES_LIMIT = 8 * 1024 * 1024;
const ACCESSOR_COUNT_LIMIT = 4_000_000;
const componentBytes = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const elementComponents = new Map([
  ['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4], ['MAT2', 4], ['MAT3', 9], ['MAT4', 16],
]);
const externalResourceError = 'Scene visual resources must be embedded in the GLB.';

interface VisualDeclaration {
  scene?: number;
  scenes: { nodes?: number[] }[];
  nodes?: { name?: string }[];
  accessors?: { count: number; componentType: number; type: string; bufferView?: number; sparse?: { count: number } }[];
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
}

function readVisualDeclaration(bytes: Uint8Array): VisualDeclaration {
  if (bytes.length < 20 || bytes.length > GLB_BYTES_LIMIT) throw new Error('Invalid scene GLB size.');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonSize = header.getUint32(12, true);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 ||
      header.getUint32(8, true) !== bytes.length || header.getUint32(16, true) !== 0x4e4f534a ||
      jsonSize > bytes.length - 20) throw new Error('Invalid scene GLB header.');

  const declaration = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonSize))) as VisualDeclaration;
  const scene = declaration?.scenes?.[declaration.scene ?? 0];
  if (!scene || (scene.nodes !== undefined && !Array.isArray(scene.nodes))) throw new Error('Invalid GLB scene.');
  for (const resources of [declaration.buffers ?? [], declaration.images ?? []]) {
    if (!Array.isArray(resources) || resources.some(item => !item || (item.uri !== undefined &&
        (typeof item.uri !== 'string' || !item.uri.startsWith('data:'))))) throw new Error(externalResourceError);
  }

  const accessors = declaration.accessors ?? [];
  if (!Array.isArray(accessors)) throw new Error('Invalid GLB accessors.');
  let decodedBytes = 0;
  for (const accessor of accessors) {
    const width = componentBytes.get(accessor?.componentType);
    const elements = elementComponents.get(accessor?.type);
    if (!width || !elements || !Number.isSafeInteger(accessor.count) || accessor.count < 1 ||
        (accessor.sparse !== undefined && (!Number.isSafeInteger(accessor.sparse?.count) ||
        accessor.sparse.count < 1 || accessor.sparse.count > accessor.count))) throw new Error('Invalid GLB accessor.');
    const size = width * elements * accessor.count;
    decodedBytes += size;
    if (accessor.count > ACCESSOR_COUNT_LIMIT || decodedBytes > ACCESSOR_BYTES_LIMIT ||
        (accessor.bufferView === undefined && size > UNBACKED_ACCESSOR_BYTES_LIMIT)) {
      throw new Error('GLB accessor allocation is too large.');
    }
  }
  return declaration;
}

function disposeGltf(scenes: THREE.Group[]) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<ImageBitmap>();
  const skeletons = new Set<THREE.Skeleton>();

  for (const scene of scenes) {
    scene.removeFromParent();
    scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        objectMaterials.forEach(material => materials.add(material));
      }
      if (object instanceof THREE.InstancedMesh) object.dispose();
      if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    });
  }

  for (const material of materials) {
    Object.values(material).forEach(value => { if (value instanceof THREE.Texture) textures.add(value); });
    material.dispose();
  }
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) images.add(texture.image);
    texture.dispose();
  }
  geometries.forEach(geometry => geometry.dispose());
  skeletons.forEach(skeleton => skeleton.dispose());
  images.forEach(image => image.close());
}

export async function loadSceneVisual(visual: SceneVisual): Promise<LoadedSceneVisual> {
  const manager = new THREE.LoadingManager();
  let blockedResource = false;
  let failedResource = false;
  manager.setURLModifier(url => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    blockedResource = true;
    throw new Error(externalResourceError);
  });
  manager.onError = () => { failedResource = true; };

  if (visual.glb.length > Math.ceil(GLB_BYTES_LIMIT / 3) * 4) throw new Error('Scene GLB is too large.');
  const bytes = Uint8Array.from(atob(visual.glb), character => character.charCodeAt(0));
  const declaration = readVisualDeclaration(bytes);
  const gltf = await new GLTFLoader(manager).parseAsync(bytes.buffer, '');
  const dispose = () => disposeGltf(gltf.scenes);
  if (blockedResource) {
    dispose();
    throw new Error(externalResourceError);
  }

  const origins = new Map(visual.bindings.map(({ id, origin }) => [id, origin]));
  const bindings = new Map<string, VisualBinding>();
  const ids = new Map<THREE.Object3D, string>();
  // GLTFLoader sanitizes names for animation. Read original names from the
  // active scene's top-level node declarations, in the order Three loads them.
  const nodeIndices = declaration.scenes[declaration.scene ?? 0].nodes ?? [];
  gltf.scene.children.forEach((node, index) => {
    node.visible = false;
    const id = declaration.nodes?.[nodeIndices[index]]?.name;
    const origin = id && origins.get(id);
    if (!origin || !id || bindings.has(id)) return;
    let hasGeometry = false;
    node.traverse(part => {
      if (part instanceof THREE.Mesh) {
        const materials = Array.isArray(part.material) ? part.material : [part.material];
        part.castShadow = materials.some(material => !material.transparent);
        part.receiveShadow = true;
      }
      if (part instanceof THREE.Mesh || part instanceof THREE.Line || part instanceof THREE.Points) hasGeometry = true;
    });
    if (hasGeometry) {
      bindings.set(id, { node, position: node.position.clone(), origin });
      ids.set(node, id);
    }
  });
  return { root: gltf.scene, bindings, ids, incomplete: failedResource || bindings.size < origins.size, dispose };
}

export function createFoliageVolume(
  foliage: NonNullable<BuildingFootprint['foliage']>, baseZ: number, solverCheck: boolean, selected: boolean,
) {
  const { center, radii } = foliage;
  const group = new THREE.Group();
  const geometry = new THREE.SphereGeometry(1, 16, 12);
  const color = selected ? 0xf59e0b : solverCheck ? 0x15803d : 0x477a48;
  const material = solverCheck
    ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.93 });
  const volume = new THREE.Mesh(geometry, material);
  volume.scale.set(radii.x, radii.z, radii.y);
  volume.position.set(center.x, center.z + baseZ, -center.y);
  volume.castShadow = !solverCheck;
  group.add(volume);

  if (solverCheck) {
    const outline = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    outline.position.copy(volume.position);
    outline.scale.copy(volume.scale);
    group.add(outline);
  } else {
    const trunkHeight = center.z - radii.z;
    if (trunkHeight > 0) {
      const trunkRadius = Math.min(radii.x, radii.y) * 0.12;
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(trunkRadius * 0.72, trunkRadius, trunkHeight, 8),
        new THREE.MeshStandardMaterial({ color: 0x68553d, roughness: 0.96 }),
      );
      trunk.position.set(center.x, baseZ + trunkHeight / 2, -center.y);
      trunk.castShadow = true;
      group.add(trunk);
    }
  }
  return group;
}
