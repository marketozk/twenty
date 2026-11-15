# LOG190 - Исследование тестового покрытия

## Целевые тестовые наборы
1. `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts`:
   - Расширение схемы `EntitySchema` для `ApplicationRegistrationVersionEntity` (`core."applicationRegistrationVersion"`).
   - Новый PostgreSQL-тест `LOG190`:
     - публикация версии при `ApplicationRegistrationService.updateFromManifest` (`publishedVersion`) с атомарной записью `applicationRegistration:update`, `applicationRegistrationVariable:create` и `applicationRegistrationVersion:create` под одним `operationId`;
     - идемпотентное создание и дозаполнение `tarballUrl` в `ApplicationRegistrationVersionService.ensureNpmVersion` (`applicationRegistrationVersion:create` -> `applicationRegistrationVersion:update`);
     - обновление `logoFileId` и `galleryImages` в `ApplicationRegistrationAssetService.storeRegistrationAssets` (`applicationRegistration:update` с `logoFileId` в `values` и `galleryImages` в `redacted`);
     - создание приложения через `ApplicationDevelopmentResolver.createDevelopmentApplication` / `ApplicationService.create` (`application:create` с проверкой `values` и сокрытия `name`, `sourcePath`, `availablePackages`, `billing`, `grantedCapabilities`);
     - каскадное удаление `applicationRegistrationVersion` и `applicationRegistrationVariable` при `ApplicationRegistrationService.delete` с общим `operationId`.
2. `packages/twenty-server/test/fork-migration/crm-audit-application-default-role.postgres-spec.ts`:
   - Проверка сохранения всех существующих сценариев `LOG164` и `LOG188`.
