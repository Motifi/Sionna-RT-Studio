import { Matrix3, Mesh, Vector3, type Intersection, type Object3D } from 'three';
import type { BuildingFootprint, ENUVector, RadioRole } from '../types';

const MIN_SUPPORT_NORMAL_UP = 0.7;

export function radioRole(object: BuildingFootprint): RadioRole {
  return object.rfRole ?? (object.category === 'building' ? 'surface' : 'visual');
}

export function isRadioSurface(object: BuildingFootprint) {
  const role = radioRole(object);
  return role === 'surface' || role === 'ground';
}

export function findHorizontalSurface(hits: Intersection[], accepts: (object: Object3D) => boolean) {
  const normal = new Vector3();
  const normalMatrix = new Matrix3();
  return hits.find(({ object, face }) => {
    if (!(object instanceof Mesh) || !face || !accepts(object)) return false;
    normalMatrix.getNormalMatrix(object.matrixWorld);
    return normal.copy(face.normal).applyNormalMatrix(normalMatrix).y >= MIN_SUPPORT_NORMAL_UP;
  });
}

export function isFloorSurface(object: BuildingFootprint) {
  if (!object.floor || object.kind !== 'mesh' || !object.mesh || radioRole(object) !== 'surface') return false;
  if (object.buildingSpec && object.type !== 'generated_slab') return false;
  const { vertices, triangles } = object.mesh;
  const edgeA = new Vector3();
  const edgeB = new Vector3();
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
    edgeA.set(vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]);
    edgeB.set(vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]);
    if (edgeA.cross(edgeB).normalize().z >= MIN_SUPPORT_NORMAL_UP) return true;
  }
  return false;
}

export function hasTerrainMesh(objects: BuildingFootprint[]) {
  return objects.some(object => object.rfRole === 'ground' && object.mesh !== undefined);
}

export function terrainHeight(point: Pick<ENUVector, 'x' | 'y'>, objects: BuildingFootprint[]) {
  let height: number | undefined;
  const { x, y } = point;
  for (const { rfRole, mesh, baseZ, kind } of objects) {
    if (rfRole !== 'ground' || kind !== 'mesh' || !mesh) continue;
    const { vertices, triangles } = mesh;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
      const ax = Math.fround(vertices[a]), ay = Math.fround(vertices[a + 1]);
      const bx = Math.fround(vertices[b]), by = Math.fround(vertices[b + 1]);
      const cx = Math.fround(vertices[c]), cy = Math.fround(vertices[c + 1]);
      if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) ||
          y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
      const dx = bx - ax, dy = by - ay, ex = cx - ax, ey = cy - ay;
      const area = dx * ey - dy * ex;
      if (area === 0) continue;
      const u = ((x - ax) * ey - (y - ay) * ex) / area;
      const v = (dx * (y - ay) - dy * (x - ax)) / area;
      if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
      const az = Math.fround(vertices[a + 2] + (baseZ ?? 0));
      const bz = Math.fround(vertices[b + 2] + (baseZ ?? 0));
      const cz = Math.fround(vertices[c + 2] + (baseZ ?? 0));
      height = Math.max(height ?? -Infinity, az + u * (bz - az) + v * (cz - az));
    }
  }
  return height;
}
