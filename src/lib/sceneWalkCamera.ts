import { MathUtils, type Vector3 } from 'three';

export interface WalkCameraState {
  position: Vector3;
  yaw: number;
  pitch: number;
}

const EYE_HEIGHT_M = 1.6;
const LOOK_RADIANS_PER_PIXEL = 0.004;
const MAX_PITCH = Math.PI / 2 - 0.05;
const WALK_SPEED_MPS = 3;
const FAST_SPEED_MPS = 8;
const MAX_STEP_SECONDS = 0.05;

export function createWalkCamera(point: Vector3, heading: Vector3): WalkCameraState {
  const position = point.clone();
  position.y += EYE_HEIGHT_M;
  const yaw = Math.hypot(heading.x, heading.z) > 1e-6 ? Math.atan2(-heading.x, -heading.z) : 0;
  return { position, yaw, pitch: 0 };
}

export function rotateWalkCamera(state: WalkCameraState, deltaX: number, deltaY: number): void {
  state.yaw -= deltaX * LOOK_RADIANS_PER_PIXEL;
  state.pitch = MathUtils.clamp(state.pitch - deltaY * LOOK_RADIANS_PER_PIXEL, -MAX_PITCH, MAX_PITCH);
}

export function advanceWalkCamera(state: WalkCameraState, keys: ReadonlySet<string>, deltaSeconds: number): void {
  const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
  const right = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
  const up = Number(keys.has('KeyE')) - Number(keys.has('KeyQ'));
  const magnitude = Math.hypot(forward, right, up);
  if (magnitude === 0 || deltaSeconds <= 0) return;

  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? FAST_SPEED_MPS : WALK_SPEED_MPS;
  const step = Math.min(deltaSeconds, MAX_STEP_SECONDS) * speed / magnitude;
  const sin = Math.sin(state.yaw);
  const cos = Math.cos(state.yaw);
  state.position.x += (right * cos - forward * sin) * step;
  state.position.y += up * step;
  state.position.z -= (right * sin + forward * cos) * step;
}
