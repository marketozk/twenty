# LOG134 — общий аудит очистки переписки и реальные точки запуска

Три проверенных операции объединены в закрытом native-message-cleanup-with-audit.
Прежние терминальные функции сохранены через re-exports. Приватные стадии общего
sweep используют одну operation и один audit context: messages → reconciliation
живых затронутых threads → empty threads → общие проверки → flush → deferred
constraints → повторные проверки. Сохраняется одна транзакция на полный проход.

MessagingMessageCleanerService подключён к этому owner с обязательной operation.
Пять jobs/CLI передают captured system identity. Remove-orphans теперь уважает
dry-run и передаёт ошибку наружу; iterator/runner сохраняют unsafe outcome даже
при сбое cache cleanup/logging и прекращают следующие workspace.

- [Результаты](results.json), [ревью](review.md), [остаток](next-boundary.md).
- [Исходники](source-snapshot.json), [целевые тесты](target.log), [регрессия](regression.log).
- [Типы](typecheck-differential.json).

ROB765 остаётся In Progress. Остальные native/system writers и общий аудит ещё
не приняты. Выкат после LOG088, HTTP-приёмка и GitHub Actions не выполнялись.
