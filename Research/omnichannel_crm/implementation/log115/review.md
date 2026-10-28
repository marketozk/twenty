# LOG115 review

Read-only independent reviewer inspected the owner, fixed-point navigation capture,
FK inventory comparison, administrative descriptors, attribution copy and savepoints.
Root implemented all changes; reviewer did not modify files or run tests.

1. Soft-delete postconditions previously accepted a newly changed deletedAt/updatedAt
   on each read. Fixed by pinning the first verified post-cleanup snapshot; subsequent
   reads must match its canonical JSON, preserving PostgreSQL microsecond precision.
   AFTER audit INSERT triggers changing either timestamp now remove the audit attempt
   while retaining the verified revocation.
2. Unsupported FK inventory previously aborted capture before known child workspace
   checks. Fixed by separating mandatory locked dependency scope/effect verification
   from journal coverage. Audit fallback cannot release capture locks or bypass known
   foreign scope checks. Paired unsupported-FK + foreign session/navigation tests reject
   cleanup; missing scope SELECT permission also rejects instead of silently downgrading.

The independent reviewer re-read both corrections and found no further blocker in
those fixes. Entry-point source research is recorded in [next-boundary](next-boundary.md).

Initial targeted result: 20/20. After both corrections: 103/103 across three suites,
25 new cases. Full regression/types passed as recorded in results.json. Runtime coverage guard does
not claim arbitrary trigger side effects or future unknown FK mutations are audited.

Remaining boundary: explicit operation input is supplied only by the new primitive
tests. Production request/job attribution wiring, cache invalidation for removed
sessions and full public removal/transfer coverage are subsequent work. Existing
cleanup callers retain their prior path until that wiring is verified. No deployment.
