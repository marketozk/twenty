# LOG151 - долговечное сохранение и восстановление манифеста сопоставления сообщений

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG151 закрывает окно потери затронутых участников между первоначальным сохранением обычных сообщений (`LOG150`) и постраничным сопоставлением (`LOG149`). Внутри транзакции `saveOrdinaryMessageBatchWithAudit` проверенный манифест сопоставления разбивается на страницы до 200 записей и сохраняется как долговечное намерение `reconcile_messageImportMatching` в `core.deferredWorkspaceMigrationAction` со статусом `PENDING` и проверкой строки после `SET CONSTRAINTS ALL IMMEDIATE`.

При штатном выполнении `MatchParticipantService.matchMessageImportParticipantsWithAudit` атомарно переводит намерение в `IN_PROGRESS` (либо синхронизируется под эксклюзивной блокировкой workspace, если фоновое восстановление уже обработало запись во время постановки очереди контактов), а каждая страница в `applyNativeMessageImportMatchingWithAudit` в своей strict/exclusive транзакции продвигает `nextPageIndex` или удаляет завершённое намерение на последней странице до `COMMIT`.

При сбое очереди контактов, падении процесса или обычной ошибке сопоставления повторное сохранение той же пачки не пересопоставляет исторических участников (`participants: []`), а `reconcileMessageImportMatchingIntentsWithAudit` воспроизводит оставшиеся страницы с `nextPageIndex`, проверяя актуальные полномочия источника и сохраняя исходные `actor`, `initiator` и `correlationId`. Неопределённые исходы (`NativeTransactionOutcomeUnknownError`, `CoreAuditPostCommitError`) фиксируются в `status = 'FAILED'` с `payload.unsafeOutcome` через `jsonb_set` без автоматического повтора.

4707 tests/155 suites PASS (1348.722s). 686 targeted/15 suites PASS (180.849s), 15 новых PostgreSQL и 2 unit случая. 26 guard tests PASS, 10 migration checksums неизменны. Types 441/442 roots, baseline/current 225 diagnostics, 0 новых/changed-file. Совпали 11 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Начальное расхождение формата ответа `DataSource.query` для `UPDATE ... RETURNING`, настройка прав тестовой роли и одна первичная ошибка типов в тесте устранены и сохранены в initial/second логах.

Далее - [аудит автоматического создания контактов и компаний](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
