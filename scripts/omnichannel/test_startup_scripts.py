"""Linux shell failure tests; no real database or application is started."""

import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipIf(os.name == "nt", "The image entrypoints run on Linux")
class StartupScriptsTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.log = self.directory / "events"
        self.env = dict(os.environ, PATH=str(self.directory) + ":" + os.environ["PATH"],
                        EVENTS=str(self.log), TWENTY_MIGRATION_DATABASE_STATE="existing", FAIL_AT="0",
                        PG_DATABASE_URL="test-only", REDIS_URL="test-only")
        self.env.pop("DISABLE_DB_MIGRATIONS", None)
        self.env.pop("DISABLE_CRON_JOBS_REGISTRATION", None)
        for name in ("node", "runtime"):
            path = self.directory / name
            label = name + " $*"
            body = '#!/bin/sh\nprintf "%s\\n" "' + label + '" >> "$EVENTS"\n'
            body += '[ "$(wc -l < "$EVENTS")" -eq "$FAIL_AT" ] && exit 9\n'
            body += 'exit 0\n'
            path.write_text(body, encoding="utf-8")
            path.chmod(0o755)

    def run_script(self, name="migrate.sh", args=()):
        self.log.unlink(missing_ok=True)
        return subprocess.run(["sh", str(ROOT / "ops/omnichannel" / name), *args],
                              env=self.env, capture_output=True, text=True)

    def events(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_existing_database_does_not_force_initialize(self):
        self.assertEqual(self.run_script().returncode, 0)
        events = self.events()
        self.assertFalse(any("setup-db" in event or "--force" in event for event in events))
        self.assertTrue(any("upgrade:status --strict" in event for event in events))
        self.assertEqual(events[-1], "node dist/command/command.js cron:register:all --strict")

    def test_fresh_initializes_before_upgrade_and_fork(self):
        self.env["TWENTY_MIGRATION_DATABASE_STATE"] = "fresh"
        self.assertEqual(self.run_script().returncode, 0)
        events = self.events()
        self.assertIn("setup-db.js", events[0])
        self.assertIn("run-instance-commands --force --include-slow", events[1])
        self.assertLess(next(i for i, e in enumerate(events) if e.endswith("upgrade")),
                        next(i for i, e in enumerate(events) if "fork-upgrade.cli.js apply" in e))

    def test_failure_at_every_stage_prevents_later_commands(self):
        self.env["TWENTY_MIGRATION_DATABASE_STATE"] = "fresh"
        self.assertEqual(self.run_script().returncode, 0)
        count = len(self.events())
        for index in range(1, count + 1):
            with self.subTest(stage=index):
                self.env["FAIL_AT"] = str(index)
                self.assertNotEqual(self.run_script().returncode, 0)
                self.assertEqual(len(self.events()), index)

    def test_partial_database_is_rejected(self):
        self.env["TWENTY_MIGRATION_DATABASE_STATE"] = "partial"
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertEqual(self.events(), [])

    def test_migrator_cannot_silently_skip_migrations(self):
        self.env["DISABLE_DB_MIGRATIONS"] = "true"
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertEqual(self.events(), [])

    def test_runtime_rejects_wrong_config_and_failed_readiness(self):
        self.assertNotEqual(self.run_script("start-runtime.sh", ["runtime"]).returncode, 0)
        self.assertEqual(self.events(), [])
        self.env["DISABLE_DB_MIGRATIONS"] = "true"
        self.env["FAIL_AT"] = "1"
        self.assertNotEqual(self.run_script("start-runtime.sh", ["runtime"]).returncode, 0)
        self.assertEqual(len(self.events()), 1)
        self.assertNotIn("runtime", self.events())

    def test_runtime_starts_only_after_successful_verification(self):
        self.env["DISABLE_DB_MIGRATIONS"] = "true"
        self.assertEqual(self.run_script("start-runtime.sh", ["runtime"]).returncode, 0)
        self.assertEqual(self.events(), [
            "node dist/database/commands/fork-upgrade/fork-upgrade.cli.js verify", "runtime "])


if __name__ == "__main__":
    unittest.main()
