# LOG152 test research

Read-only test boundary analysis for audited automatic company and contact
creation after LOG151 publication (`42772b8f`). No runtime results are claimed
here.

## Existing test fixtures and required extensions

1. `test/fork-migration/omni-native-message.fixture.ts` and
   `test/fork-migration/omni-native-cleanup.fixture.ts`:
   `createOmniNativeCleanupFixture` already initializes `person`, `company`,
   `opportunity`, `workspaceMember`, `core.workspace`, `core."connectedAccount"`,
   `core."messageChannel"` and `crm_audit."crmAuditEntry"`.
2. Existing unit tests under
   `src/modules/contact-creation-manager/utils/__tests__/*.spec.ts`:
   Must remain green without modification.

## New PostgreSQL and unit cases required for LOG152

1. **Atomic company + person creation, restoration and name enrichment with
   audit:**
   - Creating a new work-email contact creates both `company` and `person` in a
     single strict/exclusive transaction, links `person.companyId = company.id`,
     allocates sequential `position` values, emits `WorkspaceRepository`
     creation events, and writes two `crmAuditEntry` `'create'` records sharing
     one `operationId` and `CreateCompanyAndContactJob` system actor.
   - Soft-deleted `company` (matched by primary or secondary domain link) and
     soft-deleted `person` (matched by primary or additional email) are restored
     (`deletedAt = null`, `companyId` updated) and audited as `'update'` entries
     with `before.deletedAt !== null` and `after.deletedAt === null`.
   - Existing or newly restored `person` with `createdBySource` in
     `['EMAIL', 'CALENDAR']` and empty `firstName` or `lastName` is enriched
     from `displayName`/`handle`; when a soft-deleted person is both restored
     and name-enriched in the same batch, `CrmAuditTransactionContext`
     aggregates `first-before` / `last-after` into a single `'update'` audit
     entry.
   - Existing `person` with `createdBySource = 'MANUAL'` is never name-enriched.
2. **External HTTP lookup isolation outside DB locks:**
   - `CreateCompanyService.prefetchCompanyInfoByDomainNames` performs HTTP
     domain lookup before `runInWorkspaceTransaction` begins (`BEGIN`), never
     calls HTTP for domains that already exist in `company`, and falls back to
     `getCompanyNameFromDomainName` on HTTP error.
3. **Fresh core authority, workspace scoping and non-omni ownership:**
   - Filtering self/alias handles and `isInternalMessagesImportEnabled` uses the
     fresh locked `core."connectedAccount"` and `core.workspace` rows rather
     than stale queue payload values.
   - If `core."userWorkspace"` belongs to a different workspace, is soft-deleted,
     or its `core."user"` is disabled/deleted, or `core."connectedAccount"` is
     archived, contact creation skips cleanly with zero writes and zero audit.
   - If the `connectedAccount` or `messageChannel` is enrolled into omnichannel
     (`core."omniAccountBinding"`), or a deferred trigger mutates core authority
     or `workspaceMember` source rows before `COMMIT`, the transaction refuses
     and rolls back all `company`, `person` and `crmAuditEntry` writes.
4. **Skipped/rewritten DML, incoming FK update effects and deferred triggers:**
   - A `BEFORE INSERT` or `BEFORE UPDATE` trigger on `company` or `person` that
     skips (`RETURN NULL`) or rewrites a column rolls back the entire batch and
     audit.
   - An incoming `ON UPDATE CASCADE` foreign key referencing an updated
     `company` or `person` column is refused by `assertNoReferentialUpdateEffects`
     before DML executes.
5. **Multi-batch orchestration and unsafe-outcome propagation:**
   - Batches exceeding `CONTACTS_CREATION_BATCH_SIZE` (50) run in sequential
     strict/exclusive transactions sharing one `correlationId` with distinct
     `operationId`s.
   - `NativeTransactionOutcomeUnknownError` or `CoreAuditPostCommitError` on a
     batch is rethrown unchanged without calling `captureExceptions` and stops
     subsequent batches, while earlier committed batches remain committed.
