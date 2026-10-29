# LOG129 implementation and review

ConnectedAccountMetadataService now invokes the closed deletion owner from LOG127/128.
The account resolver, email-group service, manifest migration and historical scope
repair execution provide distinct captured deletion grounds. Attribution comes from
the existing request/lifecycle context; it does not replace authorization. The
AuthUserWorkspaceId decorator already rejects calls without a bound membership at
the two administrative entry points, including application-authenticated calls.

Independent review confirmed the account-to-provider ON DELETE CASCADE risk. Required
complete effects are checked inside the owner for manifest/email-group/scope repair;
administrative batches still report their actual RETURNING set. The provider handler
locks its captured provider ID and refuses any remaining account reference, including
a malformed foreign-workspace reference. An absent scoped provider returns immediately
instead of attempting a later DELETE against a row that may have changed workspace.

Email-group cleanup pins the original handle as well as channel/account identity.
Initial retained folder ownership is checked before external provider calls. The
owner rechecks membership, account permissions, retained ownership and exact effects
inside its transaction. Permission policy still uses the existing role cache.

Final independent review found that the first service authorization callback received
the full mutable entity, unlike the locked owner's four-field callback contract.
The preflight now supplies the same frozen id/userWorkspaceId/scope/provider projection.
The actual-service PostgreSQL regression checks both calls, including failed mutation
through Reflect.set; credentials and provider parameters never enter this callback.

Review found that synchronous event-dispatch errors after COMMIT could escape as an
ordinary retryable failure. They now retain confirmed-commit semantics through
CoreAuditPostCommitError. Upgrade failure recording likewise cannot replace any of
the three recognized unsafe transaction errors. Async listeners are not awaited by
EventEmitter2.emit: this change does not establish durable dispatch or native cleanup.

Initial targeted failures were two old error-message expectations after switching
to the closed owner; assertions now verify the new retained-resource refusal and
the actual unknown-transaction error class. Initial differential typecheck had no
new diagnostics, but the standalone harness omitted the repository's integration
test global declarations. The existing @types/jest.d.ts is included for both baseline
and current source; no baseline source or production declarations were changed.

Provider hooks, subscription cancellation and OAuth revocation happen before the DB
owner and cannot be undone by its rollback. Full HTTP/server boot, build, deployment,
durable event delivery and all native cleanup writers remain outside this slice.
