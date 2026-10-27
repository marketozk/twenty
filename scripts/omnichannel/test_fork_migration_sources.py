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


if __name__ == "__main__":
    unittest.main()
