# After LOG117 — core account deactivation audit

Three unaudited Repository.softDelete calls remain: UserService.deleteUser,
UserService.deleteUserWorkspaceAndPotentiallyDeleteUser, and
WorkspaceService.handleRemoveWorkspaceMember. They alter core.user separately
from membership cleanup. Add a narrow strict core transaction owner, capture the
applicable pre-removal workspace scopes, reuse trusted LOG117 attribution, and
preserve security-first audit failure semantics. No invented workspace for an
account that genuinely has no workspace; report unavailable attribution/scope.

Required checks: exact user lock/readback, already-deleted no-op, fresh remaining
active memberships where deletion is conditional, immutable snapshots, no sensitive
user fields in audit, journal failure without restored access, corruption refusal,
lost COMMIT acknowledgement without retry, and cache invalidation on unknown outcome.
Do not claim a complete concurrent membership-creation fence without tracing and
testing those writers too.

Separate residual: UserService's WorkspaceRepository.delete for native workspaceMember
is privileged and unaudited. executeInWorkspaceContext only loads context; it creates
no native audit owner. Public CommonBase autoowner does not cover this system object,
and its public delete hooks refuse ordinary CRUD. Do not merely allowlist workspaceMember:
deletion affects accountOwner/owner and system message/calendar/task participants.
Real FK inventory, exact child effects, file cleanup and trusted actor binding are
needed before that writer can claim audited coverage. Connected-account/share
transfers are also separate owners; the full public removal is not one transaction.

Security ordering prerequisite: native DELETE currently precedes core membership
revocation. The generic native audit owner aborts DELETE on journal failure, which
would prevent the later security cleanup. Reuse a proved security-first savepoint
owner or establish a durable recovery/order contract; never simply enable the generic
fail-closed owner here and claim the LOG115 revocation guarantee is preserved.

Native source inventory from standard metadata builders:

| Effect | References |
|---|---|
| SET NULL | Company.accountOwner, Opportunity.owner, Task.assignee, MessageParticipant.workspaceMember, CalendarEventParticipant.workspaceMember, AgentMessage.senderWorkspaceMember, AgentChatThread.assignee |
| CASCADE | Blocklist, TimelineActivity, AgentChatThreadParticipant, AgentChatThread.workspaceMember, AgentMessageReaction |

The native standard avatar is TEXT, not FILES. Custom nonempty FILES still require
durable cleanup; inspect cascade children's file fields separately. Confirm the
transitive AgentChatThread FK chain against actual DB before enabling that owner.
Use a dedicated DELETE-only metadata identity check: standard application UID,
workspace/object IDs, workspaceMember universal identifier/name/table, isSystem
and !isRemote. Keep the ordinary public predicate/selector unchanged.

Existing runInWorkspaceTransaction supplies the strict executor and deferred stock
callbacks. Existing prepareNativeCrmDeleteEffects handles direct supported effects,
but not these excluded system/transitive tables. A private cleanup entrypoint must
accept the already captured coreUser/application/initiator operation, since the
ordinary capture helper only derives workspaceMember/system actors.
