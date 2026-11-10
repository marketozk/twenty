# LOG181 - План проверок (`timelineActivityType`)

## 1. Целевые PostgreSQL интеграционные сценарии (`crm-audit-timeline-activity-type.postgres-spec.ts`)

1. **Жизненный цикл `timelineActivityType` через `TimelineActivityTypeResolver` и `TimelineActivityTypeService`**:
   - Переопределение стандартного типа события таймлайна через `TimelineActivityTypeResolver.updateTimelineActivityType` (под пользователем с имперсонацией, изменение `label`, `icon`, `isActive: false`, `translations`) -> `timelineActivityType:update` с `changedFields: ['overrides']` (поскольку для не-кастомного типа переопределения записываются в `overrides.workspaceCustom`).
   - Идемпотентный `TimelineActivityTypeResolver.updateTimelineActivityType` без фактических изменений -> `0` новых записей аудита.
   - Сброс переопределений стандартного типа через `TimelineActivityTypeResolver.resetTimelineActivityType` (под `apiKey`) -> `timelineActivityType:update` с `changedFields: ['overrides']` (`overrides: null`).
   - Обновление кастомного `timelineActivityType` (`label`, `icon`, `isActive: false`) через `TimelineActivityTypeResolver.updateTimelineActivityType` -> `timelineActivityType:update` с `changedFields: ['icon', 'isActive', 'label']` и `values: { isActive: { before: true, after: false } }`, а также отказ `resetTimelineActivityType` на кастомном типе с `TIMELINE_ACTIVITY_TYPE_CANNOT_BE_RESET`.
2. **Пакетные миграции приложений (`runAuditedApplicationMetadataMigration` и `isSystemBuild: true`) и барьер удаления `core.application`**:
   - Создание `timelineActivityType` через `withApplicationMetadataAudit` -> `timelineActivityType:create`.
   - Обновление `timelineActivityType` (`label`, `action`, `frontComponentUniversalIdentifier`, `triggerFieldUniversalIdentifiers`, `replacesTimelineActivityTypeUniversalIdentifier`, `isActive`) -> `timelineActivityType:update`.
   - Блокировка `runAuditedApplicationDelete` (`assertNoRemainingApplicationRoleOrPermissionMetadata`), пока у приложения остаётся строка `core."timelineActivityType"`.
   - Аудируемое удаление `timelineActivityType` при `isSystemBuild: true`, после которого `runAuditedApplicationDelete` проходит штатно.
   - Fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` при попытке выполнить неаудируемую миграцию `timelineActivityType`.
3. **Инварианты отказоустойчивости**:
   - Post-flush триггер, изменяющий `core."timelineActivityType"` после вставки в `crm_audit."crmAuditEntry"`, приводит к полному откату транзакции.
   - Потеря подтверждения `COMMIT` пробрасывает `NativeTransactionOutcomeUnknownError` без выполнения `ROLLBACK`.
