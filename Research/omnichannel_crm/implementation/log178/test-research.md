# LOG178 - План проверок (`skill`, `core.skill`)

## 1. Целевые PostgreSQL интеграционные сценарии (`crm-audit-skill.postgres-spec.ts`)

1. **Жизненный цикл `skill` через `SkillService` и `SkillResolver`**:
   - Создание пользовательского навыка через `SkillResolver.createSkill` (под пользователем с имперсонацией) -> `skill:create` с `values: { applicationId: customAppId, isCustom: true, isSystem: false, isActive: true }`, хешированными `name`, `label`, `icon`, `description`, `content` и без утечки текста инструкции в `values`.
   - Идемпотентный `SkillService.update` без изменения полей -> `0` новых записей аудита.
   - Обновление `name`, `label`, `icon`, `description`, `content` через `SkillResolver.updateSkill` (под `apiKey` и `application`) -> `skill:update` с `changedFields: ['content', 'description', 'icon', 'label', 'name']` и `values: {}`.
   - Деактивация (`deactivateSkill`) и повторная активация (`activateSkill`) как пользовательского навыка (`customAppId`), так и стандартного навыка (`standardAppId`, `isCustom: false`) -> `skill:update` с `changedFields: ['isActive']` и `values.isActive: { before: true, after: false }` / `{ before: false, after: true }`; повторный вызов `activateSkill` на уже активном навыке не создаёт лишних записей аудита.
   - Отказ при попытке удалить или изменить `content` стандартного навыка (`SkillExceptionCode.SKILL_IS_STANDARD`) -> `0` новых записей аудита.
   - Удаление пользовательского навыка через `SkillResolver.deleteSkill` -> `skill:delete` с `before` (`values: { applicationId: customAppId, isCustom: true, isSystem: false, isActive: true }`).
2. **Пакетные миграции приложений (`runAuditedApplicationMetadataMigration` и `isSystemBuild: true`) и барьер удаления `core.application`**:
   - Создание, идемпотентный повтор, обновление (`label`, `content`, `isSystem`, `isActive`) и удаление навыка приложения через `withApplicationMetadataAudit` и через `isSystemBuild: true` -> `skill:create`, `skill:update`, `skill:delete`.
   - Блокировка `runAuditedApplicationDelete` (`assertNoRemainingApplicationRoleOrPermissionMetadata`), пока у приложения остаются строки `core.skill`, и успешное удаление приложения после аудируемого удаления навыка.
   - Fail-closed отказ `WorkspaceMigrationRunnerService.executeRun` при попытке выполнить миграцию `skill` без контекста аудита.
3. **Инварианты отказоустойчивости**:
   - Post-flush триггер, изменяющий `core.skill` после вставки в `crm_audit."crmAuditEntry"`, приводит к полному откату транзакции.
   - Потеря подтверждения `COMMIT` пробрасывает `NativeTransactionOutcomeUnknownError` без выполнения `ROLLBACK`.
