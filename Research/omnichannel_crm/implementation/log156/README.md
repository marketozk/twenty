# LOG156 - аудит удаления ролей и назначения ролей агентам и API-ключам

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG156 закрывает оставшиеся публичные и AI-точки жизненного цикла ролей и назначений ролей: удаление ролей (`RoleService.deleteRole`, `RoleResolver.deleteOneRole`, `DeleteRoleTool.execute`), назначение и снятие ролей ИИ-агентов (`AiAgentRoleService.assignRoleToAgent`, `AiAgentRoleService.removeRoleFromAgent`, `RoleResolver.assignRoleToAgent`, `RoleResolver.removeRoleFromAgent`) и назначение ролей API-ключам (`ApiKeyRoleService.assignRoleToApiKey`, `ApiKeyResolver.assignRoleToApiKey`).

В `crm-audit-transaction-context.ts` действие `'delete'` добавлено в `ADMINISTRATIVE_ACTIONS.role` (с проверкой `before !== null && after === null` для `delete` и `before === null && after !== null` для `create`), а `CATALOG.roleTarget.values` расширен полями `'agentId'` и `'apiKeyId'`.

В `role-update-audit.ts` добавлены `withRoleDeleteAudit` и ветка `action === 'delete'` в `runAuditedRoleMutation`: внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`, проверка активного `defaultRoleId !== roleId`), `core.application` (`FOR SHARE`), `core.role` (`FOR UPDATE` на удаляемую роль и `defaultRole`, проверка `isEditable === true` и запрета удаления стандартных ролей Admin/Member), `core."roleTarget"` (`FOR UPDATE` на все строки роли, точное совпадение с планом удаления без скрытых каскадов) и `core."userWorkspace"` / `core."apiKey"` / `core.agent` (`FOR SHARE`, обязательная перепривязка всех активных участников, активных API-ключей и неудалённых агентов к `defaultRoleId` и пропуск отозванных API-ключей и soft-deleted агентов), проверяется защита от удаления собственной роли вызывающего субъекта под блокировками БД, записываются атомарные записи аудита `roleTarget` (`delete` и `create`) и `role` (`delete` с редактированием `label`/`description`/`icon`) до `COMMIT`, и повторно проверяется состояние после `audit.flush()`.

В `role-assignment-audit.ts` добавлены `withAgentRoleAssignmentAudit`, `withAgentRoleRemovalAudit` и `withApiKeyRoleAssignmentAudit`, поддерживающие `targetKind: 'userWorkspace' | 'agent' | 'apiKey'` и `mode: 'assign' | 'remove'` в `runAuditedRoleAssignment` с проверкой `core.agent` (`deletedAt === null`, `canBeAssignedToAgents === true`) и `core."apiKey"` (`revokedAt === null`, `canBeAssignedToApiKeys === true`) под блокировками `FOR SHARE` / `FOR UPDATE`, записью атомарного аудита `roleTarget` (`{ roleId, agentId }` / `{ roleId, apiKeyId }`) и повторной проверкой после `audit.flush()`.

3034 tests/101 suites PASS (671.015s). 116 targeted/3 suites PASS (8.675s), 16 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 456/457 roots, baseline 253 / current 252 diagnostics, 0 новых/changed-code. Совпали 12 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [аудит upsert флагов прав, объектных/полевых прав и предикатов строкового доступа роли](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
