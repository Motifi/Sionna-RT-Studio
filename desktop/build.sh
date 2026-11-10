#!/bin/bash
set -euo pipefail

studio="$(cd "$(dirname "$0")/.." && pwd -P)"
desktop="$studio/desktop"
python="${SRTS_PYTHON:-$studio/.venv/bin/python}"
node="${SRTS_NODE:-$studio/.node/bin/node}"
if [[ ! -x "$node" && -z "${SRTS_NODE:-}" ]]; then
  node="$(command -v node || true)"
fi
[[ "$python" = /* ]] || python="$PWD/$python"
[[ -z "$node" || "$node" = /* ]] || node="$PWD/$node"
destination="${1:-$studio/build/SionnaRTStudio.app}"
bundle_id="org.radioworld.sionna-studio"

if [[ ! -x "$python" ]]; then
  echo "Missing Studio Python environment at $python" >&2
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

"$python" - "$contents/Info.plist" "$python" "$bundle_id" <<'PY'
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
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "14.0",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "NSHighResolutionCapable": True,
        "StudioPythonPath": sys.argv[2],
    }, info)
PY
/usr/bin/plutil -lint "$contents/Info.plist"
cache="${SRTS_SWIFT_CACHE:-$studio/build/studio-swift-cache}"
mkdir -p "$cache"
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 -parse-as-library -O \
  -module-cache-path "$cache" "$desktop/Studio.swift" \
  -o "$contents/MacOS/SionnaRTStudio"
/usr/bin/codesign --force --sign - "$bundle"
/usr/bin/codesign --verify --strict "$bundle"

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
