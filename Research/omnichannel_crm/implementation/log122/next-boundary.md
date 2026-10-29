# Next — connected-account disconnection audit

`ConnectedAccountResolver.disconnectConnectedAccount` authorizes the request then
calls `ConnectedAccountMetadataService.disconnect`. The method runs remote hooks,
OAuth revoke and subscription cleanup before the final ordinary account transaction.
That transaction clears credentials/auth failure state, archives the account and
disables/expires message/calendar channels, but has no CRM audit context yet.

Carry the resolver's server-derived identity before awaits and inspect all callers.
Reuse the LOG122 exact snapshot and security-first audit discipline with the
existing strict transaction adapter. Preserve the different disconnect contract:
owner stays unchanged, authFailedAt/authFailedReason are cleared, current entity is
returned, and provider effects already precede the final commit.

The single production resolver currently checks caller administration before the
service and external awaits. Preserve that precheck, then recheck existing
administration rules against the locked fresh account and captured caller inside
the final owner. Custodian/scope changes during external awaits must not become
authorization for a stale account. This does not establish global role freshness.

Keep fresh ordinary/omni ownership and scope checks. Verify actual effects and
unknown-commit behavior on PostgreSQL, including JSONB precision and journal failure.
Do not describe already performed remote revoke as rolled back when DB mutation
fails. Account deletion and its full FK graph remain a separate boundary.

ROB765 stays In Progress. Real shares, files, other metadata/role/system writers,
public DESTROY/MERGE, denied/failed and health/alert acceptance still remain open.
