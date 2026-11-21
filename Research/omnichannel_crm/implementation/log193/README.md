# LOG193 - Транзакционный аудит жизненного цикла приглашений рабочего пространства (`workspaceInvitation` в `core."appToken"`)

## Сводка изменений
- В `crm-audit.types.ts` и `crm-audit-transaction-context.ts`:
  - добавлен вид ресурса `'workspaceInvitation'` с `ADMINISTRATIVE_ACTIONS.workspaceInvitation = ['create', 'delete']`;
  - добавлен `CATALOG.workspaceInvitation` с `values: ['type', 'roleId']` и `redacted: ['email', 'value', 'expiresAt', 'deletedAt', 'revokedAt']`.
- В `workspace-domain-audit.ts`:
  - добавлены `projectWorkspaceInvitation`, `runAuditedWorkspaceInvitationCreate` и `runAuditedWorkspaceInvitationDelete` с блокировками `core.workspace` (`FOR NO KEY UPDATE`) и `core."appToken"` (`FOR UPDATE`), fail-closed проверкой актора/имперсонации, проверкой границ `workspaceId` и `INVITATION_APP_TOKEN_TYPES`, а также пост-flush сверкой состояния БД.
- В `WorkspaceInvitationService`:
  - `createWorkspaceInvitation` выполняет проверку активного приглашения, проверку существующего участника, удаление просроченных приглашений и создание нового токена в одной транзакции (`runAuditedWorkspaceInvitationCreate`) с единым `operationId`;
  - `generateInvitationToken` поддерживает работу как внутри переданного `QueryRunner`, так и при прямом вызове через `runAuditedWorkspaceInvitationCreate`;
  - `deleteWorkspaceInvitation` и `invalidateWorkspaceInvitation` выполняются через `runAuditedWorkspaceInvitationDelete`;
  - `sendInvitations` / `resendWorkspaceInvitation` связывают удаление `appTokenIdToInvalidate` (строго в границах `workspaceId` и `INVITATION_APP_TOKEN_TYPES`) и создание новых приглашений общим `correlationId`, сохраняя отправку писем после `COMMIT`.
- В `WorkspaceInvitationResolver`, `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` и `SignInUpService.signInUpWithPersonalInvitation`:
  - проброшен `auditIdentity` во все операции создания, пересылки, удаления и инвалидации приглашений.
- В тестах `fork-migration`:
  - добавлен реальный PostgreSQL-спек [crm-audit-workspace-invitation.postgres-spec.ts](../../../../packages/twenty-server/test/fork-migration/crm-audit-workspace-invitation.postgres-spec.ts) (5 сценариев);
  - расширена проверка проброса `auditIdentity` и `correlationId` в [crm-audit-core-user-and-workspace.postgres-spec.ts](../../../../packages/twenty-server/test/fork-migration/crm-audit-core-user-and-workspace.postgres-spec.ts).

## Артефакты
- [Дизайн](design.md)
- [Ревью дизайна](design-review.md)
- [Исследование тестов](test-research.md)
- [Ревью кода](review.md)
- [Результаты проверок](results.json)
- [Дифференциальный typecheck](typecheck-differential.json)
- [Снимок исходников](source-snapshot.json)
- [Лог регрессии](regression.log)
- [Следующая граница](next-boundary.md)
