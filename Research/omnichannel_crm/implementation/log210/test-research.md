# LOG-210 Test Research

## New PostgreSQL 17 Suite

`packages/twenty-server/test/fork-migration/crm-audit-note-and-task.postgres-spec.ts`

Test cases against real PostgreSQL 17:
1. **Full CRUD + `RICH_TEXT` privacy + `ShareWithService` + ALS attribution on `note` and `task`**:
   - `CREATE_ONE` / `UPDATE_ONE` (`title`, `bodyV2: { blocknote, markdown, tiptap }`, `status`, `dueAt`, `assigneeId`) / `UPSERT` on `note` and `task` under `user` (with impersonation + `correlationId`), `apiKey`, and `system` auth contexts.
   - Verify exact `crmRecord` `create`/`update` entries, `changedFields`, and strict privacy redaction (zero leakage of secret `title` / `bodyV2` strings into `crmAuditEntry`).
   - Verify post-rollback `denied` audit on permission denial (`canUpdateObjectRecords: false`) and rollback on real `crm_audit."crmAuditEntry"` INSERT failure.
2. **Audited `DELETE_ONE`/`DELETE_MANY` + `RESTORE_ONE`/`RESTORE_MANY` with real `NotePostQueryHookService` and `TaskPostQueryHookService`**:
   - Wire real `NotePostQueryHookService` (`handleNoteTargetsDelete` / `handleNoteTargetsRestore`) and `TaskPostQueryHookService` (`handleTaskTargetsDelete` / `handleTaskTargetsRestore`) into `workspaceQueryHookService.executePostQueryHooks`.
   - Seed active and already soft-deleted `noteTarget` / `taskTarget` rows for `note` / `task`.
   - Delete `note` and `task` inside an ALS `withCrmAuditRequest` (`correlationId`, impersonator): verify both parent (`note`/`task`) and ONLY previously active `noteTarget`/`taskTarget` rows are audited under the same `correlationId` and server attribution, while already soft-deleted targets are untouched.
   - Restore `note` and `task`: verify parent and ONLY soft-deleted `noteTarget`/`taskTarget` rows are restored and audited; already-live targets produce no spurious audit entries.
   - Verify audit INSERT failure inside `NotePostQueryHookService` rolls back `noteTarget` soft-delete and triggers post-rollback health (`POST_ROLLBACK_AUDIT_UNAVAILABLE`) without swallowing the error.
3. **`DESTROY_ONE`, `MERGE_MANY`, `TrashCleanupService`, `attachment.file` (`FILES`), and `omniConversationTarget` protection on `note` and `task`**:
   - `DESTROY_ONE` on `note` and `task` with `noteTarget`/`taskTarget`, `attachment` (populated `core.file`), and `timelineActivity` -> single `operationId`, `crmFile:update` + `delete_filesFieldFiles` intent + real `FilesFieldDeletionListener.handleDestroyedEvent` wakeup (`workspaceQueue`, no `deleteCascadeQueue`) + `reconcileFilesFieldHardDeleteIntentsWithAudit`.
   - `MERGE_MANY` on `note` and `task` (with `duplicateCriteria` enabled) migrating `noteTarget`/`taskTarget`, live `attachment` (file stays `UPLOADED`), and `timelineActivity`, plus `CASCADE` of soft-deleted `attachment.file`.
   - `TrashCleanupService` on soft-deleted `note` and `task` with targets, `attachment.file`, and `timelineActivity` (`systemActorId: 'trash_cleanup'`).
   - `DESTROY_ONE` on `task` linked by `core."omniConversationTarget"` -> blocked with `OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND`, rollback, post-rollback `denied` (`crm.mutation.domain_command_required`).
4. **Fail-closed isolation of `runInNativeCrmTargetLifecycleScope` and non-covered `workflow`**:
   - Direct `noteTarget` / `taskTarget` soft-delete or restore inside `nativeAudit` without grant -> rejected (`Native audit coverage excludes this object or mutation`).
   - Using `runInNativeCrmTargetLifecycleScope` with `attachment` or `messageParticipant` -> rejected fail-closed.
   - Calling `update` or `delete` or mismatched `kind` (`restore` inside `'soft-delete'` grant) -> rejected fail-closed.
   - Nesting `runInNativeCrmTargetLifecycleScope` inside `runInNativeCrmMergeChildScope` (or vice versa) -> rejected fail-closed.
   - Calling `runInNativeCrmTargetLifecycleScope` without proven `nativeAudit` scope -> rejected fail-closed.

## Targeted Suites to Run

1. `crm-audit-note-and-task.postgres-spec.ts` (new)
2. `crm-audit-fk-delete-effects-coverage.postgres-spec.ts`
3. `crm-audit-custom-record.postgres-spec.ts`
4. `crm-audit-native-company.postgres-spec.ts`
5. `crm-audit-native-lifecycle.postgres-spec.ts`
6. `crm-audit-native-member.postgres-spec.ts`
7. `crm-audit-public-update.postgres-spec.ts`
8. `crm-audit-public-destroy.postgres-spec.ts`
9. `crm-audit-public-merge.postgres-spec.ts`
10. `crm-audit-post-rollback-and-health.postgres-spec.ts`
11. `crm-audit-trash-and-file-remove.postgres-spec.ts`
12. `crm-audit-file-hard-delete.postgres-spec.ts`
13. `omni-conversation-target.postgres-spec.ts`

Plus full PG 17 regression (all 147 suites), differential `typecheck`, `check_enterprise_dependencies.py --verify-baseline`, `verify_fork_migration_sources.py`, and 33 Python guard unit tests.
