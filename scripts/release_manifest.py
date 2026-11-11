"""Create and verify an RSA/SHA-256 release manifest using an external trust key.

Run from the repo root: python -m scripts.release_manifest --help
The signing key belongs outside the checkout. Distribute the public key through
a trusted channel separate from the release assets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from backend.release_updates import ASSET_NAME
from backend.version import APP_VERSION

MANIFEST_NAME = "release-manifest.json"
SIGNATURE_NAME = "release-manifest.sig"


def _describe(path: Path, version: str) -> dict:
    spec = ASSET_NAME.fullmatch(path.name)
    if not spec or spec["version"] != version:
        raise ValueError(f"Asset name does not match Studio {version}: {path.name}")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    os_name, architecture = spec["platform"].split("-")
    return {"file": path.name, "os": os_name, "architecture": architecture,
            "minimumOs": spec["minimum"], "size": path.stat().st_size, "sha256": digest}


def sign(directory: Path, key: Path, filenames: list[str]) -> None:
    if not filenames or len(set(filenames)) != len(filenames):
        raise ValueError("Specify at least one unique release asset.")
    manifest = directory / MANIFEST_NAME
    signature = directory / SIGNATURE_NAME
    contents = {
        "schemaVersion": 1, "version": APP_VERSION, "signatureAlgorithm": "RSA-PKCS1-SHA256",
        "assets": [_describe(directory / _asset_name(name), APP_VERSION) for name in sorted(filenames)],
    }
    manifest.write_text(json.dumps(contents, indent=2) + "\n", encoding="utf-8")
    subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(key),
                    "-out", str(signature), str(manifest)], check=True)


def _asset_name(name: str) -> str:
    if not ASSET_NAME.fullmatch(name):
        raise ValueError(f"Unexpected release filename: {name}")
    return name


def verify(directory: Path, key: Path, version: str, filename: str | None = None) -> dict:
    manifest = directory / MANIFEST_NAME
    signature = directory / SIGNATURE_NAME
    subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(key),
                    "-signature", str(signature), str(manifest)], check=True)
    contents = json.loads(manifest.read_text(encoding="utf-8"))
    if (contents["schemaVersion"] != 1 or contents["version"] != version
            or contents["signatureAlgorithm"] != "RSA-PKCS1-SHA256"):
        raise ValueError("Release manifest schema, version or signature algorithm mismatch.")
    entries = contents["assets"]
    if filename:
        entries = [entry for entry in entries if entry["file"] == filename]
    if not entries:
        raise ValueError("No matching package is listed in the signed manifest.")
    for expected in entries:
        name = _asset_name(expected["file"])
        if _describe(directory / name, version) != expected:
            raise ValueError(f"Package length, hash or compatibility metadata mismatch: {name}")
    return contents


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("sign")
    create.add_argument("directory", type=Path)
    create.add_argument("private_key", type=Path)
    create.add_argument("assets", nargs="+")
    check = commands.add_parser("verify")
    check.add_argument("directory", type=Path)
    check.add_argument("public_key", type=Path)
    check.add_argument("--version", default=APP_VERSION)
    check.add_argument("--asset")
    args = parser.parse_args()
    if args.command == "sign":
        sign(args.directory, args.private_key, args.assets)
    else:
        verify(args.directory, args.public_key, args.version, args.asset)


if __name__ == "__main__":
    main()
