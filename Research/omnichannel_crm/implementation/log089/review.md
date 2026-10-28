# LOG089 scoped read-only review

Reviewed native audit transaction ownership, Company update/updateMany kernels,
server principal capture, before/after snapshots, redaction and the real PostgreSQL suite.

Two confirmed findings were fixed before publication:
1. NUMERIC lost precision through pg JSON parsing. PostgreSQL now serializes each
   column value to canonical JSON text before driver decoding. A custom NUMERIC field
   changes 9007199254740992 to 9007199254740993; exact SQL value and changedFields are tested.
2. Reusing operationId across separate transactions could deduplicate a second mutation
   because redacted values are absent from payloadHash. The native transaction now takes
   a workspace/operation advisory lock and refuses an already committed operation before
   invoking its callback. Sequential/concurrent reuse and retry after rollback are tested.

Follow-up read-only review found no remaining blocker in these two fixes. Reviewer did
not run tests; execution evidence is recorded separately. Actual native permission denial
is now tested. Partial allow/deny batch with own ROB766 policy remains future work.

Mandatory before broad public enablement: index the operation lookup, wire actual native
entry points, complete non-update/file/merge coverage and post-rollback negative audit.
The current internal opt-in is not public native-audit completeness or retry receipts.
