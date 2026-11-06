# LOG161 — Независимое критическое ревью кода и безопасности

## Вердикт

Реализация `LOG161` («Audited unused agent-only role deletion and workflow agent-step role operations in AiAgentRoleService, WorkflowVersionStepOperationsWorkspaceService, and role-update-audit.ts») полностью соответствует утверждённому дизайну (`design.md`, `design-review.md`) и тестовому плану (`test-research.md`). Блокеров, уязвимостей обхода транзакционного CRM-аудита, гонок при удалении агентских ролей и нарушений архитектурных или проектных правил не обнаружено. **Изменения одобрены.**

---

## 1. Проверка fail-closed поведения `AiAgentRoleService.assignRoleToAgent` до первого `await`

- **Файлы**:
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\metadata-modules\ai\ai-agent-role\ai-agent-role.service.ts` (строки `68–129`)
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\modules\workflow\workflow-builder\workflow-version-step\workflow-version-step-operations.workspace-service.ts` (строки `1137–1150`)
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  1. Резервная неаудируемая ветка (`isAudited` / прямой вызов `executeCreate()` без `withAgentRoleAssignmentAudit`) полностью удалена из `AiAgentRoleService.assignRoleToAgent`.
  2. До первого `await` (`await this.validateAssignRoleInput(...)` на строке `102`) синхронно выполняются:
     - захват скалярных идентификаторов `capturedWorkspaceId`, `capturedAgentId`, `capturedRoleId` (строки `74–76`), исключающий подмену полей входного объекта `args` после старта промиса;
     - проверка валидности UUID для `capturedWorkspaceId`, `capturedAgentId`, `capturedRoleId` через `isUUID` (строки `77–86`);
     - проверка отсутствия активных или конфликтующих аудит-контекстов: `getRoleMutationAudit(capturedWorkspaceId) || hasConflictingMetadataAuditScope(capturedWorkspaceId, getRoleAssignmentAudit) || getRoleAssignmentAudit(capturedWorkspaceId)` (строки `87–96`), выбрасывающая `'Nested role assignment audit unsupported'` до любых обращений к репозиториям и даже при идемпотентном раннем выходе (`roleToAssignIsSameAsCurrentRole === true`);
     - синхронная валидация и проекция `const capturedIdentity = captureRoleAuditIdentity(args.auditIdentity as RoleUpdateAuditIdentity)` и проверка `captureRoleAuditOperation(capturedWorkspaceId, capturedIdentity)` (строки `97–100`).
  3. При `validationResult?.roleToAssignIsSameAsCurrentRole !== true` создание `roleTarget` безусловно выполняется внутри `withAgentRoleAssignmentAudit` со захваченными идентификаторами и `capturedIdentity` (строки `112–128`).
  4. В `WorkflowVersionStepOperationsWorkspaceService.createDraftStep` (`workflow-version-step-operations.workspace-service.ts:1138–1149`) в вызов `this.aiAgentRoleService.assignRoleToAgent` передаётся системный `auditIdentity` с `systemActorId: 'workflow-version-step:clone-agent-step'`.

---

## 2. Проверка транзакционных блокировок, защитных инвариантов и аудита в `runAuditedUnusedAgentRoleDelete`

- **Файл**: `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\role-update-audit.ts` (строки `1096–1269`).
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  1. **Синхронная предпроверка до первого `await` (строки `1105–1126`)**:
     - Валидирует и нормализует `normalizedWorkspaceId`, `normalizedRoleId`, `normalizedRoleTargetId` через `uuid(...)`.
     - Проверяет отсутствие активного или конфликтующего аудит-контекста (`getRoleMutationAudit(normalizedWorkspaceId) || hasConflictingMetadataAuditScope(normalizedWorkspaceId, getRoleMutationAudit)`).
     - Синхронно захватывает `capturedIdentity = captureRoleAuditIdentity(identity)`, `requestOperation = captureRoleAuditOperation(normalizedWorkspaceId, capturedIdentity)` и нормализует `impersonatorUserWorkspaceId`.
     - Проверяет наличие `dataSource` (`if (!dataSource) throw new Error('Unused agent role delete audit requires core DataSource')`).
  2. **Блокировки и проверки внутри `runInCoreAuditTransaction` (строки `1128–1268`)**:
     - Устанавливается `SET LOCAL lock_timeout = '8s'` (строка `1129`).
     - **`core.workspace` (`FOR NO KEY UPDATE`, строки `1130–1141`)**: проверяется существование активного воркспейса (`workspace && workspace.deletedAt === null`); если `workspace.defaultRoleId` совпадает с `normalizedRoleId`, функция возвращает `false` (роль по умолчанию воркспейса никогда не удаляется).
     - **`core.role` (`FOR UPDATE`, строки `1143–1165`)**: блокируется строка роли; при её отсутствии возвращается `false`. Под блокировкой проверяется, что роль редактируемая (`beforeRole.isEditable === true`), имеет валидный `universalIdentifier`, не равный `MEMBER_ROLE_UNIVERSAL_IDENTIFIER`, `STANDARD_ROLE.admin.universalIdentifier` и `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()`, и является эксклюзивно агентской (`canBeAssignedToAgents === true`, `canBeAssignedToUsers === false`, `canBeAssignedToApiKeys === false`). При нарушении любого условия возвращается `false` без удаления и без записи аудита.
     - **`core."roleTarget"` (`ORDER BY id FOR UPDATE`, строки `1167–1190`)**: блокируются все текущие привязки роли. Если обнаружена хотя бы одна строка с `uuid(String(row.id)) !== normalizedRoleTargetId` (конкурентное назначение роли другому агенту/ключу/участнику после предпроверки `count()`), удаление отменяется как безопасный no-op (`return false`).
     - **Явное удаление и аудит остаточного `roleTargetId` до `DELETE FROM core.role` (строки `1180–1216`)**: если строка с `id === normalizedRoleTargetId` ещё присутствует в `core."roleTarget"`, проверяется, что это строго агентская привязка (`agentId` — UUID, `userWorkspaceId === null`, `apiKeyId === null`), выполняется явный `DELETE FROM core."roleTarget" WHERE id=$1 AND "workspaceId"=$2 AND "roleId"=$3` и записывается событие `roleTarget` (`delete`, `before: projectRoleTargetAuditFields(residualTarget)`, `after: null`), что исключает неаудируемое каскадное удаление `ON DELETE CASCADE`.
     - **Удаление `core.role`, запись события `role` (`delete`) и пост-проверка (строки `1218–1267`)**: выполняется `DELETE FROM core.role WHERE id=$1 AND "workspaceId"=$2`, проверяется отсутствие удалённой роли и привязок до и после `await audit.flush()`, записывается событие `role` (`delete`, `before: projectRole(beforeRole)`, `after: null`, `securityDescriptor: { resourceKind: 'role', resourceId: normalizedRoleId, metadataAccess: 'currentWorkspaceAdministration' }`) с общим `operationId`, и возвращается `true`.

---

## 3. Проверка инвалидации кэша в `deleteAgentOnlyRoleIfUnused` и точек вызова

- **Файлы**:
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\metadata-modules\ai\ai-agent-role\ai-agent-role.service.ts` (строки `255–350`)
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\modules\workflow\workflow-builder\workflow-version-step\workflow-version-step-operations.workspace-service.ts` (строки `144–157`)
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\integration\metadata\suites\role\failing-delete-member-role.integration-spec.ts` (строки `155–169`)
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  1. До первого `await` в `deleteAgentOnlyRoleIfUnused` синхронно захватываются `capturedWorkspaceId`, `capturedRoleId`, `capturedRoleTargetId`, проверяется их UUID-формат, отсутствие активного/конфликтующего аудит-контекста и валидность `capturedIdentity` (строки `266–291`).
  2. Предпроверка в `deleteAgentOnlyRoleIfUnused` (строки `293–323`) отсекает не-агентские, нередактируемые и стандартные роли (`MEMBER_ROLE_UNIVERSAL_IDENTIFIER`, `STANDARD_ROLE.admin.universalIdentifier`, `WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER`), а также роли с `remainingAssignments !== 0`.
  3. Вызов `runAuditedUnusedAgentRoleDelete` обёрнут в `try / catch / finally` (строки `325–349`):
     - при успешном удалении (`deleted === true`) выставляется `shouldInvalidateCache = true`;
     - при безопасном no-op (`deleted === false`) или обычной ошибке до коммита `shouldInvalidateCache` остаётся `false`;
     - при `error instanceof NativeTransactionOutcomeUnknownError` (потеря подтверждения `COMMIT`) выставляется `shouldInvalidateCache = true` перед повторным выбросом ошибки;
     - в `finally` при `shouldInvalidateCache === true` вызывается `this.workspaceCacheService.invalidateAndRecompute(capturedWorkspaceId, ['flatRoleMaps', 'flatRolePermissionFlagMaps', 'rolesPermissions'])`.
  4. В `WorkflowVersionStepOperationsWorkspaceService.runWorkflowVersionStepDeletionSideEffects` (`workflow-version-step-operations.workspace-service.ts:145–156`) и в `failing-delete-member-role.integration-spec.ts:157–168` передаётся системный `auditIdentity` с `systemActorId: 'workflow-version-step:delete-agent-step'`.

---

## 4. Проверка тестового покрытия и соблюдения проектных правил (House Rules)

- **Тестовый файл**:
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\fork-migration\crm-audit-agent-role-lifecycle.postgres-spec.ts`
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  1. Реализованы все 7 целевых интеграционных PostgreSQL-сценариев из `test-research.md`:
     - атомарное удаление неиспользуемой агентской роли с записью `role` (`delete`) в `crm_audit."crmAuditEntry"`, проверкой хеширования текстовых полей (`label`, `description`, `icon`) и инвалидацией `['flatRoleMaps', 'flatRolePermissionFlagMaps', 'rolesPermissions']`;
     - явное удаление и аудит остаточного `roleTargetId` (`roleTarget:delete` + `role:delete` с единым `operationId`) до `DELETE FROM core.role`;
     - сохранение общих, стандартных (`Member`, `Admin`), нередактируемых (`WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER`) ролей и `workspace.defaultRoleId` как безопасный no-op без записей аудита и без лишней инвалидации кэша;
     - защита от гонки при параллельном назначении роли другому агенту после `roleTargetRepository.count()`, но до захвата блокировки `FOR UPDATE` в `runAuditedUnusedAgentRoleDelete`;
     - синхронный отказ до первого `await` при отсутствии `auditIdentity` или при вызове внутри конфликтующего аудит-контекста в `assignRoleToAgent` и `deleteAgentOnlyRoleIfUnused`;
     - защита от мутации входных аргументов и `auditIdentity` после старта промиса в обоих методах;
     - подавление `ROLLBACK` и обязательная инвалидация кэша в `finally` при `NativeTransactionOutcomeUnknownError` после потери подтверждения `COMMIT`;
     - сквозная проверка `WorkflowVersionStepOperationsWorkspaceService.createDraftStep` (`systemActorId: 'workflow-version-step:clone-agent-step'`) и `runWorkflowVersionStepDeletionSideEffects` (`systemActorId: 'workflow-version-step:delete-agent-step'`).
  2. **House rules и архитектурные проверки**:
     - В изменённых и добавленных файлах нет `any`, запрещённых Enterprise-импортов, JSDoc-блоков, избыточных комментариев и AI-атрибуции.
     - Проверки `python -I -X utf8 scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline` (`status: "pass"`, `violations: {}`) и `python -I -X utf8 scripts/omnichannel/check_fork_migration_sources.py` (`Verified 10 fork migration source(s)`) пройдены успешно.
