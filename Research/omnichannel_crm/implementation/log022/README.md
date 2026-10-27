# LOG-022 — аудит и атомарное создание подключения

Продолжение ROB-764 по команде пользователя «хорошо делай». Эта порция реализует
минимальный аудит и защищённый bootstrap до добавления MessageLink/receipts/outbox.
Работающий demo и реальные каналы не меняются; публичного endpoint пока нет.

## Код

- `engine/core-modules/crm-audit/`: transaction context, allowlist безопасных
  полей, first-before/last-after, deterministic event key/hash, конфликт вместо
  перезаписи. Flush выполняется тем же QueryRunner до COMMIT. Отрицательная
  попытка имеет отдельный attemptId и пишется после rollback в другой transaction.
- `crm_audit.crmAuditEntry` без workspace FK сохраняет исторический факт после
  удаления workspace. `core.omniPolicyMutationReceipt` хранит idempotency outcome;
  очищенный retention result остаётся tombstone и возвращает result_expired.
- `modules/omnichannel/services/omni-binding-bootstrap.ts`: primary transaction,
  policy UPDATE fence, обязательный текущий authorizer до исполнения и replay,
  native account/channel ownership validation, атомарные binding/policy v0/head/
  epoch/audit/receipt. Нет Application/ConnectionProvider parent, канал только APP.
- Начальные значения: inactive, human, no default queue, autoCreatePerson=false,
  capabilities={} / unverified, disabled v0 с нулевыми budgets. Это внутреннее
  создание неподтверждённого подключения; handshake/activation остаются ROB-768/766.
- Runtime `verify` проверяет append-only audit privileges до Nest, `apply` работает
  как migration owner. Проверяются также UPDATE отдельных колонок и SET ROLE.
  Никакого автоматического назначения/ослабления grants нет.

Библиотека аудита доверяет серверному transaction owner, не является auth engine.
Каталог пока ограничен пятью служебными видами записей. Native CRM coverage/UI
позже расширяют этот writer, не вводят второй журнал. Отказ авторизации не должен
превращаться в успех при недоступности отрицательного аудита.

## Схема и генерация

Штатный `generate:instance-command` сначала подтвердил пустой baseline, затем
создал два новых table definitions и receipt workspace FK. Шесть SQL-вызовов
up/down перенесены без изменения и upstream registration в fork registry.
Дополнительно явно создаётся schema `crm_audit` (штатный generator не включил
CREATE SCHEMA). Down удаляет только две пустые новые таблицы, не саму схему.
Новая миграция `omni-1793091163781-audit-bootstrap`; исходник старой миграции
и её checksum сохранены.

До генерации найден baseline noise: PostgreSQL распознаёт restoreIncarnation
с uuid_generate_v4 как generated UUID, а entity не содержала @Generated('uuid').
Декларация приведена к фактической БД; повторный baseline пустой, существующая
DDL не менялась. Schema snapshot verifier вынесен в общий helper для обеих групп.

Raw generator, логи и native up/down/up evidence сохранены рядом. На настоящей
upstream core схеме прежние девять таблиц и history fingerprints не изменились.

## Границы проверки

Изолированный PostgreSQL17/Redis на внутренней сети, без портов и live volumes.
Runtime-тесты используют отдельные LOGIN роли; owner создаёт fixtures и grants.
Проверка запретов DROP/ALTER/TRUNCATE/UPDATE и SET ROLE выполняется настоящим SQL.
Bootstrap ownership tests используют узкие fixtures native родителей; это не
полная проверка provisioning, авторизации и работы всех upstream jobs.

Действующий план авторизации ROB-766 не объявляется реализованным: production
authorizer/callsite отсутствует, настройки не активируют реальный транспорт.
MessageLink, incoming/outgoing persistence, DomainEvent, roots/dispatch и другие
таблицы ROB-764 ещё предстоят. T06 проверяется для текущего writer, не для всей CRM;
T33 дополняется текущей migration, будущие изменения требуют своих проверок.

## Находки адресного ревью

Исправлены TypeORM UPDATE RETURNING result shape (выбран CTE + SELECT), native
Application/Provider ownership, UUID case в audit dedup и sparse JSON arrays.
Неопределённый результат COMMIT не должен получать ложный failed audit; replay
проверяет durable receipt. Отсутствующий policy state при retained binding/receipt
не восстанавливается скрыто с epoch=1, требуется явный recovery.

Также исключён новый транзитивный Enterprise import через `twenty-shared/utils`:
использована уже существующая зависимость class-validator. Baseline не расширялся.
Финальное адресное независимое ревью writer/unknown outcomes/runtime gate — PASS
без подтверждённых blocker/major; Claude Code в этой порции не запускался.

## Результаты проверки

- [81/81 PostgreSQL tests](pg-tests.txt): прежняя миграционная серия и новые
  schema/audit/bootstrap/replay/authorization/rollback/commit-ACK/privilege случаи.
- [20 dependency guard tests](guard-tests.txt), [5 source checksum tests](checksum-tests.txt)
  и [7 Linux shell tests](shell-tests.txt) прошли: всего113 выполненных тестов.
- [Focused strict TypeScript](typecheck.txt):40 файлов с импортами; native entity
  initialization convention сохранена. Полный server typecheck не выполнялся.
- [Official Docker build](build-summary.txt): server пересобран, неизменённый
  frontend использует cache. Это настоящий Nest build, не подмена compiled files.
- [Собранный image](image-verification.json): новые assets присутствуют,
  переход с прежнего fork prefix и replay проходят, owner и column-write runtime
  отвергнуты до sentinel; отдельная append-only LOGIN role проходит gate.
- [Native schema](native-schema-verification.json): empty down/up и прежние
  девять таблиц проверены; все256 native upgrade history rows сохранены.
- [Enterprise guard](dependency-guard.json):0 новых нарушений, прежний долг ROB-766
  остаётся; это не полное доказательство лицензии runtime.

[Сводка](verification.json) · [Image ID / source hashes](source-snapshot.json).
Тестовый image собран до publication commit из проверенного LOG-021 build source
и полных изменённых файлов; не выдан за production release из конечного SHA.
Full build/generator logs находятся в указанном source-snapshot test directory
рядом, в `out/`; в Git сохранены короткие extracts и raw generated SQL.

Image-check harness первоначально не нашёл module из `/out`; настроен NODE_PATH
к image dependencies, до этой ошибки подключений/DDL не было. Повтор прошёл.

Дополнительно в собранном image прошёл полный native+fork migrator replay;
все 256 строк native upgrade history сохранились. Нового server/worker restart
в LOG-022 не было: соответствующая проверка LOG-021 остаётся исторической.

[Очистка](cleanup.json): собственные PostgreSQL/Redis containers, exclusive volume
и внутренняя сеть удалены, БД уничтожены вместе с tmpfs. Builder возвращён в
исходное stopped состояние. Candidate image и неактивные исходники/кэши сохранены.
Демо осталось на прежнем image с прежними start timestamps; health подтверждён.
