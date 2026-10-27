# Fork schema entrypoints (ROB-764)

These commands are implemented and tested independently. They are **not yet wired
into the live image/Compose entrypoints**. Do not enable real bindings before
ROB-766. A full server/worker build and restart remains an acceptance item.

After building twenty-server, from `packages/twenty-server`, with the intended
`PG_DATABASE_URL` supplied by the environment:

```sh
# Upstream instance/workspace upgrades must have completed first.
node dist/database/commands/fork-upgrade/fork-upgrade.cli.js apply
node dist/database/commands/fork-upgrade/fork-upgrade.cli.js verify
```

`apply` requires the migration role. It applies only the explicit fork registry,
under a transaction lock, then verifies readiness. `verify` performs read-only
schema/ledger checks. Neither entrypoint bootstraps AppModule or loads `.env`.
There is no CLI `down`: generated down SQL is tested only on empty new tables;
rollback with real data requires an explicit recovery procedure.

`start-runtime.sh` is the prepared gate for the future server/worker entrypoint.
Run it with `sh`, from the built server directory, passing the actual runtime
command. It requires `DISABLE_DB_MIGRATIONS=true`, checks the fork schema, then
executes that command. It does not itself run upstream or fork migrations.
The orchestrator must run a separate migrator before both runtime processes.

Before a build/release, verify source integrity:

```sh
python scripts/omnichannel/check_fork_migration_sources.py
```

The manifest stores SHA-256 of the final generated TypeScript command, normalized
to LF. CI rejects changed/unlisted source files. Runtime compares that declared
checksum with the DB ledger; it does **not** hash compiled JavaScript. Nest's
asset configuration includes the schema and manifest JSON. The isolated test
harness copied these assets explicitly; full Nest packaging is still unverified.
