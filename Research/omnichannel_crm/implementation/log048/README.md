# LOG048 — локальная отмена команды до enqueue

Внутренний cancelOmniLocalHumanCommand через strict transaction owner. Caller —
текущий workspaceMember с conversation read; неавтору дополнительно требуется
отдельный delegated cancel grant. Read и delegated grant проверяются на replay.
Virgin pending/revision1 без lease/acceptance/job/journal/cancel evidence и с
текущей createdRestoreIncarnation допускает cancelled/revision2. Неподтверждённый
внешний исход локально не переписывается. Неактивный route/закрытый conversation
не запрещают остановку доказанно не начатой отправки при текущих правах.

Command сохраняет автора, payload и generation. DB timestamp/reason и закрытый
local proof содержат cancelling member/user отдельно от автора. Один atomic audit,
нет Message/event/conversation counter updates. Replay требует retained audit;
restore после доказанной отмены не переписывает proof. SQL FIFO исключает только
нормализованный local proof, используя единый JS/SQL contract helper. Это доверенная
server storage запись, не криптографическая подпись произвольного SQL.

## Проверки

[370 Jest /14 suites](tests.txt) +
[20 dependency](guard-tests.txt) +[6 checksum](checksum-tests.txt) =
396 PASS. Новые44 cases:34 PostgreSQL,10 strict-owner.
Повторены claim/recovery, acceptance, native sent и restore context. Полный fork
suite1460 прошёл в [LOG047](../log047/README.md); здесь полный suite не повторялся.

[TypeScript](typecheck-differential.json):205 roots,
146 baseline/current diagnostics,0 новых/0 changed-code. Прежний aggregate diagnostic
проверен по неизменённому методу; полный server build/typecheck не заявляется.
[Source hashes](source-snapshot.json), [dependency guard](dependency-guard.json),
[7 migration checksums](migration-checksums.txt), [сводка](verification.json).
Все прежние aggregate методы и все7 migration sources неизменны.

Реальные PG проверки: concurrent cancels, claim/cancel winner, terminal/unknown
preservation, NULL/old incarnation, retained partial metadata, own/delegated/current
revoke, wrong workspace, replay без audit, >100 proven FIFO predecessors, malformed
proof blocking, JS/SQL parity, audit fail/tamper, AFTER UPDATE tamper, actual lost
COMMIT ACK. Owner tests: immutable request/callback snapshot до await, separate
failure scope after rollback, no failure audit on unknown COMMIT/ROLLBACK/release,
visible aggregate failure при недоступном audit.

Независимый scoped read-only reviewer блокеров не нашёл, сам тесты не запускал.
Полный Claude review не заявляется. HTTP/UI/live connector/cron не включены;
production/demo не менялись. GitHub Actions не использованы.

## Далее

Общий native mutation guard на WorkspaceRepository kernels и transaction-bound
domain capability по T05/T22. Проверенные caller-specific guards сохраняются.
[Матрица ROB-764](../rob764-acceptance.md) остаётся основанием проверки этапа;
статус In Progress. Remote terminal outcomes требуют transport evidence в ROB-768.
