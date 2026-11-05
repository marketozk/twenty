# LOG152 independent design review

Reviewed `Research/omnichannel_crm/implementation/log152/design.md`,
`Research/omnichannel_crm/implementation/log152/test-research.md` and the
actual `contact-creation-manager`, `crm-audit`, `twenty-orm` and PostgreSQL test
fixture files after LOG151 (`42772b8f`). This report covers the proposed
audited automatic company and contact creation slice (part of ROB-765). Runtime
and source implementation acceptance belong to the following step.

## Verdict

The proposed two-phase architecture is sound and closes the automatic company
and contact creation boundary without holding database locks across external
HTTP domain lookups. Pre-fetching domain metadata outside
`runInWorkspaceTransaction` and re-evaluating `workspaceMember`, `person` and
`company` state from scratch under `SHARE ROW EXCLUSIVE` / `SHARE` locks inside
a single strict/exclusive audited transaction preserves business semantics,
`WorkspaceRepository` event emission and post-commit safety.

Six concrete source-level details require explicit handling during
implementation:

1. **Two-phase HTTP prefetch vs locked re-evaluation and `city` fallback semantics:**
   Pre-fetching external domain metadata outside `runInWorkspaceTransaction`
   while re-evaluating `alreadyCreatedPeople` and `existingCompanies` under
   `SHARE ROW EXCLUSIVE` locks inside the transaction preserves exact business
   semantics without holding DB locks across network I/O. In Phase 1, normalize
   candidate work domains via `normalizeDomain`, skip any domain that already
   matches a live or soft-deleted `company` row on `domainNamePrimaryLinkUrl` or
   `domainNameSecondaryLinks`, and preserve `getCompanyInfoFromDomainName`
   semantics where a successful HTTP response keeps `city: data?.city`
   (`string | undefined`, omitting `addressAddressCity` when `undefined`) while
   a caught HTTP error falls back to
   `{ name: getCompanyNameFromDomainName(domainName), city: '' }`. In Phase 2,
   re-discover `alreadyCreatedPeople` and `existingCompanies` under locks: if a
   concurrent transaction created the company or person during Phase 1, discard
   the unused prefetched entry; if a company was concurrently hard-deleted after
   Phase 1 skipped it, fall back deterministically to
   `{ name: getCompanyNameFromDomainName(domainName), city: '' }` without
   issuing HTTP inside the transaction.
2. **Restoring only soft-deleted companies and deduplicating restore targets:**
   `CreateCompanyService.filterCompaniesToRestore` currently maps every
   `existingCompany` found by `findExistingCompanyByDomainName` without checking
   `existingCompany.deletedAt !== null`, which issues a redundant `updateMany`
   on already-live companies. Under audit, `companiesToRestore` must filter to
   `existingCompany.deletedAt !== null` and deduplicate by `existingCompany.id`
   (in case two contacts in the same batch match the primary and secondary
   domain links of one soft-deleted company). Likewise, `peopleToRestore` must
   deduplicate by `existingPerson.id` when two handles in a batch match the
   primary and additional emails of the same soft-deleted person.
3. **`castCalendarProofImage` and `contactCreationColumns` handling for composite, JSONB, `position`, `searchVector` and nullable FK columns:**
   - **Composite flattening:** `castCalendarProofImage` passes `$2::jsonb` to
     `jsonb_populate_record(NULL::table, ...)`, which keys on physical column
     names. `contactCreationColumns(shape, data)` must expand the allowed
     composites into physical columns on `shape.columnShapeByColumnName`:
     `domainName` (`domainNamePrimaryLinkLabel`, `domainNamePrimaryLinkUrl`,
     `domainNameSecondaryLinks`), `address` (`addressAddressCity`), `createdBy`
     (`createdBySource`, `createdByWorkspaceMemberId`, `createdByName`,
     `createdByContext`), `emails` (`emailsPrimaryEmail`,
     `emailsAdditionalEmails`) and `name` (`nameFirstName`, `nameLastName`),
     verifying `column.compositeParentFieldName === key` and rejecting any
     `FILES` column or unplanned property.
   - **JSONB values (`createdByContext`, `emailsAdditionalEmails`, `domainNameSecondaryLinks`):**
     `contactCreationColumns` must keep `RAW_JSON` column values as raw JS
     objects/arrays/`null` rather than pre-stringified JSON strings so
     `jsonb_populate_record` populates `jsonb` columns with JSON objects/arrays
     or SQL `NULL`.
   - **Nullable `companyId` on create vs restore:**
     When `companiesMap[domain]` is `undefined`, `contactCreationColumns` omits
     `companyId`. On `person.insert`, omitting `companyId` populates SQL `NULL`.
     On `person.updateMany` (restore), omitting `companyId` when `undefined`
     preserves any pre-existing `person.companyId` on the restored row while
     setting `companyId` when a work-domain company was resolved.
4. **Update precondition and strict `RETURNING` count in `contactCreationActualIds`:**
   Enforce the expected `before.deletedAt` state per update kind (`!== 'null'`
   for restore, `=== 'null'` for name enrichment), and require
   `actual.length === requestedIds.length` in `contactCreationActualIds` so a
   `BEFORE INSERT` or `BEFORE UPDATE` trigger that skips a row (`RETURN NULL`)
   or rewrites a column always throws and rolls back the batch and audit.
5. **Schema-tolerant `core.workspace` and `lockContactCreationAuthority` semantics:**
   - Lock and read `core.workspace` via
     `SELECT id, "deletedAt", to_jsonb(workspace) AS snapshot FROM core.workspace workspace WHERE id = $1 FOR NO KEY UPDATE`,
     deriving `Boolean((workspace.snapshot as Record<string, unknown>)?.isInternalMessagesImportEnabled)`
     so both minimal and full schemas work without failing on a missing column.
   - Distinguish clean inactive-authority skips (`skipped-inactive-authority`,
     zero writes, zero audit) when `connectedAccount` is missing/archived,
     `userWorkspace` is missing/deleted, `user` is missing/deleted/disabled, or
     channel rows exist with `isContactAutoCreationEnabled = false`, from hard
     refusals (throw and roll back) when `provider === 'app'`, `type === 'APP'`,
     omni ownership is present, or a post-drain validator detects a concurrent
     change before `COMMIT`.
6. **Enterprise dependency and typecheck boundaries:**
   - Keep `contact-creation-proof.ts` importing only `isUUID` from
     `class-validator` and `type NativeCrmAuditTableShape` from
     `src/engine/core-modules/crm-audit/native-crm-audit-record`.
   - Keep `CompanyWorkspaceEntity`, `getCompanyNameFromDomainName`,
     `getDomainNamesFromLinks` and `normalizeDomain` inside `CreateCompanyService`
     rather than importing them into `create-company-and-contact.service.ts`.
