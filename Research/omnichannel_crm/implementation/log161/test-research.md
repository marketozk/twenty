# LOG161 — план тестирования и исследовательская матрица проверок

## 1. Целевые сценарии в `crm-audit-agent-role-lifecycle.postgres-spec.ts`

1. **Атомарное удаление неиспользуемой агентской роли (`deleteAgentOnlyRoleIfUnused`)**:
   - Когда кастомная роль имеет `canBeAssignedToAgents: true`, `canBeAssignedToUsers: false`, `canBeAssignedToApiKeys: false`, `isEditable: true` и не имеет других `roleTarget` кроме `roleTargetId` (уже удалённого при удалении агента):
     - строка удаляется из `core.role`;
     - в `crm_audit."crmAuditEntry"` записывается событие `role` (`delete`) с `actor: { kind: 'system', id: 'workflow-version-step:delete-agent-step' }`, `redactedDiff.values` (10 булевых флагов) и хэшами `label`, `description`, `icon`;
     - вызывается `workspaceCacheService.invalidateAndRecompute(workspaceId, ['flatRoleMaps', 'flatRolePermissionFlagMaps', 'rolesPermissions'])`.
2. **Атомарное удаление остаточного `roleTargetId` вместе с агентской ролью в одной транзакции**:
   - Если `roleTargetId` ещё присутствует в `core."roleTarget"` на момент вызова `deleteAgentOnlyRoleIfUnused`, `runAuditedUnusedAgentRoleDelete` явно удаляет `roleTargetId` до удаления `core.role` и записывает два события (`roleTarget` `delete` и `role` `delete`) с общим `operationId`, исключая неаудируемый `ON DELETE CASCADE`.
3. **Сохранение роли (no-op без аудита), если роль не является эксклюзивно агентской или является системной/стандартной**:
   - Роль с `canBeAssignedToUsers: true` или `canBeAssignedToApiKeys: true`, роль `Member` (`MEMBER_ROLE_UNIVERSAL_IDENTIFIER`), роль `Admin` (`STANDARD_ROLE.admin.universalIdentifier`), роль кастомного приложения (`isEditable: false`) или роль `workspace.defaultRoleId` не удаляются; `crm_audit."crmAuditEntry"` остаётся пустой.
4. **Защита от гонки: параллельное назначение роли другому агенту перед захватом блокировки в `runAuditedUnusedAgentRoleDelete`**:
   - Если после предпроверки `roleTargetRepository.count() === 0`, но до захвата `FOR UPDATE` в `runAuditedUnusedAgentRoleDelete` в `core."roleTarget"` появляется привязка другого агента к этой роли, транзакция фиксирует `targetRows` с `id !== roleTargetId`, оставляет роль и новую привязку нетронутыми и не пишет ложный аудит удаления.
5. **Обязательность `auditIdentity` до первого `await` в `assignRoleToAgent` и `deleteAgentOnlyRoleIfUnused`**:
   - Вызов `assignRoleToAgent` или `deleteAgentOnlyRoleIfUnused` без `auditIdentity`, с чужим `workspace.id`, с `pendingActivationUser`, с `type: 'system'` без `systemActorId` или внутри конфликтующего аудит-контекста синхронно отвергается до любых обращений к `roleRepository` / `agentRepository`; `crm_audit."crmAuditEntry"` остаётся пустой.
6. **Защита от мутации входных аргументов после старта промиса**:
   - Мутация объекта аргументов или `auditIdentity` после вызова `assignRoleToAgent` / `deleteAgentOnlyRoleIfUnused` не влияет на проверяемые идентификаторы и записанного в аудит актора.
7. **Откат при ошибке БД и обработка `NativeTransactionOutcomeUnknownError` после потери подтверждения `COMMIT`**:
   - При сбое внутри транзакции `core.role`, `core."roleTarget"` и `crm_audit."crmAuditEntry"` откатываются, кэш не инвалидируется.
   - При потере подтверждения `COMMIT` (`NativeTransactionOutcomeUnknownError`) `ROLLBACK` не вызывается, удаление и запись аудита сохраняются, а `workspaceCacheService.invalidateAndRecompute` выполняется в `finally`.
8. **Сквозная проверка `WorkflowVersionStepOperationsWorkspaceService` (`runWorkflowVersionStepDeletionSideEffects` и `createDraftStep`)**:
   - Создание черновика шага `AI_AGENT` (`createDraftStep`) вызывает `assignRoleToAgent` с `systemActorId: 'workflow-version-step:clone-agent-step'` и создаёт запись `roleTarget` (`create`) в `crm_audit."crmAuditEntry"`.
   - Удаление шага `AI_AGENT` вызывает `deleteAgentOnlyRoleIfUnused` с `systemActorId: 'workflow-version-step:delete-agent-step'` и создаёт запись `role` (`delete`) в `crm_audit."crmAuditEntry"`.

## 2. Регрессионные и граничные проверки

- Целевые PostgreSQL-наборы аудита ролей и метаданных (`9` наборов).
- Полная регрессия `ROB-765` (`106` наборов).
- Дифференциальный typecheck (`typecheck-diff.cjs`), `check_enterprise_dependencies.py --verify-baseline`, `check_fork_migration_sources.py` и `26` guard unit-тестов (`33` на Linux).
