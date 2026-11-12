"""Process-local FIFO for Studio's CSI and coverage jobs."""
from __future__ import annotations

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock, Thread
import traceback
from typing import Literal
from uuid import UUID, uuid4


JobKind = Literal["csi", "coverage"]
JobStatus = Literal["queued", "running", "cancelling", "succeeded", "failed", "cancelled"]
JobStage = Literal["waiting", "preparing", "tracing", "processing", "saving", "finished"]

# Coverage grids can contain hundreds of thousands of Pydantic cells each.
_MAX_RETAINED_COVERAGE_GRIDS = 2


class SimulationCancelled(Exception):
    """The worker reached a safe stopping point after cancellation."""


class SimulationQueueFull(Exception):
    pass


class SimulationJobConflict(Exception):
    pass


@dataclass(eq=False)
class _Job:
    id: str
    kind: JobKind
    fingerprint: str | None
    run: Callable[[SimulationJobContext], object] | None
    status: JobStatus = "queued"
    stage: JobStage = "waiting"
    can_cancel: bool = True
    result: object | None = None
    error: str | None = None


class SimulationJobContext:
    def __init__(self, job: _Job, lock: Lock):
        self._job = job
        self._lock = lock

    def checkpoint(self, stage: JobStage | None = None) -> None:
        with self._lock:
            if self._job.status == "cancelling":
                raise SimulationCancelled()
            if stage is not None:
                self._job.stage = stage

    def commit(self) -> None:
        """Accept no further cancellation once the final publication begins."""
        with self._lock:
            if self._job.status == "cancelling":
                raise SimulationCancelled()
            self._job.can_cancel = False


class SimulationJobQueue:
    def __init__(self, solver_lock: Lock, *, max_pending: int = 8, max_finished: int = 16):
        self._solver_lock = solver_lock
        self._lock = Lock()
        self._jobs: dict[str, _Job] = {}
        self._pending: deque[_Job] = deque()
        self._finished: deque[_Job] = deque()
        self._worker: Thread | None = None
        self._max_pending = max_pending
        self._max_finished = max_finished

    def submit(self, kind: JobKind, run: Callable[[SimulationJobContext], object], *,
               job_id: UUID | None = None, fingerprint: str | None = None) -> dict:
        ident = str(job_id or uuid4())
        with self._lock:
            if existing := self._jobs.get(ident):
                if existing.kind != kind or existing.fingerprint != fingerprint:
                    raise SimulationJobConflict()
                return self._snapshot(existing)
            if len(self._pending) >= self._max_pending:
                raise SimulationQueueFull()
            job = _Job(ident, kind, fingerprint, run)
            self._jobs[ident] = job
            self._pending.append(job)
            if self._worker is None:
                self._worker = Thread(target=self._work, name="studio-simulation", daemon=True)
                self._worker.start()
            return self._snapshot(job)

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return self._snapshot(job) if job else None

    def cancel(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status == "queued":
                self._pending.remove(job)
                self._finish(job, "cancelled")
            elif job.status == "running" and job.can_cancel:
                job.status = "cancelling"
                job.can_cancel = False
            return self._snapshot(job)

    def _snapshot(self, job: _Job) -> dict:
        return {
            "jobId": job.id,
            "kind": job.kind,
            "status": job.status,
            "stage": job.stage,
            "queuePosition": self._pending.index(job) + 1 if job.status == "queued" else None,
            "canCancel": job.can_cancel,
            "error": job.error,
            "result": job.result,
        }

    def _finish(self, job: _Job, status: JobStatus, *, result: object = None, error: str | None = None) -> None:
        job.status = status
        job.stage = "finished"
        job.can_cancel = False
        job.run = None
        job.result = result
        job.error = error
        self._finished.append(job)
        if len(self._finished) > self._max_finished:
            expired = self._finished.popleft()
            self._jobs.pop(expired.id)
        if job.kind == "coverage" and status == "succeeded":
            coverage_results = [finished for finished in self._finished
                                if finished.kind == "coverage" and finished.status == "succeeded"]
            if len(coverage_results) > _MAX_RETAINED_COVERAGE_GRIDS:
                expired = coverage_results[0]
                self._finished.remove(expired)
                self._jobs.pop(expired.id)

    def _work(self) -> None:
        while True:
            with self._lock:
                if not self._pending:
                    self._worker = None
                    return

            # A queued job can be removed while a synchronous request owns
            # this lock. Pick the head only after acquiring the shared solver.
            with self._solver_lock:
                with self._lock:
                    if not self._pending:
                        continue
                    job = self._pending.popleft()
                    job.status = "running"
                    job.stage = "preparing"
                self._run(job)

    def _run(self, job: _Job) -> None:
        context = SimulationJobContext(job, self._lock)
        result, error = None, None
        try:
            context.checkpoint()
            assert job.run is not None
            result = job.run(context)
        except SimulationCancelled:
            pass
        except Exception as exc:
            traceback.print_exc()
            error = str(exc) or type(exc).__name__

        with self._lock:
            if job.status == "cancelling":
                self._finish(job, "cancelled")
            elif error is not None:
                self._finish(job, "failed", error=error)
            else:
                self._finish(job, "succeeded", result=result)
