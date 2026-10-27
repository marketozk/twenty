# LOG-030 — сохранённое происхождение входящих событий

ROB-764 остаётся In Progress. Receipt теперь сохраняет отдельный trusted capture
context/hash: origin, qualification adapter/version, canonical key/version,
completeness и opaque position. Полный envelopeHash связывает их с нормализованным
wire envelope. Внешняя schema прежняя и не принимает origin/actor/grants.

Пятый внутренний аргумент ingress требует отдельный текущий authorizer под теми
же policy/binding locks до нового приёма и replay. Callback фиксируется один раз
до разбора detached/frozen context. Ревью нашло P2: два чтения accessor позволяли
подменить callback; исправление проверяется accessor/async mutation негативами.
DTO/hash сами по себе не доказывают квалификацию или право импортировать.

Одинаковый wire+capture повторяется безопасно; изменённый origin/key/qualification
или NULL↔qualified даёт conflict без overwrite. Старый четырёхаргументный путь
и прежние строки остаются NULL/unqualified, без выдуманного live/backfill.
Новые поля не раскрываются аудитом. [Контракт и ограничения](capture-contract.md).

## Проверки

294 PostgreSQL + 146 unit + 20 dependency guard + 5 checksum = **465 PASS**.
[Сводка](verification.json), [полный прогон](tests.txt), [guard](dependency-guard.json),
[TypeScript](typecheck-differential.json), [снимок проверенного кода](source-snapshot.json).
106 roots сравнивались с неизменённой LOG-029 базой; 0 новых и 0 диагностик
в изменённых файлах, 141 baseline остаётся. Это не полный зелёный server typecheck.

PG проверяет qualified commit/redaction, одинаковый replay, конфликт capture,
NULL transitions, обе SHARE fences, current authorization на replay, immutable
snapshot, audit rollback, lost COMMIT acknowledgement. Первый прогон обнаружил
ошибку только fixture: Node structuredClone создавал объект другого realm,
отклоняемый строгим JSON serializer; тестовый JSON-снимок исправлен. Финальный
общий прогон выполнен после исправления. Serializer не ослаблен.

Штатный generator подтвердил пустой baseline, создал 3 up/3 down SQL и пустой
итоговый diff. Все6 SQL перенесены точно: [сверка](migration-source-verification.json),
[сырой generated command](generated-upstream-command.txt). Пятая миграция добавляет
nullable JSON/hash pair с CHECK; все четыре прежних source/checksum сохранены.
Prefix verifier выбирает новую receipt snapshot только после соответствующего
ledger ID, исторический governance suite проверяет прежний prefix4.

[Native up/down/up](native-schema-verification.json) и
[зарегистрированный apply/replay/readiness](registered-upgrade.json) прошли.
Сохранены все256 native upgrade history rows и остальные24 таблицы. PG tests
проверяют populated legacy receipt, восстановление прежней схемы, malformed
pair/JSON/hash и отказ при schema/ledger drift. Down удаляет новые provenance
колонки: это проверка изолированной БД, не разрешение такого отката с рабочими
сообщениями. Новая production-сборка не выполнялась.

Immutability обеспечивается текущими writers и ORM update:false; DB CHECK
проверяет NULL/object/hash shape, но отдельного raw UPDATE prohibition trigger нет.
Серверный registry и реальная квалификация Telegram/MAX ещё не реализованы;
fixture authorizer не является production permission bypass. Реальный import и
old-generation restore имеют отдельные обязательные permission/recovery paths.

Независимое адресное ревью PASS после P2. Claude Code/full architecture round
не запускались. GitHub Actions не используется. Демо/живые каналы не менялись,
ограниченные изолированные test resources переиспользуются дальше.

## Продолжение

Persisted ownership guards для APP/background writers, затем domain
Conversation/Identity/MessageLink/revision/DomainEvent и полный receipt apply
с проверкой lease последним под доменными locks. Native Message persistence
и capture отдельно доказаны; полный ingress acceptance ещё не закрыт.
Scheduler, inbox/outbox/recovery, собственные права, UI и live подключение впереди.
