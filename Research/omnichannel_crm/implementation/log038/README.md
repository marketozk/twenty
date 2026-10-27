# LOG-038 — конфигурация очередей и durable binding event

Закрытый internal writer принимает queue.create (inactive), queue.update (name/active),
binding.defaults.update (same-binding active queue, human). Activation binding,
route/capabilities/autoCreatePerson и произвольные relations не принимаются.
Queue activation требует явной проверки разрешения через обязательный current authorizer.
Callback получает frozen normalized command, поэтому может проверить destination queue.

Policy UPDATE берётся с начала, затем общий actor/workspace/idempotency receipt, binding,
queue. Новый key выполняет CAS; stale expectedRevision не меняет ресурс. Повтор проверяет
текущие права и возвращает прежний result без повторного CAS. Другой action/payload — conflict;
expired result не запускает новую mutation. Проверяются retained resource/operation/event IDs.
No-op пишет только receipt, без revision/epoch/event/success mutation audit.

Queue change повышает собственную revision и policy epoch; binding revision остаётся прежней.
Defaults update повышает binding revision/epoch. Нельзя отключить default queue или очередь
с любыми retained Conversations, включая closed; скрытого переноса/смены доступа нет.
Queue/default updates не включают binding и не переписывают существующие Conversations.

Реальные изменения атомарно создают binding.config_changed с deterministic eventId от operationId.
Closed payload содержит binding/revisions/resource/epoch, origin=configuration_change,
payloadVersion1, null Conversation/sequence/root/causation. Audit binding-only exception
доступно только проверенному immutable CREATE через record; обычные события и failed/denied
attempts сохраняют обязательную conversation scope. Payload/имена остаются redacted.
Никаких automation roots/admission/workflows/send commands не создаётся.

Success mutation/audit/event/receipt — один commit. Подтверждённый rollback позволяет
отдельный failed/denied attempt на проверенном binding. Unknown commit/rollback/release
не превращается в success или ложный failed audit. Обе ошибки rollback/cleanup сохраняются.

## Проверки

[826 Jest/33 suites](tests.txt), [финальные84 focused](target-final.txt),
[сводка](verification.json), [TypeScript](typecheck-differential.json),
[harness](typecheck-differential.cjs), [dependency guard](dependency-guard.json),
[6 исходников](source-snapshot.json). Итог829 distinct Jest +25 Python =854 PASS.
Финальный focused добавляет3 случая rollback/release после малого исправления сохранения
cleanupError; normal path не менялся после полного прогона. Все5 миграций неизменны.
145 typecheck roots:146 baseline/current,0 новых/0 changed-file diagnostics.
Это не полный server build/typecheck; runner6GiB/2CPU, heap4608MiB.

34 PostgreSQL cases: current/replay/revoked authorization, no-op/expired/tampered receipt,
same-key concurrency, stale revision, unknown actual COMMIT/rollback/release ACK,
каждая стадия INSERT/UPDATE/event/audit/receipt с failure trigger и общим rollback,
tenant isolation, default/inactive/retained closed queue, pg_blocking_pids policy wait,
настоящий writer repair→resume→claim→apply. Только binding activation в fixture синтетическая.
50 audit unit cases проверяют закрытые поля, scope, immutable create, ordinary compatibility,
отсутствие bypass через failed/denied, redaction и caller mutation после record.

Root review сверил установленный TypeORM PostgresQueryRunner: raw UPDATE возвращает
[rows,rowCount]. Все3 reads UPDATE RETURNING заменены на CTE SELECT, как в bootstrap.
Independent review без блокеров; будущий destination-policy callback получает frozen command.
Новый полный Claude cross-review не заявляется.

Во время проверки SSH дважды закрыл соединение; journal показал MaxStartups/drop.
Format/upload/download объединены в один SSH session, повтор успешен. Firewall/fail2ban/
production не менялись. Тесты использовали прежние ограниченные isolated PG/Redis resources.

## Границы и продолжение

Это internal API без resolver/controller/processor/cron и без production grant provider.
Полный config recovery требует typed consumer и periodic housekeeping. Workflow
ConsumerReceipt с обязательными pinnedVersion/execution IDs не заполняется фиктивными UUID.
Следующий шаг уточняет durable maintenance delivery/checkpoint и подключает recovery.
ROB-764 остаётся In Progress; демо прежнее, GitHub Actions не использовался.
