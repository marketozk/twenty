# LOG196 - Исследование и план тестов

## Существующие тесты
- Смежные PG-тесты: `crm-audit-application-metadata.postgres-spec.ts`, `crm-audit-object-and-field-delete-permissions.postgres-spec.ts`, `crm-audit-timeline-activity-type.postgres-spec.ts`.

## Обязательные реальные PostgreSQL-сценарии (`crm-audit-index-metadata.postgres-spec.ts`)
1. **Полный жизненный цикл через `IndexMetadataResolver` -> `IndexMetadataService` -> `WorkspaceMigrationRunnerService.executeRun`**:
   - `createOneIndex` с имперсонацией (`actor` + `initiator`) создаёт строку в `core."indexMetadata"` и пишет `indexMetadata:create` с `values: { applicationId, objectMetadataId, indexType, isCustom: true, isUnique: false, isSystemSideEffect: false }`, без plaintext `name` и `indexWhereClause` в `values` (оба в `redacted`), и вызывает `dispatchAfterCommit` после `COMMIT`.
   - `deleteOneIndex` с имперсонацией удаляет пользовательский индекс и пишет `indexMetadata:delete` (`before`, `after: null`).
2. **Fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun` и `IndexMetadataService`**:
   - Вызов `IndexMetadataService.createOne` / `deleteOne` без `auditIdentity` отклоняется до изменения `core."indexMetadata"`.
   - Прямой вызов `WorkspaceMigrationRunnerService.run` с `metadataName: 'index'` для `isCustom: true` (create/delete) без активного audit scope отклоняется fail-closed, тогда как системный side-effect индекс (`isCustom: false`, `isSystemSideEffect: true`) вне audit scope не блокируется.
3. **Манифестная синхронизация, каскадное удаление и проверка остатков в `application-metadata-audit.ts`**:
   - `runAuditedApplicationMetadataMigration` аудирует `create`, `update` и `delete` в `core."indexMetadata"` (включая каскадное удаление при удалении объекта/приложения).
   - `assertNoRemainingApplicationRoleOrPermissionMetadata` блокирует удаление `core.application`, если в `core."indexMetadata"` остались строки этого `applicationId`.
4. **Откат транзакций при сбое `crm_audit` flush и при пост-flush дрейфе `core."indexMetadata"`**:
   - Триггер `BEFORE INSERT` на `crm_audit."crmAuditEntry"` откатывает создание и удаление индекса, не вызывая `dispatchAfterCommit`.
   - Триггер `AFTER INSERT` на `crm_audit."crmAuditEntry"`, изменяющий `core."indexMetadata"` после `flush()`, откатывает транзакцию (`Index metadata state changed during audit flush`).
