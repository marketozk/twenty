# LOG-088: actual server image startup validation

Status: runtime and final full fork regression PASS. ROB-764 own phase1 acceptance is complete.

A complete git archive of 6dff1d0875e6f6b68a1185e68c0200c509626c9f built through
its official Dockerfile twenty-server target. Actual migration of an isolated empty
PostgreSQL database failed before the native command started: ERR_PACKAGE_PATH_NOT_EXPORTED
for twenty-shared/application/constants/TwentyStandardApplicationUniversalIdentifier.
A second deep metadata constant import had the same package-exports defect. Jest source
resolution and SWC compilation did not exercise Node's packaged export boundary.

The fix reexports both original constants through the existing narrow application-runtime
entry point, with generator-discoverable source files and the corresponding barrel.
No constant duplication, new dependency, migration change or Enterprise exception.
The broad metadata barrel was rejected by the dependency guard and is not used.

Validation of the fix: 69 PostgreSQL tests in 2 suites, 20 dependency guard unit tests,
6 migration checksum unit tests, nine unchanged migration checksums, dependency baseline
pass. Differential typecheck maps application-runtime to each snapshot's source barrel
because the old test image cannot contain the newly exported symbols. Baseline and current
both have 189 existing diagnostics, with no new or changed-code diagnostics; this is not
a clean full-server typecheck. Uploaded source hashes match the local LF source.

The runtime checks and full regression below have now passed.
Only isolated synthetic databases/networks are used. No demo or external transports changed.
GitHub Actions is not used.

## Current runtime results

Full committed image8855d9e4 now passes CJS/ESM/type-export probes. Fresh and populated
old two-migration databases reach all9 fork migrations; repeated migration preserves
CRM row counts/hashes and the full upstream upgrade ledger. Restricted runtime role
passes native upgrade status in both DBs. Actual server health200 and27 worker Bull
queue subscriptions are observed before and after restart in both DBs. All stop
exit codes are0, no OOM. Incomplete ledger blocks sentinel/server/worker before exec;
schema drift blocks sentinel/server; restored gate passes; DB owner role refuses
append-only audit verification. Seven Linux startup unit tests pass.

Full fork regression PASS:2814 tests/88 suites in886.901s;20 dependency guard,6 checksum and7 Linux startup tests also pass (2847 total). ROB764 own acceptance is complete.
Large native logs are stored as explicitly labelled last80-line excerpts with raw
SHA256/size; exact harness, image hashes, fixture and assertion results are retained.
Read-only acceptance reconciliation found no additional confirmed own-phase gap;
stale pending statements in acceptance/inventory/spec have been reconciled.

## Acceptance boundary

[ROB764 acceptance](../rob764-acceptance.md) records actual evidence. T04 external provider evidence remains ROB768; full native ORM/session/metadata audit is ROB765; public access is ROB766; UI/transport is ROB768; governed effects/import activation are ROB769/770. No whole-project completion or public CRM functionality is claimed.
