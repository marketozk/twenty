# LOG190 - Дизайн транзакционного аудита версий регистраций приложений (`core."applicationRegistrationVersion"`), ассетов регистраций (`ApplicationRegistrationAssetService`) и создания приложений (`core.application`)

## 1. Контекст и цель
После закрытия `LOG189` (`core."applicationRegistration"` и `core."applicationRegistrationVariable"`) в контуре жизненного цикла приложений и регистраций остаются следующие открытые административные мутации в `core`:
1. **Жизненный цикл версий регистраций приложений (`core."applicationRegistrationVersion"`)**:
   - Создание записи опубликованной версии в `ApplicationRegistrationService.updateFromManifest` (при публикации tarball-релиза), `ApplicationTarballService.recordPublishedTarballVersion` и `ApplicationRegistrationVersionService.createApplicationRegistrationVersion` / `ensureNpmVersion` (включая дозаполнение `tarballUrl` при установке NPM-приложения в `ApplicationInstallService.installApplication`);
   - Каскадное удаление всех строк `core."applicationRegistrationVersion"` при удалении родительской записи `core."applicationRegistration"` (`onDelete: 'CASCADE'`) в `ApplicationRegistrationService.delete`.
2. **Обновление ассетов регистрации (`logoFileId`, `galleryImages`) в `ApplicationRegistrationAssetService.storeRegistrationAssets`**:
   - Запись `logoFileId` и `galleryImages` в `core."applicationRegistration"` после сохранения файлов ассетов при синхронизации dev-приложения (`ApplicationDevelopmentService.syncApplication`) и загрузке tarball-пакета (`ApplicationTarballService`).
3. **Создание экземпляра установленного/разрабатываемого приложения (`core.application` `create`)**:
   - Создание записи `core.application` в `ApplicationService.create` (вызывается из `ApplicationDevelopmentService.createDevelopmentApplication`, `ApplicationInstallService.ensureApplicationExists`, `OAuthService.findOrInstallApplication`, `ApplicationService.createTwentyStandardApplication` и `ApplicationService.createWorkspaceCustomApplication`).

## 2. Каталог аудита и классификация полей
1. Новый вид ресурса `applicationRegistrationVersion` (`core."applicationRegistrationVersion"`):
   - `values`: `['applicationRegistrationId', 'version', 'sourceType', 'tarballFileId']`
   - `redacted`: `['sourcePackage', 'tarballUrl', 'publishedAt']`
   - `ADMINISTRATIVE_ACTIONS.applicationRegistrationVersion`: `['create', 'update', 'delete']`
2. Расширение каталога `application` (`core.application`):
   - `values`:
     - `'universalIdentifier'`
     - `'applicationRegistrationId'`
     - `'sourceType'`
     - `'state'`
     - `'version'`
     - `'logoFileId'`
     - `'packageJsonFileId'`
     - `'yarnLockFileId'`
     - `'logicFunctionLayerId'`
     - `'defaultRoleId'`
     - `'settingsCustomTabFrontComponentId'`
     - `'uninstallLogicFunctionId'`
     - `'healthCheckLogicFunctionId'`
     - `'primaryPublicDomainId'`
     - `'canBeUninstalled'`
     - `'autoUpgrade'`
     - `'isSdkLayerStale'`
   - `redacted`:
     - `'name'`
     - `'description'`
     - `'logo'`
     - `'sourcePath'`
     - `'packageJsonChecksum'`
     - `'yarnLockChecksum'`
     - `'availablePackages'`
     - `'billing'`
     - `'grantedCapabilities'`
     - `'uninstallHookCompletedForRequestedAt'`
     - `'sdkClientCoreChecksum'`
     - `'frontComponentSharedDependenciesChecksum'`
     - `'frontComponentSharedDependenciesBuiltPath'`
     - `'deletedAt'`
   - `ADMINISTRATIVE_ACTIONS.application`: `['create', 'update', 'delete']` (существующие точечные обновления `defaultRoleId` и настроек в `application-default-role-audit.ts` продолжают проецировать только изменяемые ключи, поэтому их диффы остаются неизменными).

## 3. Архитектура транзакционных владельцев
- В `workspace-domain-audit.ts`:
  - `projectApplicationRegistrationVersion` и `runAuditedApplicationRegistrationVersionSync`:
    - блокируют `core.workspace` (`FOR NO KEY UPDATE`), `core."applicationRegistration"` (`FOR NO KEY UPDATE`) и существующие строки `core."applicationRegistrationVersion"` (`ORDER BY id FOR UPDATE`);
    - выполняют `work(runner)`, вычисляют дифф по версиям (`create` / `update` / `delete`), делают `audit.flush()` и перепроверяют состояние после flush.
  - В `runAuditedApplicationRegistrationUpdate`:
    - добавляется флаг `includeVersions?: boolean`: при `includeVersions: true` снимки `core."applicationRegistrationVersion"` снимаются до и после `work(runner)` и записываются в один `CrmAuditTransactionContext` вместе с `applicationRegistration:update` и `applicationRegistrationVariable`.
  - В `runAuditedApplicationRegistrationDelete`:
    - при наличии таблицы `core."applicationRegistrationVersion"` все строки версий для удаляемой регистрации блокируются (`ORDER BY id FOR UPDATE`) до удаления `core."applicationRegistration"`, проверяются на отсутствие после каскадного удаления и записывают `applicationRegistrationVersion:delete` с тем же `operationId`, что и `applicationRegistration:delete` и `applicationRegistrationVariable:delete`.
  - `projectApplication` и `runAuditedApplicationCreate`:
    - блокируют `core.workspace` (`FOR NO KEY UPDATE`), выполняют создание строки `core.application` в транзакции, валидируют сохранённую строку (`FOR UPDATE`), записывают `application:create`, выполняют `audit.flush()` и перепроверяют состояние после flush.
- В `ApplicationRegistrationAssetService.storeRegistrationAssets`:
  - загрузка ассетов в `serverFileStorageService` остаётся вне транзакции БД;
  - запись `logoFileId` и `galleryImages` в `core."applicationRegistration"` при наличии `dataSource` и `workspaceId` (явного или `registrationBeforeAssetWrite.ownerWorkspaceId`) выполняется через `runAuditedApplicationRegistrationUpdate`.
