# LOG149 caller adapter implementation status

Caller changes are present in the shared checkout. Formatting, runtime checks,
typechecks, test updates and publication belong to the parent.

The aggregate now requires matching context/options, validates source scope
before saving, and captures the explicit immutable save-result manifest before
contact queue work. Matching returns applied or stale-run, with stale-run mapped
to the aggregate's existing undefined result. MessageParticipantService delegates
the complete batch manifest to the new MatchParticipantService adapter.

Provider origins capture named system operations before admission awaits and pass
the admitted run in a copied authority context. The existing unsafe-retry helper
now guards the provider catch before cache requeue/status handling. Inbound email
captures its server-resolved recipient/channel/account context before source fetch.
Application ingestion captures actual ALS request identity before ownership or
cache waits and validates its context before aggregate save.

SendEmailResolver captures its draft guard and caller primitives before the first
audit await, preserving its existing mutation-race test contract. Both draft and
non-draft paths capture audit before compose/send. The actual composed sending
account/channel IDs are frozen before provider send and passed through the new
fourth persistSentMessage argument. Sent persistence rejects a reloaded channel
bound to a different sending account before the initial save.

The existing request-capture implementation is exposed through neutral
captureRequestAuditOperation methods. The old draft-named wrappers remain for
compatibility. PersistSentMessageInput now requires auditOperation and
matchingCaller. Original post-send resolver and service catches are preserved.

## Additional caller found during implementation

SendEmailTool.execute also calls SendEmailService.persistSentMessage. The four
aggregate origins are accurate, but sent persistence has both resolver and tool
upstream entry points. ToolExecutionContext allows an absent userWorkspaceId.
EmailWorkflowActionBase currently drops its resolved authContext and passes only
getUserFromAuthContext fields, which are empty for platform/application contexts.

The parent selected a separate sent-tool authority with an optional member and
the existing tool account-selection policy. The tool now supplies this descriptor,
captures trusted workspace-auth identity before composing, and retains actual
ALS attribution when available. The neutral capture method accepts an explicit
trusted-identity fallback for workflow executions without CRM-audit ALS.
EmailWorkflowActionBase now includes its resolved authContext in ToolExecutionContext.
System or missing identity is refused, and provider success survives subsequent
persistence or logging errors. The actual composed sending account/channel are
captured before provider send for both resolver and tool paths.

SentMessageAuditContext and matchingCaller now discriminate sent versus sent-tool.
The tool carries applicationId from the actual authenticated application for an
agent whose audit initiator may be a user. The native owner must retain current
agent/application consistency. This requirement was sent to the owner and parent.

No source pass counts are claimed here. The caller changes need verification
against the pure contract once the owner finishes it, including application
actor/authority consistency and all existing fixtures using the new argument.
