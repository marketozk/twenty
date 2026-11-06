# LOG161 — дизайн аудита удаления неиспользуемых агентских ролей (`deleteAgentOnlyRoleIfUnused`) и операций ролей агентов в шагах workflow

## 1. Контекст и постановка задачи

После `LOG111`–`LOG113` и `LOG156`–`LOG160` весь жизненный цикл ролей (`RoleService`), прав ролей (`RolePermissionFlagService`, `ObjectPermissionService`, `FieldPermissionService`, `RowLevelPermissionPredicateService`), одиночных и пакетных назначений ролей сотрудникам (`UserRoleService`) и API-ключам (`ApiKeyRoleService`, `ApiKeyService`, `RoleTargetService`) переведён на закрытый транзакционный аудит в `core` / `crm_audit`.

В `AiAgentRoleService` (`packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service.ts`) и `WorkflowVersionStepOperationsWorkspaceService` (`packages/twenty-server/src/modules/workflow/workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service.ts`) оставались две незакрытые точки:
1. **`AiAgentRoleService.assignRoleToAgent` (`ai-agent-role.service.ts:55-101`) и `WorkflowVersionStepOperationsWorkspaceService.createDraftStep` (`workflow-version-step-operations.workspace-service.ts:1131`)**:
   - В `LOG156` метод `assignRoleToAgent` сохранял резервную неаудируемую ветку (`const isAudited = Object.hasOwn(args, 'auditIdentity') || args.auditIdentity !== undefined; ... if (capturedIdentity) { ... } await executeCreate();`), поскольку `WorkflowVersionStepOperationsWorkspaceService.createDraftStep` при создании черновика шага `AI_AGENT` вызывал `this.aiAgentRoleService.assignRoleToAgent` без `auditIdentity`.
2. **`AiAgentRoleService.deleteAgentOnlyRoleIfUnused` (`ai-agent-role.service.ts:227-267`) и `WorkflowVersionStepOperationsWorkspaceService.runWorkflowVersionStepDeletionSideEffects` (`workflow-version-step-operations.workspace-service.ts:145`)**:
   - При удалении шага `AI_AGENT` в workflow вызывался `deleteAgentOnlyRoleIfUnused({ roleId, roleTargetId, workspaceId })`, который выполнял прямое удаление строки `await this.roleRepository.delete(workspaceId, { id: roleId })` без `auditIdentity`, без транзакционных блокировок `core.workspace`, `core.role` и `core."roleTarget"`, без защиты от конкурентного назначения роли другому агенту между `count()` и `delete()` и без записи события `role` (`delete`) в `crm_audit."crmAuditEntry"`.

Цель `LOG161` — сделать `AiAgentRoleService.assignRoleToAgent` и `AiAgentRoleService.deleteAgentOnlyRoleIfUnused` полностью fail-closed (с обязательной синхронной валидацией `auditIdentity` до первого `await`), перевести удаление неиспользуемой агентской роли на закрытую транзакционную функцию `runAuditedUnusedAgentRoleDelete` в `role-update-audit.ts` и подключить системные `auditIdentity` в `WorkflowVersionStepOperationsWorkspaceService`.

---

## 2. Рассмотренные варианты архитектуры

### Вариант A (рекомендуемый): закрытый исполнитель `runAuditedUnusedAgentRoleDelete` в `role-update-audit.ts` + безусловная валидация `auditIdentity` в `AiAgentRoleService`

1. **`role-update-audit.ts` (`runAuditedUnusedAgentRoleDelete`)**:
   - Принимает `dataSource: DataSource`, `{ workspaceId, roleId, roleTargetId }` и `identity: RoleUpdateAuditIdentity`.
   - Синхронно до первого `await`:
     - проверяет отсутствие конфликтующих аудит-контекстов (`getRoleMutationAudit(workspaceId)` и `hasConflictingMetadataAuditScope(workspaceId, getRoleMutationAudit)`);
     - нормализует и валидирует UUID `workspaceId`, `roleId`, `roleTargetId`;
     - захватывает `capturedIdentity = captureRoleAuditIdentity(identity)` и `requestOperation = captureRoleAuditOperation(normalizedWorkspaceId, capturedIdentity)`.
   - Внутри `runInCoreAuditTransaction(dataSource, async (runner) => ...)`:
     1. Устанавливает `SET LOCAL lock_timeout = '8s'`.
     2. Блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет существование воркспейса и `deletedAt === null`. Если `workspace.defaultRoleId` совпадает с `normalizedRoleId`, возвращает `false` (никогда не удаляет роль по умолчанию воркспейса).
     3. Блокирует строку `core.role` (`SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE`). Если роль отсутствует, возвращает `false` (идемпотентный no-op без ложного события аудита).
     4. Под блокировкой `FOR UPDATE` проверяет, что `beforeRole` действительно является кастомной редактируемой агентской ролью:
        - `beforeRole.isEditable === true`;
        - `universalIdentifier` не равен `MEMBER_ROLE_UNIVERSAL_IDENTIFIER`, `STANDARD_ROLE.admin.universalIdentifier` и `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()`;
        - `beforeRole.canBeAssignedToAgents === true`, `beforeRole.canBeAssignedToUsers === false`, `beforeRole.canBeAssignedToApiKeys === false`.
        Если хотя бы одно условие не выполнено, возвращает `false` без удаления и без записи аудита.
     5. Блокирует все строки `core."roleTarget"` для `normalizedRoleId` (`SELECT to_jsonb(t) AS row FROM core."roleTarget" t WHERE "workspaceId"=$1 AND "roleId"=$2 ORDER BY id FOR UPDATE`):
        - если найдена хотя бы одна строка с `id !== normalizedRoleTargetId` (роль параллельно назначена другому агенту/ключу/участнику), возвращает `false` (роль используется — удаление отменяется);
        - если осталась строка `residualTarget` с `id === normalizedRoleTargetId` (например, когда вызывающий код ещё не удалил `roleTargetId`), проверяет `residualTarget.agentId !== null && residualTarget.userWorkspaceId === null && residualTarget.apiKeyId === null`, явно удаляет её (`DELETE FROM core."roleTarget" WHERE id=$1 AND "workspaceId"=$2`) и записывает событие `roleTarget` (`delete`) в `CrmAuditTransactionContext` до удаления `core.role` (исключая неаудируемый `ON DELETE CASCADE`).
     6. Разрешает `operation = await resolveRoleAuditInitiator(...)`, создаёт `CrmAuditTransactionContext`, выполняет `DELETE FROM core.role WHERE id=$1 AND "workspaceId"=$2`, проверяет отсутствие удалённых строк в `core.role` и `core."roleTarget"`, записывает событие `role` (`delete`, `before: projectRole(beforeRole)`, `after: null`), вызывает `await audit.flush()` и повторно проверяет отсутствие строк после `audit.flush()`. Возвращает `true`.
2. **`AiAgentRoleService` (`ai-agent-role.service.ts`)**:
   - В `assignRoleToAgent`:
     - убрать резервную неаудируемую ветку;
     - синхронно до первого `await` проверять отсутствие конфликтующих аудит-контекстов (`getRoleMutationAudit` / `hasConflictingMetadataAuditScope`), валидировать `capturedIdentity = captureRoleAuditIdentity(args.auditIdentity as RoleUpdateAuditIdentity)` и `captureRoleAuditOperation(capturedWorkspaceId, capturedIdentity)`;
     - всегда выполнять `this.roleTargetService.create(...)` внутри `withAgentRoleAssignmentAudit`.
   - В `deleteAgentOnlyRoleIfUnused`:
     - добавить параметр `auditIdentity?: RoleUpdateAuditIdentity` и опциональную инъекцию `@Optional() @InjectDataSource() private readonly coreDataSource?: DataSource`;
     - синхронно до первого `await` проверять отсутствие конфликтующих аудит-контекстов, валидировать UUID `workspaceId`, `roleId`, `roleTargetId` и валидировать `capturedIdentity = captureRoleAuditIdentity(auditIdentity as RoleUpdateAuditIdentity)` + `captureRoleAuditOperation(capturedWorkspaceId, capturedIdentity)`;
     - выполнять предпроверку через `roleRepository.findOne` и `roleTargetRepository.count` (быстрый выход для `Member`/shared ролей), а при прохождении предпроверки вызывать `runAuditedUnusedAgentRoleDelete(this.coreDataSource!, { workspaceId: capturedWorkspaceId, roleId: capturedRoleId, roleTargetId: capturedRoleTargetId }, capturedIdentity)` и инвалидировать кэш (`flatRoleMaps`, `flatRolePermissionFlagMaps`, `rolesPermissions`) после коммита (и в `finally` при `NativeTransactionOutcomeUnknownError`).
3. **`WorkflowVersionStepOperationsWorkspaceService` (`workflow-version-step-operations.workspace-service.ts`)**:
   - В `runWorkflowVersionStepDeletionSideEffects` (строка `145`): передавать `auditIdentity: { auth: { workspace: { id: workspaceId }, type: 'system' }, systemActorId: 'workflow-version-step:delete-agent-step' }`.
   - В `createDraftStep` (строка `1131`): передавать `auditIdentity: { auth: { workspace: { id: workspaceId }, type: 'system' }, systemActorId: 'workflow-version-step:clone-agent-step' }`.

### Вариант B: перевод `deleteAgentOnlyRoleIfUnused` на `RoleService.deleteRole`

- **Описание**: вызывать `RoleService.deleteRole` из `AiAgentRoleService.deleteAgentOnlyRoleIfUnused`.
- **Минусы**:
  - `RoleService.deleteRole` требует наличия `workspace.defaultRoleId` и перепривязывает активные `roleTarget` к `defaultRoleId`, тогда как `deleteAgentOnlyRoleIfUnused` должен быть условным no-op при наличии других привязок (`remainingAssignments > 0`) и не должен выбрасывать ошибку, если роль оказалась общей или уже удалена параллельно.
  - Кроме того, `RoleService` уже зависит от `ApiKeyRoleService`, а `AiAgentRoleModule` не импортирует `RoleModule` (риск циклической зависимости модулей).
- **Вердикт**: отклонён в пользу Варианта A.

---

## 3. Затронутые файлы

1. `packages/twenty-server/src/engine/core-modules/crm-audit/role-update-audit.ts`
2. `packages/twenty-server/src/engine/metadata-modules/ai/ai-agent-role/ai-agent-role.service.ts`
3. `packages/twenty-server/src/modules/workflow/workflow-builder/workflow-version-step/workflow-version-step-operations.workspace-service.ts`
4. `packages/twenty-server/test/integration/metadata/suites/role/failing-delete-member-role.integration-spec.ts`
5. `packages/twenty-server/test/fork-migration/crm-audit-role-delete-and-targets.postgres-spec.ts`
6. `packages/twenty-server/test/fork-migration/crm-audit-agent-role-lifecycle.postgres-spec.ts` (новый интеграционный PostgreSQL-набор)
