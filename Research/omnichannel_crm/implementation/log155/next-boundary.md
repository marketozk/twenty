# Next boundary after LOG155 - audited role delete and agent/API-key role assignment

Read-only boundary analysis for the step following LOG155. No runtime or
acceptance claim is made here.

## What LOG143-LOG155 closed across ordinary messaging and calendar imports

1. **Initial batch persistence (`LOG143`, `LOG150`):**
   - Closed `CalendarSaveEventsService` (`calendarEvent`,
     `calendarChannelEventAssociation`, `calendarEventParticipant`) and
     `saveOrdinaryMessageBatchWithAudit` (`messageThread`, `message`,
     `messageChannelMessageAssociation`, `messageParticipant`,
     `messageChannelMessageAssociationMessageFolder`, read-only
     `messageThreadTarget`) in strict/exclusive transactions.
2. **Post-save participant/target matching, background rematch, and durable intents (`LOG144`-`LOG149`, `LOG151`, `LOG153`, `LOG154`):**
   - Closed post-save matching, background rematch pages, person-company target
     reconciliation, durable `reconcile_messageImportMatching` and
     `reconcile_calendarImportMatching` intents in
     `core.deferredWorkspaceMigrationAction`, and integration with
     `DeferredWorkspaceMigrationActionRunnerService` and
     `DeferredWorkspaceMigrationActionRecoveryService`.
3. **Audited company and contact auto-creation (`LOG152`):**
   - Closed two-phase `CreateCompanyAndContactJob` /
     `CreateCompanyAndPersonService` with external HTTP domain prefetch outside
     DB locks and strict/exclusive `company` + `person` batch transactions.
4. **Transactional import-policy and blocklist freshness (`LOG155`):**
   - Closed transactional import-policy and `blocklist` freshness (`import-policy-proof.ts`)
     across provider and inbound message saves, provider calendar event saves,
     and ordinary sync calendar association cleanup, locking `blocklist`,
     `workspaceMember` and `core."userWorkspace"` `IN SHARE MODE`, refreshing
     channel/account policy fields from locked DB rows, declining stale-filtered
     batches before any native write, and rolling back on pre-commit policy or
     blocklist drift.

## Next open boundary (`rob765-progress.md` - Role lifecycle)

In `rob765-progress.md` (`Role lifecycle`):

1. `LOG111` and `LOG112` closed public and AI role `CREATE` and `UPDATE`, and
   `LOG113` closed public member role assignment (`UserRoleService`) with
   serialized last-admin demotion protection.
2. `Role delete, bulk/agent/API-key assignments` (`RoleService.deleteRoles`,
   `AiAgentRoleService.assignRoleToAgent` / `removeRoleFromAgent` /
   `deleteAgentOnlyRoleIfUnused`, and `ApiKeyRoleService.assignRoleToApiKey`)
   remain open and need atomic CRM audit coverage and last-admin / target
   authority verification under transaction locks.
