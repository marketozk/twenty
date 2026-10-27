import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from check_fork_migration_sources import verify_sources


class MigrationSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "packages/twenty-server/src/database/commands/fork-upgrade/steps/test.migration.ts"
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b"export const migration = 1;\n")
        self.manifest = self.root / "packages/twenty-server/src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json"
        self.manifest.parent.mkdir(parents=True)
        self.entries = [{"migrationId": "test", "sourcePath": self.source.relative_to(self.root).as_posix(), "checksum": hashlib.sha256(self.source.read_bytes()).hexdigest()}]
        self.save()

    def save(self):
        self.manifest.write_text(json.dumps(self.entries), encoding="utf-8")

    def test_valid_and_crlf_equivalent(self):
        self.assertEqual(verify_sources(self.root), 1)
        self.source.write_bytes(self.source.read_bytes().replace(b"\n", b"\r\n"))
        self.assertEqual(verify_sources(self.root), 1)

    def test_changed_source_rejected(self):
        self.source.write_bytes(b"changed\n")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            verify_sources(self.root)

    def test_unlisted_source_rejected(self):
        self.source.with_name("extra.migration.ts").write_text("extra", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "sources and manifest"):
            verify_sources(self.root)

    def test_duplicate_source_rejected(self):
        self.entries.append(self.entries[0].copy())
        self.save()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            verify_sources(self.root)

    def test_escaping_path_rejected(self):
        self.entries[0]["sourcePath"] = "../outside.ts"
        self.save()
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            verify_sources(self.root)

    def test_sixth_wakeup_append_preserves_the_first_five_sources(self):
        repository = Path(__file__).resolve().parents[2]
        manifest = json.loads((repository / "packages/twenty-server/src/engine/core-modules/omnichannel-storage/migrations/fork-schema-manifest.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(manifest), 6)
        self.assertEqual(manifest[5]["migrationId"], "omni-1793116941052-binding-config-wakeup")
        self.assertEqual([entry["checksum"] for entry in manifest[:5]], [
            "3414e5e6106b5ffa75e1f95d5bfcf6e3da96f86a4a84d3b4de7e9b2fad85a108",
            "a6347336b5c4dfd0a5eda047b0945acdca0c3a46a83f3bc4bcc609ba36582ed2",
            "2fbd5c91d07f4934aff21d646dc69adf14e79aa5f77c807634d92eef05645ce7",
            "0a09b9a98d78795565d154fec08497a5e39c909d49486433afe4e02cddb08e9d",
            "8fd7b96cfcfbd4d0dad52fdf8db41d93403bcdeabc571cb5bab217d97a6087ac",
        ])
        self.assertEqual(verify_sources(repository), len(manifest))


if __name__ == "__main__":
    unittest.main()
