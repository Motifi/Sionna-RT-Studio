"""Simulation jobs share the solver lock and publish only uncancelled work."""
from threading import Event, Lock
from time import monotonic, sleep
import unittest
from uuid import uuid4

from backend.simulation_jobs import SimulationJobConflict, SimulationJobQueue, SimulationQueueFull


class TestSimulationJobQueue(unittest.TestCase):
    def setUp(self):
        self.solver_lock = Lock()
        self.queue = SimulationJobQueue(self.solver_lock, max_pending=2, max_finished=3)

    def wait_for(self, job_id, state):
        deadline = monotonic() + 3
        while monotonic() < deadline:
            job = self.queue.get(job_id)
            if job and job["status"] == state:
                return job
            sleep(0.005)
        self.fail(f"Expected {state}, last status: {job}")

    def test_waits_for_existing_solver_operation_and_runs_fifo(self):
        order = []
        with self.solver_lock:
            first = self.queue.submit("csi", lambda ctx: order.append("first"))["jobId"]
            second = self.queue.submit("coverage", lambda ctx: order.append("second"))["jobId"]
            self.assertEqual(self.queue.get(first)["queuePosition"], 1)
            self.assertEqual(self.queue.get(second)["queuePosition"], 2)
            self.assertEqual(order, [])
            with self.assertRaises(SimulationQueueFull):
                self.queue.submit("coverage", lambda ctx: None)
        self.wait_for(second, "succeeded")
        self.assertEqual(order, ["first", "second"])

    def test_cancelling_queued_job_never_dispatches_it(self):
        invoked = Event()
        with self.solver_lock:
            first = self.queue.submit("coverage", lambda ctx: invoked.set())["jobId"]
            second = self.queue.submit("csi", lambda ctx: "run-2")["jobId"]
            self.assertEqual(self.queue.cancel(first)["status"], "cancelled")
            self.assertEqual(self.queue.get(second)["queuePosition"], 1)
        self.assertEqual(self.wait_for(second, "succeeded")["result"], "run-2")
        self.assertFalse(invoked.is_set())
        self.assertIsNone(self.queue.get(first)["result"])

    def test_cancellation_waits_for_dispatch_and_prevents_publish(self):
        started, release, published = Event(), Event(), Event()

        def run(ctx):
            ctx.checkpoint("tracing")
            started.set()
            if not release.wait(3):
                raise TimeoutError("Test did not release solver")
            ctx.checkpoint("saving")
            ctx.commit()
            published.set()
            return "published-run"

        first = self.queue.submit("csi", run)["jobId"]
        try:
            self.assertTrue(started.wait(3))
            second = self.queue.submit("coverage", lambda ctx: "next")["jobId"]
            self.assertEqual(self.queue.get(first)["stage"], "tracing")
            cancelled = self.queue.cancel(first)
            self.assertEqual(cancelled["status"], "cancelling")
            self.assertFalse(cancelled["canCancel"])
            self.assertIsNone(cancelled["result"])
            self.assertEqual(self.queue.get(second)["status"], "queued")
        finally:
            release.set()
        self.assertIsNone(self.wait_for(first, "cancelled")["result"])
        self.assertFalse(published.is_set())
        self.wait_for(second, "succeeded")

    def test_final_publish_cannot_be_cancelled_after_commit(self):
        committing, release = Event(), Event()

        def run(ctx):
            ctx.checkpoint("saving")
            ctx.commit()
            committing.set()
            if not release.wait(3):
                raise TimeoutError("Test did not release publisher")
            return "published-run"

        job_id = self.queue.submit("csi", run)["jobId"]
        try:
            self.assertTrue(committing.wait(3))
            response = self.queue.cancel(job_id)
            self.assertEqual(response["status"], "running")
            self.assertFalse(response["canCancel"])
        finally:
            release.set()
        self.assertEqual(self.wait_for(job_id, "succeeded")["result"], "published-run")

    def test_resubmitting_same_id_recovers_original_job(self):
        job_id = uuid4()
        invoked = Event()
        with self.solver_lock:
            self.queue.submit("csi", lambda ctx: "original", job_id=job_id, fingerprint="params")
            recovered = self.queue.submit("csi", lambda ctx: invoked.set(), job_id=job_id, fingerprint="params")
            self.assertEqual(recovered["queuePosition"], 1)
            with self.assertRaises(SimulationJobConflict):
                self.queue.submit("csi", lambda ctx: None, job_id=job_id, fingerprint="changed")
        self.assertEqual(self.wait_for(str(job_id), "succeeded")["result"], "original")
        finished = self.queue.submit("csi", lambda ctx: invoked.set(), job_id=job_id, fingerprint="params")
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["result"], "original")
        self.assertFalse(invoked.is_set())

    def test_retains_only_two_completed_coverage_grids(self):
        self.queue = SimulationJobQueue(self.solver_lock, max_finished=4)
        csi = self.queue.submit("csi", lambda ctx: "summary")["jobId"]
        self.wait_for(csi, "succeeded")
        coverage = []
        for grid in range(3):
            job = self.queue.submit("coverage", lambda ctx: grid)["jobId"]
            self.wait_for(job, "succeeded")
            coverage.append(job)
        self.assertIsNone(self.queue.get(coverage[0]))
        self.assertEqual(self.queue.get(csi)["result"], "summary")
        self.assertEqual([self.queue.get(job)["result"] for job in coverage[1:]], [1, 2])

    def test_finished_history_is_bounded_and_retains_most_recent_result(self):
        jobs = []
        for index in range(4):
            job_id = self.queue.submit("csi", lambda ctx: index)["jobId"]
            self.assertEqual(self.wait_for(job_id, "succeeded")["result"], index)
            jobs.append(job_id)
        self.assertIsNone(self.queue.get(jobs[0]))
        self.assertEqual(self.queue.get(jobs[1])["result"], 1)


if __name__ == "__main__":
    unittest.main()
