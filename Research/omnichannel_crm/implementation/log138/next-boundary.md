# Далее — аудит orphan CalendarEvent

Сначала закрытый owner для конкретных Event IDs: Event, Participant,
CalendarChannelEventAssociation, CalendarEventTarget и CallRecording.
Первые три дочерние связи удаляются CASCADE; CallRecording остаётся,
calendarEventId получает NULL, остальные поля должны точно сохраниться.

Сохранить существующий calendar контракт: явные candidate IDs могут включать
tombstoned Event; global sweep выбирает только живые Events. Живые associations
блокируют orphan deletion, tombstoned associations не блокируют и входят в аудит
фактического каскада. Не копировать messaging orphan policy.

FILES guard нужен для реально удаляемых строк. Непустые audio/video FILES,
transcript и summary у surviving CallRecording сохраняются. Проверить возможные
ON UPDATE effects самой FK-записи, exact snapshots и actual RETURNING.

После owner — общий sweep и композиция sync callers с единым flush. Calendar
blocklist по текущему контракту запускает только orphan sweep, не удаляет
встречи из-за заблокированного участника.

Остаток — [единственная таблица приёмки](../rob765-progress.md).
