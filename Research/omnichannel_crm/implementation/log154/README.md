# LOG154 - интеграция runner и recovery отложенных действий с намерениями сопоставления импорта

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG154 подключает общий исполнитель отложенных действий (`DeferredWorkspaceMigrationActionRunnerService`), сервис восстановления (`DeferredWorkspaceMigrationActionRecoveryService`) и реестр обработчиков (`DeferredWorkspaceMigrationActionHandlerRegistryService`) к долговечным намерениям сопоставления сообщений (`reconcile_messageImportMatching`, `LOG151`) и календаря (`reconcile_calendarImportMatching`, `LOG153`) в `core."deferredWorkspaceMigrationAction"`.

В `reconcile-import-matching-deferred-action-handler.service.ts` выделены обработчики `ReconcileMessageImportMatchingDeferredActionHandlerService` и `ReconcileCalendarImportMatchingDeferredActionHandlerService` с инжекцией `MatchParticipantService` через токен `IMPORT_MATCHING_INTENT_RECONCILIATION` (зарегистрированы в `MatchParticipantModule` и обнаруживаются `DeferredWorkspaceMigrationActionHandlerRegistryService` без создания рёбер в Enterprise-граф). Оба обработчика объявляют `metadataNamesToLoad = []` и `managesOwnPersistence = true`.

В `DeferredWorkspaceMigrationActionRunnerService.claimAndExecute` для обработчиков с `managesOwnPersistence = true` исключены внешние `update({ status: 'IN_PROGRESS' })` и `delete(...)`, благодаря чему сохраняются атомарный захват строки, постраничное продвижение `nextPageIndex`, транзакционное удаление по завершении до `COMMIT`, инкремент `attempts` и изоляция `unsafeOutcome` внутри `MatchParticipantService`. При удалённом или soft-deleted `core.workspace` устаревшие `PENDING`-намерения без `unsafeOutcome` очищаются, а строки с `payload.unsafeOutcome` переводятся в `FAILED`.

В `DeferredWorkspaceMigrationActionRecoveryService` методы `resetStaleInProgressActions`, `enqueueWorkspacesWithPendingActions`, `retryFailedActions` и `findWorkspaceIdsByStatus` защищены условием `NOT (payload ? 'unsafeOutcome')`, что исключает повторную постановку в очередь или сброс в `PENDING` намерений с неопределённым исходом коммита (`NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`).

3013 tests/99 suites PASS (656.643s). 275 targeted/11 suites PASS (125.942s), 6 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 453/455 roots, baseline 220 / current 220 diagnostics, 0 новых/changed-file. Совпали 11 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Начальная настройка `EntitySchema` для тестового `deferredDataSource` и типизация `Provider[]` в тесте устранены и сохранены в логах.

Далее - [транзакционная проверка свежести import policy и blocklist при сохранении сообщений и календаря](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
