# LOG191 - Дизайн транзакционного аудита обновлений метаданных, пакета, SDK-слоя и манифеста установленных приложений (`core.application`) и создания кастомной регистрации рабочего пространства (`ApplicationService.createWorkspaceCustomApplicationRegistration`)

## 1. Контекст и цель
После закрытия `LOG188`-`LOG190` в `ApplicationService` и связанных сервисах жизненного цикла установленных приложений остаются следующие мутации в `core.application` и `core."applicationRegistration"`:
1. **Синхронизация манифеста установленного приложения (`ApplicationSyncService.syncApplication` -> `ApplicationService.update`)**:
   - Обновление `name`, `description`, `logo`, `version`, `packageJsonChecksum`, `yarnLockChecksum`, `billing`, `grantedCapabilities`, `frontComponentSharedDependenciesChecksum`, `frontComponentSharedDependenciesBuiltPath` и `applicationRegistrationId` в `core.application`.
2. **Загрузка файлов пакета и привязка `packageJsonFileId` / `yarnLockFileId` (`ApplicationService.uploadPackageFilesAndSetFileIds` -> `ApplicationService.update`)**:
   - Обновление `packageJsonFileId`, `yarnLockFileId`, `packageJsonChecksum`, `yarnLockChecksum` и `availablePackages` в `core.application`.
3. **Обновление логотипа и версии при установке приложения (`ApplicationInstallService.installApplication` / `markInstallCompleted` -> `ApplicationService.update`)**:
   - Обновление `logo`, `logoFileId` и `version` в `core.application`.
4. **Обновление состояния SDK-клиента (`SdkClientGenerationService.storeSdkClientCoreChecksum` -> `ApplicationService.update` и `SdkClientArchiveService.markSdkLayerFresh`)**:
   - Обновление `isSdkLayerStale` и `sdkClientCoreChecksum` в `core.application`.
5. **Создание кастомной регистрации рабочего пространства (`ApplicationService.createWorkspaceCustomApplicationRegistration`)**:
   - Запись `core."applicationRegistration"` при создании кастомного приложения рабочего пространства вне внешнего `queryRunner`.

## 2. Архитектура решения
1. В `application-default-role-audit.ts`:
   - Расширяются множества `APPLICATION_AUDIT_UUID_KEYS` (`applicationRegistrationId`, `logoFileId`, `packageJsonFileId`, `yarnLockFileId`, `logicFunctionLayerId`, `primaryPublicDomainId`), `APPLICATION_AUDIT_BOOLEAN_KEYS` (`canBeUninstalled`, `isSdkLayerStale`) и добавляются `APPLICATION_AUDIT_STRING_KEYS` (`version`, `name`, `description`, `logo`, `sourceType`, `state`, `sourcePath`, `packageJsonChecksum`, `yarnLockChecksum`, `uninstallHookCompletedForRequestedAt`, `sdkClientCoreChecksum`, `frontComponentSharedDependenciesChecksum`, `frontComponentSharedDependenciesBuiltPath`) и `APPLICATION_AUDIT_JSON_KEYS` (`availablePackages`, `billing`).
   - В `runAuditedApplicationDefaultRoleUpdate` сохраняется набор `APPLICATION_AUDIT_ROLE_COMPANION_KEYS` (`settingsCustomTabFrontComponentId`, `uninstallLogicFunctionId`, `healthCheckLogicFunctionId`, `autoUpgrade`, `grantedCapabilities`), чтобы неизменный `defaultRoleId` не порождал лишнюю запись аудита роли при попутном обновлении `version`.
   - В `runAuditedApplicationSettingsUpdate` проецируются все ключи из `APPLICATION_AUDIT_NON_ROLE_KEYS`, изменившиеся в данном вызове `ApplicationService.update`.
   - В `captureApplicationSettingsAudit` поддерживается `defaultSystemActorId?: string`, используемый при вызове из внутренних сервисов (`ApplicationSyncService`, `ApplicationInstallService`, `SdkClientGenerationService`, `ApplicationService.uploadPackageFilesAndSetFileIds`) вне пользовательского GraphQL-контекста.
2. В `ApplicationService`:
   - В `createWorkspaceCustomApplicationRegistration`: при отсутствии внешнего `queryRunner` и наличии `coreDataSource` создание регистрации выполняется через `runAuditedApplicationRegistrationCreate`.
   - В `update`: все обновления полей из `APPLICATION_AUDIT_ALWAYS_NON_ROLE_KEYS` (а также `version` при наличии `auditIdentity` или активного ALS-контекста аудита) выполняются атомарно через `runAuditedApplicationSettingsUpdate`.
3. В `SdkClientArchiveService.markSdkLayerFresh`:
   - При наличии `applicationService` или `coreDataSource` сброс `isSdkLayerStale: false` выполняется через транзакционный аудит `runAuditedApplicationSettingsUpdate`.
