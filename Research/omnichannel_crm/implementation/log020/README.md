# LOG-020 — schema foundation, 27.10.2026

ROB-764 остаётся In Progress. Реализована первая группа из9 core tables,
23 foreign keys и15 CHECK; это ещё не работающий chat pipeline.

## Evidence

- `generated-upstream-command.txt` — неизменённый результат штатного generator;
  `generator-baseline.log` подтверждает no changes до новых entities;
  `generator-output.log` — штатную генерацию. Временная регистрация была только
  внутри disposable image; в Git upstream registry не менялся.
- `upstream-first-apply.json` — fresh fork apply/verify/replay на настоящей
  upstream core schema, missing-ledger отказ,256 upstream rows unchanged.
- `upstream-final-verification.json` — повтор после исправления verifier/index
  snapshot: apply/replay, readiness wrapper и focused strict typecheck PASS.
- `postgres-tests.txt` —35 tests (16 foundation +19 schema/readiness).
- `source-guard-tests.txt` —25 tests (20 Enterprise graph +5 source integrity).
- `dependency-guard.json` —0 новых нарушений; это не runtime license proof.
- `generate-in-isolated-image.cjs` и `verify-in-isolated-image.cjs` — harnesses,
  использованные для генерации и проверки внутри ограниченного test container.

## Среда и воспроизведение

Использован существующий pinned image `marketozk/twenty:2.52-44e1449c` (Node24),
PostgreSQL17 и Redis в отдельных temporary containers/internal network, без портов
и рабочих volumes. PG512MiB/1CPU/tmpfs512MiB; Redis128MiB/1CPU; runner2GiB/2CPU.
Штатные `setup-db.js` и `run-instance-commands --force --include-slow` создали
upstream core schema. Native workspace не seeding-овался.

Harness ожидает source subset в `/source`, tools в `/tools`, output в `/out`;
cwd `/app/packages/twenty-server`. Tools: Jest29.7, SWC1.15.11 musl,
@swc/jest0.2.39, TypeScript5.9.3, Prettier3.6.2. Runtime TypeORM/pg берутся из
pinned app. Новый TypeScript компилировался поверх ephemeral image через SWC;
JSON копировались в соответствующие dist paths. Сам образ не изменялся.

Suite требует отдельную БД `twenty_rob764_test_<16hex>` в
`FORK_MIGRATION_TEST_URL` и запускается с
`jest --config packages/twenty-server/jest-fork-migration.config.mjs --runInBand`.
Она удаляет core только внутри этой уникальной тестовой БД. Parent fixtures для
Workspace/ConnectedAccount/MessageChannel минимальные; full native validation
ими не доказывается. Другая отдельная БД содержит настоящий upstream core и
используется harness через PG_DATABASE_URL; обе БД disposable.

## Адресное ревью и исправления

68 SQL-вызовов final command совпали с generator artifact. Ревью обнаружило,
что TypeORM snapshot не удостоверяет convalidated/condeferrable/indisvalid.
Добавлены catalog checks и NOT VALID/DEFERRABLE negative tests. Schema test
выявил нестабильный порядок колонок индекса в TypeORM introspection между БД;
переход на pg_get_indexdef устранил ложный drift и позволил отклонять перестановку
колонок. Уточнён тип workspaceId у test helper. Финальные проверки прошли.

Первая попытка generator harness остановилась на EACCES до генерации; отдельный
disposable runner запущен с uid0. На fresh setup до создания keyValuePair был
ожидаемый fallback конфигурации. Наивный raw schema diff без штатного
UpgradeAware adapter не использовался для миграции; настоящий CLI подтвердил
нулевой baseline. Ни один из этих случаев не скрыт как успешный первый запуск.

## Пределы результата

Full Nest build/assets packaging, populated workspace upgrade и фактический
server/worker restart ещё не проверены. Wrapper подготовлен, но не подключён
к live Compose. Native same-workspace/account pairing проверит будущий writer;
ORM update:false у policy versions не заменяет domain immutability enforcement.
Generated down проверен только на пустых новых таблицах, CLI down отсутствует.
Демо, коннекторы и клиентские сообщения не менялись. ROB-764 не закрывается.

Код опубликован и Linear обновлён; [publication.json](publication.json) содержит
commit, comment и read-back статусов. Оба GitHub job блокированы до запуска
из-за billing аккаунта; CI pass не заявлен. Собственные тесты приведены выше.
Временные контейнеры/БД/network удалены; [cleanup.json](cleanup.json).
