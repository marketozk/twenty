# LOG-021 — packaging, migrator и настоящий startup

27.10.2026, ROB-764 остаётся In Progress. Разрешение пользователя: «хорошо делай».
Продолжен следующий шаг LOG-020; live demo и клиентские каналы не изменялись.

## Реализовано

- Официальный Docker target `twenty` использует новый entrypoint: отдельный
  migrator либо read-only fork verification перед server/worker. `twenty-app-dev`
  сохраняет отдельный s6 путь и в эту проверку не входит.
- Координатор держит отдельный PostgreSQL session lock над всей последовательностью;
  второй migrator не запускает child. Fresh init определяется через pg_namespace
  на том же соединении; partial DB без core отклоняется до DDL.
- Native cache flush, upgrade status и cron registration получили opt-in `--strict`.
  При ошибке migrator завершается; прежние вызовы без флага совместимы.
- Compose требует успешного migrator и здорового server перед worker, разделяет
  migration/runtime credentials. Worker stop grace6 минут покрывает native AI
  drain300000ms и запас; длительные другие jobs требуют отдельного drain policy.
- Сравнение UNIQUE нормализует порядок21 наборов колонок. Два обычных индекса
  сохраняют порядок, FK mappings и68 исходных SQL-вызовов миграции не менялись.
- CI расширен проверками shell и strict commands. Полный Enterprise dependency
  guard не обнаружил новых нарушений; существующая задолженность остаётся ROB-766.

## Проверки

| Проверка | Результат |
|---|---|
| PostgreSQL17 integration | 38/38, включая coordinator lock, отказ конкурента и потерю backend |
| Strict command unit | 15/15, ошибки не скрываются, legacy behavior сохранён |
| Linux shell sequencing | 7/7, отказ на каждом этапе прекращает последующие |
| Python dependency/source guards | 20+5, source checksum прежний |
| TypeScript5.9.3 strict | coordinator и lock tests прошли; не полный server typecheck |
| Official Docker/Nest build | target twenty собран, server пересобран; frontend слой использует cache |
| Assets в собранном image | main/worker/coordinator, оба JSON и front/index.html присутствуют |
| Fresh DB | native init → upgrades → fork apply → strict cron;32 registered,0 failed,3 skipped |
| Populated upstream DB |1 ACTIVE workspace; upgrade/replay не изменили599 companies,150 opportunities,1200 people |
| Реальные процессы | fresh/upgraded server health200, worker запуск и restart; не mock command |
| Runtime role | non-owner/non-superuser, fork ledger SELECT-only; не полная проверка всех функций |
| Negative checks | до миграции, partial DB и schema drift запрещают startup; sentinel не выполнен |
| Compose | ошибка migrator блокирует runtime; после исправления запуск успешен, без опубликованных портов |
| Worker readiness/stop |26 своих Bull subscriptions в Redis db2; graceful exit0 за5,45s, не OOM |

Изначальный короткий Compose stop дал137 до подтверждённой готовности worker,
OOM=false. Проверка исправлена: ожидание собственных queue subscriptions и
stop timeout360s; повтор дал exit0. `Running` сам по себе не означает готовность.

Данные: [verification.json](verification.json), [исходники/image](source-snapshot.json),
[fingerprints](record-preservation.json), [Compose](compose-verification.json),
[PostgreSQL](pg-tests.txt), [commands](unit-tests.txt), [shell](shell-tests.txt),
[guard](dependency-guard.txt). Сборки: [baseline](build-baseline-summary.txt),
[candidate](build-candidate-final-summary.txt). Полные build logs сохранены на
Schrodinger в `/opt/twenty-builds/log021-{baseline,candidate-final}-build.log`.

Собранный image получен из Git archive `8e1facac` и полных изменённых файлов
до публикации commit. Точный image ID и LF hashes зафиксированы. Он не выдаётся
за production release из конечного commit и не отправлен в registry.

## Ревью и ограничения

Адресное self/subagent review выявило swallowed errors трёх native commands,
отсутствие lock над общей native/fork последовательностью, privilege-filtered
schema discovery и нюанс startup/shutdown worker. Исправления проверены. Последнее
scoped review не нашло новых замечаний. Claude Code и полный круг архитектуры
в LOG-021 не запускались.

Native commands загружают AppModule до fork DDL. Новые entities не читают таблицы
при bootstrap; нельзя добавлять туда readiness hooks. Runtime gate остаётся до Nest.
Upstream cache flush очищает EngineLock: перед migrator старые server/workers
должны быть остановлены. Compose dependency не останавливает уже работающую версию.

Session lock не даёт fencing всех child SQL sessions при потере соединения:
PostgreSQL может отпустить lock раньше обнаружения disconnect процессом. Автоповтора
нет; после неизвестного исхода требуется проверить историю и отсутствие старого
process tree в maintenance window. [Операционный порядок](../../../../ops/omnichannel/README.md).

Это проверка текущих9 таблиц и T33 для них. Нет полного server typecheck,
полной проверки auth/provision/background permissions, активного AI stream drain,
audit writer, bootstrap, ingress/outbox и клиентского общения. Новые этапы/миграции
потребуют своих тестов. Реальные bindings остаются выключенными до ROB-766.

Временные PG/Redis/runtime containers и exclusive volumes удалены;
тестовые БД уничтожены с tmpfs, internal network удалён, builder возвращён
в исходное stopped состояние. Inactive source/tool caches и test images сохранены.
Демо server/worker/db/redis работает: [cleanup read-back](cleanup.json).
