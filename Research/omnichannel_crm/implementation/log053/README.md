# LOG-053: provider identity and reconnect protection

ROB-764 In Progress. This slice closes ordinary provider writes, not the entire account lifecycle.

New native bindings require ConnectedAccount provider=app with null applicationId
and connectionProviderId and a separate APP MessageChannel. Generic account update
rejects identity conversion, including relation-shaped fields, under existing locks.
New account creation uses INSERT. Google/Microsoft/IMAP reconnect, SSO, refreshed
tokens and aliases use conditional UPDATE matching provider, app/provider IDs,
workspace and custodian. A changed/missing account cannot be silently recreated.
APP OAuth retains externalAccountId pinning and shared-account reconnect while
rechecking current caller reachability and app/provider identity in SQL.

Every affected ordinary UPDATE excludes any retained omniAccountBinding, including
legacy ordinary-provider bindings allowed before this invariant. No status filter.
Unreadable ownership fails closed. Existing bindings are not rewritten or deleted.
No assumption that archivedAt is a permanent admission marker is introduced.

## Verification

279 tests/9 affected Jest suites +20 dependency +6 checksum =305 PASS.
39 new PostgreSQL owner cases exercise actual create/reconnect/SSO/IMAP/refresh/
alias/APP persistence and complete Google/Microsoft callers with real repositories.
10 identity/bootstrap tests extend the prior metadata PG suite. Network, encryption,
permission-context setup and scheduling boundaries are fixture doubles; persistence,
rows, transactions and binding checks use PostgreSQL. No live OAuth provider tested.
Legacy binding, private/shared custody change, incomplete snapshots, foreign scope,
insert collision, both native and ordinary behavior, channel re-enable, no effects on
conflict, and unreadable ownership storage are covered. Full OAuth browser callback
and credential exchange are outside this slice; APP persistence is tested directly.

Typecheck230 roots: 198 baseline/197 current;0new/changed-code.
Full server typecheck is not claimed. Full fork suite last passed1635 tests at LOG051;
this bounded diff ran affected suites. All7 migrations unchanged; dependency guard
passes without widening baseline. Local/test source LF hashes match.

[Tests](tests.txt), [verification](verification.json), [typecheck](typecheck-differential.json),
[source snapshot](source-snapshot.json), [dependency guard](dependency-guard.json).

## Review and repairs

Initial tests caught provider enum case mismatch and a historical fixture lacking
provider. Review and typecheck caught account fields accidentally added to channel
predicates. Both repaired and tested through actual orchestration. Review also found
legacy bindings; conditional NOT EXISTS now protects them. Final scoped independent
review found no blockers. No new full Claude review claimed. Shared types barrel
added forbidden transitive edges; structural generic helper avoids that dependency.
Typecheck also corrected pre-existing unknown error.message access in the touched
IMAP method. Tests use real shared enums to detect storage-value drift.

## Remaining

Network disconnect/transfer/deleteMany still need final locked ownership admission;
resolver pendingGroupEmailsAction still needs atomicity. Final T22 inventory and
whole-stage acceptance remain. APP-only identity permits a short DB-only native
lifecycle without holding transactions across hooks/provider HTTP.

Rollback means a coordinated full Git snapshot; no schema migration in this slice.
Older code reopens these write paths and must not serve protected native accounts.
Live demo/SaleBot/transports unchanged. GitHub Actions not used.
