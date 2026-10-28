# LOG-088: actual server image startup validation

Status: IN PROGRESS. ROB-764 remains In Progress; current runtime acceptance is not passed.

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

Next: rebuild a complete committed snapshot, verify built exports, migrate fresh and
populated two-migration databases, check preserved CRM/upstream-ledger fingerprints,
start/restart actual server and worker, exercise incomplete/schema/privilege gates,
and run the full fork regression. These checks remain pending until their evidence is recorded.
Only isolated synthetic databases/networks are used. No demo or external transports changed.
GitHub Actions is not used.
