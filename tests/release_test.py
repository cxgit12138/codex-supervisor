import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release", ROOT / "lib/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PackageTest(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.work = Path(work.name).resolve()
        self.data = self.work / "config/codex-supervisor"
        self.data.mkdir(parents=True)
        self.settings = self.data / "settings.json"
        self.settings.write_text('{"openDesktop":false}')
        self.install = self.work / "config/plugins/codex-supervisor"
        self.install.mkdir(parents=True)
        (self.install / "plugin.json").write_text('{"name":"codex-supervisor","version":"1.3.2"}')
        release.pack(ROOT, self.work, "a" * 40, "latest")
        self.manifest = json.loads((self.work / "release-manifest.json").read_bytes())
        self.zip = self.work / release.ASSET

    def apply(self, manifest):
        with tempfile.TemporaryDirectory(dir=self.data) as tmp:
            stage = Path(tmp) / "next"
            release.stage_package(self.zip, manifest, stage)
            return release.activate(self.install, stage, self.data)

    def test_package_and_install(self):
        with ZipFile(self.zip) as z:
            names = z.namelist()
            self.assertTrue(release.REQUIRED.issubset(names))
            self.assertTrue(all(release.runtime_file(n) for n in names))
            self.assertTrue(any(n.endswith(".js.gz") for n in names))
            self.assertFalse(any(n.startswith(("mjq/", "tests/", "node_modules/", ".git")) for n in names))
        backup = self.apply(self.manifest)
        self.assertEqual(release.manifest_at(backup)["version"], "1.3.2")
        self.assertEqual(json.loads((self.install / release.INFO).read_bytes())["commitSha"], "a" * 40)
        self.assertEqual(self.settings.read_text(), '{"openDesktop":false}')

    def test_bad_hash_and_metadata_preserve_installed_version(self):
        for overrides in ({"sha256": "0" * 64}, {"version": "9.9.9"}, {"commitSha": "b" * 40}):
            with self.assertRaises(ValueError):
                self.apply({**self.manifest, **overrides})
            self.assertEqual(release.manifest_at(self.install)["version"], "1.3.2")

    def test_invalid_archive_path_rejected_before_install(self):
        with ZipFile(self.zip, "a") as archive:
            archive.writestr("../outside.txt", "invalid")
        self.manifest["sha256"] = hashlib.sha256(self.zip.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "无效路径"):
            self.apply(self.manifest)
        self.assertEqual(release.manifest_at(self.install)["version"], "1.3.2")

    def test_switch_failure_restores_old_install(self):
        rename = os.rename

        def fail_install(source, target):
            if Path(source).name == "next":
                raise PermissionError("模拟 Windows 文件占用")
            return rename(source, target)

        with patch.object(release.os, "rename", side_effect=fail_install):
            with self.assertRaises(PermissionError):
                self.apply(self.manifest)
        self.assertEqual(release.manifest_at(self.install)["version"], "1.3.2")
        self.assertTrue(self.settings.is_file())

    def test_tag_must_match_manifest(self):
        with self.assertRaises(ValueError):
            release.pack(ROOT, self.work, "a" * 40, "v0.0.1")


if __name__ == "__main__":
    unittest.main()
