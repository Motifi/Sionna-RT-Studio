"""Replay one archived CSI calculation without the Studio service."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory


def _verify_files(folder: Path, files: dict[str, str]) -> None:
    for name, digest in files.items():
        member = (folder / name).resolve()
        if not member.is_relative_to(folder):
            raise ValueError(f"Invalid replay member: {name}")
        checksum = hashlib.sha256()
        with member.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                checksum.update(chunk)
        if checksum.hexdigest() != digest:
            raise ValueError(f"Replay file checksum differs: {name}")


def _configure_variant(original: str | None) -> None:
    from backend.runtime_env import configure_drjit_llvm_path
    from backend.solver_runtime import BACKENDS

    configure_drjit_llvm_path()
    import mitsuba as mi

    requested = os.environ.get("SRTS_MITSUBA_VARIANT")
    if requested and requested not in BACKENDS:
        raise ValueError(f"Unsupported SRTS_MITSUBA_VARIANT: {requested}")
    variants = [requested] if requested else dict.fromkeys(
        variant for variant in (original, *BACKENDS) if variant in BACKENDS
    )
    failures = []
    for variant in variants:
        if variant not in mi.variants():
            failures.append(f"{variant}: not compiled into this Mitsuba build")
            continue
        try:
            mi.set_variant(variant)
            return
        except (ImportError, RuntimeError) as exc:
            reason = str(exc).strip().splitlines()
            failures.append(f"{variant}: {reason[0] if reason else type(exc).__name__}")
    raise RuntimeError("No usable Mitsuba variant. " + " ".join(failures))


def replay(folder: Path) -> None:
    folder = folder.resolve()
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    _verify_files(folder, manifest["files"])
    _configure_variant(manifest["solverRuntime"]["variant"])

    from backend.csi_runs import CsiRunRequest, _ResolvedInputs, _calculate_csi
    from backend.scene_build import load_scene_file
    from backend.solver import _TxSpec
    from backend.solver_runtime import solver_runtime

    request = json.loads((folder / "request.json").read_text(encoding="utf-8"))
    inputs = request.pop("resolved")
    inputs["tx_specs"] = [_TxSpec(**spec) for spec in inputs["tx_specs"]]
    resolved = _ResolvedInputs(**inputs)
    req = CsiRunRequest.model_validate(request)
    scene = load_scene_file(folder / "scene.xml", req.freqGhz, req.materials)
    with TemporaryDirectory(prefix=".replay-", dir=folder) as tmp:
        temporary = Path(tmp)
        _calculate_csi(temporary, req, scene, resolved)
        (temporary / "csi.npz").replace(folder / "csi-replay.npz")
    print(f"Replayed {manifest['runId']} ({manifest['sceneId']}) as csi-replay.npz")
    print(json.dumps(solver_runtime()))


if __name__ == "__main__":
    try:
        replay(Path(__file__).resolve().parent)
    except (OSError, ValueError, RuntimeError, ImportError) as exc:
        sys.exit(f"CSI replay failed: {exc}")
