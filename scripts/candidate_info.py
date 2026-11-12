"""Record the checkout and runtime used for a desktop build or solver check."""
import argparse
from hashlib import sha256
from importlib import metadata
import json
import os
from pathlib import Path
import platform
import re
import runpy
import subprocess
import tomllib


ROOT = Path(__file__).resolve().parents[1]


def _git(*args):
    try:
        return subprocess.check_output(
            ["git", "-C", str(ROOT), *args], text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def source_revision():
    # A source snapshot can carry a base revision supplied by its builder.
    # A checkout always reports the actual HEAD, including CI merge commits.
    commit = _git("rev-parse", "--verify", "HEAD") if (ROOT / ".git").exists() else None
    if commit is not None:
        status = _git("status", "--porcelain")
        dirty = bool(status) if status is not None else None
    else:
        commit = os.getenv("SRTS_BUILD_COMMIT")
        dirty = {"1": True, "0": False}.get(os.getenv("SRTS_BUILD_DIRTY"))
    if commit and not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", commit):
        raise ValueError("SRTS_BUILD_COMMIT must be a full Git commit ID.")
    return {"commit": commit, "sourceDirty": dirty}


def runtime_packages():
    packages = {"python": platform.python_version()}
    for name in ("sionna-rt", "mitsuba", "drjit", "numpy", "shapely", "trimesh", "mapbox-earcut",
                 "fastapi", "uvicorn", "pydantic"):
        try:
            packages[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            packages[name] = None
    return packages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("kind", choices=("macos-arm64-development", "macos-arm64-bundled", "windows-x64-installed"))
    parser.add_argument("--prebuilt-frontend", action="store_true")
    args = parser.parse_args()
    version = runpy.run_path(str(ROOT / "backend" / "version.py"))["APP_VERSION"]
    package = json.loads((ROOT / "package.json").read_bytes())
    lock_bytes = (ROOT / "package-lock.json").read_bytes()
    lock = json.loads(lock_bytes)
    shell = ROOT / "desktop" / "src-tauri"
    with (shell / "Cargo.toml").open("rb") as manifest:
        rust_version = tomllib.load(manifest)["package"]["version"]
    config = json.loads((shell / "tauri.conf.json").read_bytes())
    versions = (package["version"], lock["version"], lock["packages"][""]["version"],
                rust_version, config.get("version", rust_version))
    if any(value != version for value in versions):
        raise ValueError("Studio backend, frontend, and desktop shell versions disagree.")
    info = {
        "schemaVersion": 1, "appVersion": version, "kind": args.kind, **source_revision(),
        "prebuiltFrontend": args.prebuilt_frontend, "frontendLockSha256": sha256(lock_bytes).hexdigest(),
        "packages": runtime_packages(),
    }
    args.output.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
