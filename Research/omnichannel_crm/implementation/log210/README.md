# LOG-210 - Нативный аудит CRM для `note` и `task`, включение Branch A `ShareWithService` на `CREATE` и аудит хуков `noteTarget`/`taskTarget`

- Дата: `2026-11-24`
- Задача: Linear `ROB-765` (Phase 2a, остаётся `In Progress`)
- Ветка: `codex/omnichannel-requirements`

## Изменённые и добавленные файлы кода и тестов
1. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-record.ts` - добавлены `note` и `task` в `AUDITED_OBJECTS` (полное покрытие `CREATE_ONE/MANY`, `UPDATE_ONE/MANY`, `UPSERT`, `DELETE_ONE/MANY`, `RESTORE_ONE/MANY`, `DESTROY_ONE/MANY`, `MERGE_MANY`, `TrashCleanupService`, `FilesFieldDeletionListener`, post-rollback `denied`/`failed` и редактирование всех значений `crmRecord`, включая `RICH_TEXT` `bodyV2` и `title`); в `assertNativeCrmAuditWriteSupported` добавлен узкий допуск `getNativeCrmTargetLifecycleScope` строго для `noteTarget` и `taskTarget` при пустом `data`, совпадении `objectMetadataId`/`kind` (`'soft-delete' | 'restore'`) и наличии `deletedAt: DATE_TIME`.
2. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts` - добавлен наименьший грант `NativeCrmTargetLifecycleGrant` (`runInNativeCrmTargetLifecycleScope` / `getNativeCrmTargetLifecycleScope`) со строгим взаимным исключением между `targetLifecycleScopes`, `mergeChildScopes` и `delegatedRecordShareExecutors` и очисткой в `finally`.
3. `packages/twenty-server/src/engine/api/common/common-query-runners/common-create-many-query-runner/common-create-many-query-runner.service.ts` - убрана устаревшая pre-Branch-A проверка `resolveShareWithToWrite(...) !== null` в `isNativeAuditCreateEligible`, открывшая атомарный Branch A аудит `crmRecord:create` + `recordShare:create` под одним `operationId` для `INHERITED`-объектов (`note`, `task`), `PRIVATE`-объектов и покрытых `OPEN`-объектов с явным `shareWith` (непокрытые объекты сохраняют standalone Branch B).
4. `packages/twenty-server/src/engine/twenty-orm/workspace-orm.manager.ts` - добавлен безопасный метод `getObjectMetadataId(nameSingular)` с `Object.hasOwn`, исключающий новые импорты `orm-workspace-context.storage.ts` (Enterprise-граница сохраняет `0` нарушений).
5. `packages/twenty-server/src/modules/note/query-hooks/note-post-query-hook.service.ts` и `packages/twenty-server/src/modules/task/query-hooks/task-post-query-hook.service.ts` - `handleNoteTargetsDelete`/`Restore` и `handleTaskTargetsDelete`/`Restore` переведены на строгие транзакции `nativeAudit` с fail-closed валидацией UUID `payload` и `workspace.id`, предвыборкой и блокировкой только переходящих строк (`SELECT id ... AND "deletedAt" IS NULL / IS NOT NULL ORDER BY id FOR UPDATE`), чанкованием `In(targetIds)` по `1000` внутри `runInNativeCrmTargetLifecycleScope` (сохраняющим database batch events `DELETED`/`RESTORED`), наследованием ALS (`correlationId`, имперсонация) и post-rollback аудитом (`recordPostRollbackNativeCrmAuditAttempt`).
6. `packages/twenty-server/test/fork-migration/crm-audit-note-and-task.postgres-spec.ts` (новый) - 4 комплексных PG 17 сценария: `CREATE`/`UPDATE`/`UPSERT` (включая `user` с имперсонацией и `correlationId`, `apiKey`, `system`, реальный `ShareWithService` Branch A на `INHERITED` и `OPEN` с `shareWith`, редактирование `RICH_TEXT` `bodyV2`/`title`, permission denial и rollback при сбое аудита); реальные `NotePostQueryHookService`/`TaskPostQueryHookService` на `DELETE_ONE/MANY` и `RESTORE_ONE/MANY` с проверкой `DELETED`/`RESTORED` batch events, targetless-кейса, `system`-актора, отката при сбое аудита и post-rollback `failed` при триггере БД; `DESTROY_ONE`, `MERGE_MANY`, `TrashCleanupService` и `omniConversationTarget`-блокировка на `note`/`task`; fail-closed изоляция `runInNativeCrmTargetLifecycleScope`.
7. 7 существующих PG-тестов (`crm-audit-custom-record`, `crm-audit-fk-delete-effects-coverage`, `crm-audit-native-company`, `crm-audit-native-lifecycle`, `crm-audit-public-destroy`, `crm-audit-public-merge`, `crm-audit-public-update`) - переведены с `task` на `workflow` как непокрытый стандартный объект, а 3 pre-Branch-A проверки в `crm-audit-public-update` обновлены под Branch A.

## Артефакты
- [design.md](design.md)
- [test-research.md](test-research.md)
- [design-review.md](design-review.md)
- [review.md](review.md)
- [results.json](results.json)
- [typecheck-differential.json](typecheck-differential.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
