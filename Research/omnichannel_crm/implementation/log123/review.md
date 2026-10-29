# LOG123 review and verification notes

Independent reviewer: Codex subagent native_transaction, read-only source review.

- Preserve cross-workspace server impersonation: do not scope initiator lookup to
  the target workspace. Implemented and exercised against PostgreSQL.
- Replacing the ordinary wrapper initially lost its active-manager rejection.
  Restored before provider effects; a real transaction-bound repository negative
  verifies no independent commit or network effect.
- Updated the old metadata preflight test's required caller and findOne adapter.
  Its successful transfer/disconnect paths had an old fake transaction owner,
  incompatible with the strict PG adapter. These preflight tests now explicitly
  adapt that final owner; real owners are covered by the PostgreSQL suite.
- The initial PG run had 92/93 passing: the new redaction assertion incorrectly
  expected a plaintext-key diff rather than changedFields. Corrected the test to
  assert the changed-field name and absence of its value.
- Added actual resolver orchestration capture before awaits, fresh scope/owner
  and membership refusal after provider work, admin success, unchanged archive,
  no-op audit suppression, membership serialization, journal failure, corruption,
  >2^53 JSONB precision and real lost COMMIT acknowledgement cases.
- Type verification caught four diagnostics from using the plain Express Request
  type for authenticated fields. Importing RawAuthContext then failed the
  dependency guard because it reaches the Enterprise graph. The resolver now
  projects just the fields from the existing closed audit authentication type;
  runtime authentication, guards and the dependency baseline remain unchanged.

Final counts are in results.json. Global role-cache freshness, full HTTP,
external provider reconciliation and account deletion remain outside this slice.
