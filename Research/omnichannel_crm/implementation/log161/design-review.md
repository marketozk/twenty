# LOG161 — независимое критическое ревью дизайна и плана тестирования

## Вердикт

Дизайн (`design.md`) и план проверок (`test-research.md`) для `LOG161` («Audited unused agent-only role deletion and workflow agent-step role operations in AiAgentRoleService, WorkflowVersionStepOperationsWorkspaceService, and role-update-audit.ts») архитектурно согласованы с закрытыми в `LOG111`–`LOG113` и `LOG156`–`LOG160` контурами транзакционного CRM-аудита и **одобрены к реализации** с обязательным учётом уточнений ниже (в частности, по точному имени метода `createDraftStep` на строке `1131` в `WorkflowVersionStepOperationsWorkspaceService` и обновлению интеграционного теста `failing-delete-member-role.integration-spec.ts`).

---

## 1. Проверка fail-closed поведения `AiAgentRoleService.assignRoleToAgent` до первого `await`

### Статус проверки: ПОДТВЕРЖДЕНО (с уточнением метода в `WorkflowVersionStepOperationsWorkspaceService`)

1. **Удаление резервной неаудируемой ветки в `AiAgentRoleService.assignRoleToAgent` (`packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service.ts:55-101`)**:
   - В текущем коде (`ai-agent-role.service.ts:62-69, 91-100`) при отсутствии ключа `auditIdentity` во входном объекте (`assignRoleToAgent({ workspaceId, agentId, roleId })`) проверка `captureRoleAuditIdentity` пропускалась, а `this.roleTargetService.create(...)` выполнялся напрямую без `withAgentRoleAssignmentAudit`.
   - После удаления резервной ветки каждый вызов `assignRoleToAgent` обязан синхронно до первого `await` (`await this.validateAssignRoleInput(...)`):
     1. Захватить скалярные поля `const capturedWorkspaceId = args.workspaceId; const capturedAgentId = args.agentId; const capturedRoleId = args.roleId;` (защита от мутации объекта `args` после старта промиса).
     2. Проверить отсутствие активного или конфликтующего аудит-контекста:
        ```ts
        if (
          getRoleMutationAudit(capturedWorkspaceId) ||
          hasConflictingMetadataAuditScope(
            capturedWorkspaceId,
            getRoleMutationAudit,
          )
        ) {
          throw new Error('Nested role assignment audit unsupported');
        }
        ```
        Поскольку `getRoleMutationAudit`, `getRoleAssignmentAudit`, `getRolePermissionAudit` и `getApiKeyCreateAudit` зарегистрированы через `registerMetadataAuditScopeCheck`, эта синхронная проверка гарантирует отказ при вложенном или чужом аудит-контексте даже в случае, если далее `validateAssignRoleInput` вернёт `roleToAssignIsSameAsCurrentRole: true` (ранний выход без входа в `withAgentRoleAssignmentAudit`).
     3. Валидировать UUID `capturedWorkspaceId`, `capturedAgentId`, `capturedRoleId` (через `isUUID`), чтобы вызовы с невалидными идентификаторами отклонялись до обращения к `agentRepository` / `roleRepository`.
     4. Захватить `const capturedIdentity = captureRoleAuditIdentity(args.auditIdentity as RoleUpdateAuditIdentity)` и выполнить `captureRoleAuditOperation(capturedWorkspaceId, capturedIdentity)`.
     5. При `validationResult?.roleToAssignIsSameAsCurrentRole !== true` безусловно вызывать `withAgentRoleAssignmentAudit({ workspaceId: capturedWorkspaceId, agentId: capturedAgentId, roleId: capturedRoleId }, capturedIdentity, executeCreate)`.

2. **Критическое уточнение к `design.md` (строки 8–9, 51) и `test-research.md` (строки 23–24) по `WorkflowVersionStepOperationsWorkspaceService`**:
   - В `design.md:8-9, 51` и `test-research.md:23-24` указана строка `workflow-version-step-operations.workspace-service.ts:1131`, но метод назван `cloneStep`.
   - Фактически в `packages/twenty-server/src/modules/workflow/workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service.ts`:
     - метод `cloneStep` находится на строках `893-985` и вызывает только `this.duplicateAgent(...)` (без вызова `assignRoleToAgent`);
     - вызов `await this.aiAgentRoleService.assignRoleToAgent({ agentId: newAgent.id, roleId, workspaceId })` на строке `1131` находится внутри метода **`createDraftStep`** (`строки 1086-1153`).
   - **Требование к реализации и тестам**:
     - Передавать `auditIdentity: { auth: { workspace: { id: workspaceId }, type: 'system' }, systemActorId: 'workflow-version-step:clone-agent-step' }` именно в вызов `this.aiAgentRoleService.assignRoleToAgent` внутри `createDraftStep` (`workflow-version-step-operations.workspace-service.ts:1131`).
     - В интеграционном сценарии 8 (`crm-audit-agent-role-lifecycle.postgres-spec.ts`) вызывать `workflowVersionStepOperationsWorkspaceService.createDraftStep(...)` для проверки аудируемого назначения роли клонированному агенту черновика шага.

3. **Полнота охвата всех точек вызова `assignRoleToAgent`**:
   - В кодовой базе `twenty-server` существуют ровно два продуктовых вызова `AiAgentRoleService.assignRoleToAgent`:
     1. `RoleResolver.assignRoleToAgent` (`packages/twenty-server/src/engine/metadata-modules/role/role.resolver.ts:471`) — уже передаёт `auditIdentity: roleAuditIdentityFromRequest(context.req)`.
     2. `WorkflowVersionStepOperationsWorkspaceService.createDraftStep` (`workflow-version-step-operations.workspace-service.ts:1131`) — переводится на системный `auditIdentity` в рамках `LOG161`.

---

## 2. Проверка транзакционных блокировок, защитных инвариантов и аудита в `runAuditedUnusedAgentRoleDelete`

### Статус проверки: ПОДТВЕРЖДЕНО (с рекомендацией по проверке `residualTarget`)

1. **Синхронная предпроверка до первого `await`**:
   - В `runAuditedUnusedAgentRoleDelete` (`packages/twenty-server/src/engine/core-modules/crm-audit/role-update-audit.ts`) до входа в `runInCoreAuditTransaction` синхронно выполняются:
     - валидация `normalizedWorkspaceId = uuid(input.workspaceId)`, `normalizedRoleId = uuid(input.roleId)`, `normalizedRoleTargetId = uuid(input.roleTargetId)`;
     - проверка отсутствия активных/конфликтующих аудит-контекстов (`getRoleMutationAudit(normalizedWorkspaceId) || hasConflictingMetadataAuditScope(normalizedWorkspaceId, getRoleMutationAudit)`);
     - захват `capturedIdentity = captureRoleAuditIdentity(identity)` и `requestOperation = captureRoleAuditOperation(normalizedWorkspaceId, capturedIdentity)`.

2. **Транзакционные блокировки и проверки внутри `runInCoreAuditTransaction`**:
   - Устанавливается `SET LOCAL lock_timeout = '8s'`.
   - **Блокировка `core.workspace` (`FOR NO KEY UPDATE`)**:
     - Проверяется наличие строки воркспейса и `workspace.deletedAt === null` (иначе выбрасывается ошибка `'Role delete audit workspace unavailable'`).
     - Если `typeof workspace.defaultRoleId === 'string' && isUUID(workspace.defaultRoleId) && uuid(workspace.defaultRoleId) === normalizedRoleId`, функция возвращает `false` (роль по умолчанию воркспейса никогда не удаляется). При этом если `workspace.defaultRoleId === null`, функция корректно продолжает проверку роли, так как перепривязка `roleTarget` к `defaultRoleId` для неиспользуемой агентской роли не требуется.
   - **Блокировка `core.role` (`FOR UPDATE`)**:
     - Выполняется `SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE`.
     - Если строка не найдена (`roleRows.length !== 1`), возвращается `false` без ошибки и без ложной записи аудита.
     - Под блокировкой `FOR UPDATE` проверяется, что роль является кастомной, редактируемой и эксклюзивно агентской:
       - `beforeRole.isEditable === true`;
       - `universalIdentifier` валиден и не равен `MEMBER_ROLE_UNIVERSAL_IDENTIFIER`, `STANDARD_ROLE.admin.universalIdentifier` и `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()`;
       - `beforeRole.canBeAssignedToAgents === true`, `beforeRole.canBeAssignedToUsers === false`, `beforeRole.canBeAssignedToApiKeys === false`.
       Если хотя бы одно условие нарушено, возвращается `false` (безопасный no-op).
   - **Блокировка `core."roleTarget"` (`FOR UPDATE`) и защита от конкурентного назначения роли**:
     - Выполняется `SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND "roleId"=$2 ORDER BY id FOR UPDATE`.
     - Если обнаружена хотя бы одна строка с `uuid(String(row.id)) !== normalizedRoleTargetId` (например, параллельная транзакция назначила эту роль другому агенту после `roleTargetRepository.count()`, но до захвата `FOR UPDATE`), функция немедленно возвращает `false` без удаления роли и без записи аудита.
   - **Явное удаление и аудит остаточного `roleTargetId` до `DELETE FROM core.role`**:
     - Если в `targetRows` присутствует строка `residualTarget` с `uuid(String(row.id)) === normalizedRoleTargetId`, необходимо проверить, что эта привязка действительно является агентской:
       ```ts
       if (
         typeof residualTarget.agentId !== 'string' ||
         !isUUID(residualTarget.agentId) ||
         residualTarget.userWorkspaceId !== null ||
         residualTarget.apiKeyId !== null
       ) {
         throw new Error(
           'Unused agent role delete target is not an agent binding',
         );
       }
       ```
     - Затем до удаления `core.role` выполняется явный `DELETE FROM core."roleTarget" WHERE id=$1 AND "workspaceId"=$2 AND "roleId"=$3` и записывается событие `roleTarget` (`delete`, `before: projectRoleTargetAuditFields(residualTarget)`, `after: null`), что полностью исключает скрытое удаление привязки через `ON DELETE CASCADE` на внешнем ключе `core."roleTarget"."roleId"`.
   - **Удаление `core.role`, запись события `role` (`delete`) и пост-проверка после `audit.flush()`**:
     - Выполняется `DELETE FROM core.role WHERE id=$1 AND "workspaceId"=$2`.
     - До и после `await audit.flush()` проверяется отсутствие удалённой роли в `core.role` и отсутствие любых строк в `core."roleTarget"` с `"roleId" = normalizedRoleId` или `id = normalizedRoleTargetId`.
     - В `CrmAuditTransactionContext` записывается событие `role` (`delete`, `before: projectRole(beforeRole)`, `after: null`, `securityDescriptor: { resourceKind: 'role', resourceId: normalizedRoleId, metadataAccess: 'currentWorkspaceAdministration' }`). При наличии `residualTarget` оба события (`roleTarget` `delete` и `role` `delete`) получают единый `operationId`.

---

## 3. Проверка инвалидации кэша в `deleteAgentOnlyRoleIfUnused` и обновления `failing-delete-member-role.integration-spec.ts`

### Статус проверки: ПОДТВЕРЖДЕНО

1. **Инвалидация `['flatRoleMaps', 'flatRolePermissionFlagMaps', 'rolesPermissions']` после коммита и при `NativeTransactionOutcomeUnknownError`**:
   - В исходном коде `AiAgentRoleService.deleteAgentOnlyRoleIfUnused` (`ai-agent-role.service.ts:262-265`) инвалидировались только `['flatRoleMaps', 'flatRolePermissionFlagMaps']` без `'rolesPermissions'`, и не обрабатывался случай потери подтверждения `COMMIT` (`NativeTransactionOutcomeUnknownError`).
   - В `LOG161` при вызове `runAuditedUnusedAgentRoleDelete`:
     - если `runAuditedUnusedAgentRoleDelete` возвращает `true` (роль реально удалена), устанавливается `shouldInvalidateCache = true`;
     - если `runAuditedUnusedAgentRoleDelete` возвращает `false` (no-op), `shouldInvalidateCache` остаётся `false`, и кэш не пересчитывается вхолостую;
     - если `runAuditedUnusedAgentRoleDelete` выбрасывает `NativeTransactionOutcomeUnknownError` (исход `COMMIT` неизвестен, транзакция могла зафиксироваться в БД), в `catch` устанавливается `shouldInvalidateCache = true` перед пробросом ошибки;
     - если транзакция откатилась до коммита (обычная ошибка), `shouldInvalidateCache` остаётся `false`;
     - в блоке `finally` при `shouldInvalidateCache === true` вызывается:
       ```ts
       await this.workspaceCacheService.invalidateAndRecompute(
         capturedWorkspaceId,
         ['flatRoleMaps', 'flatRolePermissionFlagMaps', 'rolesPermissions'],
       );
       ```
   - Это полностью согласуется с поведением `WorkspaceMigrationRunnerService.invalidateCache` (`workspace-migration-runner.service.ts:93-130, 527-541`).

2. **Обновление `packages/twenty-server/test/integration/metadata/suites/role/failing-delete-member-role.integration-spec.ts`**:
   - На строках `155-161` этого файла вызывается `deleteAgentOnlyRoleIfUnused` без `auditIdentity`:
     ```ts
     await getAppProviderByClassName<AiAgentRoleService>(
       'AiAgentRoleService',
     ).deleteAgentOnlyRoleIfUnused({
       roleId: agentOnlyMemberRoleId,
       roleTargetId: agentRoleTargetId,
       workspaceId: SEED_APPLE_WORKSPACE_ID,
     });
     ```
   - Поскольку `deleteAgentOnlyRoleIfUnused` становится fail-closed до первого `await`, вызов без `auditIdentity` выбросит `'Role mutation requires authenticated audit identity'` до проверки `MEMBER_ROLE_UNIVERSAL_IDENTIFIER`.
   - В `failing-delete-member-role.integration-spec.ts:157` необходимо передать валидный системный `auditIdentity`:
     ```ts
     auditIdentity: {
       auth: { workspace: { id: SEED_APPLE_WORKSPACE_ID }, type: 'system' },
       systemActorId: 'workflow-version-step:delete-agent-step',
     },
     ```

---

## 4. Проверка соблюдения правил репозитория (`CLAUDE.md`) и границ `check_enterprise_dependencies.py`

### Статус проверки: ПОДТВЕРЖДЕНО

1. **Границы Enterprise-зависимостей (`scripts/omnichannel/check_enterprise_dependencies.py`)**:
   - Все изменяемые файлы (`role-update-audit.ts`, `ai-agent-role.service.ts`, `workflow-version-step-operations.workspace-service.ts`) находятся в открытом контуре `packages/twenty-server/src/`.
   - В `role-update-audit.ts` константы `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER` и `STANDARD_ROLE` уже импортированы в `LOG160`; новых импортов не требуется.
   - В `ai-agent-role.service.ts` добавляются только `@Optional()` (`@nestjs/common`), `@InjectDataSource()` (`@nestjs/typeorm`), `DataSource` (`typeorm`), `isUUID` (`class-validator`), `NativeTransactionOutcomeUnknownError` и экспорты из `src/engine/core-modules/crm-audit/role-update-audit`. Ни один из этих импортов не ведёт к `@license Enterprise` файлам и не создаёт непрозрачных DI/динамических токенов в `check_enterprise_dependencies.py`.
2. **Соблюдение `CLAUDE.md` (house rules)**:
   - Использовать только именованные экспорты (`export const runAuditedUnusedAgentRoleDelete`), типы вместо интерфейсов, строгую типизацию без `any`, полные имена переменных без аббревиатур и краткие `//` комментарии (не более 5 строк, только про неочевидное WHY, без JSDoc `/** ... */`).
