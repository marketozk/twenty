# LOG117 review

Readonly review of all known callers confirmed the distinction between coreUser,
application with user, API key, explicit system job and impersonation initiator.
It found a target race: userId could change after lookup but before the cleanup
lock. expectedUserId now reaches the transaction and is checked under FOR UPDATE.
A real PostgreSQL interleaving verifies the changed membership is not removed.

Hard teardown originally enumerated deleted memberships, then looked them up as
active by userId. Exact membership IDs now survive that loop; the count of other
memberships remains active-only. The old job without an exact ID retains its active
lookup semantics and does not sweep historical rows.

The dependency guard initially found a new broad RawAuthContext import through
WorkspaceResolver. Replaced it with the exact structural impersonation field;
the guard passes with its baseline unchanged.

First tests exposed fixture errors after using the actual core service: EntitySchema
targets had to use the same mocked class tokens as the service, and audit entries
store actor.id rather than a top-level actorId. Fixed the fixtures. The root adapter
test also initially omitted UserException needed by the real user validator; it now
keeps that actual exception. Production checks were not weakened to satisfy fixtures.

134 targeted tests and 8 root tests pass. Broader regression: 1296/42 pass.
Final differential types: 190/190 existing diagnostics, zero new/changed-code.

Type checking found that a combined system/pendingActivation union did not narrow
to application after both early returns. Split it into two discriminated variants;
no cast or runtime permission bypass was introduced. Six diagnostics belong to
unchanged methods in existing UserWorkspaceService/WorkspaceResolver; the checker
compares those method bodies against the baseline rather than exempting changed code.

Follow-up readonly review verified expectedUserId at all three production callers
and under the transaction lock. No remaining blocker found in this bounded diff.
Full native-member attribution and core-user soft deletion remain explicit residuals.
