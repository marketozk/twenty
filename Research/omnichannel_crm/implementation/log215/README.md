# LOG-215 - схема ядра собственных прав доступа (`crm-access`) и форк-миграция #11

Дата: 25.11.2026
Задача: `ROB-766` (Этап 3: собственные права и переходы сделок)

## Состав изменений
- Типы схемы: `packages/twenty-server/src/engine/core-modules/crm-access/types/crm-access-schema.types.ts` (включая расширенный домен `principalKind`: `workspaceMember`, `team`, `role`, `application`, `agent`, `apiKey`, `workflow`).
- 8 core-сущностей в `packages/twenty-server/src/engine/core-modules/crm-access/entities/`:
  - `crm-team.entity.ts` (`core."crmTeam"`)
  - `crm-team-member.entity.ts` (`core."crmTeamMember"`, составной `FK` на `core."crmTeam"` `RESTRICT`)
  - `crm-resource-assignment.entity.ts` (`core."crmResourceAssignment"`, частичный `UNIQUE INDEX` `UQ_crmResourceAssignment_primary_owner` + `CHK_crmResourceAssignment_principal`)
  - `crm-resource-grant.entity.ts` (`core."crmResourceGrant"`)
  - `crm-stage-rule.entity.ts` (`core."crmStageRule"`, строгий `CHK_crmStageRule_shape` + `btrim(col) = col` без `NULL`/wildcard двусмысленности, `T30`)
  - `crm-queue-grant.entity.ts` (`core."crmQueueGrant"`, 3-колоночный составной `FK` на `core."omniQueue"` `RESTRICT`)
  - `crm-record-revision.entity.ts` (`core."crmRecordRevision"`, CAS сделки §15.17)
  - `crm-automation-artifact-scope.entity.ts` (`core."crmAutomationArtifactScope"`, производный ACL ИИ/workflow §15.12, составной `FK` на `core."omniConversation"` `RESTRICT`)
- Форк-миграция #11 и верификация схемы:
  - `packages/twenty-server/src/database/commands/fork-upgrade/steps/crm-access-foundation.migration.ts` (`omni-1795564629556-crm-access-foundation`, точные имена `PK`/`FK` из `TypeORM DefaultNamingStrategy`, безопасный `down()` с `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` и отказом `CRM_ACCESS_FOUNDATION_ROLLBACK_REQUIRES_RECONCILIATION` на непустых таблицах)
  - `packages/twenty-server/src/engine/core-modules/omnichannel-storage/migrations/crm-access-foundation.check.ts`
  - `packages/twenty-server/src/engine/core-modules/omnichannel-storage/migrations/crm-access-foundation.schema.json`
  - Обновлены `fork-schema-manifest.json`, `fork-schema-checks.ts`, `fork-migrations.ts`
- Тесты:
  - `packages/twenty-server/test/fork-migration/crm-access-foundation.postgres-spec.ts` (12 тестов: upgrade 10->11, fresh 11/11 + нулевой diff `TypeORM SchemaBuilder`, все инварианты с проверкой SQLSTATE и `constraint`, 3-колоночный FK, дрейф partial index и `crmStageRule` CHECK, отказ при неучтённой таблице, отказ `down()` на непустой таблице, чистый `down()`/`up()`)
  - `packages/twenty-server/test/fork-migration/crm-audit-operation-index.postgres-spec.ts` (закреплён исторический срез `.slice(0, 10)`)
  - `scripts/omnichannel/test_fork_migration_sources.py` (добавлен тест сохранения контрольных сумм первых 10 миграций при добавлении 11-й)

## Результаты проверок
- 4 PG 17 Jest-сьюта (`crm-access-foundation`, `crm-audit-operation-index`, `audit-bootstrap-schema`, `omni-incoming-application-result`): `50/50` тестов PASS за `96.584s`.
- TypeScript typecheck на всех 15 `.ts` файлах среза: `0` диагностик.
- Python guard-тесты на Linux: `34/34` PASS (`0.148s`, вкл. 7 Linux-only startup тестов и `Verified 11 fork migration source(s)`).
- Enterprise dependency guard: `status: pass`, `0` нарушений (`edges: 138144`).
- `18/18` local/remote SHA-256 совпали; временный стенд `twenty-log215-pg` на Schrodinger полностью удалён (`STAND_CLEAN`).
- Подробности: [design.md](design.md), [review.md](review.md), [results.json](results.json), [next-boundary.md](next-boundary.md).
