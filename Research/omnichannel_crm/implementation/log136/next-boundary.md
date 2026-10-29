# Далее — аудит удаления по blocklist

MessagingBlocklistItemDeleteMessagesJob сначала удаляет associations напрямую,
затем запускает общий orphan sweep LOG134. Аудит второго шага не покрывает первый.

Нужно закрыть выборку и удаление одной границей: актуальные blocklist entries,
WORKSPACE/member scope, аккаунт/канал/aliases, matching FROM/TO participants,
существующая exact/domain policy и проверка владения. Снимки до удаления,
фактические effects, связанные orphan stages и финальный аудит должны
использовать одну транзакцию. Current policy и scope не заменять новым
неявным нормализатором адресов. Проверить stale/late policy, rollback,
защищённые записи и uncertain commit.

Calendar cleanup остаётся отдельным путём. Остальной объём — в
[единственной таблице приёмки](../rob765-progress.md).
