#!/bin/bash
set -euo pipefail

studio="$(cd "$(dirname "$0")/.." && pwd -P)"
desktop="$studio/desktop"
python="${SRTS_PYTHON:-$studio/.venv/bin/python}"
node="${SRTS_NODE:-$studio/.node/bin/node}"
if [[ ! -x "$node" && -z "${SRTS_NODE:-}" ]]; then
  node="$(command -v node || true)"
fi
cargo="$(command -v "${SRTS_CARGO:-cargo}" || true)"
cargo_target_dir="${CARGO_TARGET_DIR:-$studio/build/desktop-cargo}"
[[ "$python" = /* ]] || python="$PWD/$python"
[[ -z "$node" || "$node" = /* ]] || node="$PWD/$node"
[[ -z "$cargo" || "$cargo" = /* ]] || cargo="$PWD/$cargo"
[[ "$cargo_target_dir" = /* ]] || cargo_target_dir="$PWD/$cargo_target_dir"
destination="${1:-$studio/build/SionnaRTStudio.app}"
bundle_id="org.radioworld.sionna-studio"

if [[ ! -x "$python" ]]; then
  echo "Missing Studio Python environment at $python" >&2
  exit 1
fi
if [[ ! -x "$cargo" ]]; then
  echo 'Rust and Cargo are required to build the Studio desktop app. Install Rust with rustup or set SRTS_CARGO.' >&2
  exit 1
fi
mkdir -p "$(dirname "$destination")"
output_dir="$(cd "$(dirname "$destination")" && pwd -P)"
destination="$output_dir/$(basename "$destination")"
staging="$(mktemp -d "$output_dir/.studio-build.XXXXXX")"
cleanup() {
  if [[ ! -e "$destination" && -d "$staging/previous.app" ]]; then
    mv "$staging/previous.app" "$destination" || return
  fi
  rm -rf "$staging"
}
trap cleanup EXIT
bundle="$staging/SionnaRTStudio.app"
contents="$bundle/Contents"
resources="$contents/Resources"
mkdir -p "$contents/MacOS" "$resources/backend"

if [[ -n "${SRTS_DESKTOP_ASSETS:-}" ]]; then
  cp -R "$SRTS_DESKTOP_ASSETS" "$resources/site"
else
  if [[ ! -x "$node" || ! -f "$studio/node_modules/vite/bin/vite.js" ]]; then
    echo 'Studio Node and Vite are required to build the frontend.' >&2
    exit 1
  fi
  (cd "$studio"; "$node" node_modules/vite/bin/vite.js build --outDir "$resources/site" --emptyOutDir)
fi
test -f "$resources/site/index.html"
cp "$studio"/backend/*.py "$resources/backend/"
cp "$desktop/studio_server.py" "$studio/LICENSE" "$studio/NOTICE" "$resources/"
version="$("$python" -c 'import runpy, sys; print(runpy.run_path(sys.argv[1])["APP_VERSION"])' "$studio/backend/version.py")"
bundled_python=""
if [[ -n "${SRTS_BUNDLED_PYTHON:-}" ]]; then
  if [[ ! -x "$SRTS_BUNDLED_PYTHON/bin/python3.12" ]]; then
    echo 'SRTS_BUNDLED_PYTHON must point to a relocatable arm64 CPython 3.12 prefix with Studio dependencies installed.' >&2
    exit 1
  fi
  ditto "$SRTS_BUNDLED_PYTHON" "$resources/python"
  bundled_python="python/bin/python3.12"
  "$resources/$bundled_python" -B -I - "$resources/python" <<'PY'
from importlib.util import find_spec
from pathlib import Path
import platform
import sys

import fastapi, mapbox_earcut, mitsuba, numpy, shapely, trimesh, uvicorn

root = Path(sys.argv[1]).resolve()
assert platform.machine() == "arm64" and sys.version_info[:2] == (3, 12), "Expected arm64 CPython 3.12"
assert Path(sys.base_prefix).resolve() == root, "Python relies on a prefix outside the app bundle"
for module in (fastapi, mapbox_earcut, mitsuba, numpy, shapely, trimesh, uvicorn):
    assert Path(module.__file__).resolve().is_relative_to(root), f"{module.__name__} is outside the app bundle"
assert find_spec("sionna") is not None, "Sionna RT is missing from the bundled Python"
PY
  metadata_python="$resources/$bundled_python"
  package_kind="macos-arm64-bundled"
else
  metadata_python="$python"
  package_kind="macos-arm64-development"
  printf '%s\n' "$python" > "$resources/python-path.txt"
fi
build_info_args=("$resources/build-info.json" "$package_kind")
if [[ -n "${SRTS_DESKTOP_ASSETS:-}" ]]; then
  build_info_args+=(--prebuilt-frontend)
fi
"$metadata_python" -B -I "$studio/scripts/candidate_info.py" "${build_info_args[@]}"

/usr/bin/sips -c 132 132 --cropOffset 0 0 "$studio/assets/logo-app-bone.png" \
  --out "$staging/icon.png" >/dev/null
for size in 16 32 64 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$staging/icon.png" \
    --out "$staging/icon-${size}.png" >/dev/null
done
"$python" - "$staging" "$resources/Studio.icns" <<'PY'
from pathlib import Path
import struct
import sys

# An ICNS file can store lossless PNG representations directly.
def chunk(kind, payload):
    return struct.pack(">4sI", kind, len(payload) + 8) + payload

source = Path(sys.argv[1])
images = [(16, b"icp4"), (32, b"icp5"), (64, b"icp6"), (128, b"ic07"), (256, b"ic08"), (512, b"ic09")]
icon = b"".join(chunk(kind, (source / f"icon-{size}.png").read_bytes()) for size, kind in images)
Path(sys.argv[2]).write_bytes(chunk(b"icns", icon))
PY

"$python" - "$contents/Info.plist" "$python" "$bundle_id" "$version" "$bundled_python" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "wb") as info:
    plistlib.dump({
        "CFBundleDevelopmentRegion": "en",
        "CFBundleDisplayName": "Sionna RT Studio",
        "CFBundleExecutable": "SionnaRTStudio",
        "CFBundleIconFile": "Studio.icns",
        "CFBundleIdentifier": sys.argv[3],
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": "Sionna RT Studio",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": sys.argv[4],
        "CFBundleVersion": sys.argv[4],
        "LSMinimumSystemVersion": "14.0",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "NSHighResolutionCapable": True,
        **({"StudioBundledPython": sys.argv[5]} if sys.argv[5] else {"StudioPythonPath": sys.argv[2]}),
    }, info)
PY
/usr/bin/plutil -lint "$contents/Info.plist"
target="aarch64-apple-darwin"
if ! (cd "$studio" && MACOSX_DEPLOYMENT_TARGET=14.0 "$cargo" build --release --locked \
  --manifest-path "$desktop/src-tauri/Cargo.toml" --target "$target" --target-dir "$cargo_target_dir"); then
  echo 'The Studio desktop build failed. Check the Cargo output and the macOS Command Line Tools.' >&2
  exit 1
fi
/usr/bin/install -m 755 "$cargo_target_dir/$target/release/SionnaRTStudio" "$contents/MacOS/SionnaRTStudio"
/usr/bin/codesign --force --sign - "$bundle"
/usr/bin/codesign --verify --strict "$bundle"

if [[ -L "$destination" ]]; then
  echo "Refusing to replace a symbolic link at $destination" >&2
  exit 1
fi
if [[ -e "$destination" ]]; then
  current_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$current_id" != "$bundle_id" ]]; then
    echo "Refusing to replace an unrelated bundle at $destination" >&2
    exit 1
  fi
  mv "$destination" "$staging/previous.app"
fi
if ! mv "$bundle" "$destination"; then
  if [[ -d "$staging/previous.app" ]]; then
    mv "$staging/previous.app" "$destination"
  fi
  exit 1
fi
printf 'Built %s\n' "$destination"
