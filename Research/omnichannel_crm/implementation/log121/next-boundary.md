# Next — connected-account ownership transfer audit

Source-confirmed caller: `ConnectedAccountOwnershipTransferService` resolves a
custodian and calls `ConnectedAccountMetadataService.transferOwnership` from
UserService removal and WorkspaceMemberDeleteOnePostQueryHook. The metadata method already owns an ordinary
account transaction through withOmniMetadataMutation and locks account rows.
Its current transaction wrapper does not verify the raw PostgreSQL COMMIT command
tag; use the existing strict core audit owner while retaining the shared native
ownership fence. The account owner UUID has no membership FK, so destination
membership must be checked fresh in the new transaction.

The transaction changes connectedAccount owner, clears credentials, archives the
account, disables message/calendar sync and expires pending webhook subscriptions.
It currently has no CRM audit context. Webhook stopping happens before the
transaction and OAuth revocation after it; these remote effects cannot be described
as one database commit.

Carry the captured LOG117 attribution through the known removal callers, inspect
every transfer caller and validate fresh from/to membership under the appropriate
existing workspace/member fences. Reuse the core transaction/audit catalog with
safe allowlisted metadata snapshots; never persist credential material. Read and
verify actual account/channel effects in the same owner. Preserve security-first
deactivation on journal failure and no remote retry on unknown commit.

RecordShareOwnershipTransferService is explicitly Enterprise. Do not extend or
bypass it as our implementation; own access/share work belongs to the approved
noncommercial architecture. Physical file deletion, public DESTROY/MERGE, other
metadata/system writers and general denied/failed/health coverage remain open.

ROB765 stays In Progress. This sequence does not establish whole public removal
atomicity, fresh authorization for all in-flight requests or completion of later
rights/chat/connector/AI phases.
