# LOG152 independent owner implementation review

Reviewed the two-phase HTTP domain prefetch, strict/exclusive audited company and
contact creation transaction, structural proof leaf, authority and omnichannel
ownership checks, and unit/PostgreSQL test suites against
`Research/omnichannel_crm/implementation/log152/design.md` and
`Research/omnichannel_crm/implementation/log152/design-review.md`. No source or
runtime files were modified during this review.

## Verdict

No remaining blocking defects, race conditions, SQL injection or authority
bypass vectors, or rollback/audit gaps were identified in the inspected working
tree changes:

- `packages/twenty-server/src/engine/core-modules/crm-audit/contact-creation-proof.ts`
- `packages/twenty-server/src/modules/contact-creation-manager/jobs/create-company-and-contact.job.ts`
- `packages/twenty-server/src/modules/contact-creation-manager/services/create-company.service.ts`
- `packages/twenty-server/src/modules/contact-creation-manager/services/create-person.service.ts`
- `packages/twenty-server/src/modules/contact-creation-manager/services/create-company-and-contact.service.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-contact-creation-entrypoints.spec.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-contact-creation.postgres-spec.ts`

All six implementation details raised in `design-review.md` are accurately
implemented.

## Verification of design-review.md findings

1. **Two-phase HTTP prefetch vs locked re-evaluation and `city` fallback semantics:**
   `CreateCompanyAndPersonService.createCompaniesAndPeople` extracts work domains
   outside `runInWorkspaceTransaction` and calls
   `CreateCompanyService.prefetchCompanyInfoByDomainNames`, which normalizes
   domain names via `normalizeDomain`, checks live and soft-deleted `company`
   rows on both `domainNamePrimaryLinkUrl` and `domainNameSecondaryLinks`, and
   fetches metadata only for missing domains. `getCompanyInfoFromDomainName`
   preserves `city: data.city` (`string | undefined`) on HTTP success and falls
   back to `{ name: getCompanyNameFromDomainName(domainName ?? ''), city: '' }`
   when an HTTP error is caught. Inside the strict/exclusive transaction,
   `prepareCompaniesWithinTransaction` re-evaluates `existingCompanies` from
   scratch under `SHARE ROW EXCLUSIVE` table locks, discards unused prefetched
   entries if a company was created concurrently, falls back deterministically
   to `{ name: getCompanyNameFromDomainName(domainName), city: '' }` without
   network I/O if a company was concurrently hard-deleted after Phase 1, and
   omits `address` when `info.city === undefined`.
2. **Restoring only soft-deleted companies and deduplicating restore targets:**
   `CreateCompanyService.filterCompaniesToRestore` checks
   `isDefined(existingCompany) && isDefined(existingCompany.deletedAt)`,
   avoiding redundant updates and audit entries on already-live companies.
   `prepareCompaniesWithinTransaction` deduplicates `companiesToRestore` by
   `id` via `uniqueByKey(..., 'id')` and normalizes IDs to lowercase.
   `CreateCompanyAndPersonService.formatPeopleToRestoreFromContacts` filters out
   rows with `isNull(existingPerson.deletedAt)` and deduplicates by
   `existingPerson.id` while preferring a resolved work-domain `companyId` when
   multiple handles in a batch match the same soft-deleted person.
3. **`castCalendarProofImage` and `contactCreationColumns` handling for composite, JSONB, `position`, `searchVector` and nullable FK columns:**
   `contactCreationColumns` in
   `packages/twenty-server/src/engine/core-modules/crm-audit/contact-creation-proof.ts`
   whitelists scalar fields (`id`, `name`, `position`, `deletedAt` for
   `company`; `id`, `companyId`, `position`, `deletedAt` for `person`) and
   expands allowed composite fields (`domainName`, `address`, `createdBy`,
   `emails`, `name`) into physical column names on
   `shape.columnShapeByColumnName`, verifying `compositeParentFieldName` and
   rejecting any `FILES` column or unplanned property. `RAW_JSON` values remain
   raw JS objects, arrays, or `null` for `jsonb_populate_record` in
   `castCalendarProofImage`. When `companyId` is `undefined`, omitting it sets
   SQL `NULL` on `person.insert` and preserves any pre-existing `companyId` on
   `person.updateMany` (`restore`).
4. **Update precondition and strict `RETURNING` count in `contactCreationActualIds`:**
   `updateContactCreationRecords` enforces `before.deletedAt !== 'null'` when
   `mode === 'restore'` and `before.deletedAt === 'null'` when
   `mode === 'update'`, updating `state.expected` after restore so a same-batch
   name enrichment on a restored person transitions cleanly and aggregates into
   a single `update` audit entry in `CrmAuditTransactionContext`.
   `contactCreationActualIds` requires `result.raw` to be an array of unique
   UUIDs matching `requestedIds` with `actual.length === requestedIds.length`
   and `result.affected` agreement, rolling back when a `BEFORE` trigger skips
   a row (`RETURN NULL`) or alters columns.
5. **Schema-tolerant `core.workspace` and `lockContactCreationAuthority` semantics:**
   `prepareContactCreationAudit` locks `core.workspace` `FOR NO KEY UPDATE` and
   reads `isInternalMessagesImportEnabled` from `to_jsonb(workspace) AS snapshot`.
   `lockContactCreationAuthority` locks `core."connectedAccount"`,
   `core."userWorkspace"` (scoped by `"workspaceId"`), `core."user"`, and
   `core."messageChannel"` / `core."calendarChannel"` `FOR SHARE`. Missing or
   archived accounts, missing or soft-deleted `userWorkspace` rows, missing,
   deleted, or disabled `user` rows, and channels with
   `isContactAutoCreationEnabled === false` return `{ active: false }` for a
   clean no-op skip (`[]`, zero writes, zero audit). Application accounts
   (`provider === 'app'`), `APP` message channels, invalid account scopes,
   omnichannel-owned accounts or channels, and any authority drift detected by
   `state.validators` before `COMMIT` throw and roll back.
6. **Enterprise dependency and typecheck boundaries:**
   `contact-creation-proof.ts` imports only `isUUID` from `class-validator` and
   `type NativeCrmAuditTableShape` from
   `src/engine/core-modules/crm-audit/native-crm-audit-record`.
   `CompanyWorkspaceEntity`, `getCompanyNameFromDomainName`,
   `getDomainNamesFromLinks`, and `normalizeDomain` remain encapsulated in
   `CreateCompanyService` rather than imported into
   `create-company-and-contact.service.ts`.

## Security, transactional integrity and boundary checks

1. **SQL injection and input validation:**
   All raw SQL queries in `prepareContactCreationAudit`,
   `lockContactCreationAuthority`, `readContactCreationGraph`,
   `verifyContactCreationGraph`, and `updateContactCreationRecords` use
   parameterized `$1..$N` placeholders and `quoteContactCreationIdentifier` /
   `contactCreationTableSql` on verified standard object shapes. Both
   `CreateCompanyAndContactJob.handle` and `CreateCompanyAndPersonService`
   validate and clone `workspaceId`, `connectedAccount`, `contactsToCreate`, and
   `source` before awaiting asynchronous work.
2. **Rollback, referential update safety, and deferred constraint drain:**
   `prepareContactCreationAudit` verifies standard object metadata, single
   schema membership, and the `person.companyId -> company.id` foreign key, sets
   `lock_timeout = '8000ms'`, and locks `company` and `person` in
   `SHARE ROW EXCLUSIVE MODE` and `workspaceMember` in `SHARE MODE`. Discovered
   `company` and `person` rows are locked `FOR UPDATE` and verified against ORM
   discovery before DML. `updateContactCreationRecords` runs
   `assertNoReferentialUpdateEffects` before `updateMany`, and
   `finishContactCreationAudit` flushes audit entries, runs
   `SET CONSTRAINTS ALL IMMEDIATE`, and re-verifies all authority and workspace
   table snapshots before `COMMIT`.
3. **Unsafe-outcome propagation across batches:**
   `createCompaniesAndPeopleAndUpdateParticipants` checks
   `isTransactionUnsafeToRetry(error)` first in its batch `catch` block and
   rethrows `NativeTransactionOutcomeUnknownError` and
   `CoreAuditPostCommitError` immediately without continuing to subsequent
   chunks or swallowing the error in `exceptionHandlerService`.
