# Далее — аудит очистки календаря

Начать с удаления calendarChannelEventAssociation после удаления канала.
Проверить current/absent channel proof, реальные FK effects, пагинацию,
actual RETURNING, атрибуцию jobs и откат, сохраняя существующие writer boundaries.

Orphan CalendarEvent имеет более широкий граф: participant, target, association
и связь callRecording с SET NULL. Этот отдельный owner нельзя считать готовым
по одному удалению associations. Calendar blocklist сейчас запускает лишь общий
orphan sweep; не переносить в него messaging handle policy.

Остальные критерии — [единственная таблица приёмки](../rob765-progress.md).
