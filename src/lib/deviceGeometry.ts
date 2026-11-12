import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const hardware = 0x505967;
const radome = 0xe6e1d8;
const apAccent = 0xad4b38;
const ueAccent = 0x226b86;

function part(geometry: THREE.BufferGeometry, color: number, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.72 }));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

function addMount(parent: THREE.Group, height: number, x: number, z: number, radius: number) {
  if (height <= 0) return;
  const baseHeight = Math.min(height, 0.16);
  parent.add(
    part(new THREE.CylinderGeometry(radius * 0.8, radius, height, 12), hardware, x, -height / 2, z),
    part(new THREE.CylinderGeometry(radius * 2.15, radius * 2.3, baseHeight, 12), hardware, x, -height + baseHeight / 2, z),
  );
}

function phaseCenter(color: number, active: boolean) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(active ? 0.78 : 0.57, active ? 1.0 : 0.72, 24),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  // The RF phase center remains easy to pick when the device is distant.
  const hitTarget = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
  return new THREE.Group().add(ring, hitTarget);
}

export function createAccessPointModel(height: number, azimuthDegrees: number, elevationDegrees: number, active: boolean) {
  const model = new THREE.Group();
  const azimuth = THREE.MathUtils.degToRad(azimuthDegrees);
  const elevation = THREE.MathUtils.degToRad(elevationDegrees);
  const panel = new THREE.Group();
  // The model faces +Z, and ENU north is -Z in the viewport.
  panel.rotation.set(-elevation, Math.PI - azimuth, 0, 'YXZ');
  panel.add(
    part(new RoundedBoxGeometry(0.62, 1.15, 0.25, 2, 0.06), radome, 0, 0, -0.045),
    part(new THREE.BoxGeometry(0.36, 0.88, 0.13), hardware, 0, 0, -0.20),
    part(new THREE.BoxGeometry(0.34, 0.085, 0.026), apAccent, 0, -0.35, 0.083),
  );
  addMount(model, height, -Math.sin(azimuth) * 0.28, Math.cos(azimuth) * 0.28, 0.14);
  model.add(panel, phaseCenter(apAccent, active));

  if (active) {
    const axis = new THREE.Vector3(0, 0, 1).applyEuler(panel.rotation);
    const tip = axis.clone().multiplyScalar(11);
    const shaft = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), tip]);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.36, 1.3, 12), new THREE.MeshBasicMaterial({ color: apAccent }));
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    head.position.copy(tip).addScaledVector(axis, -0.65);
    const line = new THREE.Line(shaft, new THREE.LineBasicMaterial({ color: apAccent }));
    // Boresight is an overlay and should leave the devices beneath it selectable.
    line.raycast = head.raycast = () => {};
    model.add(line, head);
  }
  return model;
}

export function createReceiverModel(height: number, active: boolean) {
  const model = new THREE.Group();
  if (height >= 1.15 && height <= 1.95) {
    const floor = -height;
    const torso = part(new THREE.CapsuleGeometry(0.17, 0.39, 4, 8), ueAccent, 0, floor + 1.04, -0.30);
    torso.scale.z = 0.66;
    model.add(
      torso,
      part(new THREE.SphereGeometry(0.125, 10, 8), 0xc19474, 0, floor + 1.51, -0.30),
    );
    for (const side of [-1, 1]) {
      const leg = part(new THREE.CapsuleGeometry(0.063, 0.58, 3, 8), 0x394350, side * 0.091, floor + 0.37, -0.30);
      const shoe = part(new RoundedBoxGeometry(0.13, 0.075, 0.23, 2, 0.025), hardware, side * 0.091, floor + 0.04, -0.25);
      const shoulder = new THREE.Vector3(side * 0.16, floor + 1.24, -0.28);
      const hand = new THREE.Vector3(side * 0.05, 0, -0.065);
      const shoulderToHand = hand.clone().sub(shoulder);
      const arm = part(new THREE.CapsuleGeometry(0.047, shoulderToHand.length(), 3, 8), ueAccent, 0, 0, 0);
      arm.position.copy(shoulder).lerp(hand, 0.5);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), shoulderToHand.normalize());
      model.add(leg, shoe, arm);
    }
    model.add(
      part(new RoundedBoxGeometry(0.085, 0.164, 0.021, 2, 0.01), hardware, 0, 0, 0),
      part(new THREE.BoxGeometry(0.068, 0.132, 0.002), 0x9fced8, 0, 0, -0.012),
    );
  } else {
    addMount(model, height, 0, 0, 0.068);
    model.add(
      part(new RoundedBoxGeometry(0.32, 0.24, 0.16, 2, 0.035), radome, 0, 0, 0),
      part(new THREE.BoxGeometry(0.19, 0.028, 0.008), ueAccent, 0, -0.06, 0.082),
    );
  }
  model.add(phaseCenter(ueAccent, active));
  return model;
}
