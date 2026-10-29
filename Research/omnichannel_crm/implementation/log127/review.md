# LOG127 review

Independent read-only review by native_transaction inspected the primitive and tests,
FK inventory/table locks, actual returned subset, skipped graph exact snapshots,
folder-only retained ownership and post-audit readback. No tests run by reviewer.

Confirmed finding: reusing operationId could deduplicate a second deletion after
recreating identical IDs and safe projections. Fixed with fresh captured operationId;
real PostgreSQL test expects eight events and two operation IDs across two deletions.

The review asked whether bootstrap produced an inactive binding. Verified migration
DEFAULT inactive and bootstrap's persisted/public inactive contract; an explicit
SELECT assertion now documents the test precondition. This was not a runtime defect.

The initial test harness imported an unrelated IndexMetadataEntity dependency graph
ending in unsupported AI ESM. Reused the existing fixture suites' leaf class adapter;
actual owner, PostgreSQL, FK machinery, audit and bootstrap remain real. Missing
bootstrap-only fixture columns and provider casing were corrected, not runtime code.

Production caller authorization/wiring is not covered by this primitive. No claim of
full ROB-765 acceptance, HTTP coverage, deployment or external provider cleanup.
