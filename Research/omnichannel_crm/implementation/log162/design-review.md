# LOG162 - Независимое критическое ревью дизайна и тест-плана

**Объект ревью:**
- `Research/omnichannel_crm/implementation/log162/design.md`
- `Research/omnichannel_crm/implementation/log162/test-research.md`
- Связанный исходный код `role-assignment-audit.ts`, `from-update-agent-input-to-flat-agent-to-update.util.ts`, `agent.service.ts`, `agent.resolver.ts`, `create-agent.tool.ts`, `update-agent.tool.ts`, `delete-agent.tool.ts`, `workflow-version-step-operations.workspace-service.ts`, `workspace-migration-runner.service.ts`.

**Итоговый вердикт:** Дизайн и тест-план архитектурно обоснованы и закрывают последний прямой контур мутаций `core."roleTarget"` вне транзакционного CRM-аудита. В ходе сверки с реальным пайплайном `WorkspaceMigrationBuildOrchestratorService` и `computeOrderedMigrationActions` выявлено **1 блокирующее расхождение в спецификации `agentMode === 'update'`** и **3 важных уточнения реализации**, которые необходимо учесть при написании кода.

---

## 1. Проверка целевых инвариантов

### 1.1. `computeAgentFlatRoleTargetToUpdate` (`from-update-agent-input-to-flat-agent-to-update.util.ts`)
- **Текущее состояние в коде (`строки 30–92`):**
  - При `roleId === undefined` возвращает `{}`.
  - При `roleId === null` возвращает `{ flatRoleTargetToDelete: existingRoleTarget }`, если `isDefined(existingRoleTarget)`, иначе `{}`.
  - При `isDefined(roleId)` и наличии `existingRoleTarget` сейчас возвращает `{ flatRoleTargetToUpdate: ... }` **даже при `existingRoleTarget.roleId === roleId`** (отсутствует no-op) и использует `update` вместо канонической пары `delete` + `create`.
- **Оценка дизайна (раздел 2.1 `design.md`):**
  - Полностью корректно: при `isDefined(existingRoleTarget) && existingRoleTarget.roleId === roleId` возвращается `{}` (идемпотентный no-op); при `existingRoleTarget.roleId !== roleId` возвращается `{ flatRoleTargetToDelete: existingRoleTarget, flatRoleTargetToCreate: newFlatRoleTarget }` с новыми `id: v4()` и `universalIdentifier: v4()`.
  - **Рекомендация при реализации:** сравнивать `existingRoleTarget.roleId.toLowerCase() === flatRole.id.toLowerCase()` (на случай различия регистра входного UUID до нормализации), а в `AgentService.updateOneAgent` передавать `flatEntityToUpdate: []` для `roleTarget`.

### 1.2. `withAgentMetadataRoleTargetAudit` / `targetKind === 'agentMetadata'` (`role-assignment-audit.ts`)
- **Блокировки и проверки (`design.md`, раздел 2.2):**
  - Внутри `runInCoreAuditTransaction` устанавливается `SET LOCAL lock_timeout = '8s'`, блокируются:
    - `core.workspace` (`FOR NO KEY UPDATE`, проверка `deletedAt === null`);
    - `core.application` (`FOR SHARE` через `verifyRoleAuditApplication`);
    - `core.agent` (`FOR SHARE` при `update`/`delete` с проверкой `deletedAt === null`; при `create` - проверка отсутствия до `work(runner)` и точной сохранённой строки после `work(runner)`);
    - `core."roleTarget"` (`FOR UPDATE`);
    - `core.role` (`FOR SHARE`, проверка `canBeAssignedToAgents === true` для целевой роли на `create`/`update` и существования исходной роли при `delete`/замене).
  - **Защита от потери `before`-образа из-за `ON DELETE CASCADE`:**
    В `RoleTargetEntity` (`role-target.entity.ts:54-58`) внешний ключ `agentId` объявлен с `onDelete: 'CASCADE'`. В `runAuditedRoleAssignment` выборка и блокировка `beforeRows` (`SELECT to_jsonb(t) AS row FROM core."roleTarget" ... FOR UPDATE`) выполняются **до** вызова `work(runner)` (то есть до запуска `DeleteRoleTargetActionHandlerService` и `DeleteAgentActionHandlerService`), что гарантирует сохранение `beforeTargets` для записи `roleTarget` (`delete`) в `crm_audit."crmAuditEntry"` независимо от порядка выполнения обработчиков и каскадного FK.
  - **Атомарность записи аудита:**
    Записи `roleTarget` (`delete` и/или `create`) формируются через `projectRoleTargetAuditFields` в `CrmAuditTransactionContext` с единым `operationId`, сбрасываются через `await audit.flush()`, после чего повторно проверяются инварианты состояния таблиц в той же транзакции.

### 1.3. Загрузка карт в `WorkspaceMigrationRunnerService.executeRun` (`workspace-migration-runner.service.ts:297-313, 408`)
- В `executeRun` список `actionsMetadataAndRelatedMetadataNames` строится через `getMetadataNamesToLoadForWorkspaceMigration(actionMetadataNames)`.
- В `ALL_METADATA_REQUIRED_METADATA_FOR_VALIDATION` (`all-metadata-required-metadata-for-validation.constant.ts:61-67`) задано:
  - `roleTarget: { role: true, agent: true }`;
  - `agent: { role: true }`.
- Следовательно, когда `actions` содержат действия `roleTarget` (как вместе с `agent`, так и без него), `allFlatEntityMapsKeys` гарантированно включает `flatRoleTargetMaps`, `flatRoleMaps` и `flatAgentMaps`, а объект `mappings` (`workspace-migration-runner.service.ts:403-408`) получает непустые словари `roles`, `targets` и `agents`.
- **Важный нюанс для `agentMode === 'create'`:** `cachedAllFlatEntityMaps` загружается на строке 308 **до** выполнения `CreateAgentActionHandlerService`, поэтому новый агент ещё отсутствует в `mappings.agents` на момент входа в `runAuditedRoleAssignment`. В `design.md` (раздел 2.2) это учтено верно: в режиме `create` связь `roleTarget` сверяется напрямую с действием `agent` (`create`) по `action.id === request.agentId` и `action.flatEntity.universalIdentifier === request.agentUniversalIdentifier`, а не через `mappings.agents`.

### 1.4. Соблюдение House Rules и границ `check_enterprise_dependencies.py`
- Все изменяемые файлы находятся в открытом контуре `packages/twenty-server/src/engine/` и `packages/twenty-server/src/modules/workflow/` и не импортируют `ee/` или модули с `@license Enterprise`.
- Использование `roleAuditIdentityFromRequest` из `src/engine/core-modules/crm-audit/role-update-audit` не тянет граф авторизации Enterprise.

---

## 2. Критические замечания и необходимые корректировки при реализации

### Замечание 1 (Блокер реализации): В `agentMode === 'update'` число действий `agent` (`update`) равно `0..1`, а не строго `1`, и порядок действий в миграции - `[roleTarget.delete, agent.update, roleTarget.create]`
- **Доказательство по коду:**
  1. В `fromUpdateAgentInputToFlatAgentToUpdate` (`from-update-agent-input-to-flat-agent-to-update.util.ts:125-143`) свойства агента выбираются по `FLAT_AGENT_EDITABLE_PROPERTIES` (`name`, `label`, `icon`, `description`, `prompt`, `modelId`, `responseFormat`, `modelConfiguration`, `triggers` - без `roleId`).
  2. Когда `AgentService.updateOneAgent` вызывается только для назначения, смены или снятия `roleId` (например, `{ id: agentId, roleId: newRoleId }` или `{ id: agentId, roleId: null }`, как в сценарии 2 `test-research.md`), `mergeUpdateInExistingRecord` возвращает `flatAgentToUpdate`, по всем сравниваемым полям идентичный `existingFlatAgent`.
  3. В `WorkspaceEntityMigrationBuilderService.validateAndBuild` (`workspace-entity-migration-builder.service.ts:108`) -> `flatEntityDeletedCreatedUpdatedMatrixDispatcher` (`universal-flat-entity-deleted-created-updated-matrix-dispatcher.util.ts:84-92`) -> `compareTwoFlatEntity` (`compare-two-universal-flat-entity.util.ts:38-45`) дифф по `agent` оказывается пустым (`flatEntityDifferences.length === 0`), и действие `agent` (`update`) **не генерируется** (`0` действий `agent`).
  4. Если же одновременно с `roleId` изменён, например, `label` или `prompt`, генерируется `1` действие `agent` (`update`). При этом в `computeOrderedMigrationActions` (`compute-ordered-migration-actions.util.ts:62-68`) порядок действий фиксирован:
     - сначала `roleTarget.delete` (строка 62),
     - затем `agent.update` (строка 66),
     - затем `roleTarget.create` (строка 68).
- **Что нужно исправить при реализации `role-assignment-audit.ts`:**
  - В ветке `agentMode === 'update'` разрешить `0..1` действие `agent` (`update`): `agentUpdates.length <= 1`, и если `agentUpdates.length === 1`, проверять `uuid(agentUpdates[0].universalIdentifier) === request.agentUniversalIdentifier` и отсутствие `action.id` / несовпадения владельца.
  - Проверку того, что `delete` предшествует `create`, выполнять по подмножеству действий `roleTarget` (`roleTargetActions = actions.filter((a) => a.metadataName === 'roleTarget')`), чтобы присутствие `agent.update` между `roleTarget.delete` и `roleTarget.create` не нарушало проверку порядка.
  - В `crm-audit-agent-service-role-targets.postgres-spec.ts` протестировать оба варианта `updateOneAgent`: (а) изменение только `roleId` (`0` действий `agent.update`) и (б) одновременное изменение `label`/`prompt` и `roleId` (`1` действие `agent.update`).

### Замечание 2 (Важно): Блокировка `core."roleTarget"` для всех удаляемых агентов в `agentMode === 'delete'`
- **Доказательство по коду:**
  В `AgentService.deleteManyAgents` (`agent.service.ts:299-315`) массив `agentsToDelete` может содержать $N$ агентов, из которых $M \le N$ имеют привязки в `flatRoleTargetByAgentIdMaps`.
- **Что нужно учесть при реализации `role-assignment-audit.ts`:**
  В `agentMode === 'delete'` запрос `readTargets()` (`SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND ("agentId"=ANY($2::uuid[]) OR id=ANY($3::uuid[])) ORDER BY id FOR UPDATE`) должен передавать в `$2` идентификаторы **всех удаляемых в миграции агентов** (`plannedAgentDeleteIds`), а не только `request.targets.map((t) => t.agentId)`. Тогда, если у любого из удаляемых агентов в БД окажется неучтённая строка `core."roleTarget"` (например, из-за гонки или устаревшего кэша), условие `beforeRows.length !== plannedTargetDeletes.length` немедленно прервёт и откатит транзакцию до того, как `ON DELETE CASCADE` удалит эту строку без аудита.

### Замечание 3 (Важно): Передача `applicationUniversalIdentifier` в `AgentService.updateOneAgent`
- **Доказательство по коду:**
  В `fromUpdateAgentInputToFlatAgentToUpdate` (`from-update-agent-input-to-flat-agent-to-update.util.ts:88-89`) создаваемый `flatRoleTargetToCreate` получает `applicationId: flatAgent.applicationId` и `applicationUniversalIdentifier: flatAgent.applicationUniversalIdentifier`. Однако в `AgentService.updateOneAgent` (`agent.service.ts:218-219`) в `validateBuildAndRunWorkspaceMigration` сейчас жёстко передаётся `workspaceCustomFlatApplication.universalIdentifier`.
- **Что нужно учесть при реализации `agent.service.ts`:**
  Аналогично исправлению в `createOneAgent` (`resolvedFlatApplication.universalIdentifier`), в `updateOneAgent` передавать `applicationUniversalIdentifier: flatAgentToUpdate.applicationUniversalIdentifier`, а в `deleteManyAgents` - уникальный `applicationUniversalIdentifier` удаляемых сущностей (с fallback на `workspaceCustomFlatApplication.universalIdentifier`, как в `RoleTargetService.createMany`). Это гарантирует совпадение `input.applicationUniversalIdentifier` и `mappings.application.universalIdentifier` в `runAuditedRoleAssignment` для агентов, принадлежащих приложениям.

### Замечание 4 (Средняя важность): Типизация `@Context()` в `AgentResolver` и обратная совместимость `agent-tools.spec.ts`
- В `design.md` (раздел 2.3) для `AgentResolver` указан тип `@Context() context: { req: CustomRequest }`. Типа `CustomRequest` в `twenty-server` нет; канонический паттерн репозитория (см. `role.resolver.ts:17, 154` и `api-key.resolver.ts:11, 113`) - `import { type Request } from 'express'` и `@Context() context: { req: Request }`.
- В `agent-tools.spec.ts` (`строки 46–58, 364–378, 409–412`) базовый тестовый `context: ToolProviderContext` не содержит `authContext`, а вызовы `agentService.updateOneAgent` и `agentService.deleteOneAgent` проверяются через `toHaveBeenCalledWith`. В `CreateAgentTool`, `UpdateAgentTool` и `DeleteAgentTool` следует передавать `auditIdentity` только при `isDefined(context.authContext)` (через условный spread для объектного аргумента в `updateOneAgent` и условный 3-й аргумент в `createOneAgent`/`deleteOneAgent`), а в `agent-tools.spec.ts` добавить отдельные проверки проброса `auditIdentity` при наличии `context.authContext`.
- Кроме того, проверены остальные места вызова `AgentService` в кодовой базе:
  - `update-workflow-agent.tool.ts:125` - обновляет только `prompt`/`modelId` (`roleId === undefined`), не мутирует `roleTarget`;
  - `dev-seeder-workflow-pending-input.workspace-service.ts:188` - создаёт системного workflow-агента без `roleId` (`roleId === undefined`), не мутирует `roleTarget`.
  Поскольку при `roleId === undefined` и отсутствии удаляемых `roleTarget` параметр `auditIdentity` остаётся опциональным, оба этих вызова сохраняют полную работоспособность.
