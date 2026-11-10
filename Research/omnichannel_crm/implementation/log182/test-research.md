# LOG182 - План проверок (`commandMenuItem`)

## 1. Целевые PostgreSQL интеграционные сценарии (`crm-audit-command-menu-item.postgres-spec.ts`)

1. **Жизненный цикл `commandMenuItem` через `CommandMenuItemResolver`, `CommandMenuItemService` и каскады `frontComponent` / `pageLayout`**:
   - Создание кастомного `commandMenuItem` (`FRONT_COMPONENT_RENDERER`) через `CommandMenuItemResolver.createCommandMenuItem` (под пользователем с имперсонацией) -> `commandMenuItem:create`.
   - Обновление кастомного `commandMenuItem` через `CommandMenuItemResolver.updateCommandMenuItem` (`label`, `shortLabel`, `icon`, `position`, `isPinned`, `availabilityType`, `availabilityObjectMetadataId`, `hotKeys`, `conditionalAvailabilityExpression`) -> `commandMenuItem:update`.
   - Идемпотентный `CommandMenuItemResolver.updateCommandMenuItem` без фактических изменений -> `0` новых записей аудита.
   - Деактивация стандартного `commandMenuItem` через `CommandMenuItemResolver.deleteCommandMenuItem` (`shouldDeactivate = true`) -> `commandMenuItem:update` с `changedFields: ['overrides']`, затем сброс через `CommandMenuItemResolver.resetCommandMenuItem` (под `apiKey`) -> `commandMenuItem:update` с `overrides: null`.
   - Физическое удаление кастомного `commandMenuItem` через `CommandMenuItemResolver.deleteCommandMenuItem` (`shouldDeactivate = false`) -> `commandMenuItem:delete`.
   - Каскадное удаление `commandMenuItem` при удалении родительского `frontComponent` (`mode: 'frontComponent'`) -> `frontComponent:delete` + `commandMenuItem:delete`.
2. **Пакетные миграции приложений (`runAuditedApplicationMetadataMigration` и `isSystemBuild: true`) и барьер удаления `core.application`**:
   - Создание и обновление `commandMenuItem` через `withApplicationMetadataAudit` -> `commandMenuItem:create`, `commandMenuItem:update`.
   - Блокировка `runAuditedApplicationDelete` (`assertNoRemainingApplicationRoleOrPermissionMetadata`), пока у приложения остаётся собственная или зависимая строка `core."commandMenuItem"`.
   - Согласование (`reconcileApplicationRoleAndPermissionOperations`) и аудируемое удаление `commandMenuItem` при `isSystemBuild: true`, после которого `runAuditedApplicationDelete` проходит штатно.
   - Fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` при попытке выполнить неаудируемую миграцию `commandMenuItem`.
3. **Инварианты отказоустойчивости**:
   - Post-flush триггер, изменяющий `core."commandMenuItem"` после вставки в `crm_audit."crmAuditEntry"`, приводит к полному откату транзакции.
   - Потеря подтверждения `COMMIT` пробрасывает `NativeTransactionOutcomeUnknownError` без выполнения `ROLLBACK`.
