# LOG187 - Исследование тестового покрытия

## 1. Существующие тесты
- `packages/twenty-server/test/fork-migration/crm-audit-workspace-default-role.postgres-spec.ts` - 9 интеграционных тестов PostgreSQL для `core.workspace` (`LOG163`, `LOG186`).
- `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` - 7 интеграционных тестов PostgreSQL для доменных и корпоративных сущностей (`LOG174`, `LOG184`, `LOG185`).
- `packages/twenty-server/src/engine/core-modules/file/file-core-picture/services/__tests__/file-core-picture.service.complete-workspace-logo-upload.spec.ts` - unit-тесты гонок `completeWorkspaceLogoUpload`.

## 2. Новые тестовые сценарии LOG187
1. **Привязка логотипа рабочего пространства (`FileCorePictureService` / `FileCorePictureResolver`)** в `crm-audit-workspace-default-role.postgres-spec.ts`:
   - Вызов `FileCorePictureResolver.completeWorkspaceLogoUpload` и `FileCorePictureResolver.uploadWorkspaceLogo` с пользовательским контекстом (`workspaceMember`) обновляет `core.workspace."logoFileId"`, переводит временный файл в постоянный, удаляет предыдущий логотип после коммита, инвалидирует кэш `workspaceEntity` и записывает `workspace:update` с `changedFields: ['logoFileId']` и точными `before`/`after`.
   - Повторный вызов `completeWorkspaceLogoUpload` для уже привязанного `logoFileId` является идемпотентным no-op и не создаёт лишних записей аудита.
2. **Жизненный цикл переводов приложений (`ApplicationTranslationSyncService.syncFromManifest`)** в `crm-audit-workspace-domain.postgres-spec.ts`:
   - Первичная синхронизация манифеста с локалями `en` и `fr-FR` создаёт 2 строки в `core."applicationTranslation"` и записывает 2 события `applicationTranslation:create` с `values: { applicationRegistrationId, locale }` и скрытым `messages` в `redacted`.
   - Повторная синхронизация с изменённым словарём `en`, неизменённым `fr-FR`, новой локалью `de-DE` и удалённой локалью (например, `fr-FR` убрана из манифеста) записывает `applicationTranslation:update` для `en`, `applicationTranslation:create` для `de-DE` и `applicationTranslation:delete` для удалённой локали, не раскрывая содержимое `messages` в `redactedDiff.values`.
   - Повторная синхронизация идентичного манифеста не создаёт новых записей аудита (no-op).
