import { useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '../api';
import { newProjectId } from '../project';
import { cancelSimulationJob, pollSimulationJob, type SimulationJob } from './simulationJobs';

const PROJECT_CHANGED = Symbol('project changed');

type Submit<Input, Output> = (input: Input, jobId?: string) => Promise<SimulationJob<Output>>;
type Retry<Input, Output> = { input: Input; onResult: (result: Output) => void; jobId?: string };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function transient(error: unknown) {
  return !(error instanceof ApiRequestError) || error.status >= 500;
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms));
}

export function useSimulationTask<Input, Output>(submit: Submit<Input, Output>) {
  const controller = useRef<AbortController | null>(null);
  const activeJobId = useRef<string | null>(null);
  const previous = useRef<Retry<Input, Output> | null>(null);
  const [job, setJob] = useState<SimulationJob<Output> | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => controller.current?.abort(), []);

  const run = async (input: Input, onResult: (result: Output) => void, existingId?: string) => {
    if (controller.current) return;
    const active = new AbortController();
    controller.current = active;
    const jobId = existingId ?? newProjectId();
    activeJobId.current = jobId;
    previous.current = { input, onResult, jobId };
    setJob(null);
    setBusy(true);
    setReconnecting(false);
    setError('');
    try {
      let latest: SimulationJob<Output>;
      try {
        latest = await submit(input, jobId);
      } catch (cause) {
        if (!transient(cause) || active.signal.aborted) throw cause;
        // A connection can drop after enqueue. Reuse the client ID to recover
        // the same task, including the case where the server has already finished.
        setReconnecting(true);
        await delay(400);
        if (active.signal.aborted) return;
        latest = await submit(input, jobId);
      }
      if (active.signal.aborted) {
        // The project may have changed before the enqueue request was acknowledged.
        if (active.signal.reason === PROJECT_CHANGED && latest.canCancel) {
          void cancelSimulationJob(jobId).catch(() => {});
        }
        return;
      }
      previous.current = { input, onResult };
      setReconnecting(false);
      setJob({ ...latest, result: null });
      while (!active.signal.aborted && !['succeeded', 'failed', 'cancelled'].includes(latest.status)) {
        await delay(400);
        if (active.signal.aborted) return;
        try {
          const snapshot = await pollSimulationJob<Output>(jobId, active.signal);
          if (active.signal.aborted) return;
          latest = snapshot;
          setJob({ ...snapshot, result: null });
          setReconnecting(false);
          setError('');
        } catch (cause) {
          if (active.signal.aborted) return;
          if (!transient(cause)) throw cause;
          // Retain the job ID while the service reconnects. Poll failures must
          // never submit a second solver task.
          setReconnecting(true);
          await delay(1200);
        }
      }
      if (active.signal.aborted) return;
      if (latest.status === 'succeeded' && latest.result !== null) {
        previous.current = null;
        onResult(latest.result);
      }
    } catch (cause) {
      if (!active.signal.aborted) {
        setJob(null);
        setError(message(cause));
      }
    } finally {
      if (controller.current === active) {
        controller.current = null;
        activeJobId.current = null;
        setBusy(false);
        setReconnecting(false);
      }
    }
  };

  const cancel = async () => {
    const active = controller.current;
    if (!job?.canCancel || !active) return;
    try {
      const state = await cancelSimulationJob<Output>(job.jobId);
      if (controller.current === active) setJob({ ...state, result: null });
    } catch (cause) {
      if (controller.current === active) setError(message(cause));
    }
  };

  const retry = () => {
    const last = previous.current;
    if (last) void run(last.input, last.onResult, last.jobId);
  };

  const reset = () => {
    const jobId = activeJobId.current;
    controller.current?.abort(PROJECT_CHANGED);
    controller.current = null;
    activeJobId.current = null;
    if (jobId) void cancelSimulationJob(jobId).catch(() => {});
    previous.current = null;
    setJob(null);
    setError('');
    setBusy(false);
    setReconnecting(false);
  };

  return { run, cancel, retry, reset, job, busy, reconnecting, error, canRetry: !busy && !!previous.current };
}
