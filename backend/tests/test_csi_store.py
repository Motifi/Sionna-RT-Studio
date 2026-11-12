"""Project history stays readable through restart and interrupted publication."""
from concurrent.futures import ThreadPoolExecutor
import errno
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4
import zipfile

import numpy as np

from backend.csi_runs import CsiRun, _Link, _write_json
from backend.csi_store import CsiRunStore
from backend.simulation_jobs import SimulationCancelled
from backend.solver import _channel_metrics


class TestCsiStore(unittest.TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.store = CsiRunStore(self.root)
        self.project = uuid4()

    def stage(self, index):
        directory = TemporaryDirectory(dir=self.store.prepare(self.project), prefix=".stage-")
        self.addCleanup(directory.cleanup)
        staged = Path(directory.name)
        np.savez_compressed(staged / "csi.npz", a=np.asarray([index]))
        sha256 = hashlib.sha256((staged / "csi.npz").read_bytes()).hexdigest()
        request = {"buildings": [], "anchor": None, "txs": [{"id": "tx"}],
                   "rxs": [{"id": "rx"}], "materials": []}
        _write_json(staged / "request.json", request)
        summary = {
            "projectId": str(self.project), "runId": uuid4().hex, "mode": "static", "output": "cir",
            "sceneId": "scene", "createdAtUtc": f"2026-11-12T12:00:0{index}+00:00",
            "txIds": ["tx"], "rxIds": ["rx"], "timeSeconds": [0.0], "uncompressedBytes": 4,
        }
        manifest = {**summary, "files": {"csi.npz": sha256},
                    "fronthaulMbpsByTxId": {"tx": 4.0}}
        run = CsiRun(directory, summary, manifest, [[_Link([], _channel_metrics([]))]],
                     np.asarray([1.0]), np.asarray([[[[float(index)]]]]))
        return run

    def test_reopened_store_previews_and_downloads_oldest_result(self):
        traces = []
        for index in range(3):
            traces.append(self.stage(index))
            self.store.publish(self.project, traces[-1])
        first = traces[0]
        run_id = first.summary["runId"]
        restarted = CsiRunStore(self.root)
        self.assertEqual([entry["runId"] for entry in restarted.list(self.project)],
                         [run.summary["runId"] for run in reversed(traces)])
        record = restarted.get(self.project, run_id)
        self.assertIsNotNone(record)
        self.assertEqual(record.preview(0, "tx", "rx")["magnitudeDb"],
                         first.preview(0, "tx", "rx")["magnitudeDb"])
        self.assertEqual(record.detail()["snapshot"]["txs"], [{"id": "tx"}])
        self.assertEqual(record.detail()["fronthaulMbpsByTxId"], {"tx": 4.0})
        with self.assertRaisesRegex(ValueError, "not in the CSI run"):
            record.preview(0, "outside", "rx")
        destination = self.root / "export.zip"
        for update, expected in ((None, 4.0), ({"tx": 19.0}, 19.0)):
            record.write_export(destination, update)
            with zipfile.ZipFile(destination) as archive:
                self.assertEqual(hashlib.sha256(archive.read("csi.npz")).hexdigest(),
                                 first.manifest["files"]["csi.npz"])
                self.assertEqual(json.loads(archive.read("manifest.json"))["fronthaulMbpsByTxId"],
                                 {"tx": expected})
        self.assertEqual(record.detail()["fronthaulMbpsByTxId"], {"tx": 4.0})
        other = uuid4()
        self.assertEqual(restarted.list(other), [])
        self.assertIsNone(restarted.get(other, run_id))
        self.assertIsNone(restarted.get(self.project, "../" + run_id))

    def test_cancellation_before_atomic_publish_removes_staged_files(self):
        old = self.stage(0)
        self.store.publish(self.project, old)
        cancelled = self.stage(1)
        run_id = cancelled.summary["runId"]

        def cancel_before_rename():
            self.assertIsNone(self.store.get(self.project, run_id))
            raise SimulationCancelled()

        with self.assertRaises(SimulationCancelled):
            self.store.publish(self.project, cancelled, before_publish=cancel_before_rename)
        self.assertFalse(Path(cancelled.directory.name).exists())
        self.assertIsNone(self.store.get(self.project, run_id))
        self.assertEqual([entry["runId"] for entry in self.store.list(self.project)],
                         [old.summary["runId"]])

    def test_partial_write_is_hidden_and_old_record_survives(self):
        old = self.stage(0)
        self.store.publish(self.project, old)
        broken = self.stage(1)
        old_id = old.summary["runId"]
        broken_id = broken.summary["runId"]

        def fail_rename(*_args):
            with ThreadPoolExecutor(max_workers=1) as readers:
                listed = readers.submit(self.store.list, self.project)
                self.assertEqual([entry["runId"] for entry in listed.result()], [old_id])
                found = readers.submit(self.store.get, self.project, broken_id)
                self.assertIsNone(found.result())
            raise OSError(errno.ENOSPC, "test disk full")

        with patch("backend.csi_store.os.rename", side_effect=fail_rename):
            with self.assertRaisesRegex(OSError, "test disk full"):
                self.store.publish(self.project, broken)
        self.assertFalse(Path(broken.directory.name).exists())
        self.assertIsNotNone(self.store.get(self.project, old_id))
        self.assertIsNone(self.store.get(self.project, broken_id))
