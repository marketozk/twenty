# LOG140 — календарный sweep и реальные фоновые задания

Очистка orphan CalendarEvent во всём workspace теперь использует закрытый owner:
все страницы и их фактические каскады записываются в один аудит и одну транзакцию.
CallRecording сохраняется с обнулённой ссылкой; прочие поля и файлы не меняются.
Подключены задания удаления канала, очистки после удаления аккаунта и blocklist.

Global discovery выбирает только живые Event и повторно проверяет это условие
после ожидания блокировки. Явный candidate API сохраняет прежнее поведение для
tombstoned Event. Пропущенные и защищённые записи не останавливают обход страниц.

- [Результаты](results.json), [исходники](source-snapshot.json), [типы](typecheck-differential.json).
- [Целевые проверки](target.log), [регрессия](regression.log), [guards](guards.log).
- [Ревью](review.md), [следующая работа](next-boundary.md).

Удаление associations канала и последующий sweep остаются двумя транзакциями
с общей correlation. Ошибка первой не допускает вторую. Calendar blocklist
не удаляет встречи по участнику, а только уже существующие orphan Event.

Provider-sync и core metadata ещё не покрыты полностью. ROB765 In Progress;
сборка, выкат и полная HTTP/JWT приёмка не выполнены. GitHub Actions не используется.
