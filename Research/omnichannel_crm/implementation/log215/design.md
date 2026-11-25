# LOG-215 - схема ядра собственных прав доступа (`crm-access`) и форк-миграция #11 (`ROB-766`)

Дата: 25.11.2026
Задача: `ROB-766` (Этап 3: собственные права и переходы сделок)
Нормативные источники: [implementation-spec.md](../../plan/implementation-spec.md) (§3, §7, §15.12, §15.13, §15.15, §15.17, §15.18, §15.27), [contracts/access-control.md](../../plan/contracts/access-control.md), [phase_3_access.md](../../plan/phase_3_access.md), [access-source.md](../access-source.md).

## Цель среза `LOG-215`

Ввести постоянное хранилище собственных прав доступа, переходов сделок, CAS-ревизий записей и производных артефактов ИИ/workflow в схеме `core` через изолированный fork-only migration runner (миграция #11) с полными инвариантами БД (`UNIQUE`, `CHECK`, составные tenant-scoped `FK`, `RESTRICT`), снапшот-верификатором и PG 17 интеграционными тестами, не изменяя runtime-поведение существующих запросов до подключения политик в следующих срезах (`LOG-216`+).

## Уже существующий фундамент (переиспользуется без дублирования)

В `packages/twenty-server/src/engine/core-modules/omnichannel-storage/entities/` уже существуют и мигрированы (`LOG-022`..`LOG-088`):
- `core."omniWorkspacePolicyState"` (`epoch`, `restoreIncarnation`)
- `core."omniPolicyMutationReceipt"` (идемпотентность административных policy mutations)
- `core."omniQueue"` (`bindingId`, `name`, `active`, `revision`)
- `core."omniConversationTarget"` (каноническое ребро `conversation <-> CRM record`)
- `core."omniConversationMember"` / `core."omniConversationReadCursor"`
- Базовый класс `OmniWorkspaceRow` (`id`, `workspaceId`, FK `core.workspace(id) ON DELETE RESTRICT`, `createdAt`, `updatedAt`).

## Новые сущности (`packages/twenty-server/src/engine/core-modules/crm-access/entities/`)

Все сущности наследуют `OmniWorkspaceRow` (автоматически обнаруживаются `core.datasource.ts` по glob `engine/core-modules/**/*.entity{.ts,.js}`), не регистрируются в `objectMetadata` / generated CRUD, не имеют `CASCADE` и не используют Enterprise RLS / `RecordShareModule`.

1. `core."crmTeam"` (`CrmTeamEntity`):
   - `name` (`text NOT NULL`), `revision` (`bigint NOT NULL DEFAULT '1'`)
   - `UNIQUE (workspaceId, name)`, `UNIQUE (workspaceId, id)`
   - `CHECK ("revision" > 0)`, `CHECK (btrim("name") <> '')`
2. `core."crmTeamMember"` (`CrmTeamMemberEntity`):
   - `teamId` (`uuid NOT NULL`), `workspaceMemberId` (`uuid NOT NULL`), `revision` (`bigint NOT NULL DEFAULT '1'`)
   - `UNIQUE (workspaceId, teamId, workspaceMemberId)`, `UNIQUE (workspaceId, id)`
   - Составной `FK (workspaceId, teamId) -> core."crmTeam"(workspaceId, id) ON DELETE RESTRICT`
   - `workspaceMemberId` - динамическая workspace-запись (проверяется сервером под policy fence, без core FK по §3)
   - `CHECK ("revision" > 0)`
3. `core."crmResourceAssignment"` (`CrmResourceAssignmentEntity`):
   - `resourceKind` (`text NOT NULL`), `resourceId` (`uuid NOT NULL`), `principalKind` (`text NOT NULL`), `principalId` (`uuid NOT NULL`), `assignmentKind` (`text NOT NULL`), `revision` (`bigint NOT NULL DEFAULT '1'`)
   - `UNIQUE (workspaceId, resourceKind, resourceId, principalKind, principalId, assignmentKind)`
   - Частичный `UNIQUE INDEX` на `(workspaceId, resourceKind, resourceId) WHERE "assignmentKind" = 'primary_owner'` (строго один основной владелец на ресурс)
   - `CHECK ("assignmentKind" IN ('primary_owner', 'team'))`
   - `CHECK (("assignmentKind" = 'primary_owner' AND "principalKind" = 'workspaceMember') OR ("assignmentKind" = 'team' AND "principalKind" = 'team'))`
   - `CHECK (btrim("resourceKind") = "resourceKind" AND "resourceKind" <> '')`, `CHECK ("revision" > 0)`
   - Индекс поиска по участнику/команде `(workspaceId, principalKind, principalId, resourceKind)`
4. `core."crmResourceGrant"` (`CrmResourceGrantEntity`):
   - `resourceKind` (`text NOT NULL`), `resourceId` (`uuid NOT NULL`), `principalKind` (`text NOT NULL`), `principalId` (`uuid NOT NULL`), `action` (`text NOT NULL`), `effect` (`text NOT NULL`), `revision` (`bigint NOT NULL DEFAULT '1'`)
   - `UNIQUE (workspaceId, resourceKind, resourceId, principalKind, principalId, action)`
   - `CHECK ("effect" IN ('allow', 'deny'))` (explicit deny доминирует в движке)
   - `CHECK ("principalKind" IN ('workspaceMember', 'team', 'role', 'application', 'agent', 'apiKey', 'workflow'))`
   - `CHECK (btrim("resourceKind") = "resourceKind" AND "resourceKind" <> '')`, `CHECK (btrim("action") = "action" AND "action" <> '')`, `CHECK ("revision" > 0)`
   - Индекс `(workspaceId, principalKind, principalId, resourceKind, action)`
5. `core."crmStageRule"` (`CrmStageRuleEntity`):
   - `objectMetadataId` (`uuid NOT NULL`), `fieldMetadataId` (`uuid NOT NULL`), `action` (`text NOT NULL`), `optionValue` (`text NOT NULL`), `fromValue` (`text NOT NULL`), `toValue` (`text NOT NULL`), `principalKind` (`text NOT NULL`), `principalId` (`uuid NOT NULL`), `effect` (`text NOT NULL`), `revision` (`bigint NOT NULL DEFAULT '1'`)
   - `UNIQUE (workspaceId, objectMetadataId, fieldMetadataId, action, optionValue, fromValue, toValue, principalKind, principalId)`
   - Строгие `CHECK` без `NULL`/wildcard двусмысленности (§3, `T30`):
     - `action IN ('read', 'edit', 'transition', 'configure')`
     - `effect IN ('allow', 'deny')`
     - Для `read`/`edit`: `optionValue <> '*'` AND `fromValue = '*'` AND `toValue = '*'`
     - Для `transition`: `optionValue = '*'` AND `fromValue <> '*'` AND `toValue <> '*'`
     - Для `configure`: `optionValue = '*'` AND `fromValue = '*'` AND `toValue = '*'`
     - Все текстовые значения `btrim(...) <> ''`, `revision > 0`
6. `core."crmQueueGrant"` (`CrmQueueGrantEntity`):
   - `bindingId` (`uuid NOT NULL`), `queueId` (`uuid NOT NULL`), `principalKind` (`text NOT NULL`), `principalId` (`uuid NOT NULL`), `action` (`text NOT NULL`), `effect` (`text NOT NULL`), `revision` (`bigint NOT NULL DEFAULT '1'`)
   - `UNIQUE (workspaceId, bindingId, queueId, principalKind, principalId, action)`
   - Составной `FK (workspaceId, bindingId, queueId) -> core."omniQueue"(workspaceId, bindingId, id) ON DELETE RESTRICT`
   - `CHECK ("effect" IN ('allow', 'deny'))`, `CHECK ("revision" > 0)`
7. `core."crmRecordRevision"` (`CrmRecordRevisionEntity`, §15.17 CAS сделки):
   - `objectMetadataId` (`uuid NOT NULL`), `recordId` (`uuid NOT NULL`), `revision` (`bigint NOT NULL DEFAULT '1'`)
   - `UNIQUE (workspaceId, objectMetadataId, recordId)`
   - `CHECK ("revision" > 0)`
8. `core."crmAutomationArtifactScope"` (`CrmAutomationArtifactScopeEntity`, §15.12 производный ACL ИИ/workflow):
   - `artifactKind` (`text NOT NULL`), `artifactId` (`uuid NOT NULL`), `conversationId` (`uuid NOT NULL`), `referenceId` (`uuid`), `capturedResourceScope` (`jsonb NOT NULL`)
   - `UNIQUE (workspaceId, artifactKind, artifactId)`
   - Составной `FK (workspaceId, conversationId) -> core."omniConversation"(workspaceId, id) ON DELETE RESTRICT`
   - `CHECK (jsonb_typeof("capturedResourceScope") = 'object')`
   - Индекс `(workspaceId, conversationId, artifactKind)`

## Форк-миграция #11 и проверки

- Шаг миграции: `packages/twenty-server/src/database/commands/fork-upgrade/steps/crm-access-foundation.migration.ts` (класс `CrmAccessFoundationFastInstanceCommand`, `kind = 'fork'`, `up` + `down` на пустых новых таблицах).
- Манифест и верификатор:
  - `fork-schema-manifest.json` (11-я запись `omni-<epoch_ms>-crm-access-foundation` с SHA-256 checksum, первые 10 checksums не меняются!)
  - `crm-access-foundation.schema.json` + `crm-access-foundation.check.ts`
  - Обновление `fork-schema-checks.ts` (11 записей) и `fork-migrations.ts`.
- Критерий проверки `LOG-215`:
  - Новые PG 17 тесты (`crm-access-foundation.postgres-spec.ts`): применение 11/11 форк-миграций на чистой и ранее мигрированной БД (после 10 миграций), идемпотентный повтор, проверка частичного `UNIQUE` `primary_owner`, все `CHECK`-инварианты `crmStageRule` (без NULL/wildcard двусмысленности), составных FK `crmTeamMember`/`crmQueueGrant`/`crmAutomationArtifactScope`, `down` на пустых таблицах и `verifyForkTableSnapshot`.
  - Все Python guard-тесты (миграционные checksums + Enterprise dependency guard = 0 новых нарушений).
  - Differential typecheck = 0 новых диагностик.

## Дорожная карта следующих срезов `ROB-766`

- `LOG-216`: `CrmAccessContext`, `CrmAccessPolicyService`, `OwnBaselineReadabilityPolicy`, primary-forced routing (`useReplica: false` + свежие native permissions под policy fence), `PolicyMutationReceipt` admin writers (Team/Member/Grant/Assignment/StageRule/QueueGrant) + **ранний micro-load T19** по строке `omniWorkspacePolicyState` (до массового подключения ORM/UI).
- `LOG-217`: `crm-scope-predicate.ts`, `WorkspaceRepository.onBeforeExecute` + `WorkspaceSelectQueryBuilder` + nested relations / groupBy / search / export (`capturePermissionsHash` с own policy epoch) + `CrmMutationPolicyService` (before/after, `StageRule` validator, `CrmRecordRevision` CAS, `ConversationTarget` link/unlink, `ResourceAssignment` projection).
- `LOG-218`: `CrmEventAccessService` (SSE, webhooks, logic-functions, DATABASE_EVENT workflow/agent/wake-up), protected `FileByIdGuard`/`FileController`, `ConnectedAccountMetadataService`/`MessageChannelMetadataService`/`MessageFolderMetadataService` guards, read-only feature inventory на `/opt/twenty-demo` (§15.18) и удаление baseline Enterprise-зависимостей (`T20`).
