# Fork image startup (ROB-764, LOG-021)

The fork image uses `/app/omnichannel/entrypoint.sh`. Build explicitly with
`--target twenty` (server + frontend) or `--target twenty-server`. The independent
`twenty-app-dev` target still uses s6 and is outside this deployment path.
Verify `Config.Entrypoint` before using an image. The running demo has not been
switched to this release; real bindings stay disabled until ROB-766.

## Release preparation

```sh
python scripts/omnichannel/check_fork_migration_sources.py
docker buildx build --load --target twenty --build-arg APP_VERSION=v2.52.0 \
  -t <verified-image> -f packages/twenty-docker/twenty/Dockerfile .
```

Supply `OMNI_IMAGE`, `SERVER_URL`, `APP_SECRET`, `REDIS_URL`,
`PG_MIGRATION_DATABASE_URL` and `PG_RUNTIME_DATABASE_URL` to `compose.fork.yaml`.
Only the migrator receives migration credentials; server and worker receive the
runtime URL. The template uses external PostgreSQL/Redis and local file storage.
For an existing installation, reconcile its full environment/storage/network
configuration first; this template is not a replacement for that inventory.
The HTTP port binds only to loopback (2020 by default).

## Ordered startup and upgrades

Stop/quiesce all existing server and worker processes before running the
migrator. Its global lock serializes migrators, not running applications;
upstream `cache:flush` also flushes EngineLock entries. Do not run it against an
active instance. A deployment must keep applications stopped after any failure.

1. Start only the `migrator` service with command `migrate`.
2. Require successful completion before starting server/worker. The supplied
   Compose dependencies enforce this on startup; they do not stop older services
   already running before an upgrade.
3. Start server with `DISABLE_DB_MIGRATIONS=true`; wait for `/healthz`.
4. Start worker with the same setting and `DISABLE_CRON_JOBS_REGISTRATION=true`.

The worker gets six minutes to stop, covering the native default five-minute AI
stream drain plus shutdown overhead. Keep this aligned with any configured drain
timeout; other unbounded native jobs still require a maintenance/drain policy.
A running container alone is not proof that Nest and queue subscriptions are ready.

The coordinator uses a dedicated PostgreSQL session advisory lock over the
complete sequence. A second migrator fails before launching its child. It reads
database state through that same connection: an empty DB initializes; an
existing core schema goes through upgrade; other partial contents are refused.
`--force --include-slow` is used only during fresh instance initialization.

Sequence: native setup (fresh only) → `cache:flush --strict` → native `upgrade` →
`upgrade:status --strict` → fork `apply` (including verification) → strict cache
flush → `cron:register:all --strict`. These commands preserve their old behavior
without `--strict`; the migrator always requests strict behavior.

Server/worker entrypoints perform read-only fork schema/ledger verification
before starting Nest. With the LOG-022 audit schema, `verify` also checks the
runtime role's append-only audit permissions, including column grants and roles
reachable through SET ROLE. `apply` runs as the migration owner and does not
apply that runtime-only role check. Neither path silently changes grants.
Server/worker cannot silently initialize or migrate a database.
Native migration commands still bootstrap AppModule before fork DDL; do not put
an omnichannel table query/readiness hook into AppModule initialization.

## Failure handling and boundaries

The migrator has no automatic restart/retry. SIGINT/SIGTERM or an observed lost
lock connection kills the whole child process group. PostgreSQL can release a
lost session lock before the coordinator observes the disconnect: this is not
DB-side fencing of every child SQL session. After disconnect, host failure or
unknown outcome, keep the maintenance window and inspect native migration
history, fork ledger and schema before any manual retry. Do not start a competing
replacement migrator while the previous process tree may still be alive.

The migration role provisions schema. The runtime role must not own or write
the fork ledger. It needs USAGE on `crm_audit` and SELECT/INSERT on
`crm_audit."crmAuditEntry"`, with no schema CREATE, UPDATE/DELETE/TRUNCATE or
column-write grants and no reachable privileged owner/writer role. Database,
schema and audit-table ownership must remain separate from runtime. LOG-022
checks that contract before startup and audit writes; LOG-021 tested startup
with a separate non-owner/non-superuser runtime role and SELECT-only ledger access.
Complete provision/auth/background
permission coverage and audit-schema ownership separation remain later work;
these startup tests do not certify all application permissions.

Direct diagnostics, after upstream upgrades have succeeded:

```sh
node dist/database/commands/fork-upgrade/fork-upgrade.cli.js verify
```

There is no CLI `down`: generated down SQL is tested only on empty new tables.
Do not downgrade/delete schema containing client data as an automatic rollback.

The manifest hashes LF-normalized generated TypeScript command bytes. The build
check rejects changed/unlisted commands; runtime compares the declared checksum
with the DB ledger, not compiled JavaScript bytes. Nest copies both JSON assets;
LOG-021 verified them in the actual built image. UNIQUE column sets are sorted
for comparison because TypeORM introspection order is unstable. Ordinary index
definitions preserve column order through PostgreSQL's `pg_get_indexdef`.
