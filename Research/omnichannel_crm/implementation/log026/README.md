# LOG-026 — надёжный внутренний приём текстовых событий

Продолжение ROB-764. Реализован `acceptOmniIncomingEvent`: receipt и success audit
сохраняются в одной транзакции. Новых таблиц и миграций не потребовалось.
Сервис вызывается только тестами: HTTP/HMAC, credential storage/rate limits,
реальные коннекторы, Message apply, automation и отправка ещё не подключены.

## Контракт и поток

План §4/§15.16 требует сначала строгий versioned envelope, затем durable receipt.
Вместо дублирующего протокола использованы существующие IncomingReceipt,
canonicalAuditJson/auditPayloadHash и CrmAuditTransactionContext.
Lazy policy bootstrap, новый receipt ledger и отдельная БД здесь не нужны.

- [Envelope v1](../../../../packages/twenty-server/src/modules/omnichannel/contracts/README.md)
  поддерживает текстовые message.received/edited/deleted, строгие вложенные объекты,
  nullable source evidence и отдельные синтетические Telegram/MAX fixtures.
  Unknown kind/version и внешние origin/workspace/actor/grants отвергаются.
- JSON Schema генерируется из Zod, snapshot equality проверяется тестом.
  Provider IDs и bigint generation — строки без числового округления.
  Ограничения строк заданы в Unicode code points; lone surrogates отклоняются.
  128 KiB canonical UTF-8 limit проверяется отдельно, до записи.
- Detached semantic envelope сериализуется до первого await. Hash включает
  все его поля, включая occurredAt/capture generation; порядок ключей не важен.
  Transport timestamp/signature в тело не входят. Менять вложенный объект
  вызывающей стороной во время авторизации уже нельзя.
- Существующий WorkspacePolicyState SHARE → binding SHARE → обязательный
  current authorizer → active/current generation → receipt. Отсутствующий
  policy fence не создаётся. Дубликат также требует актуальной авторизации.
- INSERT ON CONFLICT сравнивает semantic hash: одинаковый повтор возвращает
  прежний ID и текущее состояние; другой payload — typed conflict без overwrite.
  Success audit создаётся только с новой receipt, через тот же QueryRunner.
  Содержание сообщений и provider/event IDs не попадают в открытый audit diff.
- Возврат результата возможен только после COMMIT. Потерянный ответ COMMIT или
  ошибка освобождения соединения после него дают typed outcome unknown с прежним
  eventId. Отрицательный audit пишется отдельно только после подтверждённого
  rollback; ошибка самого audit остаётся видимой.

Точная capture generation сохраняется: обычный приём отвергает старое поколение,
даже при повторе. Будущий authenticated reconciliation будет отдельным путём;
переписывание старого события новым поколением запрещено. Значения author/direction/
sourceVariant пока лишь untrusted evidence, не разрешение на бизнес-эффект.

## Проверки и границы

Прошли **236 тестов**: [169 PostgreSQL и 42 envelope unit](tests.txt),
[20 dependency guard](guard-tests.txt), [5 checksum](checksum-tests.txt).
34 новых PG сценария проверяют именно ingress; остальные — регрессия.
[Focused strict typecheck](typecheck.txt) прошёл для 64 файлов с импортами.
[Dependency graph](dependency-guard.json) не содержит новых нарушений;
старый Enterprise runtime долг этим не объявляется устранённым.
Четыре migration source/checksum не менялись. [Хеши](source-snapshot.json) ·
[Сводка](verification.json). Тестовая
роль PostgreSQL не владеет таблицами и имеет только append-only audit privileges.
Проверяются concurrency/dedup/conflict, tenant/binding isolation, current auth,
policy fence, generation, audit rollback/redaction, lost COMMIT ACK и release.
Unit checks проверяют schema/fixtures, semantic hash, Unicode и размер.

На независимом адресном ревью найден и исправлен допуск lone UTF-16 surrogate:
теперь такой envelope отклоняется до PostgreSQL jsonb. Также унифицированы
ограничения длины Unicode между runtime и portable schema. Финальное ревью
сервиса/audit/контрактов не обнаружило подтверждённых blocker/major. Claude Code
и полный архитектурный круг не запускались.

Новый полный Docker image и полный server typecheck в этой порции не выполнялись.
Использован прежний image с инструментами в ограниченных временных containers.
[Cleanup](cleanup.json): собственные containers, exclusive volumes и сеть удалены,
временные БД уничтожены вместе с tmpfs; неактивные caches сохранены. Builder
не запускался, demo image/start timestamps/health прежние.
Действующее демо и каналы SaleBot не менялись. Runtime own ACL/credential verifier
не выдаются за готовые: обязательный callback — внутренний стык будущей интеграции,
а synthetic authorizer находится только в тестах, без production bypass.

## Порядок проверки и следующий шаг

По решению пользователя GitHub Actions не является этапом разработки. Два наших
workflows переведены в manual-only, автоматические push/PR triggers убраны.
Проверки в собственной среде, commit/push и отчёт в Linear сохраняются.
Upstream workflows, настройки оплаты и сторонние репозитории не менялись.

Python unit tests и source/dependency guards запускаются из корня проекта
по [инструкции](../../../../scripts/omnichannel/README.md).
Jest: `node .yarn/releases/yarn-4.18.1.cjs jest --config packages/twenty-server/jest-fork-migration.config.mjs --runInBand`
с `FORK_MIGRATION_TEST_URL` на выделенную временную БД
`twenty_rob764_test_<16 hex>`. Этот набор сбрасывает её тестовые схемы;
не направлять его в клиентскую БД. Unit schema tests входят в тот же набор.

Далее — worker claim/lease и атомарное сохранение Message+participants+link+
audit+event через общий executor, затем inbox/outbox/recovery и email regression.
ROB-764 остаётся In Progress; подтверждение durable receipt ещё не означает,
что сообщение появилось в интерфейсе или запустило ИИ.
