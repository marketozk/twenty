# LOG187 - Проектирование транзакционного аудита привязки логотипа рабочего пространства (`workspace.logoFileId`) и переводов приложений (`applicationTranslation`, `core."applicationTranslation"`)

## 1. Контекст и цель
После закрытия `LOG186` (обновления настроек, `allowedIframeOrigins` и `isCustomDomainEnabled` в `core.workspace`) открытыми остаются две связанные поверхности настроек и локализации:
1. Привязка загруженного файла логотипа рабочего пространства к `core.workspace."logoFileId"` в `FileCorePictureService.completeWorkspaceLogoUpload` и `FileCorePictureService.uploadWorkspacePicture` (вызываются из `FileCorePictureResolver.completeWorkspaceLogoUpload`, `FileCorePictureResolver.uploadWorkspaceLogo`, `AuthResolver.completeNewWorkspaceLogoUpload`, `AuthResolver.uploadNewWorkspaceLogo`).
2. Синхронизация переводов приложений в `core."applicationTranslation"` (`ApplicationTranslationEntity`) через `ApplicationTranslationSyncService.syncFromManifest` (вызывается из `ApplicationSyncService.synchronizeFromManifest`).

Цель `LOG187` - обеспечить атомарный транзакционный аудит `workspace:update` (`logoFileId`) при привязке логотипа активного рабочего пространства и `applicationTranslation` (`create`, `update`, `delete`) при синхронизации переводов манифеста приложения.

## 2. Рассмотренные варианты

### Вариант A (рекомендуемый) - Расширение `FileCorePictureService` через `runAuditedWorkspaceSettingsUpdate` и добавление `applicationTranslation` в `workspace-domain-audit.ts`
- **Каталог (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)**:
  - Добавить ресурс `applicationTranslation` в `CrmAuditResourceKind`, `CATALOG` и `ADMINISTRATIVE_ACTIONS`:
    - `values`: `['applicationRegistrationId', 'locale']`
    - `redacted`: `['messages', 'deletedAt']`
    - действия: `['create', 'update', 'delete']`.
- **Аудит привязки логотипа (`FileCorePictureService`, `FileCorePictureResolver`)**:
  - В `FileCorePictureResolver.uploadWorkspaceLogo` и `FileCorePictureResolver.completeWorkspaceLogoUpload` принимать `@Context() context?: { req?: Request }` и передавать `auditIdentity: isDefined(context?.req) ? roleAuditIdentityFromRequest(context.req) : undefined` в `FileCorePictureService`.
  - В `FileCorePictureService.uploadWorkspacePicture` и `FileCorePictureService.completeWorkspaceLogoUpload` захватывать `requireSettingsAudit = isDefined(auditIdentity) ? captureWorkspaceSettingsAudit(workspaceId, auditIdentity) : undefined` до первого `await`.
  - В `claimFileAsWorkspaceLogo` при наличии `settingsAudit` и `coreDataSource` (и если рабочее пространство не находится в `PENDING_CREATION`) выполнять блокировку строки, `claimTemporaryFile` и `manager.update(WorkspaceEntity, workspaceId, { logoFileId: fileId })` внутри `runAuditedWorkspaceSettingsUpdate(resolvedDataSource, settingsAudit, ['logoFileId'], ...)`.
  - Для `AuthResolver.uploadNewWorkspaceLogo` и `AuthResolver.completeNewWorkspaceLogoUpload` рабочее пространство гарантированно находится в `WorkspaceActivationStatus.PENDING_CREATION` (`getPendingWorkspaceForLogoUploadOrThrow`), поэтому поведение pre-activation онбординга сохраняется без изменений.
  - При `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` инвалидировать кэш `workspaceEntity`, не удаляя старый файл логотипа из хранилища при неопределённом исходе коммита.
- **Аудит переводов приложений (`workspace-domain-audit.ts`, `ApplicationTranslationSyncService`, `ApplicationSyncService`)**:
  - В `workspace-domain-audit.ts` добавить `projectApplicationTranslation` и `runAuditedApplicationTranslationSync`, которые под блокировкой `core.workspace` (`FOR NO KEY UPDATE`) и строк `core."applicationTranslation"` (`WHERE "applicationRegistrationId" = $1 ORDER BY id FOR UPDATE`) выполняют вставку новых локалей (`applicationTranslation:create`), обновление/восстановление существующих локалей (`applicationTranslation:update`, только если `canonicalAuditJson(before) !== canonicalAuditJson(after)`) и soft-delete удалённых локалей (`applicationTranslation:delete`), после чего перепроверяют состояние таблицы после `audit.flush()`.
  - В `ApplicationSyncService.synchronizeFromManifest` передавать `workspaceId` в `this.applicationTranslationSyncService.syncFromManifest({ workspaceId, applicationRegistrationId, translations })`.
  - В `ApplicationTranslationSyncService.syncFromManifest` захватывать контекст аудита (явный `auditIdentity`, ambient-контекст запроса/задачи или системный актор `{ kind: 'system', id: 'ApplicationTranslationSyncService.syncFromManifest' }` при наличии `workspaceId` и `DataSource`) и выполнять мутации `core."applicationTranslation"` атомарно в `runAuditedApplicationTranslationSync`, сохраняя fallback на repository при unit-тестах без `DataSource`/`workspaceId`.

### Вариант B - Создание отдельного сервиса `ApplicationTranslationAuditService` с NestJS DI
- **Минусы**: усложняет граф модулей (`ApplicationTranslationModule`, `FileCorePictureModule`) и дублирует инфраструктуру `runInCoreAuditTransaction`, уже реализованную в `workspace-domain-audit.ts` и `workspace-default-role-audit.ts`.

## 3. Выбор решения
Выбран **Вариант A**: минимальный хирургический diff, полное переиспользование проверенных примитивов `workspace-default-role-audit.ts` и `workspace-domain-audit.ts`, отсутствие новых зависимостей на `@license Enterprise` и сохранение обратной совместимости существующих unit-тестов.
