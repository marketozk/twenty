# LOG176 - план проверок

1. **Обновление переменных приложений уровня рабочего пространства (`core."applicationVariable"`)**:
   - `ApplicationVariableEntityResolver.updateOneApplicationVariable` -> `ApplicationVariableEntityService.update`: обновление значения переменной (`scope = 'WORKSPACE'`) от имени `workspaceMember` (под имперсонацией с фиксацией `initiator: { kind: 'coreUser' }`), `apiKey` и собственного `application` токена; запись `applicationVariable:update` с `changedFields: ['value']`, `values: {}` и отсутствием открытого секрета или `enc:v2:` в `redactedDiff`.
   - Идемпотентный повтор с тем же зашифрованным значением не создаёт дублирующей записи в `crm_audit."crmAuditEntry"`.
   - Отказ с каноническими ошибками `APPLICATION_VARIABLE_NOT_FOUND` (при отсутствующем ключе, отсутствующем приложении или приложении из чужого рабочего пространства) и `INVALID_APPLICATION_VARIABLE_INPUT` (при `scope = 'USER'`) под блокировкой БД без записи в журнал аудита.
   - Fail-closed отказ при отсутствии `auditIdentity`, при попытке приложения обновить переменную чужого приложения или при кросс-воркспейсной строке `applicationVariable`.

2. **Жизненный цикл флагов функций (`core."featureFlag"`)**:
   - `LabResolver.updateLabPublicFeatureFlag` -> `FeatureFlagService.upsertWorkspaceFeatureFlag`: создание (`featureFlag:create`, `values: { key: { before: null, after: ... }, value: { before: null, after: true } }`), повторный вызов с тем же значением (`0` новых записей аудита, `0` лишних сбросов кэша) и переключение в `false` (`featureFlag:update`, `values: { value: { before: true, after: false } }`).
   - `AdminPanelResolver.updateWorkspaceFeatureFlag`: управление флагом в том же рабочем пространстве и кросс-воркспейсное управление флагом в другом рабочем пространстве от имени серверного администратора (`actor: { kind: 'coreUser' }`), включая сессию с имперсонацией (`initiator: { kind: 'coreUser' }`).
   - `FeatureFlagService.enableFeatureFlags` (включая вызов из `WorkspaceService.activateWorkspace`): пакетное создание недостающих флагов, перевод существующих `false -> true` и пропуск уже включённых (`true`) флагов в одной транзакции с общим `operationId`.
   - Отказ с `UserInputError` при невалидном или непубличном ключе в `LabResolver` / `AdminPanelResolver` до открытия транзакции БД.

3. **Отказоустойчивость и защита после `audit.flush()`**:
   - Откат транзакции при повреждении строки `core."applicationVariable"` или `core."featureFlag"` триггером во время `audit.flush()`.
   - Инвалидация `'flatApplicationVariableMaps'` и `'featureFlagsMap'` и проброс `NativeTransactionOutcomeUnknownError` при потере подтверждения `COMMIT`.
