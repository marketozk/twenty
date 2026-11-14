# LOG189 - Проектирование транзакционного аудита полного жизненного цикла регистрации приложений (`applicationRegistration`, `core."applicationRegistration"`) и серверных переменных регистрации (`applicationRegistrationVariable`, `core."applicationRegistrationVariable"`)

## 1. Контекст и цель
После закрытия `LOG188` (`core.application` и `applicationKeyValuePair`) в контуре приложений рабочего пространства открытыми остаются две таблицы в `core`:
1. Регистрация приложений (`core."applicationRegistration"`):
   - Создание (`ApplicationRegistrationService.create` / `createWithClientSecret` в `ApplicationRegistrationResolver.createApplicationRegistration`, `ApplicationTarballService.createTarballRegistration` и `ApplicationService.createWorkspaceCustomApplicationRegistration`), обновление (`ApplicationRegistrationService.update`, `ApplicationRegistrationService.rotateClientSecret`, `ApplicationRegistrationService.claimOwnership`, `ApplicationRegistrationService.transferOwnership`, `ApplicationRegistrationService.updateFromManifest`, `ApplicationRegistrationAssetService.storeRegistrationAssets`) и удаление (`ApplicationRegistrationService.delete` в `ApplicationRegistrationResolver.deleteApplicationRegistration`) выполнялись без транзакционного аудита `applicationRegistration`.
2. Серверные переменные регистрации приложений (`core."applicationRegistrationVariable"`):
   - Синхронизация схем переменных из манифеста (`ApplicationRegistrationVariableService.syncVariableSchemas` при `ApplicationRegistrationService.updateFromManifest` / `createFromCatalog`), обновление и сброс зашифрованных значений переменных (`ApplicationRegistrationVariableService.updateVariable` в `ApplicationRegistrationResolver.updateApplicationRegistrationVariable`) и каскадное удаление переменных при удалении `core."applicationRegistration"` (`ON DELETE CASCADE`) выполнялись без транзакционного аудита `applicationRegistrationVariable`.

Цель `LOG189` - обеспечить атомарный транзакционный аудит полного жизненного цикла `applicationRegistration` (`create`, `update`, `delete`) и `applicationRegistrationVariable` (`create`, `update`, `delete`, включая каскадное удаление при удалении `core."applicationRegistration"`).

## 2. Рассмотренные варианты

### Вариант A (рекомендуемый) - Расширение `workspace-domain-audit.ts`
- **Каталог (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
  - Добавить ресурс `applicationRegistration`:
    - `values`: `['universalIdentifier', 'ownerWorkspaceId', 'createdByUserId', 'sourceType', 'tarballFileId', 'logoFileId', 'latestAvailableVersion', 'isListed', 'isVetted', 'isPreInstalled']`
    - `redacted`: `['name', 'oAuthClientId', 'oAuthClientSecretHash', 'oAuthRedirectUris', 'oAuthScopes', 'sourcePackage', 'manifest', 'logo', 'description', 'author', 'category', 'websiteUrl', 'aboutDescription', 'pricingDescription', 'termsUrl', 'emailSupport', 'issueReportUrl', 'screenshots', 'galleryImages', 'deletedAt']`
    - `ADMINISTRATIVE_ACTIONS.applicationRegistration`: `['create', 'update', 'delete']`.
  - Добавить ресурс `applicationRegistrationVariable`:
    - `values`: `['applicationRegistrationId', 'type', 'isSecret', 'isRequired', 'isDeprecated']`
    - `redacted`: `['key', 'encryptedValue', 'description', 'options']`
    - `ADMINISTRATIVE_ACTIONS.applicationRegistrationVariable`: `['create', 'update', 'delete']`.
- **Транзакционные владельцы в `workspace-domain-audit.ts`**:
  - `projectApplicationRegistration` и `projectApplicationRegistrationVariable`.
  - `runAuditedApplicationRegistrationCreate`, `runAuditedApplicationRegistrationUpdate`, `runAuditedApplicationRegistrationDelete` (включая блокировку и каскадный аудит `applicationRegistrationVariable:delete` при удалении регистрации), `runAuditedApplicationRegistrationClaimOwnership` и `runAuditedApplicationRegistrationTransferOwnership`.
  - `runAuditedApplicationRegistrationVariableUpdate` и `runAuditedApplicationRegistrationVariableSync`.
- **Подключение сервисов и резолверов**:
  - В `ApplicationRegistrationResolver` (`createApplicationRegistration`, `updateApplicationRegistration`, `deleteApplicationRegistration`, `rotateApplicationRegistrationClientSecret`, `claimApplicationRegistrationOwnership`, `transferApplicationRegistrationOwnership`, `updateApplicationRegistrationVariable`, `completeAppTarballUpload`, `uploadAppTarball`) и `ApplicationRegistrationClaimController` (`githubCallback`) передавать контекст запроса (`auditIdentity`).
  - В `ApplicationRegistrationService` (`createWithClientSecret`, `create`, `update`, `rotateClientSecret`, `claimOwnership`, `transferOwnership`, `updateFromManifest`, `delete`) и `ApplicationRegistrationVariableService` (`updateVariable`, `syncVariableSchemas`) запускать транзакционный аудит при наличии `ownerWorkspaceId` и подключённого `DataSource`.

### Вариант B - Отдельный перехватчик TypeORM Subscriber
- **Минусы**: нарушает архитектурное правило проекта (запрет неявных ORM-хуков вместо явных транзакционных владельцев с проверкой post-flush).

## 3. Выбор решения
Выбран **Вариант A**: расширение `workspace-domain-audit.ts` с полным сокрытием OAuth-секретов, манифестов и зашифрованных значений переменных и проверкой состояния после `audit.flush()`.
