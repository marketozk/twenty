# LOG161 - аудит удаления неиспользуемых агентских ролей (`deleteAgentOnlyRoleIfUnused`) и операций ролей агентов в шагах workflow

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG161 закрывает оставшиеся операции ролей агентов в `AiAgentRoleService` (`assignRoleToAgent`, `deleteAgentOnlyRoleIfUnused`) и `WorkflowVersionStepOperationsWorkspaceService` (`createDraftStep`, `runWorkflowVersionStepDeletionSideEffects`).

В `role-update-audit.ts` добавлена закрытая транзакционная функция `runAuditedUnusedAgentRoleDelete`: до первого `await` синхронно валидируются UUID (`workspaceId`, `roleId`, `roleTargetId`), отсутствие конфликтующих аудит-контекстов, `auditIdentity` и `dataSource`, а внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.role` (`FOR UPDATE`) и `core."roleTarget"` (`ORDER BY id FOR UPDATE`). Под блокировками проверяется, что роль не является `workspace.defaultRoleId`, стандартной (`Member`, `Admin`) или нередактируемой (`isEditable !== true`), имеет `canBeAssignedToAgents === true`, `canBeAssignedToUsers === false`, `canBeAssignedToApiKeys === false` и не имеет других привязок кроме `roleTargetId`. Если остаточный `roleTargetId` ещё присутствует в `core."roleTarget"`, он явно удаляется и записывается в `CrmAuditTransactionContext` (`roleTarget` `delete`) до `DELETE FROM core.role`, исключая неаудируемый `ON DELETE CASCADE`, после чего записывается событие `role` (`delete`) с единым `operationId` и проверяется отсутствие строк до и после `audit.flush()`.

В `AiAgentRoleService` удалена резервная неаудируемая ветка в `assignRoleToAgent`, оба метода (`assignRoleToAgent` и `deleteAgentOnlyRoleIfUnused`) синхронно до первого `await` проверяют `auditIdentity` и конфликтующие аудит-контексты, а `deleteAgentOnlyRoleIfUnused` инвалидирует `['flatRoleMaps', 'flatRolePermissionFlagMaps', 'rolesPermissions']` после коммита и в `finally` при `NativeTransactionOutcomeUnknownError`. В `WorkflowVersionStepOperationsWorkspaceService` подключены системные `auditIdentity` (`workflow-version-step:clone-agent-step` и `workflow-version-step:delete-agent-step`).

3087 tests/106 suites PASS (677.916s). 278 targeted/9 suites PASS (26.32s), 8 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 458/459 roots, baseline 240 / current 240 diagnostics, 0 новых/changed-code. Совпали 5 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [привязки `roleTarget` при мутациях агентов в `AgentService` и оставшиеся core/native writers](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
