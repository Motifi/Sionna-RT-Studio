import * as THREE from 'three';
import type { BuildingFootprint, ENUVector } from '../types';

const asphalt = 0x4b5057;
const selectedColor = 0xf59e0b;
const roadHeight = 0.12;
const sidewalkWidth = 1.8;

type Rectangle = [x1: number, z1: number, x2: number, z2: number];

function rectanglesOnGround(rectangles: Rectangle[], y: number) {
  const positions: number[] = [];
  for (const [x1, z1, x2, z2] of rectangles) {
    positions.push(x1, y, z1, x1, y, z2, x2, y, z1, x2, y, z1, x1, y, z2, x2, y, z2);
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
}

export function createStreetSegment(
  length: number, width: number, { selected, sidewalks, markings }: {
    selected: boolean; sidewalks: 'avenue' | 'lane' | null; markings: boolean;
  },
) {
  const group = new THREE.Group();
  const start = -length / 2;
  const end = length / 2;
  const edge = width / 2;
  const surfaceGeometry = rectanglesOnGround([[start, -edge, end, edge]], roadHeight);
  surfaceGeometry.computeVertexNormals();
  const surface = new THREE.Mesh(surfaceGeometry, new THREE.MeshStandardMaterial({
    color: selected ? selectedColor : asphalt, roughness: 0.94,
  }));
  surface.receiveShadow = true;
  group.add(surface);

  if (sidewalks) {
    const corner = sidewalks === 'avenue' ? start + sidewalkWidth : start;
    const geometry = rectanglesOnGround([
      [corner, -edge - sidewalkWidth, end, -edge],
      [corner, edge, end, edge + sidewalkWidth],
    ], roadHeight + 0.10);
    geometry.computeVertexNormals();
    const sidewalk = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xc9c0af, roughness: 1 }));
    sidewalk.receiveShadow = true;
    group.add(sidewalk);
  }

  if (markings && length >= 4) {
    const paint: Rectangle[] = [];
    for (let x = start + (sidewalks ? 8 : 1); x + 2.6 < end - 1; x += 6) {
      paint.push([x, -0.075, x + 2.6, 0.075]);
    }
    if (sidewalks && length >= 8) {
      for (let z = -edge + 0.8; z + 0.5 < edge - 0.6; z += 1.05) {
        paint.push([start + 1.1, z, start + 3.6, z + 0.5]);
      }
    }
    if (paint.length) {
      group.add(new THREE.Mesh(rectanglesOnGround(paint, roadHeight + 0.008), new THREE.MeshBasicMaterial({ color: 0xf4edda })));
    }
  }
  return group;
}

export function createJunction(points: ENUVector[], selected: boolean) {
  const geometry = new THREE.ShapeGeometry(new THREE.Shape(points.map(({ x, y }) => new THREE.Vector2(x, y))));
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: selected ? selectedColor : asphalt, roughness: 0.94 }));
  mesh.position.y = roadHeight;
  mesh.receiveShadow = true;
  return mesh;
}

export function createFacadeWindows(building: BuildingFootprint, selected: boolean) {
  const { enuPoints: points, height, material } = building;
  const floorHeight = material === 'itu_glass' ? 3.8 : 3.2;
  const floors = Math.min(12, Math.floor((height - 0.6) / floorHeight));
  const positions: number[] = [];
  let signedArea = 0;
  for (let i = 0; i < points.length; i++) {
    const from = points[i], to = points[(i + 1) % points.length];
    signedArea += from.x * to.y - to.x * from.y;
  }
  const outward = Math.sign(signedArea) * 0.025;
  const base = building.baseZ ?? 0;
  for (let i = 0; i < points.length; i++) {
    const from = points[i], to = points[(i + 1) % points.length];
    const east = to.x - from.x, north = to.y - from.y;
    const length = Math.hypot(east, north);
    const columns = Math.min(24, Math.floor(length / 3.4));
    if (!columns) continue;
    const pitch = length / columns;
    const windowWidth = Math.min(material === 'itu_glass' ? 2.7 : 1.65, pitch * 0.8);
    const startX = from.x + north / length * outward;
    const startZ = -from.y + east / length * outward;
    for (let column = 0; column < columns; column++) {
      const center = (column + 0.5) * pitch;
      const left = (center - windowWidth / 2) / length;
      const right = (center + windowWidth / 2) / length;
      const x1 = startX + east * left, x2 = startX + east * right;
      const z1 = startZ - north * left, z2 = startZ - north * right;
      for (let floor = 0; floor < floors; floor++) {
        const y1 = base + (floor + 0.32) * floorHeight;
        const y2 = y1 + floorHeight * (material === 'itu_glass' ? 0.57 : 0.46);
        positions.push(x1, y1, z1, x2, y1, z2, x2, y2, z2, x1, y1, z1, x2, y2, z2, x1, y2, z1);
      }
    }
  }
  if (!positions.length) return null;

  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const windows = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: selected ? 0xbe773c : material === 'itu_glass' ? 0x4b6876 : 0x62676a,
    roughness: 0.48,
    side: THREE.DoubleSide,
  }));
  windows.name = building.id;
  windows.receiveShadow = true;
  return windows;
}
