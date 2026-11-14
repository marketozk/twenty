# LOG187 - Ревью дизайна (`workspace.logoFileId`, `applicationTranslation`)

## Вердикт
`pass` (блокеров не выявлено)

## Проверка инвариантов

1. **Сокрытие чувствительных данных и текстов переводов**:
   - Для `workspace` поле `logoFileId` входит в `CATALOG.workspace.values` (отслеживается смена UUID файла логотипа), а `logo` остаётся в `redacted`.
   - Для `applicationTranslation` в `values` входят только `['applicationRegistrationId', 'locale']`, а словарь переводов `messages` и `deletedAt` находятся в `redacted` (только SHA-256 хеш).
2. **Атомарность и внешние побочные эффекты**:
   - В `FileCorePictureService` загрузка файла в хранилище (`uploadCorePicture` / `completeFileUpload`) происходит до транзакции БД, внутри транзакции БД атомарно выполняются `claimTemporaryFile`, обновление `core.workspace."logoFileId"` и запись в `crm_audit."crmAuditEntry"`, а физическое удаление заменённого файла `deleteCorePicture` выполняется только после успешного коммита.
   - При `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` кэш `workspaceEntity` инвалидируется, а удаление старого файла не запускается.
   - В `ApplicationTranslationSyncService.syncFromManifest` инвалидация кэша `applicationTranslationCacheService.invalidate` выполняется только после успешного коммита транзакции (или в блоке перехвата `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`).
3. **Границы лицензий (`@license Enterprise`)**:
   - Ни один из затрагиваемых файлов не импортирует модули с маркером `@license Enterprise`.
