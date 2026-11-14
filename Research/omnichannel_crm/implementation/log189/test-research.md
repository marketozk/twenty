# LOG189 - Исследование тестового покрытия

## 1. Существующие тесты
- `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` - 9 интеграционных тестов PostgreSQL (`LOG174`, `LOG184`, `LOG185`, `LOG187`, `LOG188`).
- `packages/twenty-server/src/engine/core-modules/application/application-registration/__tests__/application-registration-upsert-from-catalog.spec.ts` - unit-тесты `upsertFromCatalog`.
- `packages/twenty-server/src/engine/core-modules/application/application-registration/__tests__/application-registration-asset-broadcast.spec.ts` - unit-тесты `ApplicationRegistrationAssetService`.

## 2. Новые тестовые сценарии LOG189 в `crm-audit-workspace-domain.postgres-spec.ts`
1. **Жизненный цикл `applicationRegistration` (`create`, `update`, `rotateClientSecret`, `claimOwnership`, `transferOwnership`, `delete`)**:
   - Создание регистрации через `ApplicationRegistrationResolver.createApplicationRegistration` записывает `applicationRegistration:create` с `values` (`universalIdentifier`, `ownerWorkspaceId`, `createdByUserId`, `sourceType`, `isListed`, `isVetted`, `isPreInstalled`) и полным сокрытием `name`, `oAuthClientId`, `oAuthClientSecretHash`, `oAuthRedirectUris`, `oAuthScopes` в `redacted`.
   - Обновление регистрации через `ApplicationRegistrationResolver.updateApplicationRegistration` и ротация секрета через `rotateApplicationRegistrationClientSecret` записывают `applicationRegistration:update` с изменёнными полями в `changedFields` без утечки хеша секрета или URI.
   - Захват владения (`claimApplicationRegistrationOwnership`) и передача владения (`transferApplicationRegistrationOwnership`) записывают `applicationRegistration:update` с точным переходом `ownerWorkspaceId`.
2. **Жизненный цикл `applicationRegistrationVariable` (`syncVariableSchemas`, `updateApplicationRegistrationVariable`) и каскадное удаление при `deleteApplicationRegistration`**:
   - Синхронизация переменных манифеста через `ApplicationRegistrationVariableService.syncVariableSchemas` (create, update, delete) и обновление значения через `ApplicationRegistrationResolver.updateApplicationRegistrationVariable` записывают `applicationRegistrationVariable:create`, `update`, `delete` с полным сокрытием `key`, `encryptedValue`, `description`, `options`.
   - Удаление регистрации через `ApplicationRegistrationResolver.deleteApplicationRegistration` каскадно удаляет оставшиеся строки `core."applicationRegistrationVariable"` и записывает `applicationRegistrationVariable:delete` и `applicationRegistration:delete` в одной транзакции.
