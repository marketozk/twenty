# LOG-040 — транзакционный владелец config recovery

Статус: внутренний owner и housekeeping реализованы и проверены; ROB-764 остаётся In Progress.

LOG-039 предоставил strict scope-accepting функции. Следующий шаг связывает их
с уже зарегистрированным MessagingSaveMessagesAndEnqueueContactCreationService:
закрытые команды, native workspace context, подтверждённый commit и отрицательный
аудит после подтверждённого rollback. Новый transaction framework не вводится.

Housekeeping выбирает один последний завершённый проход при позднем blocked
receipt, если уже нет незавершённой поддерживаемой обработки. Порядок определяется
исходным событием, не временем backfill. Нормативный владелец правил —
[спецификация §15.27](../../plan/implementation-spec.md#1527-начальные-настройки-и-владельцы-служебных-проекций).

Проверки: реальный путь accepted→blocked_config→config writer→wakeup→claim/apply→
native Message и Person participant; поздний defer после completed config event;
актуальные права, failure audit, общий rollback, lost COMMIT ACK, bounded rearm,
отсутствие чужих tenant effects. Отдельные unit checks проверяют снимок аргументов
до await и исключение неизвестного исхода из failed/denied audit.

Scheduler и текущий production grant provider пока не подключаются. Демо, внешние
маршруты и GitHub Actions не меняются.

## Результат

`executeOmniBindingConfigRecovery` в существующем зарегистрированном сервисе
принимает пять закрытых операций. Аргументы и оба callback сохраняются до await.
Current native workspace context не выдаёт разрешение: для каждого leaf остаётся
обязательный authorizer, а process дополнительно требует history.resume.

Failed/denied attempt записывается отдельной strict transaction только после
подтверждённого rollback и проверки binding в нужном workspace. Ошибка до входа
в transaction callback не создаёт ложный аудит. Unknown commit/rollback/release
сохраняет неопределённость; ошибка failure-audit не скрывает исходную причину.

Housekeeping проверяет текущий generation, не включает inactive binding и не
перезаписывает pending/running/retryable/blocked поддерживаемую работу. Он выбирает
один последний completed event по времени исходного DomainEvent, даже если старое
событие было backfilled позже. Повторный rearm отдельно проверяет текущее разрешение.

17 PostgreSQL-сценариев используют настоящий owner и существующие persistence
services. Late-defer race воспроизведена барьером подключения перед реальным defer:
config event успевает завершиться, затем blocked receipt появляется и подбирается
housekeeping. Конечный результат — один native Message, Person participant и тот
же IncomingReceipt; import остаётся suppressed, отправки/automation не запускаются.

## Проверки и границы

[226 Jest/11 suites](tests.txt) и26 Python guards =252 различных PASS в этом шаге.
После исправления typing getter spy в новом тесте [21 unit](final-unit.txt) повторён;
runtime не менялся. [Первая диагностика](typecheck-initial.txt) сохранена.
[Финальный TypeScript](typecheck-differential.json), [harness](typecheck-differential.cjs):
155 roots,146 baseline/current,0 новых/0 changed-code diagnostics. Одна диагностика
изменённого файла относится к прежнему методу; AST и полный текст всех старых
методов совпадают с baseline. Полный server build/typecheck не заявляется.

Полный fork suite890 последний раз прошёл в [LOG039](../log039/README.md).
Здесь повторены затронутые persistence/recovery/native transaction suites;
все6 миграций прежние: [checksums](migration-checksums.txt), [6 guard tests](checksum-tests.txt).
[Dependency guard](dependency-guard.json), [его20 тестов](guard-tests.txt) прошли.
[Проверенные исходники](source-snapshot.json) совпали по LF SHA256 с удалёнными.
[Сводка](verification.json) отделяет этот прогон от предыдущей полной регрессии.

Независимое scoped review owner/snapshot/housekeeping без блокеров. Применены
ai-dev-workflow, behavioral-guardrails, server-schrodinger; новый полный Claude
cross-review не заявляется. Следующий LOG-041 — приём human text command в outbox.
Нет подключённого scheduler/current production grant provider, HTTP/UI/transport;
полный ROB-764/T05 ещё не закрыт.
