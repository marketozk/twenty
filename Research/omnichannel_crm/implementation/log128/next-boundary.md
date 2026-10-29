# Next: wire existing services and entry points

Use LOG127 owner with LOG128 boundaries in ConnectedAccountMetadataService.deleteMany.
Copy inputs and consume any repair source before the first await, including provider
hooks. Reject enclosing transaction managers and missing attribution before effects.
Capture real request/impersonator or existing LOG124/125 lifecycle identity; do not
invent a system principal for legacy identity-less jobs.

- Account resolver: captured caller/operation; initial authorization before providers,
  locked safe-account callback recheck at deletion. A skipped single DELETE must not
  return a successful deleted DTO.
- Email-group: pinned channel/account, existing campaign check and initial permission;
  domain cleanup only after actual account deletion.
- Manifest: captured owner application/provider IDs and lifecycle operation; stale
  provider selection refuses. Preserve plan-before-provider-effects and dry-run.
- Historical scope command: consume exact one-shot runner source and capture selected
  account→provider links. Direct destructive invocation outside a runner refuses.
  Adapt its existing integration test to the trusted execution wrapper, not the old
  committed command source.

Manifest must refuse partial/all-skipped account deletion inside the owner transaction:
otherwise the subsequent provider migration could cascade-delete skipped accounts
outside this audit boundary. Scope repair also needs complete effects before its old
command reports the selected count. Email-group needs the pinned current account
handle (or actual deleted handle) for correct domain cleanup after provider awaits;
channel/account identity alone does not fix a changed send domain. Add these final
effect requirements with production wiring and verify rollback of a skipped subset.

Require-all alone is insufficient: a new account/reparent can arrive after the deletion
owner commits but before metadata migration deletes the provider. The actual
DeleteConnectionProviderActionHandlerService currently calls repository.delete against
an ON DELETE CASCADE parent. In its existing metadata transaction lock the provider
FOR UPDATE and refuse any remaining account references before DELETE. This final guard
must fence concurrent FK inserts; a check on a separate connection is insufficient.

Initial ordinary-account checks must also consider retained folder-only ownership
before external effects. Publish existing account/message/calendar events from actual
returned IDs only, after known COMMIT. Native listeners remain separate transactions.
Provider hooks/revocation/subscriptions are not rolled back by failed DB audit.

Preserve known unsafe transaction errors through Upgrade runner's failing migration
recorder as well as application lifecycle wrappers; an error in failure reporting must
not replace unknown COMMIT or confirmed-postcommit failure. Verify actual runner path.

Use actual service/entry-point tests for stale caller/selection after provider awaits,
missing identity/foreign transaction with no external effects, partial/all-skipped
delete, audit refusal and lost COMMIT ACK with no false cleanup events. Existing
cache-backed permission policy is not a proof of general fresh ACL revocation.
