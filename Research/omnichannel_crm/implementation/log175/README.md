# LOG-175 - Транзакционный аудит полного жизненного цикла `webhook` (`core.webhook`) и блокировка неаудируемого каскадного удаления при удалении `core.application`

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `webhook`: `values: ['applicationId']`, `redacted: ['targetUrl', 'operations', 'description', 'secret']`, действия `['create', 'update', 'delete']`.
2. Расширен модуль `packages/twenty-server/src/engine/core-modules/crm-audit/navigation-menu-item-audit.ts`:
   - Добавлен режим `mode: 'webhook'`, функции `assertWebhookRowInvariants` и `projectWebhook`, поля `expectedWebhookCreateIds`, `expectedWebhookUpdateIds`, `expectedWebhookDeleteIds` и маппинг `webhooks`.
   - В `runAuditedNavigationMenuItemMigration` операции над `core.webhook` выполняются внутри `runInCoreAuditTransaction` с `SET LOCAL lock_timeout = '8s'`, блокировкой `core.workspace`, `core.application` и субъектов (`FOR NO KEY UPDATE` / `FOR SHARE`) и чтением `core.webhook` (`ORDER BY id FOR UPDATE`), проверкой инвариантов строк, пропуском no-op обновлений и повторной сверкой снимка `core.webhook` после `audit.flush()`.
3. Расширены `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts` и `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`:
   - В `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` добавлен `'webhook'` (fail-closed барьер на любые неаудируемые миграции `webhook` в `WorkspaceMigrationRunnerService.executeRun` и автоматическая системная обёртка при `isSystemBuild: true` в `WorkspaceMigrationValidateBuildAndRunService`).
   - В `runAuditedApplicationMetadataMigration` добавлены чтение под `FOR UPDATE`, проверка и запись событий `webhook` (`create`, `update`, `delete`), запрет действий `webhook` в режимах `objectDelete`/`fieldDelete` и повторная сверка снимка после `audit.flush()`.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавлена проверка `core.webhook`, исключающая тихое каскадное удаление `ON DELETE CASCADE` при `DELETE FROM core.application` (`ApplicationService.delete` / `runAuditedApplicationDelete`).
4. Подключены все входные точки создания, обновления и удаления вебхуков:
   - `WebhookService` (`create`, `update`, `delete`) с синхронным копированием входных данных и захватом атрибуции до первого `await`.
   - `WebhookResolver` (`createWebhook`, `updateWebhook`, `deleteWebhook`), `WebhookController` (`create`, `update`, `remove`) и AI-инструменты (`CreateWebhookTool`, `UpdateWebhookTool`, `DeleteWebhookTool`).

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `19` suites / `224` tests PASS (`35.044s`), включая `3` новых интеграционных теста в `packages/twenty-server/test/fork-migration/crm-audit-webhook.postgres-spec.ts`.
- Полный регрессионный прогон: `120` suites / `3169` tests PASS (`703.795s`) - [`regression.log`](regression.log).
- Guard unit tests: `33` tests PASS (`0.190s`), `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `486` baseline / `487` current roots, `277` baseline / `277` current diagnostics, `0` новых и `0` в изменённом коде - [`typecheck-differential.json`](typecheck-differential.json).
- Снимок исходников: `12` файлов проверены по SHA-256 (LF) - [`source-snapshot.json`](source-snapshot.json).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
