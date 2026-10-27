# LOG-044 — durable подтверждение отправки

Durable capture и claim реализованы и проверены. ROB-764 остаётся In Progress.

Закрытый command.sent envelope и квалифицированный server capture сохраняются
в существующем IncomingReceipt. Отдельные internal accept/claim проверяют текущие
worker grants и историческое доказательство, также при replay. Обычный message
ingress не принимает этот kind; его claim/renew/defer не захватывают sent receipts.
Старое отключённое поколение допустимо только для сверки существующей Command.

Нормативная граница: [confirmed sent](../../plan/contracts/sending-ui.md#confirmed-sent).
LOG044 реализует durable capture и lease; atomic Message/Link/sent apply — следующий
LOG045. Ни сохранение receipt, ни lease не разрешают отправку в provider и не
означают, что native Message уже появился. Нет production transport/verifier.

Проверены actual admitted/claimed Command, strict owner, concurrent event
replay, evidence conflicts и scope isolation, stale/historical grants, lease
reclaim/DB clock/audit expiry, actual COMMIT ACK loss, отрицательный аудит после
подтверждённого rollback, неизменность Command/native graph. Старые message lease
cases повторяются. Схема и шесть миграций остаются прежними.

## Проверки и границы

[487 Jest /18 suites](tests.txt) и [20 dependency](guard-tests.txt) +
[6 checksum](checksum-tests.txt) =513 PASS. Повторены прежние message ingress/
capture/lease, human outbox/acceptance и strict native transaction suites.
Полный1025 fork suite последний раз проходил в [LOG041](../log041/README.md).

[TypeScript](typecheck-differential.json):184roots,146 baseline/current,
0 новых/0 changed-code. Известная ошибка неизменённого метода подтверждена AST
и baseline; полный server build/typecheck не заявляется. Все6 миграций и прежние
методы aggregate неизменны. [Source hashes](source-snapshot.json) совпадают с
проверенным кодом стенда; [dependency guard](dependency-guard.json) без нарушений.
[Сводка](verification.json).

Реальные PG triggers задерживают audit до истечения lease и подменяют receipt
после audit: транзакция полностью откатывается. Реальный commit с потерянным ACK
не создаёт ложный failure; replay находит прежний receipt/lease. Невалидные hash,
scope, key, source position и qualification не переписывают ранее принятое событие.
Текущие worker grants/verifier проверяются даже для replay/no-op. Старое поколение,
отключённый binding и отозванный автор допускают только историческую сверку.

Обычные claim/renew/defer не меняют command.sent; отказ старого API может оставить
его прежний failed-attempt audit после подтверждённого rollback, но не success.
Существующие частичные acceptance job/sequence должны совпадать; неполный факт
не исправляется этим writer. Непустой malformed normalized proof отклоняется.
Synthetic verifier не квалифицирует реальный Telegram/MAX connector.

Независимое scoped review без блокеров; skills ai-dev-workflow,
behavioral-guardrails, server-schrodinger. Полный Claude review не повторялся.
Следующий LOG045 переиспользует native Message persistence и сохраняет автора
без выдуманного исторического имени/email. Демо прежнее, GitHub Actions не используется.
