# LOG190 - Транзакционный аудит версий регистраций приложений (`core."applicationRegistrationVersion"`), ассетов регистраций (`ApplicationRegistrationAssetService`) и создания приложений (`core.application`)

## Сводка изменений
- В `crm-audit.types.ts` и `crm-audit-transaction-context.ts`:
  - добавлен вид ресурса `applicationRegistrationVersion` (`values: ['applicationRegistrationId', 'version', 'sourceType', 'tarballFileId']`, `redacted: ['sourcePackage', 'tarballUrl', 'publishedAt']`, действия `['create', 'update', 'delete']`);
  - расширен каталог `application` (`values: ['universalIdentifier', 'applicationRegistrationId', 'sourceType', 'state', 'version', 'logoFileId', 'packageJsonFileId', 'yarnLockFileId', 'logicFunctionLayerId', 'defaultRoleId', 'settingsCustomTabFrontComponentId', 'uninstallLogicFunctionId', 'healthCheckLogicFunctionId', 'primaryPublicDomainId', 'canBeUninstalled', 'autoUpgrade', 'isSdkLayerStale']`, `redacted: ['name', 'description', 'logo', 'sourcePath', 'packageJsonChecksum', 'yarnLockChecksum', 'availablePackages', 'billing', 'grantedCapabilities', 'uninstallHookCompletedForRequestedAt', 'sdkClientCoreChecksum', 'frontComponentSharedDependenciesChecksum', 'frontComponentSharedDependenciesBuiltPath', 'deletedAt']`, действия `['create', 'update', 'delete']`).
- В `workspace-domain-audit.ts` добавлены проекции `projectApplicationRegistrationVersion`, `projectApplication` и транзакционные хелперы `runAuditedApplicationRegistrationVersionSync` и `runAuditedApplicationCreate`, а также расширены `runAuditedApplicationRegistrationUpdate` (`includeVersions`) и `runAuditedApplicationRegistrationDelete` (каскадный аудит `applicationRegistrationVersion:delete`).
- В `ApplicationRegistrationVersionService`, `ApplicationRegistrationAssetService`, `ApplicationRegistrationService`, `ApplicationTarballService`, `ApplicationInstallService`, `ApplicationDevelopmentService`, `ApplicationDevelopmentResolver` и `ApplicationService.create` подключён транзакционный аудит версий и ассетов регистраций и создания экземпляров приложений.

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
