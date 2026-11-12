import type { ENUVector, Receiver, TrajectoryPoint } from '../types';

export function sampleTrajectory(
  points: TrajectoryPoint[], intervalMs: number, speedKmh: number, absolute: boolean,
  resolvePosition?: (point: ENUVector) => ENUVector | undefined,
) {
  const arc = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].enu;
    const b = points[i].enu;
    arc.push(arc[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, absolute ? b.z - a.z : 0));
  }
  const length = arc[arc.length - 1];
  const speed = speedKmh / 3.6;
  if (length < 1e-6 || speed <= 0 || intervalMs <= 0) return { waypoints: [], timeSeconds: [] };
  const step = Math.max(speed * intervalMs / 1000, 0.05);
  const segmentCount = (distance: number) => Math.min(99, Math.max(1, Math.ceil(distance / step - 1e-9)));
  const sample = (segments: number) => {
    const waypoints: ENUVector[] = [points[0].enu];
    const timeSeconds = [0];
    let edge = 1;
    for (let i = 1; i < segments; i++) {
      const distance = length * i / segments;
      while (edge < arc.length - 1 && arc[edge] < distance) edge++;
      const fraction = (distance - arc[edge - 1]) / Math.max(arc[edge] - arc[edge - 1], 1e-9);
      const a = points[edge - 1].enu;
      const b = points[edge].enu;
      waypoints.push({ x: a.x + fraction * (b.x - a.x), y: a.y + fraction * (b.y - a.y), z: a.z + fraction * (b.z - a.z) });
      timeSeconds.push(distance / speed);
    }
    waypoints.push(points[points.length - 1].enu);
    timeSeconds.push(length / speed);
    return { waypoints, timeSeconds };
  };
  const segments = segmentCount(length);
  const initial = sample(segments);
  if (!resolvePosition) return initial;

  // Estimate the 3D distance at each emitted sample, including terrain between
  // control points. Send the original waypoints for authoritative solver placement.
  const estimate = (route: ReturnType<typeof sample>) => {
    const timeSeconds = [0];
    let previous = resolvePosition(route.waypoints[0]);
    for (const point of route.waypoints.slice(1)) {
      const current = resolvePosition(point);
      if (!previous || !current) return route;
      const distance = Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z);
      timeSeconds.push(timeSeconds[timeSeconds.length - 1] + distance / speed);
      previous = current;
    }
    return { waypoints: route.waypoints, timeSeconds };
  };
  const estimated = estimate(initial);
  const adjustedSegments = segmentCount(estimated.timeSeconds[segments] * speed);
  return adjustedSegments > segments ? estimate(sample(adjustedSegments)) : estimated;
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
