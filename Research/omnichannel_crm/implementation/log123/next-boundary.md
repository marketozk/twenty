# Next — core connected-account deletion audit

Inspect ConnectedAccountMetadataService.deleteMany and every production caller.
The same-database graph includes account, message/calendar channels and message
folders. Confirm actual FK inventory before defining the closed delete owner;
refuse uncovered populated mutating references rather than silently omitting them.

Use the existing strict core transaction adapter and native ownership fence,
scoped exact snapshots, stable parent/child locks, actual DELETE RETURNING IDs and
verified final absence. Preserve ordinary/omni ownership refusal. Unlike credential
revocation, ordinary destructive deletion must roll back if audit cannot persist.
Publish existing cleanup events only after a known commit and for actual effects.

Callers include the authenticated resolver, email-group channel deletion,
application manifest migration and DeleteConnectedAccountsOutsideProviderScope
upgrade command. Carry their actual server/system attribution, preserve their
distinct permission and transaction contracts, and inspect delegation before edits.

Native message deletion is a separate postcommit listener/job; auditing the core
FK graph does not make that cleanup atomic. Provider effects also remain outside
the database commit. Verify folder cascades, child-reparent races, unsupported FK,
skipped DELETE, late corruption, failed audit and lost ACK with no false events.

ROB765 stays In Progress. Other native/system writers, real shares, files,
public DESTROY/MERGE, denied/failed and health/alert acceptance remain open.
