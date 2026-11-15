# LOG191 - Исследование тестового покрытия

## Целевые тестовые наборы
1. `packages/twenty-server/test/fork-migration/crm-audit-application-default-role.postgres-spec.ts`:
   - Расширение схемы `ApplicationEntity` в тестовом стенде всеми колонками `core.application`.
   - Новый PostgreSQL-тест `LOG191`:
     - синхронизация метаданных и манифеста приложения (`name`, `description`, `logo`, `logoFileId`, `version`, `packageJsonChecksum`, `yarnLockChecksum`, `billing`, `grantedCapabilities`, `frontComponentSharedDependenciesChecksum`, `frontComponentSharedDependenciesBuiltPath`, `applicationRegistrationId`) через `ApplicationService.update`;
     - загрузка пакетных файлов (`packageJsonFileId`, `yarnLockFileId`, `packageJsonChecksum`, `yarnLockChecksum`, `availablePackages`) через `ApplicationService.uploadPackageFilesAndSetFileIds`;
     - обновление состояния SDK-клиента (`isSdkLayerStale: true`, `sdkClientCoreChecksum` -> `isSdkLayerStale: false`);
     - проверка идемпотентности при повторной записи тех же значений и сокрытия чувствительных полей в `redacted`.
2. `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts`:
   - Проверка `ApplicationService.createWorkspaceCustomApplicationRegistration` и `ApplicationService.createWorkspaceCustomApplication` с атомарной записью `applicationRegistration:create`, `application:create` и `application:update` (`packageJsonFileId`, `yarnLockFileId`).
