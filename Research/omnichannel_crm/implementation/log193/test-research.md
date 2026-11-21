# LOG193 - Исследование и план тестов

## Существующие тесты, затрагиваемые или смежные
- `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` - проверяет домены и сущности `workspace-domain-audit.ts`; добавим отдельный сфокусированный PG-спек `crm-audit-workspace-invitation.postgres-spec.ts` по аналогии с другими доменными спеками.
- `packages/twenty-server/test/fork-migration/crm-audit-core-user-and-workspace.postgres-spec.ts` - проверяет `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` (мокает `workspaceInvitationService`, но нужно убедиться, что не ломается совместимость вызова с третьим аргументом `auditIdentity`).
- `packages/twenty-server/src/engine/core-modules/workspace-invitation/utils/cast-app-token-to-workspace-invitation.spec.ts` - не затрагивается.

## Обязательные реальные PostgreSQL-сценарии (`crm-audit-workspace-invitation.postgres-spec.ts`)
1. **Полный жизненный цикл через `WorkspaceInvitationResolver` и `WorkspaceInvitationService`**:
   - `sendInvitations` создаёт `INVITATION_TOKEN` (с `roleId`) и пишет `workspaceInvitation:create` с `values: { type, roleId }`, без plaintext `email` и `value` (оба в `redacted`), с корректным `actor` и `initiator` при имперсонации.
   - `resendWorkspaceInvitation` удаляет прежний токен (`workspaceInvitation:delete`) и создаёт новый (`workspaceInvitation:create`) с общим `correlationId`.
   - `deleteWorkspaceInvitation` удаляет токен и пишет `workspaceInvitation:delete` (`before`, `after: null`), а повторный вызов для несуществующего ID возвращает `'error'` и не пишет лишних записей.
2. **Атомарная замена просроченного приглашения**:
   - При наличии просроченного приглашения (`expiresAt <= now`) для того же `email` `createWorkspaceInvitation` в одной транзакции (один `operationId`) удаляет просроченное (`workspaceInvitation:delete`) и создаёт новое (`workspaceInvitation:create`), в том числе `ONBOARDING_INVITATION_TOKEN`.
3. **Инвалидация при принятии приглашения (`invalidateWorkspaceInvitation`, `UserWorkspaceService`, `SignInUpService`)**:
   - `invalidateWorkspaceInvitation` удаляет активное приглашение (case-insensitive по `email`) и пишет `workspaceInvitation:delete`; при отсутствии активного приглашения ничего не удаляет и не пишет запись аудита.
   - `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` с реальным `WorkspaceInvitationService` инвалидирует приглашение с тем же `correlationId`, что и `userWorkspace:create` и `roleTarget:create`.
4. **Fail-closed и откат транзакций**:
   - Без `auditIdentity` / `CrmAuditAttributionContext` `createWorkspaceInvitation`, `generateInvitationToken`, `deleteWorkspaceInvitation` и `invalidateWorkspaceInvitation` отклоняются без изменения `core."appToken"`.
   - Попытка удалить приглашение другого workspace через `deleteWorkspaceInvitation` или `sendInvitations(..., appTokenIdToInvalidate)` не удаляет чужую строку и не пишет ложный аудит.
   - При отказе записи в `crm_audit` (триггер/ошибка flush) и при пост-flush мутации `core."appToken"` транзакция откатывается полностью (ни вставки нового, ни удаления старого приглашения).
