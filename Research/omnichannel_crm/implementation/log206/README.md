# LOG-206 - Аудит `TrashCleanupService` и долговечный hard-delete `FILES` при `UPDATE` `toRemove`

- Дата: `2026-11-22`
- Задача: Linear `ROB-765` (Phase 2a, остаётся `In Progress`)
- Ветка: `codex/omnichannel-requirements`

## Изменённые и добавленные файлы кода и тестов
1. `packages/twenty-server/src/engine/trash-cleanup/services/trash-cleanup.service.ts` - включение `nativeAudit` (`systemActorId: 'trash_cleanup'`, общий `correlationId` на прогон воркспейса) для покрытых CRM-объектов (`isNativeCrmAuditMetadata`), поштучная fail-closed изоляция poison-pill записей с узким whitelist `TRASH_AUDIT_COVERAGE_REJECTION_MESSAGES` (без обхода межзаписной проверки `Native file must have one unambiguous owner`, с немедленным пробросом `isTransactionUnsafeToRetry` и инфраструктурных/аудитных ошибок).
2. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-files.ts` - общие внутренние helpers `assertEligibleForAuditedFileRemoval` и `persistFilesFieldHardDeleteIntent`; перевод `createNativeCrmAuditFilesStore` `toRemove` на `deletedAt + settings: { isTemporaryFile: false, toDelete: true }` + атомарную вставку `delete_filesFieldFiles` intent в `core."deferredWorkspaceMigrationAction"`; запрет `mode === 'create' && action === 'toRemove'`; валидация и нормализация UUID; детерминированный `ORDER BY id` при пост-проверке.
3. `packages/twenty-server/src/engine/twenty-orm/repository/workspace-repository.ts` - нормализация `file.fileId.toLowerCase()` (`normalizeNativeFilesFieldIds`) на `runBatchUpdate` и `runMutation(update)` без мутации входных данных вызывающего кода.
4. `packages/twenty-server/src/engine/twenty-orm/field-operations/files-field-sync/files-field-sync.ts` - регистронезависимое сопоставление `fileId` в `computeFilesFieldDiff`, `validateAndEnrichFileDiffs` и `updateEntitiesWithEnrichedFilesFieldValues` (поддержка предсуществующих uppercase `fileId` в JSONB БД).
5. `packages/twenty-server/src/engine/core-modules/file/files-field/listeners/files-field-deletion.listener.ts` - обработчик `@OnDatabaseBatchEvent('*', DatabaseEventAction.UPDATED)` (`handleUpdatedEvent` + `hasPotentialFilesFieldRemoval`) для пост-коммитной постановки `delete_filesFieldFiles` в `workspaceQueue` без лишних запросов на `toAdd`/переименование/обычные `UPDATE` и без вызова `FilesFieldDeletionJob`.
6. `packages/twenty-server/test/fork-migration/crm-audit-native-files.postgres-spec.ts` - перевод на `coreSchema: 'fork'` с `core.application` + `applicationId` + `files-field/...`, проверка `settings.toDelete === true` и `PENDING` intent на `toRemove`, тест на `BEFORE UPDATE` триггер `core.file`.
7. `packages/twenty-server/test/fork-migration/omni-parent-lifecycle.postgres-spec.ts` - передача полной `FlatObjectMetadata` из `getWorkspaceContext().flatObjectMetadataMaps` в тестовый мок `TrashCleanupService`.
8. `packages/twenty-server/test/fork-migration/crm-audit-trash-and-file-remove.postgres-spec.ts` (новый) - 9 PostgreSQL 17 сценариев end-to-end для `TrashCleanupService` + `UPDATE` `toRemove` + `FilesFieldDeletionListener` + `DeleteFilesFieldFilesDeferredActionHandlerService`.

## Артефакты
- [design.md](design.md)
- [test-research.md](test-research.md)
- [design-review.md](design-review.md)
- [review.md](review.md)
- [results.json](results.json)
- [typecheck-differential.json](typecheck-differential.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
