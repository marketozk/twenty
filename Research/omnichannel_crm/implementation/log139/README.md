# LOG139 — аудит удаления календарного события и его зависимостей

Закрытый owner удаляет явно выбранные orphan CalendarEvent и учитывает реальные
каскады Association, Participant и Target. CallRecording остаётся: обнуляется
только ссылка на Event, прочие поля сохраняются с точностью PostgreSQL.
Изменение и аудит выполняются в одной strict/exclusive транзакции.

Живая Association сохраняет событие. Tombstoned Association может быть удалена
каскадом; явно выбранный tombstoned Event разрешён прежним адресным контрактом.
Снимки охватывают также защищённые и пропущенные триггером строки. Проверка
фактических FK и косвенных UPDATE effects не позволяет скрыть дополнительные
изменения под обычным удалением события.

- [Проверки](results.json), [исходники](source-snapshot.json), [типы](typecheck-differential.json).
- [Целевые PostgreSQL cases](target.log), [регрессия](regression.log), [guards](guards.log).
- [Ревью и ограничения](review.md), [следующее подключение](next-boundary.md).

Это внутренний owner без production callers. Общий календарный sweep и provider
sync ещё используют прежние пути. ROB765 остаётся In Progress; сборка, выкат и
полная HTTP/JWT приёмка не выполнены. GitHub Actions не используется.
