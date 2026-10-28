# Fork migration PostgreSQL checks

From the repository root with its Node 24 / Yarn dependencies installed:

```sh
FORK_MIGRATION_TEST_URL='postgres://test_owner:password@localhost:5432/twenty_rob764_test_<16 hex>' \
  node .yarn/releases/yarn-4.18.1.cjs jest \
  --config packages/twenty-server/jest-fork-migration.config.mjs --runInBand
```

Create a fresh disposable PostgreSQL database with a random 16-character hex
suffix first. The test owner must be able to create/drop roles and terminate its
test connections. Never use a demo or customer database. The suite rejects
database names outside this namespace **before connecting**, and drops its own fixture `core`, `crm_audit` and generated workspace schemas
between cases. No `.env` files, application bootstrap,
normal integration setup or application database reset are loaded.
The `.postgres-spec.ts` suffix also keeps these destructive isolated fixtures
outside the normal unit and application integration test discovery patterns.

Run these checks on isolated PostgreSQL 17 with a unique database. GitHub Actions
is not used for this fork (owner decision); retained workflows are manual-only.
The isolated Jest configuration intentionally does not use the application test
setup: it tests the runner against real PostgreSQL, without unrelated jobs or
seed data. TypeORM is the repository's patched version.

Coverage: replay, ordered applied prefix, concurrent migrators, DDL/ledger atomic
rollback, lost connection, checksum/schema mismatch, unknown ledger entries,
unrecorded tables, and read-only readiness/role restrictions. The upstream cursor
case is a **synthetic fixture**, not a full Twenty upgrade or application restart.

The current manifest has ten fork migrations, explicit checksums/schema verifiers,
native+fork migration orchestration and fail-fast server/worker readiness. LOG088
also validated actual packaged image startup/restart and a populated upstream
schema; the synthetic test above is not a substitute for that runtime evidence.
The runtime verifier imports no command code. Generated `down` remains in the command
type but is not exposed as an automatic data rollback. The audit operation index
uses ordinary transactional CREATE INDEX: stop writers during its deployment.

Ledger shape checks cover columns/types/nullability and the primary key; per-step
verifiers must check their own schema invariants. They are not a general database
schema certification. Runtime readiness enforces a read-only transaction even if
a verifier accidentally attempts a write.
