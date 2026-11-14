# LOG188 - Транзакционный аудит настроек, привилегий и манифестных привязок приложений (`core.application`) и key-value хранилища приложений (`core."keyValuePair"`)

## Сводка изменений
- В `crm-audit.types.ts` и `crm-audit-transaction-context.ts`:
  - расширен каталог `application` (`values: ['defaultRoleId', 'settingsCustomTabFrontComponentId', 'uninstallLogicFunctionId', 'healthCheckLogicFunctionId', 'autoUpgrade']`, `redacted: ['grantedCapabilities']`);
  - добавлен вид ресурса `applicationKeyValuePair` (`values: ['applicationId', 'scope']`, `redacted: ['key', 'value']`, действия `['create', 'update', 'delete']`).
- В `application-default-role-audit.ts`, `ApplicationService.update`, `ApplicationInstallResolver.updateApplication` и `ApplicationCapabilityResolver.grantApplicationCapabilities` реализован транзакционный аудит настроек, привилегий и манифестных привязок приложения (`runAuditedApplicationSettingsUpdate`, расширенный `runAuditedApplicationDefaultRoleUpdate`).
- В `workspace-domain-audit.ts`, `ApplicationKeyValueService`, `ApplicationKeyValueResolver` и `runAuditedApplicationDelete` (`application-authorization-and-variable-audit.ts`) реализован транзакционный аудит `applicationKeyValuePair` (`create`, `update`, `delete` в областях `WORKSPACE` и `SERVER` и каскадное удаление при удалении `core.application`).

## Артефакты
- [Дизайн](design.md)
- [Ревью дизайна](design-review.md)
- [Исследование тестов](test-research.md)
- [Ревью кода](review.md)
- [Результаты проверок](results.json)
- [Дифференциальный typecheck](typecheck-differential.json)
- [Снимок исходников](source-snapshot.json)
- [Лог регрессии](regression.log)
- [Следующая граница](next-boundary.md)
