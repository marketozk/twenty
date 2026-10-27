# LOG-046 — восстановление неизвестного исхода и поиск команд

Реализовано и проверено на изолированном PostgreSQL. Предыдущий LOG045 опубликован.

Закрываем C05 и recovery foundation этапа1: durable outcome_unknown + backoff,
очистка только собственного действующего lease, statusRevision и audit одной
транзакцией. Discovery ищет ожидающие human text/v0 Commands в PostgreSQL;
результат — подсказки для существующего claim, не разрешение отправки.

Текущие worker grants/qualification и captured restore incarnation обязательны.
Historical route/author revocation не запрещают сверку, но не разрешают новый send.
Acceptance/job/journal/cancel/payload сохраняются. Superseded/expired/terminal/no-op
не выдаются за доказанное выполнение прежнего defer. Backoff и lease проверяются
после audit; readback ловит silent AFTER UPDATE изменения.

Проверены реальный admission/claim/defer/reclaim, обе очередности acceptance
и sent, replay/concurrency, revoked grants, восстановление/incarnation, audit failure,
expiry/backoff elapsed и lost COMMIT ACK; keyset pagination с микросекундами,
scope isolation и новый scan для изменившихся deadlines. Схема без новой миграции.
Нет HTTP, cron, provider calls, production changes или GitHub Actions.

## Доказательства и ограничения

[392 Jest /14 suites](tests.txt) +
[20 dependency](guard-tests.txt) +[6 checksum](checksum-tests.txt) =
418 PASS. Новые67 cases:33 PostgreSQL,23 contract,11 owner.
Повторены human admission/claim, acceptance и native sent apply; полный1368 suite
прошёл в [LOG045](../log045/README.md), здесь не повторялся.

[TypeScript](typecheck-differential.json):197 roots,
146 baseline/current,0 новых/0 changed-code. Старый aggregate diagnostic
сопоставлен по неизменённому методу/AST; полный server build/typecheck не заявляется.
[Source hashes](source-snapshot.json) проверены на тестовом исходнике;
[dependency guard](dependency-guard.json) и [migration checksums](migration-checksums.txt)
без нарушений. Все6 миграций и прежние aggregate methods неизменны.
[Сводка](verification.json).

Две очередности durable ACK/defer и native sent/defer, concurrent duplicate,
повтор после actual lost COMMIT ACK не создают новую отправку/ложный failure.
Audit/Command write faults, истечение lease или backoff во время аудита и silent
AFTER UPDATE tamper откатывают весь writer. Точный replay без прежнего lease
даёт lease_superseded, а не вымышленное подтверждение старого defer.

Действующий worker проходит auth и qualification даже перед no-op. Другое
существующее подключение не видит исходную Command и не пишет чужой audit.
Scope mismatch отклоняется до SQL. Read-only discovery использует binding grant;
неудачное чтение не маскируется как mutation audit. Файлы/reply/AI commands остаются
вне данного закрытого human text/v0 контракта. Лимит100 ограничивает выдачу,
не стоимость SQL; load testing и scheduler принадлежат следующей интеграции.

Scoped independent review выполнено по коду и контрактам. Полный Claude review
не повторялся. Нет HTTP/UI/provider calls/production grants или изменения демо.
GitHub Actions не использовался; ROB-764 остаётся In Progress.
