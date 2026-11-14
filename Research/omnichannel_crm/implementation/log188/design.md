# LOG188 - Проектирование транзакционного аудита настроек, привилегий и манифестных привязок приложений (`application`, `core.application`) и key-value хранилища приложений (`applicationKeyValuePair`, `core."keyValuePair"`)

## 1. Контекст и цель
После закрытия `LOG187` (привязка логотипа рабочего пространства и переводы приложений `applicationTranslation`) в контуре приложений рабочего пространства открытыми остаются две поверхности записи:
1. Административные настройки, привилегии и манифестные привязки приложений (`core.application`):
   - Ранее (`LOG164`) в `core.application` аудировалось только поле `defaultRoleId`.
   - Обновление флага автоматического обновления `autoUpgrade` (`ApplicationInstallResolver.updateApplication`), выдача привилегий приложения `grantedCapabilities` (`ApplicationCapabilityResolver.grantApplicationCapabilities`, `ApplicationInstallService`, `ApplicationSyncService`), а также обновление манифестных привязок `settingsCustomTabFrontComponentId`, `uninstallLogicFunctionId`, `healthCheckLogicFunctionId` (`ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`) в `ApplicationService.update` не записывали транзакционный аудит `application:update`.
2. Хранилище пар ключ-значение приложений (`core."keyValuePair"` с `type = 'APPLICATION_VARIABLE'`):
   - `ApplicationKeyValueService.set` и `ApplicationKeyValueService.delete` (`ApplicationKeyValueResolver.setAppKeyValue` и `ApplicationKeyValueResolver.deleteAppKeyValue`) создают, обновляют и удаляют пары ключ-значение приложения в области `WORKSPACE` (`workspaceId` заполнен) и `SERVER` (`workspaceId IS NULL`, `value` хранит UUID рабочего пространства, захватившего ключ) без транзакционного аудита.
   - При удалении `core.application` через `ApplicationService.delete` связанные строки `core."keyValuePair"` удаляются по `ON DELETE CASCADE` без записи аудита.

Цель `LOG188` - обеспечить атомарный транзакционный аудит:
- `application` (`update` в `core.application` для `defaultRoleId`, `settingsCustomTabFrontComponentId`, `uninstallLogicFunctionId`, `healthCheckLogicFunctionId`, `autoUpgrade` и `grantedCapabilities`);
- `applicationKeyValuePair` (`create`, `update`, `delete` в `core."keyValuePair"` при вызовах `ApplicationKeyValueService.set` / `delete` и при каскадном удалении в `ApplicationService.delete`).

## 2. Рассмотренные варианты

### Вариант A (рекомендуемый) - Расширение `application-default-role-audit.ts`, `application-authorization-and-variable-audit.ts` и `workspace-domain-audit.ts`
- **Каталог (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
  - Расширить `CATALOG.application`:
    - `values`: `['defaultRoleId', 'settingsCustomTabFrontComponentId', 'uninstallLogicFunctionId', 'healthCheckLogicFunctionId', 'autoUpgrade']`
    - `redacted`: `['grantedCapabilities']`
    - `ADMINISTRATIVE_ACTIONS.application`: `['update']`.
  - Добавить ресурс `applicationKeyValuePair` (`core."keyValuePair"`):
    - `values`: `['applicationId', 'scope']`
    - `redacted`: `['key', 'value']`
    - `ADMINISTRATIVE_ACTIONS.applicationKeyValuePair`: `['create', 'update', 'delete']`.
- **Аудит настроек, привилегий и привязок `core.application` (`application-default-role-audit.ts`, `ApplicationService`, `ApplicationInstallResolver`, `ApplicationCapabilityResolver`)**:
  - В `application-default-role-audit.ts` добавить `projectApplicationAuditFields`, `captureApplicationSettingsAudit` и `runAuditedApplicationSettingsUpdate`, а также расширить `runAuditedApplicationDefaultRoleUpdate` параметром `changedKeys`, чтобы при совместном обновлении `defaultRoleId` и манифестных привязок (`settingsCustomTabFrontComponentId`, `uninstallLogicFunctionId`, `healthCheckLogicFunctionId`) все изменённые поля фиксировались в одной записи `application:update`.
  - В `ApplicationService.update` направлять обновления, затрагивающие `APPLICATION_AUDIT_ALL_KEYS` без `defaultRoleId`, через `runAuditedApplicationSettingsUpdate` при наличии `options?.auditIdentity` или активного контекста аудита.
  - В `ApplicationInstallResolver.updateApplication` и `ApplicationCapabilityResolver.grantApplicationCapabilities` передавать контекст запроса (`roleAuditIdentityFromRequest` и `withCrmAuditRequest(captureCrmAuditRequest(context.req), ...)`).
- **Аудит `ApplicationKeyValueService` и каскада при `ApplicationService.delete` (`workspace-domain-audit.ts`, `application-authorization-and-variable-audit.ts`)**:
  - В `workspace-domain-audit.ts` добавить `projectApplicationKeyValuePair`, `runAuditedApplicationKeyValueSet` и `runAuditedApplicationKeyValueDelete`.
  - В `ApplicationKeyValueService.set` и `ApplicationKeyValueService.delete` выполнять операции `WORKSPACE` и `SERVER` через `runAuditedApplicationKeyValueSet` / `runAuditedApplicationKeyValueDelete`.
  - В `runAuditedApplicationDelete` (`application-authorization-and-variable-audit.ts`) блокировать строки `core."keyValuePair"` (`WHERE "applicationId"=$1 AND type='APPLICATION_VARIABLE' ORDER BY id FOR UPDATE`), проверять принадлежность `workspaceId` и записывать каскадные `applicationKeyValuePair:delete` в одной транзакции с `applicationAuthorization:delete` и `publicDomain:delete`.

### Вариант B - Отдельный перехватчик TypeORM Subscriber на `ApplicationEntity` и `KeyValuePairEntity`
- **Минусы**: нарушает архитектурное правило проекта (запрет неявных ORM-хуков вместо явных транзакционных владельцев с проверкой post-flush).

## 3. Выбор решения
Выбран **Вариант A**: хирургическое расширение существующих транзакционных владельцев `application-default-role-audit.ts`, `application-authorization-and-variable-audit.ts` и `workspace-domain-audit.ts` с полной обратной совместимостью всех существующих тестов (`LOG164`, `LOG165`, `LOG167`, `LOG174`).
