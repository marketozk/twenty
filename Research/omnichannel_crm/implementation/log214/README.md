# LOG-214 - Сборка изолированного кандидата `marketozk/twenty:log214-server` и сквозная HTTP/JWT/GraphQL приёмка `ROB-765`

- Дата: `2026-11-25`
- Задача: Linear `ROB-765` (Phase 2a; изолированная серверная и HTTP/JWT приёмка пройдена, живой выкат отдельно)
- Ветка: `codex/omnichannel-requirements`
- Образ-кандидат: `marketozk/twenty:log214-server` (`sha256:337f98be0ed94b08b6556dab64568a4126fe97dbe43c569826f97b171c99110b`)

## Реальные production-баги, выявленные и исправленные при живой приёмке
1. `packages/twenty-server/src/engine/core-modules/crm-audit/navigation-menu-item-audit.ts` (коммит `59ff9692`) + `packages/twenty-server/test/fork-migration/crm-audit-command-menu-item.postgres-spec.ts` - в `VALID_COMMAND_MENU_ITEM_AVAILABILITY_TYPES` отсутствовало значение `GLOBAL_OBJECT_CONTEXT` из `CommandMenuItemAvailabilityType`, что ломало реальный `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow` при инициализации рабочего пространства. Добавлено `GLOBAL_OBJECT_CONTEXT` и тест полноты по всем значениям `Object.values(CommandMenuItemAvailabilityType)`.
2. `packages/twenty-server/src/engine/core-modules/crm-audit/navigation-menu-item-audit.ts`, `core-workflow-and-view-audit.ts`, `two-factor-authentication-audit.ts` - имя схемы воркспейса для проверки `"workspaceMember"` вычислялось в hex/UUID вместо канонического base36 (`workspace_${BigInt('0x' + id.replace(/-/g, '')).toString(36)}`), из-за чего живой `createDashboard` падал с `Navigation menu item audit workspaceMember table unavailable`, а workflow/view/2FA пропускали проверку `workspaceMember`. Все 3 файла переведены на приоритетное разрешение канонической base36-схемы (с сохранением совместимости для синтетических фикстур).

## Подтверждённая приёмка
- Сборка `packages/twenty-docker/twenty/Dockerfile` (`--target twenty-server`): CJS/ESM экспорты `twenty-shared/application-runtime` OK, `10` форк-миграций в манифесте, идемпотентный повтор миграций OK.
- `workspace:seed:dev --light` под ограниченной append-only ролью `runtime_log214`: рабочее пространство `apple` перешло в `ACTIVE`, записано `1 704` аудит-записи по `19` видам ресурсов.
- Стартовые гейты: `upgrade:status --strict` PASS под `runtime_log214`; DB-владелец `test_owner` заблокирован (`append-only privileges`); неполный `forkMigrationLedger` заблокирован до `exec` (exit 1); восстановленный ledger PASS (exit 0).
- Живая HTTP/JWT/GraphQL приёмка (`e2e-acceptance.mjs`) против `twenty-log214-server` + `twenty-log214-worker`:
  - `GET /healthz` 200 OK; `27` BullMQ-подписок воркера.
  - Реальный логин `tim@apple.dev` и `scott.forstall@apple.dev` -> JWT + session cookie + `userSession:create` / `refreshToken:create` без утечки токенов.
  - `/admin-panel` `crmAuditHealth`: анонимный и non-admin (`scott.forstall@apple.dev`) отклонены; full server admin (`tim@apple.dev`) получает `status: OK`, `databaseReachable: true`, `appendOnlyPrivilegesVerified: true`.
  - `/graphql`: полный жизненный цикл `company` (`create`/`update`/`soft_delete`/`restore`/`destroy`), плюс `createNote`, `createTask`, `createDashboard` - все записаны в `crm_audit."crmAuditEntry"`.
  - Post-rollback `failed` audit (`crmRecord:update`, `reasonCode: crm.mutation.record_not_found`) на несуществующем `companyId`.
  - `renewToken` + `signOut({ refreshToken: parent })` отзывает и родителя, и ротированного потомка (`USER_SIGN_OUT`), при этом повторный `renewToken(child)` отклонён.
  - Чистый stop / restart / stop обоих контейнеров (`ExitCode=0`, `OOMKilled=false`, `27` очередей BullMQ после рестарта).
- Проверки кода: `5/5` целевых PG 17 сьютов (`28/28` тестов PASS), `33/33` Python-тестов на Linux (вкл. `7` Linux-only startup тестов), `0` новых диагностик typecheck, `0` нарушений Enterprise (`edges: 138107`), `4/4` SHA-256 совпали, временный стенд `log214` полностью удалён (`STAND_CLEAN`).

## Артефакты
- [rob765-acceptance.md](../rob765-acceptance.md)
- [e2e-acceptance.mjs](e2e-acceptance.mjs)
- [results.json](results.json)
- [review.md](review.md)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
