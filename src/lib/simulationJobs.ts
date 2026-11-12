import { ApiRequestError, errorDetail, type CoverageJobRequest, type CsiRun, type CsiRunRequest } from '../api';
import type { RadioMapGrid } from '../types';
import { withRequestTimeout } from '../utils';

export interface SimulationJob<T> {
  jobId: string;
  kind: 'csi' | 'coverage';
  status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  stage: 'waiting' | 'preparing' | 'tracing' | 'processing' | 'saving' | 'finished';
  queuePosition: number | null;
  canCancel: boolean;
  error: string | null;
  result: T | null;
}

const BASE = '/api/simulation-jobs';
const TIMEOUT_MS = 15_000;

function requestJob<T>(url: string, options: RequestInit = {}, signal?: AbortSignal): Promise<SimulationJob<T>> {
  return withRequestTimeout(TIMEOUT_MS, async requestSignal => {
    const response = await fetch(url, { ...options, signal: requestSignal });
    if (!response.ok) throw new ApiRequestError(response.status, await errorDetail(response));
    return await response.json() as SimulationJob<T>;
  }, signal);
}

function startJob<T>(kind: SimulationJob<T>['kind'], input: unknown, jobId?: string): Promise<SimulationJob<T>> {
  const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
  return requestJob<T>(`${BASE}/${kind}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function startCsiJob(input: CsiRunRequest, jobId?: string): Promise<SimulationJob<CsiRun>> {
  return startJob('csi', input, jobId);
}

export function startCoverageJob(input: CoverageJobRequest, jobId?: string): Promise<SimulationJob<RadioMapGrid>> {
  return startJob('coverage', input, jobId);
}

export function pollSimulationJob<T>(jobId: string, signal?: AbortSignal): Promise<SimulationJob<T>> {
  return requestJob<T>(`${BASE}/${encodeURIComponent(jobId)}`, {}, signal);
}

export function cancelSimulationJob<T>(jobId: string): Promise<SimulationJob<T>> {
  return requestJob<T>(`${BASE}/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}
