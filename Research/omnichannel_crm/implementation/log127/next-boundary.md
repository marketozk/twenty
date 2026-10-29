# Next: integrate closed deletion into actual callers

Wire ConnectedAccountMetadataService.deleteMany and its callers to LOG127, preserving
their separate authorization and selection contracts. LOG124/125 already provide
request/job/OAuth/system attribution; absence must not invent a principal.

The closed DB owner must retain DELETE ownership. Use a bounded source contract for
authenticated account administration, pinned email-group channel, manifest provider
removal and provider-scope repair. Recheck stale selection predicates on locked rows:
channel reparenting, connectionProviderId/application ownership, and changed scope.
Fresh account/member checks are distinct from current cache-backed role permissions.

Keep entry authorization before provider side effects, then recheck under database
locks. A narrow frozen safe-data authorization callback must not receive an unrestricted
runner/mutation function. Actual returned deletion IDs define postcommit cleanup events;
partial/zero deletion must not falsely publish old requested IDs or delete send domains.

Provider hooks/revocation/subscription calls currently precede DB deletion and cannot
be rolled back with PostgreSQL. Native cleanup is an independent postcommit listener/job.
Do not claim cross-service atomicity. Preserve committed/unknown error propagation
through lifecycle/queue boundaries already covered by LOG125/126.

Check CLAUDE.md before changing historical upgrade commands; do not rewrite an older
committed upgrade implementation just to inject audit identity. Prefer its current
execution boundary and a scoped system source where required.

After wiring, verify actual service/resolver/orchestrator calls, denied caller with no
external calls, stale selection, audit failure, partial returned sets, lost COMMIT ACK
and no false cleanup events. Then continue remaining ROB765 acceptance inventory.
