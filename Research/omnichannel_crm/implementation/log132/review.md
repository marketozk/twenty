# LOG132 review

## Контракт

Повторно использованы issued cleanup scope, CrmAuditTransactionContext,
actual FK discovery, точные JSONB snapshots, WorkspaceRepository.delete и
ownership guard. Новых зависимостей, migrations и публичных API нет.

Проверяются active workspace, exact standard metadata, обязательные FK
association→message и participant→message CASCADE. FK DDL заморожен table locks;
message/participant rows заблокированы. Populated unsupported mutating FK
приводят к отказу. Изначальные и оставшиеся строки сверяются по полным снимкам,
а не только IDs. Deferred triggers выполняются до финальной проверки.

Возвращаются actual deletedMessageIds и уникальные non-null affectedThreadIds
из удалённых before-images. Аудит использует actual DELETE RETURNING; partial
trigger skips разрешены с неизменностью пропущенных строк. После audit.flush
повторно проверяются workspace, ownership, граф и отсутствие associations.

## Проверки

Реальные PostgreSQL FK races: association INSERT и participant INSERT, оба
порядка; ожидание подтверждается pg_blocking_pids конкретных соединений.
Негативные сценарии: missing FK, unknown mutating FK, чужой scope, inactive
workspace, audit failure, late MessageLink, deferred resurrection, lost COMMIT ACK.
Проверяются soft-deleted blockers, protected records, input mutation, partial
RETURNING, dedup/null affectedThreadIds и неизменность Thread/Target.

Независимый read-only review агента delete_entry_tests не нашёл конкретных
блокеров; агент сам тесты не запускал. Исполненные проверки перечислены в results.

## Ограничения

Owner терминальный: вызывающая транзакция передаёт ошибки наружу и не меняет
проверенный граф после возврата. Для полного sweep нужен закрытый общий owner
с приватными этапами, одним audit context и финальной проверкой после всех writes.
Текущий owner не заявляет такой интеграции, durable event delivery или выкат.
