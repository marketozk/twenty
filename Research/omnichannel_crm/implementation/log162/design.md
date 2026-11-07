# LOG162 - дизайн аудита встроенных мутаций `roleTarget` в `AgentService` (`createOneAgent`, `updateOneAgent`, `deleteOneAgent`, `deleteManyAgents`)

## 1. Контекст и постановка задачи

После `LOG111`–`LOG113` и `LOG156`–`LOG161` все прямые сервисы управления ролями и привязками `roleTarget` (`RoleService`, `UserRoleService`, `AiAgentRoleService`, `ApiKeyRoleService`, `ApiKeyService`, `RoleTargetService`, `RolePermissionFlagService`, `ObjectPermissionService`, `FieldPermissionService`, `RowLevelPermissionPredicateService`) переведены на закрытый транзакционный CRM-аудит.

Единственным сервисом, способным создавать, заменять или удалять строки `core."roleTarget"` в обход `runAuditedRoleAssignment`, оставался `AgentService` (`packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/agent.service.ts:82-350`):
1. **`AgentService.createOneAgent` (`agent.service.ts:82-160`)**:
   - Когда во входном `CreateAgentInput` передан `roleId`, `fromCreateAgentInputToFlatAgent` формирует одновременно `flatAgentToCreate` и `flatRoleTargetToCreate`, а `validateBuildAndRunWorkspaceMigration` выполняет создание `agent` и `roleTarget` без `withRoleAssignmentAudit` и без записи `roleTarget` (`create`) в `crm_audit."crmAuditEntry"`.
2. **`AgentService.updateOneAgent` (`agent.service.ts:162-250`) и `fromUpdateAgentInputToFlatAgentToUpdate` (`from-update-agent-input-to-flat-agent-to-update.util.ts:30-92`)**:
   - При передаче `input.roleId`:
     - если `input.roleId === null` и у агента была роль, возвращается `flatRoleTargetToDelete`;
     - если у агента не было роли и передан `roleId`, возвращается `flatRoleTargetToCreate`;
     - если у агента уже была роль, `computeAgentFlatRoleTargetToUpdate` возвращал `flatRoleTargetToUpdate` (даже когда новый `roleId` совпадал с текущим `existingRoleTarget.roleId`!), вместо канонической модели `delete` + `create` (`ADMINISTRATIVE_ACTIONS.roleTarget = ['create', 'delete']`) и пропуска no-op при совпадении `roleId`.
   - При этом `validateBuildAndRunWorkspaceMigration` выполнялся без транзакционного аудита `roleTarget`.
3. **`AgentService.deleteOneAgent` / `deleteManyAgents` (`agent.service.ts:252-350`)**:
   - При удалении агентов, имеющих привязки в `flatRoleTargetByAgentIdMaps`, формируется `roleTargetsToDelete` и запускается `validateBuildAndRunWorkspaceMigration` (`{ agent: { flatEntityToDelete: agentsToDelete }, roleTarget: { flatEntityToDelete: roleTargetsToDelete } }`) без записи `roleTarget` (`delete`) в `crm_audit."crmAuditEntry"`.
4. **Точки входа (`AgentResolver`, `CreateAgentTool`, `UpdateAgentTool`, `DeleteAgentTool`, `WorkflowVersionStepOperationsWorkspaceService`)**:
   - Не передавали `auditIdentity` в методы `AgentService`.

Цель `LOG162` - перевести все встроенные мутации `roleTarget` в `AgentService` (`createOneAgent`, `updateOneAgent`, `deleteOneAgent`, `deleteManyAgents`) на закрытый однотранзакционный аудит через `withAgentMetadataRoleTargetAudit` в `role-assignment-audit.ts`, нормализовать замену роли в `fromUpdateAgentInputToFlatAgentToUpdate` на `delete` + `create` (с no-op при совпадении `roleId`) и подключить передачу `auditIdentity` во всех точках входа.

---

## 2. Архитектура решения

### 2.1. Нормализация `computeAgentFlatRoleTargetToUpdate` (`from-update-agent-input-to-flat-agent-to-update.util.ts`)

1. Если `roleId === undefined`: возвращается `{}` (привязка `roleTarget` не изменяется).
2. Если `roleId === null`:
   - при наличии `existingRoleTarget` возвращается `{ flatRoleTargetToDelete: existingRoleTarget }`;
   - при отсутствии `existingRoleTarget` возвращается `{}` (no-op).
3. Если `roleId` - строка UUID:
   - если `isDefined(existingRoleTarget) && existingRoleTarget.roleId === roleId` (без учёта регистра), возвращается `{}` (идемпотентный no-op без лишней перезаписи `roleTarget`);
   - если `isDefined(existingRoleTarget) && existingRoleTarget.roleId !== roleId`, возвращается пара `{ flatRoleTargetToDelete: existingRoleTarget, flatRoleTargetToCreate: newFlatRoleTarget }` (с новым `id` и `universalIdentifier` под приложением миграции `roleTargetApplication`, полностью согласованно с `fromCreateRoleTargetInputToFlatRoleTargetToCreate` и `ADMINISTRATIVE_ACTIONS.roleTarget = ['create', 'delete']`);
   - если `!isDefined(existingRoleTarget)`, возвращается `{ flatRoleTargetToCreate: newFlatRoleTarget }`.

### 2.2. Расширение `role-assignment-audit.ts` (`targetKind: 'agentMetadata'` и `withAgentMetadataRoleTargetAudit`)

1. Добавить в `role-assignment-audit.ts` вариант `AgentMetadataAssignment` (`targetKind: 'agentMetadata'`):
   - `agentMode: 'create'`: `{ workspaceId, agentId, agentUniversalIdentifier, roleId }` - создание нового агента одновременно с привязкой `roleTarget` (`create`);
   - `agentMode: 'update'`: `{ workspaceId, agentId, agentUniversalIdentifier, roleId: string | null, expectedDeletedRoleTargetId: string | null }` - обновление агента с созданием, заменой (`delete` + `create`) или удалением (`delete`) его `roleTarget`;
   - `agentMode: 'delete'`: `{ workspaceId, targets: readonly { agentId: string; roleTargetId: string }[] }` - удаление одного или нескольких агентов вместе с их привязками `roleTarget` (`delete`).
2. В `runAuditedRoleAssignment` добавить ветку `if (request.targetKind === 'agentMetadata')`:
   - Проверяет, что все действия миграции принадлежат только `metadataName === 'agent'` или `metadataName === 'roleTarget'`, и отсутствуют `roleTarget` действия с `type === 'update'`.
   - Для `agentMode === 'create'`:
     - ровно 1 действие `agent` (`create`, `id === request.agentId`, `universalIdentifier === request.agentUniversalIdentifier`) и 1 действие `roleTarget` (`create`, `agentUniversalIdentifier === request.agentUniversalIdentifier`, `mappedRoleId === request.roleId`, `userWorkspaceId === null`, `apiKeyId === null`);
     - внутри `runInCoreAuditTransaction`: блокирует `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), проверяет отсутствие существующего `core.agent` и `core."roleTarget"`, блокирует `core.role` (`FOR SHARE`, проверяет `canBeAssignedToAgents === true`), выполняет `work(runner)`, проверяет созданную строку `core.agent` и созданную строку `core."roleTarget"` (все скалярные поля + микросекундные `createdAt`/`updatedAt`), записывает `roleTarget` (`create`) в `CrmAuditTransactionContext`, вызывает `await audit.flush()` и повторно сверяет состояние после `audit.flush()`.
   - Для `agentMode === 'update'`:
     - `0..1` действие `agent` (`update`, `universalIdentifier === request.agentUniversalIdentifier`; при изменении только `roleId` дифф по `agent` пуст и действия нет, а при одновременном изменении полей агента порядок миграции `[roleTarget.delete, agent.update, roleTarget.create]`), `0..1` действие `roleTarget` (`delete`) и `0..1` действие `roleTarget` (`create`), причём `targetDeletes.length + targetCreates.length >= 1` и среди действий `roleTarget` `delete` предшествует `create`;
     - внутри `runInCoreAuditTransaction`: блокирует `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), `core.agent` (`FOR SHARE`, `deletedAt === null`), текущую строку `core."roleTarget"` (`FOR UPDATE`, сверяет с `expectedDeletedRoleTargetId`) и `core.role` (`FOR SHARE`, проверяет `canBeAssignedToAgents === true` для целевой роли и наличие исходной роли), выполняет `work(runner)`, проверяет итоговое состояние `core."roleTarget"` (отсутствие удалённого `id`, точное совпадение новой строки и микросекундных меток времени при `roleId !== null`), записывает `delete` и/или `create` `roleTarget` с единым `operationId`, вызывает `await audit.flush()` и повторно сверяет состояние после `audit.flush()`.
   - Для `agentMode === 'delete'`:
     - $N \ge 1$ действий `agent` (`delete`) и $M = \text{request.targets.length} \ge 0$ действий `roleTarget` (`delete`), биективно сопоставленных с `request.targets`; пустой `targets` допустим, потому что удаление агента каскадно удалит любую привязку, которой нет в плане;
     - внутри `runInCoreAuditTransaction`: блокирует `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), удаляемые строки `core.agent` (`FOR UPDATE`: конфликтует с `KEY SHARE`, который берёт FK при вставке `roleTarget`, поэтому новая привязка не может появиться между проверкой и каскадом), все строки `core."roleTarget"` всех удаляемых в миграции агентов (`"agentId"=ANY($2) OR id=ANY($3) ... FOR UPDATE`, проверяет точное совпадение с `request.targets` до выполнения `DeleteAgentActionHandlerService` / `DeleteRoleTargetActionHandlerService`, чтобы ни каскадный FK `ON DELETE CASCADE` на `core."roleTarget"."agentId"`, ни неучтённая привязка любого удаляемого агента не привели к потере `before`-образа) и исходные роли `core.role` (`FOR SHARE`), выполняет `work(runner)`, проверяет полное отсутствие удалённых `core.agent` и `core."roleTarget"`, записывает события `roleTarget` (`delete`) с общим `operationId`, вызывает `await audit.flush()` и повторно проверяет отсутствие удалённых строк после `audit.flush()`.

### 2.3. Подключение `AgentService` и точек вызова

1. **`AgentService` (`agent.service.ts`)**:
   - Во всех мутационных методах (`createOneAgent`, `updateOneAgent`, `deleteOneAgent`, `deleteManyAgents`) принимать `auditIdentity?: RoleUpdateAuditIdentity`:
     - синхронно до первого `await` проверять отсутствие конфликтующих аудит-контекстов (`'Nested role assignment audit unsupported'`) и снимать `auditIdentity` (`captureRoleAuditIdentity` + `captureRoleAuditOperation`); ошибка снятия запоминается и предъявляется до первого `await`, если запрошен `roleId` (`isDefined(input.roleId)` в `createOneAgent`, `input.roleId !== undefined` в `updateOneAgent`), и при любом непустом `ids` в `deleteManyAgents`: удаление агента каскадно удаляет его привязку, а снимок кэша может её не видеть. Создание и правки агента без смены роли остаются доступны вызывающим, которые не могут писать аудит (например, `pendingActivationUser`); удаление - нет;
     - отсутствующий `auditIdentity` при мутации `roleTarget` и при удалении агента отклоняется с `'Role mutation requires authenticated audit identity'`;
     - когда миграция включает создание или удаление `roleTarget` (`isDefined(flatRoleTargetToCreate)` в `createOneAgent`, `isDefined(flatRoleTargetToCreate) || isDefined(flatRoleTargetToDelete)` в `updateOneAgent`) и при любом удалении агентов (`deleteManyAgents`, в том числе без привязок в кэше), оборачивать `validateBuildAndRunWorkspaceMigration` в `withAgentMetadataRoleTargetAudit(...)`.
   - `applicationUniversalIdentifier` миграции остаётся приложением рабочего пространства (`workspaceCustomFlatApplication`), как до изменения. Рекомендация 3 ревью дизайна (передавать приложение агента) отклонена: `FlatAgentValidatorService` запрещает менять и удалять стандартных агентов, если вызывающее приложение не стандартное (`isCallerTwentyStandardApp`), а `validateAgentTriggersCallerApplication` разрешает менять триггеры только приложению агента. Подстановка приложения агента обходила бы оба запрета. Обработчики `create` записывают `applicationId` приложения миграции, поэтому новая привязка при смене роли планируется под приложением миграции (`roleTargetApplication`), как в `RoleTargetService`. Аудит сверяет `applicationId` новых строк с приложением миграции; в режиме `update` с ним же сверяется и универсальное приложение плана `roleTarget`, в режиме `create` - с приложением создаваемого агента (тоже приложение рабочего пространства: `input.applicationId` скрыт `@HideField`).
2. **Точки вызова**:
   - `AgentResolver` (`packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/agent.resolver.ts`): в `createOneAgent`, `updateOneAgent` и `deleteOneAgent` принимать `@Context() context: { req: Request }` (`express`) и передавать `auditIdentity: roleAuditIdentityFromRequest(context.req)`.
   - `CreateAgentTool`, `UpdateAgentTool`, `DeleteAgentTool` (`packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/tools/`): передавать `{ auth: context.authContext, agentId: context.agentId }` только при наличии `context.authContext` (проверка `isUndefined` из `@sniptt/guards` в create/delete, чтобы не добавлять рёбер к `twenty-shared/utils`, которые запрещает `check_enterprise_dependencies.py`).
   - `WorkflowVersionStepOperationsWorkspaceService` (`workflow-version-step-operations.workspace-service.ts:139, 566, 1183`): передавать системный `auditIdentity` в `deleteManyAgents` (`workflow-version-step:delete-agent-step`) и `createOneAgent` (`workflow-version-step:create-agent-step`, `workflow-version-step:duplicate-agent`).

---

## 3. Затронутые файлы

1. `packages/twenty-server/src/engine/core-modules/crm-audit/role-assignment-audit.ts`
2. `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/utils/from-update-agent-input-to-flat-agent-to-update.util.ts`
3. `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/agent.service.ts`
4. `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/agent.resolver.ts`
5. `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/tools/create-agent.tool.ts`
6. `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/tools/update-agent.tool.ts`
7. `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent/tools/delete-agent.tool.ts`
8. `packages/twenty-server/src/modules/workflow/workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service.ts`
9. `packages/twenty-server/test/fork-migration/crm-audit-agent-service-role-targets.postgres-spec.ts` (новый интеграционный PostgreSQL-набор)
