# LOG152 - audited automatic company and contact creation

Proposed concrete design incorporating independent review (`design-review.md`).
Source inspection used the `contact-creation-manager` module,
`CreateCompanyAndContactJob`, `LOG143`/`LOG150` closed save owners and
`LOG143`/`LOG147`/`LOG151` next-boundary analyses. No repository or runtime
changes are claimed by this document.

## Problem and scope

When `isContactAutoCreationEnabled` is enabled on an ordinary message or
calendar channel, `MessagingSaveMessagesAndEnqueueContactCreationService`
(`EMAIL`) and `CalendarEventParticipantService` (`CALENDAR`) enqueue
`CreateCompanyAndContactJob`, which delegates to
`CreateCompanyAndPersonService.createCompaniesAndPeopleAndUpdateParticipants`.

This slice closes automatic company and contact creation under a strict/exclusive
workspace audit owner while keeping external HTTP domain lookups outside DB
locks:

1. **Two-phase HTTP prefetch outside DB locks:** Pre-fetch external domain
   metadata (`name`, `city`) via `CreateCompanyService` before entering
   `runInWorkspaceTransaction`, skipping domains that already exist in `company`
   and falling back deterministically to `getCompanyNameFromDomainName` inside
   the transaction without network I/O.
2. **Closed strict/exclusive `company` + `person` batch owner:** Lock
   `core.workspace` (`FOR NO KEY UPDATE`), `company` and `person` (`SHARE ROW EXCLUSIVE`),
   and `workspaceMember` (`SHARE`), re-evaluate candidate `person` and `company`
   rows under `FOR UPDATE` row locks, deduplicate restore targets and filter
   `companiesToRestore` to `deletedAt !== null`, verify full expected PostgreSQL
   row images via `castCalendarProofImage`, require exact `RETURNING` counts via
   `contactCreationActualIds`, check incoming FK update effects via
   `assertNoReferentialUpdateEffects`, preserve `WorkspaceRepository` event
   emission, and flush `CrmAuditTransactionContext` before `COMMIT` and
   `SET CONSTRAINTS ALL IMMEDIATE`.
3. **Fresh core authority and non-omni ownership proof:** Lock and verify
   `core.workspace`, `core.connectedAccount`, `core.userWorkspace` (scoped by
   `workspaceId`), `core.user` and channel `isContactAutoCreationEnabled` rows,
   skipping cleanly on inactive/missing user or disabled auto-creation while
   throwing and rolling back on `app` provider/channel, omni-owned account or
   channel, or post-drain authority/source drift.
4. **Unsafe-outcome propagation:** Rethrow `isTransactionUnsafeToRetry(error)`
   (`NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`)
   immediately in `createCompaniesAndPeopleAndUpdateParticipants` without
   swallowing or continuing to subsequent batches.

## Structural proof leaf (`contact-creation-proof.ts`)

Add `packages/twenty-server/src/engine/core-modules/crm-audit/contact-creation-proof.ts`
importing only `isUUID` from `class-validator` and
`type NativeCrmAuditTableShape` from `native-crm-audit-record`:

- `CONTACT_CREATION_WRITE_TABLES = ['company', 'person'] as const`
- `CONTACT_CREATION_TABLES = ['company', 'person', 'workspaceMember'] as const`
- `contactCreationColumns(shape, data)`:
  Expands allowed scalar and composite fields for `company` (`id`, `name`,
  `position`, `deletedAt`, `domainName`, `address`, `createdBy`) and `person`
  (`id`, `companyId`, `position`, `deletedAt`, `emails`, `name`, `createdBy`)
  into physical columns on `shape.columnShapeByColumnName`, keeping `RAW_JSON`
  values as raw JS objects/arrays/`null` for `jsonb_populate_record` and
  rejecting any `FILES` column or unplanned property.
- `contactCreationActualIds(result, requestedIds)`:
  Validates `result.raw` array presence, UUID format, membership in
  `requestedIds`, uniqueness and exact `actual.length === requestedIds.length`
  and `result.affected` agreement.
