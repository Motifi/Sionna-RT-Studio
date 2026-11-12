import type { ENUVector, Receiver, TrajectoryPoint } from '../types';

export function sampleTrajectory(points: TrajectoryPoint[], intervalMs: number, speedKmh: number, absolute: boolean) {
  const arc = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].enu;
    const b = points[i].enu;
    arc.push(arc[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, absolute ? b.z - a.z : 0));
  }
  const length = arc[arc.length - 1];
  const speed = speedKmh / 3.6;
  if (length < 1e-6 || speed <= 0 || intervalMs <= 0) return { waypoints: [], timeSeconds: [] };
  const segments = Math.min(99, Math.max(1, Math.ceil(length / Math.max(speed * intervalMs / 1000, 0.05))));
  const waypoints: ENUVector[] = [];
  const timeSeconds: number[] = [];
  let edge = 1;
  for (let i = 0; i <= segments; i++) {
    if (i === 0 || i === segments) {
      waypoints.push(points[i === 0 ? 0 : points.length - 1].enu);
      timeSeconds.push(i === 0 ? 0 : length / speed);
      continue;
    }
    const distance = length * i / segments;
    while (edge < arc.length - 1 && arc[edge] < distance) edge++;
    const fraction = (distance - arc[edge - 1]) / Math.max(arc[edge] - arc[edge - 1], 1e-9);
    const a = points[edge - 1].enu;
    const b = points[edge].enu;
    waypoints.push({ x: a.x + fraction * (b.x - a.x), y: a.y + fraction * (b.y - a.y), z: a.z + fraction * (b.z - a.z) });
    timeSeconds.push(distance / speed);
  }
  return { waypoints, timeSeconds };
}

export function deviceAtRunPosition<T extends Pick<Receiver, 'height' | 'heightReference' | 'enu'>>(
  device: T, position: number[] | undefined,
): T {
  if (!position) return device;
  const [x, y, z] = position;
  return { ...device, heightReference: 'enu', height: z, enu: { x, y, z } };
}

export function trajectorySampling(timeSeconds: readonly number[], requestedMs: number) {
  if (timeSeconds.length < 2) return null;
  const durationSeconds = timeSeconds[timeSeconds.length - 1] - timeSeconds[0];
  const intervalMs = 1000 * durationSeconds / (timeSeconds.length - 1);
  return {
    sampleCount: timeSeconds.length, durationSeconds, intervalMs,
    capped: timeSeconds.length === 100 && intervalMs > requestedMs + 0.01,
  };
}
