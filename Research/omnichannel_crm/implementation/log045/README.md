# LOG-045 — подтверждённое исходящее в штатном Message

Реализован внутренний atomic apply для human text Command с disabled policy v0.

После durable command.sent capture/claim добавляем atomic apply: существующие
Twenty Message/Participant/channel association и omni MessageLink/revision,
Command sent, один suppressed message.sent root/dispatch, receipt applied и audit.
Текущий worker grant и qualified historical verifier обязательны; provider send
не вызывается. Нормативная граница — [confirmed sent](../../plan/contracts/sending-ui.md#confirmed-sent).

Body и immutable author IDs берутся из сохранённой human text Command. Native
handle/displayName NULL не выдаются за вымышленный email. Relation допускает
удалённого автора, но snapshot не меняется. Собственное подтверждение не повышает
replyRevision повторно и не запускает AI/workflow/customer admission.

Повтор проверяет прежний native/core graph. Несколько evidence event IDs той же
доказанной command/native identity получают один bubble; исходное display time
не заменяется временем позднего capture. Конфликтующие proof/key/channel/thread
и несколько links на Command требуют явного отказа. Command/Receipt locks берутся
после изменяемых native records и root/dispatch. Финальный receipt lease CAS после
аудита откатывает всю транзакцию при expiry. Ни isolated grant, ни сохранённый
receipt не квалифицируют production connector.

Проверены full real-PG chain с настоящими Twenty persistence helpers,
concurrent/reordered/repeated receipts, sent-before-acceptance-ACK, author deletion
с реальным SET NULL, bad native mapping, expiry/fault каждого write, lost COMMIT ACK,
неизменность Person/targets/emitter. После узких проверок выполнены полный fork suite
и дифференциальная проверка типов; схемы и шесть миграций без изменений.

## Проверки и границы

[Полный fork suite](tests.txt): 1368 Jest /57 suites.
[20 dependency](guard-tests.txt) +[6 checksum](checksum-tests.txt), всего
1394 PASS. Добавлены80 случаев:55 PG,17 facade,4 failure audit,
4 nullable participant/email regression. Финальный suite выполнен после исправления
runtime SQL row validation. Первоначальные252 focused cases проходили до этой правки.

[TypeScript](typecheck-differential.json):191 roots,
146 baseline/current,0 новых/0 changed-code. Known upstream aggregate diagnostic
сопоставлен по неизменённому методу/AST; полный server build/typecheck не заявляется.
[Source hashes](source-snapshot.json) совпадают с проверенным кодом.
[Dependency guard](dependency-guard.json) и [миграции](migration-checksums.txt)
без нарушений. [Сводка](verification.json).

Реальные triggers проверяют12 write failures,2 silent post-audit tamper и2 expiry;
вся операция откатывается. Lost COMMIT ACK не создаёт ложный failed audit. Физическое
удаление автора проверяется с настоящим FK SET NULL; soft delete и replay не
перепривязывают сообщение. Sent без сохранённого графа — явный reconciliation
conflict, без автоматического восстановления. Native Message хранит текст immutable
Command, проверенный qualified verifier; непроверенный caller text не принимается.

First apply пишет11 success audit records; новый receipt того же подтверждённого
сообщения —1 receipt audit; точный replay —0. Исторический worker не получает send
разрешения. Synthetic verifier/queue grants не являются production qualification.
Нет HTTP, UI, scheduler, внешних calls и включённых automation consumers.

Scoped independent review без блокеров; skills ai-dev-workflow,
behavioral-guardrails, server-schrodinger. Полный Claude review не повторялся.
Далее LOG046: ambiguous outcome/backoff и discovery due Commands без Redis.
Демо прежнее, GitHub Actions не используется.
