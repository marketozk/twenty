# LOG188 - Исследование тестового покрытия

## 1. Существующие тесты
- `packages/twenty-server/test/fork-migration/crm-audit-application-default-role.postgres-spec.ts` - 6 интеграционных тестов PostgreSQL для `core.application` (`LOG164`).
- `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` - 8 интеграционных тестов PostgreSQL (`LOG174`, `LOG184`, `LOG185`, `LOG187`).
- `packages/twenty-server/src/engine/core-modules/application/application-install/__tests__/application-capability.resolver.spec.ts` - 8 unit-тестов `ApplicationCapabilityResolver`.

## 2. Новые тестовые сценарии LOG188
1. **Настройки, привилегии и манифестные привязки `core.application`** в `crm-audit-application-default-role.postgres-spec.ts`:
   - `ApplicationInstallResolver.updateApplication` записывает `application:update` при изменении `autoUpgrade` (`false -> true -> false`) и пропускает no-op повтор.
   - `ApplicationCapabilityResolver.grantApplicationCapabilities` записывает `application:update` с `grantedCapabilities` в `redacted` (детерминированное сравнение множества привилегий без дублирования на повторной выдаче).
   - `ApplicationManifestMigrationService.syncMetadataFromManifest` (и `ApplicationService.update`) записывает `application:update` при изменении `settingsCustomTabFrontComponentId`, `uninstallLogicFunctionId` и `healthCheckLogicFunctionId` (как вместе с `defaultRoleId`, так и отдельно от него).
2. **Жизненный цикл `applicationKeyValuePair` (`set`, `delete`, каскад при `ApplicationService.delete`)** в `crm-audit-workspace-domain.postgres-spec.ts`:
   - `ApplicationKeyValueResolver.setAppKeyValue` (create, update и no-op в области `WORKSPACE`; create и идемпотентный повтор в области `SERVER`, а также отказ при конфликте захвата другим рабочим пространством) и `ApplicationKeyValueResolver.deleteAppKeyValue` записывают `applicationKeyValuePair:create`, `applicationKeyValuePair:update` и `applicationKeyValuePair:delete` с `actor: { kind: 'application', id: targetAppId }`, `values: { applicationId, scope }` и сокрытием `key` и `value` в `redacted`.
   - `ApplicationService.delete` каскадно удаляет оставшиеся строки `core."keyValuePair"` (`WORKSPACE` и `SERVER`) и записывает `applicationKeyValuePair:delete` в одной транзакции.
