"""Immutable, project-scoped CSI history backed by the user's data directory."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import cached_property
import json
import os
from pathlib import Path
import re
import sys
from uuid import UUID
import zipfile

from .csi_runs import CsiRun, _json_bytes, _preview_indices, _sha256, _write_export, _write_json


_RUN_ID = re.compile(r"[a-f0-9]{32}")
_RECORD_VERSION = 1
_LIST_FIELDS = (
    "runId", "projectId", "createdAtUtc", "mode", "output", "sceneId",
    "uncompressedBytes", "archiveBytes",
)


def csi_runs_dir() -> Path:
    if configured := os.environ.get("SRTS_RUNS_DIR"):
        return Path(configured).expanduser()
    if sys.platform == "win32":
        data = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        data = Path.home() / "Library" / "Application Support"
    else:
        data = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return data / "SionnaRTStudio" / "csi-runs"


def _read_json(file: Path) -> dict:
    return json.loads(file.read_bytes())


def _preview_member(sample_index: int, rx_index: int, tx_index: int) -> str:
    return f"{sample_index}/{rx_index}/{tx_index}.json"


@dataclass
class ArchivedCsiRun:
    directory: Path
    index: dict

    @cached_property
    def summary(self) -> dict:
        return _read_json(self.directory / "summary.json")

    def detail(self) -> dict:
        request = _read_json(self.directory / "request.json")
        return {
            "run": self.summary,
            "snapshot": {key: request[key] for key in ("buildings", "anchor", "txs", "rxs", "materials")},
            "fronthaulMbpsByTxId": self.index["fronthaulMbpsByTxId"],
        }

    def preview(self, sample_index: int, tx_id: str, rx_id: str) -> dict:
        rx_index, tx_index = _preview_indices(self.index, sample_index, tx_id, rx_id)
        with zipfile.ZipFile(self.directory / "preview.zip") as previews:
            return json.loads(previews.read(_preview_member(sample_index, rx_index, tx_index)))

    def write_export(self, destination: Path, fronthaul: dict[str, float | None] | None) -> None:
        _write_export(self.directory, destination, _read_json(self.directory / "manifest.json"), fronthaul)


class CsiRunStore:
    def __init__(self, root: Path):
        self.root = root.absolute()

    def prepare(self, project_id: UUID) -> Path:
        directory = self.root / str(project_id)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        return directory

    def publish(self, project_id: UUID, run: CsiRun, *, checkpoint: Callable[[], None] | None = None,
                before_publish: Callable[[], None] | None = None) -> None:
        directory = Path(run.directory.name)
        summary = run.summary
        run_id = summary["runId"]
        project = self.root / str(project_id)
        try:
            if checkpoint is not None:
                checkpoint()
            if (directory.parent != project or not directory.name.startswith(".stage-")
                    or summary.get("projectId") != str(project_id) or not _RUN_ID.fullmatch(run_id)):
                raise ValueError("CSI run does not belong to this project")
            _write_json(directory / "summary.json", summary)
            _write_json(directory / "manifest.json", run.manifest)
            with zipfile.ZipFile(directory / "preview.zip", "w", zipfile.ZIP_DEFLATED) as previews:
                for sample_index in range(len(summary["timeSeconds"])):
                    for rx_index in range(len(summary["rxIds"])):
                        if checkpoint is not None:
                            checkpoint()
                        for tx_index in range(len(summary["txIds"])):
                            previews.writestr(
                                _preview_member(sample_index, rx_index, tx_index),
                                _json_bytes(run.preview_at(sample_index, rx_index, tx_index)),
                            )
            _write_json(directory / "index.json", {
                "schemaVersion": _RECORD_VERSION,
                **{key: summary[key] for key in (*_LIST_FIELDS, "txIds", "rxIds", "timeSeconds")
                   if key in summary},
                "fronthaulMbpsByTxId": run.manifest["fronthaulMbpsByTxId"],
                "files": {name: _sha256(directory / name)
                          for name in ("summary.json", "manifest.json", "preview.zip")},
            })
            # The source and target share one parent and filesystem. Until
            # this rename succeeds the staging directory is invisible to readers.
            if before_publish is not None:
                before_publish()
            os.rename(directory, project / run_id)
        finally:
            run.directory.cleanup()

    def get(self, project_id: UUID, run_id: str) -> ArchivedCsiRun | None:
        if not _RUN_ID.fullmatch(run_id):
            return None
        directory = self.root / str(project_id) / run_id
        try:
            index = _read_json(directory / "index.json")
        except (FileNotFoundError, NotADirectoryError):
            return None
        if (index.get("schemaVersion") != _RECORD_VERSION
                or index.get("projectId") != str(project_id) or index.get("runId") != run_id):
            return None
        return ArchivedCsiRun(directory, index)

    def list(self, project_id: UUID) -> list[dict]:
        project = self.root / str(project_id)
        if not project.exists():
            return []
        rows = []
        for entry in project.iterdir():
            record = self.get(project_id, entry.name)
            if record is not None:
                rows.append({key: record.index[key] for key in _LIST_FIELDS if key in record.index})
        return sorted(rows, key=lambda row: (row["createdAtUtc"], row["runId"]), reverse=True)
