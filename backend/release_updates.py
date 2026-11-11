"""Daily stable-release discovery for desktop installs."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import re
import socket
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .version import APP_VERSION

REPOSITORY = "Motifi/Sionna-RT-Studio"
RELEASES_URL = f"https://github.com/{REPOSITORY}/releases"
LATEST_URL = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
STABLE_VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
ASSET_NAME = re.compile(
    rf"SionnaRTStudio-(?P<version>{STABLE_VERSION})-"
    r"(?P<platform>macos-arm64|windows-x64)-min(?P<minimum>[0-9]+(?:\.[0-9]+){1,3})"
    r"\.(?P<extension>dmg|zip|msi|exe)"
)
_MAX_RELEASE_BYTES = 1024 * 1024


def platform_install():
    system, machine = platform.system(), platform.machine().lower()
    if system == "Darwin" and machine == "arm64":
        return "macos-arm64", platform.mac_ver()[0]
    if system == "Windows" and machine in ("amd64", "x86_64"):
        return "windows-x64", platform.version()
    return None, ""


def _version(value: str) -> tuple[int, ...]:
    parts = tuple(int(part) for part in value.split("."))
    return parts + (0,) * (4 - len(parts))


def select_update(release: dict, current: str, target: str | None, os_version: str) -> dict:
    tag = release.get("tag_name", "")
    match = re.fullmatch(rf"v?({STABLE_VERSION})(?:\+[0-9A-Za-z.-]+)?", tag) if isinstance(tag, str) else None
    if release.get("draft") or release.get("prerelease") or not match:
        return {"status": "no_stable_release"}
    version = match[1]
    if _version(version) <= _version(current):
        return {"status": "up_to_date", "version": version}
    release_url = f"{RELEASES_URL}/tag/{quote(tag, safe='')}"
    latest = {"version": version, "releaseUrl": release_url,
              "notes": str(release.get("body") or "")[:16_000]}
    matched = []
    for asset in release.get("assets", []):
        name = asset.get("name", "")
        size = asset.get("size")
        if not isinstance(name, str) or not isinstance(size, int) or size <= 0:
            continue
        spec = ASSET_NAME.fullmatch(name)
        if not spec or spec["version"] != version or spec["platform"] != target:
            continue
        if spec["extension"] not in ({"zip", "dmg"} if target == "macos-arm64" else {"zip", "exe", "msi"}):
            continue
        if not os_version or _version(os_version) < _version(spec["minimum"]):
            continue
        # Reconstruct the download URL from the release and asset identity.
        matched.append({
            "name": name, "size": size, "minimumOs": spec["minimum"],
            "url": f"{RELEASES_URL}/download/{quote(tag, safe='')}/{quote(name, safe='')}",
        })
    if not matched:
        return {"status": "no_compatible_asset", **latest}
    rank = {"dmg": 0, "msi": 0, "exe": 1, "zip": 2}
    asset = min(matched, key=lambda item: (rank[item["name"].rsplit(".", 1)[-1]], item["name"]))
    return {"status": "available", **latest, "asset": asset}


def fetch_latest() -> dict:
    request = Request(LATEST_URL, headers={"Accept": "application/vnd.github+json", "User-Agent": "SionnaRTStudio"})
    with urlopen(request, timeout=8) as response:
        payload = response.read(_MAX_RELEASE_BYTES + 1)
    if len(payload) > _MAX_RELEASE_BYTES:
        raise ValueError("GitHub response exceeds the metadata size limit.")
    release = json.loads(payload)
    if not isinstance(release, dict) or not isinstance(release.get("assets"), list):
        raise ValueError("GitHub returned invalid release metadata.")
    return release


class ReleaseChecker:
    def __init__(self, cache: Path):
        self._lock = threading.Lock()
        self._cache = cache
        target, os_version = platform_install()
        self._install = target, os_version
        self._status = {"status": "not_checked", "currentVersion": APP_VERSION,
                        "platform": target, "osVersion": os_version, "releasesUrl": RELEASES_URL}
        try:
            saved = json.loads(cache.read_text(encoding="utf-8"))
            if (saved["currentVersion"], saved["platform"], saved["osVersion"]) == (APP_VERSION, target, os_version):
                self._status.update(saved)
        except (OSError, ValueError, KeyError, TypeError):
            pass
        self._checking = False

    def status(self) -> dict:
        with self._lock:
            return {**self._status, "checking": self._checking}

    def check(self, manual: bool = False) -> None:
        with self._lock:
            if self._checking:
                return
            checked_at = self._status.get("checkedAt")
            if checked_at and not manual:
                try:
                    age = (datetime.now(timezone.utc) - datetime.fromisoformat(checked_at)).total_seconds()
                    if 0 <= age < 86400:
                        return
                except (ValueError, TypeError):
                    pass
            self._checking = True
        threading.Thread(target=self._refresh, daemon=True, name="studio-release-check").start()

    def _refresh(self) -> None:
        try:
            result = select_update(fetch_latest(), APP_VERSION, *self._install)
        except HTTPError as exc:
            result = {"status": "no_stable_release"} if exc.code == 404 else {"status": "http_error", "detail": str(exc.code)}
        except (URLError, TimeoutError) as exc:
            reason = getattr(exc, "reason", exc)
            result = {"status": "timeout" if isinstance(reason, (TimeoutError, socket.timeout)) else "offline"}
        except (OSError, ValueError, AttributeError, TypeError):
            result = {"status": "invalid_response"}
        with self._lock:
            for key in ("version", "notes", "asset", "releaseUrl", "detail"):
                self._status.pop(key, None)
            self._status.update(result, checkedAt=datetime.now(timezone.utc).isoformat())
            self._checking = False
            try:
                self._cache.parent.mkdir(parents=True, exist_ok=True)
                staged = self._cache.with_name(f"{self._cache.name}.{os.getpid()}.tmp")
                staged.write_text(json.dumps(self._status), encoding="utf-8")
                staged.replace(self._cache)
            except OSError:
                pass


def desktop_update_cache() -> Path:
    base = (Path(os.environ["LOCALAPPDATA"]) if platform.system() == "Windows" and "LOCALAPPDATA" in os.environ
            else Path.home() / "Library" / "Application Support")
    return base / "SionnaRTStudio" / "release-check.json"
