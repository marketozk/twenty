# LOG-063: complete ownership for provider writes

Seven writers reuse full derived ownership with shared fence → account FOR UPDATE
→ identity-limited write. Google/MS/IMAP own strict transactions; inner helpers do
not nest them. Network remains outside DB owner. SSO merges current scopes; app OAuth
preserves shared reconnect/external ID pinning and reads back through the same manager.
Unknown commit prevents success credentials and postcommit reconnect cleanup.
IMAP archived child re-enable checks current parent; application mapping propagates
unknown refresh commit. Scoped review finding fixed and re-reviewed clear.

342 targeted Jest/6 suites +26 guards=368 PASS.
45 new cases (44 PG +1 mapping boundary). Typecheck 269 roots:
190/190,0 new/changed-code.7 migrations unchanged; LF hashes matched.
[Tests](tests.txt), [verification](verification.json), [source snapshot](source-snapshot.json),
[typecheck](typecheck-differential.json). Last full fork [LOG056](../log056/README.md),1881/71.
No new full fork/full server typecheck/full Claude review/ROB764 acceptance claimed.

Initial missing-account wording regressions fixed; SSO JSON and enum typing corrected.
Reconnect reset/enqueue and later list-fetch cache/cleanup remain in
[inventory](../rob764-metadata-writer-inventory.md). No Redis/SQL atomicity claim.
Demo/transport unchanged, GitHub Actions unused. Rollback uses a coordinated full
Git revision; no schema change. Older code restores the derived-ownership write gap.
