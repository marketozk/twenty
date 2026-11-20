# LOG192 - Ревью дизайна

## Вердикт
`pass` (блокеров не выявлено)

## Проверка по чеклисту
1. **Единый `operationId` и атомарность**:
   - `application:delete` и все каскадные `applicationAuthorization:delete`, `publicDomain:delete`, `applicationKeyValuePair:delete` записываются в один `CrmAuditTransactionContext` внутри одной `runInCoreAuditTransaction`, до `COMMIT`, с повторной проверкой отсутствия `core.application` и каскадных строк после `audit.flush()`.
2. **Fail-closed инвариант**:
   - Любое прямое удаление `core.application` через `ApplicationService.delete` / `runAuditedApplicationDelete` без валидного `auditIdentity` (и без ambient ALS) отклоняется до вызова `work(runner)`, даже если у приложения нет связанных строк в `applicationAuthorization`, `publicDomain` или `keyValuePair`.
   - Предварительная проверка `assertNoRemainingApplicationRoleOrPermissionMetadata` сохраняется первой, так что удаление приложения с оставшимися ролями/правами/метаданными продолжает блокироваться до проверки авторизации.
3. **Сокрытие чувствительных метаданных**:
   - `projectApplication` передаёт в `CrmAuditTransactionContext` все поля `core.application`; согласно `CATALOG.application`, поля `name`, `description`, `logo`, `sourcePath`, контрольные суммы, `availablePackages`, `billing`, `grantedCapabilities` хешируются в `redacted`, а в `values` отражаются только скалярные идентификаторы, флаги и версия.
4. **Обратная совместимость**:
   - Все вызовы `ApplicationUninstallRunnerService.uninstallApplication` без `auditIdentity` (включая `TriggerUninstallApplicationJob` под `withCrmAuditIdentity`) продолжают работать без изменения сигнатуры вызова.
   - `ApplicationInstallResolver.uninstallApplication` принимает `@Context() context` опционально, как `updateApplication`.
5. **Граница Enterprise**:
   - Ни один изменяемый файл не добавляет импортов в `@license Enterprise` модули.
