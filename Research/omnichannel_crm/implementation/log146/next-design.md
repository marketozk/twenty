# LOG147 — аудит целей переписки после привязки компании

Статус: выбранная реализация в согласованном ROB765; код ещё не написан.
Основание: [исследование текущего кода](next-boundary.md).

## Решение и альтернативы

1. Обернуть legacy reconcileParticipantTargets общим audit context: меньше строк,
   но прежний ORM-путь не доказывает фактические эффекты, текущий selector и
   неизменность источников. Не соответствует принятому контракту аудита.
2. Новый независимый target owner: позволяет полный контроль, но дублирует уже
   проверенные planner, RETURNING/FK checks, flush и deferred drain.
3. Закрытая страница person-selector внутри существующего native cleanup owner:
   выбран этот вариант. Небольшой частный параметр stage; публичного callback
   или изменяемого session нет. Existing thread-ID entry остаётся прежним.

Новые DI-провайдеры, сущности, миграции, каналы и listener triggers не нужны.
Изменяются native-message-cleanup-with-audit.ts, его существующий re-export,
оставшийся messaging loop ParticipantTargetReconciliationService и узкие тесты.

## Контракт страницы

- Реальный SYSTEM scope, strict commit outcome, exclusive ownership fence.
  Полный operation уже захвачен сервисом до любых записей; страница получает
  новый operationId с прежним correlation и инициатором.
- До discovery: prepareSession, сортированные table locks, затем SHARE на
  Person/Company/Opportunity. Источники в этом пути только читаются.
- Не более 200 live Participant по personIds, стабильный UUID cursor.
  Discovery сохраняет исходные Participant/Person/Message/Thread IDs. Orphan
  hints тоже продвигают cursor. Discovery не блокирует дочерние строки.
- Stage блокирует родителей раньше детей. Допуск только по точным текущим
  исходным связям и живым Participant/Message/Thread. Уже перемещённые hints
  пропускаются: старую цель не чистим, за новым родителем не следуем.
- Отдельный неизменяемый selector proof сохраняет исходные IDs и отсутствие
  исходной строки; его verifier регистрируется внутри session до target DML
  и вызывается после deferred drain. Не блокировать ребёнка нового родителя.
- Обе стороны planner ограничены допущенными Thread. Desired targets выводятся
  из всех живых участников этих Thread, а не только triggering people.
- Ordinary APP остаётся допустимым; реальные omni-owned Thread исключаются.
  Принята существующая политика owner: удалённый Thread не изменяется.
- Только target DML; actual effects и существующий generated-field fail-closed
  контракт сохраняются. Поддержка новых generated effects не заявляется.
- Один finalize/flush, после него нет записей. Полная страница возвращает
  последний discovered ID даже при нуле допущенных; неполная — null.
- Service выполняет messaging pages, затем calendar pages. Ранние успешные
  страницы остаются сохранёнными. Ошибки/unsafe outcomes проходят без замены
  и без автоматического повторения неоднозначно завершённой страницы.

## Порядок реализации и проверки

1. Закрытый entry и частный selector в существующем stage; сохранить generic
   callers. Проверить diff, реальные import edges и типы.
2. Перевести только messaging loop публичного сервиса на strict/exclusive pages.
   Проверить job/service path, correlation, новые operation IDs, порядок каналов.
3. PostgreSQL: весь admitted thread, manual/tombstone, stale/moved/orphan hints,
   all-skipped full page, source absence/raw writers, поздние selector/source
   изменения и deferred drain, ownership, audit failure, actual skipped DML,
   incoming FK, generated refusal и реальная потеря COMMIT ACK.
4. Existing target/calendar/rematch suites, широкая регрессия, differential types,
   dependency guard без изменения baseline, 26 guards, 10 migration checksums,
   source hash check. Сохранить первоначальные ошибки и исправления.
5. Документы, commit/push, GitHub API verification, Linear/readback; ROB765
   остаётся In Progress до общей приёмки. Демо и Actions не используются.

Это закрывает один writer из единственной таблицы приёмки ROB765. Company
replacement/removal и другие listener triggers, contact creation, durable
delivery и общая HTTP/JWT/эксплуатационная приёмка остаются вне этого шага.
