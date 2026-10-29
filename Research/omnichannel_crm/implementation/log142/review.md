# LOG142 — проверка публичных настроек календаря

Изучены CalendarChannelResolver, CalendarChannelMetadataService, DTO/Entity,
CalendarChannelSyncStatusService, текущий ordinary channel gate, auth decorators
и реальный GraphQL error handler. Единственный production caller update — resolver.
Resolver уже имел status service; новый DI module не нужен.

## Совместимость и полномочия

Настройки сохраняют owner-only политику account.userWorkspaceId. Shared account
не делает другого сотрудника владельцем. Ordinary/omni gate применяется только
к reset и не запрещает настройки защищённых/архивных аккаунтов, разрешённые ранее.
Caller userId отделён от audit actor: проверяются активный пользователь и membership
без возможности перепривязать последний. Все фактические пути JwtStrategy,
включая cookie/impersonation, создают membership вместе с эффективным пользователем;
ключи без пользователя уже отклонялись обязательным AuthUserWorkspaceId.

Пять DTO полей копируются до await; undefined пропускается, null и неизвестные
поля отклоняются. Owner возвращает фактический pre-reset DTO с PG Date values.
Сохранён прежний edge case: skipped primary UPDATE не запрещает reset, если
запрошенное excludePrivateEvents отличается от исходного. Cache marker выдаётся
только при фактическом reset RETURNING; два skipped UPDATE не создают audit/cache.

Независимое чтение owner/catalog блокеров не выявило. Родительское ревью нашло
потерю публичных кодов ошибок при замене verifyOwnership на новый owner. До импорта
восстановлены CalendarChannelException NOT_FOUND/OWNERSHIP_VIOLATION/INVALID_INPUT;
реальный handler проверяется на NOT_FOUND/FORBIDDEN/BAD_USER_INPUT. Поздний drift
и unsafe outcomes не оборачиваются. Legacy concurrent reparent test использует
реальный repository writer вместо закрытого settings API; race assertions прежние.

## Транзакция и аудит

Core owner держит workspace/user/member/account/channel locks и точные исходные
снимки. Ожидаемая строка строится в PostgreSQL, сохраняя микросекунды; применённые
изменения определяет UPDATE RETURNING. Incoming UPDATE FK effects проверяются
до записи; поздние изменения и deferred triggers проверяются до COMMIT.
Один audit context агрегирует first-before/last-after. Cursor и syncStageStartedAt
хешируются; изменённый только updatedAt не создаёт смысловое audit событие.

Resolver не выполняет второй reset после commit. Cache-only helper захватывает
IDs до await; confirmed-commit cache failure отличается от rollback/unknown.
Предыдущие неиспользуемые create/delete metadata методы не менялись.

Первые проверки: 512 PASS, один тест обращался к отсутствующему changedFields
вместо redactedDiff.changedFields; исправлено только чтение результата тестом.
Dependency guard выявил новые связи с EE через общие type/utility barrels и
новую service→status DI связь. Baseline и guard не менялись: owner теперь имеет
плоский закрытый settings contract и CalendarChannelSettingsError; service
переводит только этот отказ в существующий публичный CalendarChannelException.
Unknown/confirmed outcomes сохраняются. Cache-only действие осталось в resolver
с его прежней DI связью; новый AuthUser использует минимальный {id} contract.
Повторный dependency guard PASS. Общие DTO, enum definitions, exports и upstream
exception helpers не изменялись.

Runtime результаты фиксируются отдельно. Здесь не заявляются полный HTTP/JWT
проход, durable cache invalidation, полный calendar sync audit или выкат.
