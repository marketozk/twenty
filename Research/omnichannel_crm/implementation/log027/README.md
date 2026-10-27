# LOG-027 — владение обработкой входящих событий

Следующая порция ROB-764: внутренние claim/reclaim, renew и defer для уже
сохранённых IncomingReceipt. Нормативная таблица переходов и пределы добавлены
в [spec §4](../../plan/implementation-spec.md#4-приём-и-отправка--rob-764).
Scheduler, HTTP/коннекторы и Message apply в эту порцию не входят.

## Исследование и граница реализации

Проверены IncomingReceipt, acceptOmniIncomingEvent и audit context, а также
WorkspaceOrmManager.runInWorkspaceTransaction, WorkspaceDataSource.transaction,
MessagingMessageService.saveMessagesWithinTransaction и
MessagingMessageParticipantService.saveMessageParticipants.

Native Message helpers уже принимают WorkspaceTransactionScope с одним
executor. Общий import aggregate открывает свою транзакцию и запускает matching
после commit — его нельзя вложить в omni apply. Наш audit сейчас использует
TypeORM QueryRunner и его lifecycle, а workspace scope — отдельный pg executor.
Для следующей порции нужен реальный узкий adapter к тому же executor; отдельная
audit connection или приведение scope к QueryRunner не обеспечат атомарность.
Также нужны event-suppression wrapper, ownership/revision/identity writers и
различимый unknown commit на native transaction path.

Поэтому эта порция не позволяет callback отметить receipt applied без настоящих
Message/link/event. Receipt-only transitions берут совместимый prefix locks;
будущий apply обязан взять Conversation/Identity/CRM/root locks до receipt.
Одного schema presence или успешного lease недостаточно для бизнес-эффекта.

## Реализация

Существующие таблицы и индексы переиспользуются, миграции не нужны. Каждый запрос
получает trusted internal principal и обязательную текущую авторизацию. Обычный
claim выбирает due accepted/retryable_error или expired processing текущего
поколения, пропускает заблокированные rows через SKIP LOCKED и увеличивает token.
Applied/quarantined/blocked_config не получают автоматический новый claim.

Renew/defer проверяют владение и время БД после получения receipt lock.
Старый token не изменяет ни новое владение, ни итог. Envelope/hash/generation
не перезаписываются. Defer сохраняет retryable_error, blocked_config либо
quarantined, очищает lease и пишет техническую причину из закрытого каталога.
Claim и каждая transition имеют атомарный redacted audit с отдельным operationId.
COMMIT/release uncertainty видна вызывающему коду, не превращается в успех.

Нет фонового процесса, подключения рабочих каналов или изменения существующего
демо. Собственные права/квалификация коннекторов ещё не реализованы; synthetic
authorizer используется только в тестах. Старое поколение и blocked_config
сохраняются для будущих специализированных reconciliation/wake-up путей.

## Проверки

Прошли **292 теста**: [225 PostgreSQL и 42 envelope unit](tests.txt),
[20 dependency guard](guard-tests.txt), [5 checksum](checksum-tests.txt).
56 новых PG сценариев относятся к lease lifecycle. [Focused strict typecheck](typecheck.txt)
прошёл для 66 файлов с импортами. [Граф зависимостей](dependency-guard.json) —
без новых нарушений; прежний Enterprise runtime долг этим не устранён.
Четыре миграции/checksums сохранены. [Сводка](verification.json) ·
[Хеши исходников](source-snapshot.json); локальные и загруженные файлы совпали.

Реальные PostgreSQL tests проверяют races двух workers, SKIP LOCKED, expiry/
reclaim, stale token, current auth/generation, состояние после ожидания lock,
audit rollback, unknown COMMIT/release и сохранность immutable receipt.
Результаты, хеши исходников и очистка собственной тестовой среды сохраняются
рядом. Независимое адресное ревью сервиса/audit/контрактов — без подтверждённых
blocker/major. Claude Code и полный архитектурный круг не запускались.
Полный server image/typecheck и native Message acceptance не заявляются.

[Cleanup](cleanup.json): собственные PostgreSQL/Redis containers, exclusive
volumes и сеть удалены; временные БД уничтожены с tmpfs. Неактивные caches
сохранены, builder не запускался. Образ, start timestamps и health демо прежние.

## Дальше

Общий executor для audit/native workspace transaction и корректный unknown
commit; затем атомарные Conversation/Message/participants/link/revision/event,
initial plans/receipts, config wake-up, inbox/outbox/recovery и email regression.
ROB-764 остаётся In Progress. Проверки выполняем в собственной среде перед
commit/push; GitHub Actions не запускаем и не ждём.

## Публикация

Код: `306e2522fd11b316bfbf668fe365edd9fc104e91`; remote HEAD подтверждён
GitHub API. Описание ROB-764 и единственный
[комментарий LOG-027](https://linear.app/robotrts/issue/ROB-764/1-realizovat-model-obsheniya-i-nadyozhnoe-sohranenie#comment-82f2637b)
проверены повторным чтением. Статусы 11 задач сохранены.
[Метаданные](publication.json). Actions не запускались и не ожидались.
