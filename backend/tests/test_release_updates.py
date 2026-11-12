import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.release_updates import RELEASES_URL, ReleaseChecker, select_update
from backend.version import APP_VERSION
from scripts.release_manifest import MANIFEST_NAME, sign, verify


def release(tag="v1.10.0", *names, **flags):
    return {"tag_name": tag, "assets": [{"name": name, "size": 1234} for name in names], **flags}


class TestReleaseSelection(unittest.TestCase):
    def test_stable_asset_uses_numeric_semver_and_minimum_os(self):
        names = ("SionnaRTStudio-1.10.0-macos-arm64-min15.0.dmg",
                 "SionnaRTStudio-1.10.0-macos-arm64-min14.0.zip",
                 "SionnaRTStudio-1.10.0-windows-x64-min10.0.22000.exe")
        version = release("v1.10.0", *names)
        update = select_update(version, "1.9.9", "macos-arm64", "14.6")
        self.assertEqual(update["status"], "available")
        self.assertEqual(update["asset"]["name"], names[1])
        self.assertEqual(update["asset"]["url"], f"{RELEASES_URL}/download/v1.10.0/{names[1]}")
        self.assertEqual(select_update(version, "1.9.9", "windows-x64", "10.0.22631")["asset"]["name"], names[2])
        self.assertEqual(select_update(version, "1.9.9", "windows-x64", "10.0.19045")["status"], "no_compatible_asset")
        self.assertEqual(select_update(version, "1.9.9", None, "")["status"], "no_compatible_asset")

    def test_ignores_prerelease_draft_and_older_version(self):
        for metadata in (release("v2.0.0-rc.1"), release("v2.0.0", prerelease=True), release("v2.0.0", draft=True)):
            self.assertEqual(select_update(metadata, "1.0.0", "macos-arm64", "14.0")["status"], "no_stable_release")
        self.assertEqual(select_update(release("v1.2.0"), "1.3.0", "macos-arm64", "14.0")["status"], "up_to_date")

    def test_throttle_persists_and_manual_check_bypasses_it(self):
        with tempfile.TemporaryDirectory() as root, patch("backend.release_updates.fetch_latest", return_value=release(APP_VERSION)):
            path = Path(root) / "updates.json"
            ReleaseChecker(path)._refresh()
            with patch("backend.release_updates.threading.Thread") as thread:
                restored = ReleaseChecker(path)
                restored.check()
                thread.assert_not_called()
                restored.check(manual=True)
                thread.assert_called_once()

    def test_reports_offline_and_timeout(self):
        from urllib.error import URLError
        for error, status in [(URLError("offline"), "offline"), (TimeoutError(), "timeout")]:
            with tempfile.TemporaryDirectory() as root, patch("backend.release_updates.fetch_latest", side_effect=error):
                checker = ReleaseChecker(Path(root) / "updates.json")
                checker._refresh()
                self.assertEqual(checker.status()["status"], status)


@unittest.skipUnless(shutil.which("openssl"), "requires openssl")
class TestReleaseManifest(unittest.TestCase):
    def test_rejects_changes_to_package_or_signed_manifest(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            private_key, public_key = root / "private.pem", root / "public.pem"
            assets = root / "assets"
            assets.mkdir()
            mac = f"SionnaRTStudio-{APP_VERSION}-macos-arm64-min14.0.zip"
            windows = f"SionnaRTStudio-{APP_VERSION}-windows-x64-min10.0.22000.zip"
            for name in (mac, windows):
                (assets / name).write_bytes(b"fixture")
            subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-out", str(private_key)],
                           check=True, capture_output=True)
            subprocess.run(["openssl", "pkey", "-in", str(private_key), "-pubout", "-out", str(public_key)],
                           check=True, capture_output=True)
            sign(assets, private_key, [mac, windows])
            entries = verify(assets, public_key, APP_VERSION)["assets"]
            self.assertEqual([(asset["os"], asset["architecture"], asset["minimumOs"]) for asset in entries],
                             [("macos", "arm64", "14.0"), ("windows", "x64", "10.0.22000")])
            with self.assertRaisesRegex(ValueError, "version"):
                verify(assets, public_key, "0.0.0")
            (assets / mac).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "hash"):
                verify(assets, public_key, APP_VERSION)
            manifest = assets / MANIFEST_NAME
            manifest.write_bytes(manifest.read_bytes() + b" ")
            with self.assertRaises(subprocess.CalledProcessError):
                verify(assets, public_key, APP_VERSION)
