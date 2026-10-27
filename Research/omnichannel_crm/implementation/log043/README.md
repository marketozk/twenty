# LOG-043 — доказанный приём команды коннектором

Внутренний reducer реализован и проверен; ROB-764 остаётся In Progress.

Цель: admitted→claimed→verified acceptance→следующий FIFO claim. Переиспользуем
существующие Command.connectorJobId/connectorAcceptedEvidence/journalSequence,
statusRevision, strict owner и audit. Миграции не требуются.

Текущий omni-incoming-envelope поддерживает только received/edited/deleted
сообщения; он не подходит для ACK. Отдельный внутренний closed DTO/reducer
проверяет текущий worker reconciliation grant и qualified adapter proof,
сохраняет нормализованный server-owned формат. Это не native userbot wire protocol
и не открытый HTTP endpoint. Нет callback default allow или фактической отправки.

Нормативная семантика внесена в [sending-ui](../../plan/contracts/sending-ui.md#command-states).
Факт acceptance не означает provider sent; unknown сохраняется без свежего
authoritative outcome. Новый факт снимает старый lease, exact replay оставляет
всё неизменным. Конфликт не перезаписывает доказательство. Исторические route и
отозванный автор допускаются для сверки с текущим worker grant.

FIFO исключает только точно соответствующий Command закрытый доказанный формат;
неизвестные записи остаются в bounded проверке. Отдельный watermark не нужен.
Проверены JS/SQL parity,151 доказанный предшественник и один неизвестный,
повторы/конфликты, historical grant, rollback/audit, lost COMMIT ACK и отсутствие
Message/отправки. Sent/native Message — последующий отдельный reducer.

## Проверки и границы

[285 Jest /14 suites](tests.txt) и [20 dependency](guard-tests.txt) +
[6 checksum](checksum-tests.txt) =311 PASS. Добавлен91 case:53 PostgreSQL,
25 contract,11 strict owner и2 audit. Полный1025 fork suite последний раз
проходил в [LOG041](../log041/README.md); здесь повторены затронутые
admission/lease/acceptance/audit/native transaction suites.

[TypeScript](typecheck-differential.json):177roots,146 baseline/current,
0 новых/0 changed-code. Старая ошибка в неизменённом методе подтверждена baseline
и AST-сравнением; полный server build/typecheck не заявляется. Все6 миграций
и прежние методы aggregate неизменны. [Source hashes](source-snapshot.json)
совпали с проверенным кодом стенда; [dependency guard](dependency-guard.json)
без нарушений. [Сводка](verification.json).

Первый proof получен настоящим reducer после admission/claim; для масштаба
150 исторических строк клонированы SQL с корректными scope/IDs. Это проверка
151 predecessor в FIFO, не151 сетевой отправки. Для23 вариантов повреждённого
proof реальный PostgreSQL и JS дают отказ, следующий claim не разблокируется.
Отдельно проверены Unicode, journalSequence=0, garbage counters, конечный перевод
строки и immutable nested snapshot. Payload hash пересчитывается до записи proof.
SQL shortcut доверяет защищённому writer и неизменности Command; он не является
криптографическим доказательством против произвольного изменения БД.

Проверены replay с текущими grants, historical generation, отозванный автор,
конфликт scope/job/journal, сохранение нового reconcile lease, rollback и потеря
COMMIT ACK после фактического commit. Принятие не создаёт Message/participants,
admission/event и не вызывает сеть. sent не понижается; unknown остаётся unknown.

Применены ai-dev-workflow, behavioral-guardrails, server-schrodinger. Выполнено
scoped независимое review; полный Claude cross-review не повторялся.
Нет production verifier/HTTP/scheduler; synthetic grants не являются обходом
боевых прав. GitHub Actions не используется. Продолжаем confirmed sent/Message.
