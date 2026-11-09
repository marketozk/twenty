# LOG179 - План проверок (`frontComponent` и `settingsMenuItem`)

## 1. Целевые PostgreSQL интеграционные сценарии (`crm-audit-front-component-and-settings-menu-item.postgres-spec.ts`)

1. **Жизненный цикл `frontComponent` и каскад `settingsMenuItem` через `FrontComponentResolver` и `FrontComponentService`**:
   - Создание фронтенд-компонента через `FrontComponentResolver.createFrontComponent` (под пользователем с имперсонацией) -> `frontComponent:create` с `values: { applicationId: customAppId, isHeadless: false, usesSdkClient: false }` и хешированными `name`, `description`, `sourceComponentPath`, `builtComponentPath`, `componentName`, `builtComponentChecksum`, `widgetAvailability`.
   - Идемпотентный `FrontComponentResolver.updateFrontComponent` без фактических изменений -> `0` новых записей аудита.
   - Обновление `name`, `description`, `sourceComponentPath`, `builtComponentPath`, `componentName`, `builtComponentChecksum`, `isHeadless` через `FrontComponentResolver.updateFrontComponent` (под `apiKey`) -> `frontComponent:update` с `changedFields: ['builtComponentChecksum', 'builtComponentPath', 'componentName', 'description', 'isHeadless', 'name', 'sourceComponentPath']` и `values: { isHeadless: { before: false, after: true } }`.
   - Системное создание через `FrontComponentService.createOne` с `defaultSystemActorId: 'dev-seeder:prefill-front-component'` -> `frontComponent:create` с `actor: { kind: 'system', id: 'dev-seeder:prefill-front-component' }`.
   - Удаление фронтенд-компонента через `FrontComponentResolver.deleteFrontComponent`, к которому привязан `core."settingsMenuItem"` (`ON DELETE CASCADE`), -> атомарная запись `frontComponent:delete` и `settingsMenuItem:delete` с одним `operationId`.
2. **Пакетные миграции приложений (`runAuditedApplicationMetadataMigration` и `isSystemBuild: true`) и барьер удаления `core.application`**:
   - Совместное создание `frontComponent` (с `universalWidgetAvailability` и `usesSdkClient: true`) и `settingsMenuItem` (с `frontComponentUniversalIdentifier`, `scope: 'WORKSPACE'`, `title`, `icon`, `position`) через `withApplicationMetadataAudit` -> `frontComponent:create` и `settingsMenuItem:create`.
   - Обновление `frontComponent` (`description`, `usesSdkClient`, `universalWidgetAvailability`) и `settingsMenuItem` (`title`, `icon`, `position`, `scope: 'USER'`) -> `frontComponent:update` и `settingsMenuItem:update`.
   - Блокировка `runAuditedApplicationDelete` (`assertNoRemainingApplicationRoleOrPermissionMetadata`), пока у приложения остаются строки `core."frontComponent"`, `core."settingsMenuItem"` или чужой `settingsMenuItem`, ссылающийся на `frontComponent` удаляемого приложения.
   - Аудируемое удаление `settingsMenuItem` и `frontComponent`, после которого `runAuditedApplicationDelete` проходит штатно, а также проверка автоматического системного аудита при `isSystemBuild: true`.
   - Fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` при попытке выполнить неаудируемую миграцию `frontComponent` или `settingsMenuItem`.
3. **Инварианты отказоустойчивости**:
   - Post-flush триггер, изменяющий `core."frontComponent"` после вставки в `crm_audit."crmAuditEntry"`, приводит к полному откату транзакции.
   - Потеря подтверждения `COMMIT` пробрасывает `NativeTransactionOutcomeUnknownError` без выполнения `ROLLBACK`.
