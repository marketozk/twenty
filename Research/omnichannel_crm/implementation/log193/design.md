# LOG193 - Дизайн транзакционного аудита приглашений рабочего пространства (`workspaceInvitation` в `core."appToken"`)

## Цель и границы
Закрыть транзакционный аудит полного жизненного цикла персональных и онбординг-приглашений в рабочее пространство (`core."appToken"` с типами `INVITATION_TOKEN` и `ONBOARDING_INVITATION_TOKEN`) во всех точках создания, пересылки, отзыва и инвалидации:
- `WorkspaceInvitationService.createWorkspaceInvitation` (включая удаление просроченных приглашений для того же `email` и вставку нового приглашения в одной транзакции)
- `WorkspaceInvitationService.generateInvitationToken` (внутри переданного `QueryRunner` при вызове из `createWorkspaceInvitation` и в собственной транзакции при прямом вызове)
- `WorkspaceInvitationService.deleteWorkspaceInvitation`
- `WorkspaceInvitationService.invalidateWorkspaceInvitation`
- `WorkspaceInvitationService.resendWorkspaceInvitation` и `WorkspaceInvitationService.sendInvitations` (удаление `appTokenIdToInvalidate` с проверкой `workspaceId` и `INVITATION_APP_TOKEN_TYPES` + создание новых приглашений с общим `correlationId`)
- `WorkspaceInvitationResolver`: `sendInvitations`, `resendWorkspaceInvitation`, `deleteWorkspaceInvitation` (проброс `context?.req` в `auditIdentity`)
- `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` и `SignInUpService.signInUpWithPersonalInvitation` (проброс `auditIdentity` при вызове `invalidateWorkspaceInvitation`)

Вне границ `LOG193`:
- Прочие типы `core."appToken"` (`EMAIL_VERIFICATION_TOKEN`, `SSO_EXCHANGE_TOKEN`, `AUTHORIZATION_CODE`, `CODE_CHALLENGE`, `ENTERPRISE_VALIDITY_TOKEN`) - они обслуживают другие подсистемы и не относятся к жизненному циклу приглашений.
- Отправка SMTP-писем (`this.emailService.send`) остаётся строго после `COMMIT` транзакции БД.

## Модель аудита и сокрытие данных
- Новый `CrmAuditResourceKind`: `'workspaceInvitation'` в `crm-audit.types.ts`.
- `CATALOG.workspaceInvitation` в `crm-audit-transaction-context.ts`:
  - `values: ['type', 'roleId']`
  - `redacted: ['email', 'value', 'expiresAt', 'deletedAt', 'revokedAt']`
- `ADMINISTRATIVE_ACTIONS.workspaceInvitation`: `['create', 'delete']`.
- `securityDescriptor`: `{ resourceKind: 'workspaceInvitation', resourceId, metadataAccess: 'currentWorkspaceAdministration' }`.
- Проекция `projectWorkspaceInvitation(row)`:
  - проверяет, что `row.type` входит в `INVITATION_TOKEN | ONBOARDING_INVITATION_TOKEN`;
  - извлекает `type`, `roleId` (`context.roleId` как валидный UUID или `null`), `email` (`context.email.toLowerCase()` или `null`), `value`, `expiresAt`, `deletedAt`, `revokedAt` (ISO timestamp или `null`);
  - гарантирует, что PII (`email`) и секретный токен (`value`) никогда не попадают в открытый `values`.

## Транзакционные раннеры (`workspace-domain-audit.ts`)
1. `runAuditedWorkspaceInvitationCreate`:
   - `SET LOCAL lock_timeout = '8s'`.
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`) и проверяет, что рабочее пространство активно (`deletedAt IS NULL`).
   - Блокирует `FOR UPDATE` все существующие приглашения данного `email` в `workspaceId` (`type IN ('INVITATION_TOKEN', 'ONBOARDING_INVITATION_TOKEN') AND lower(t.context->>'email') = lower($2)`), снимает карту `beforeRows`.
   - Проверяет и резолвит актора/имперсонацию через `resolveWorkspaceDomainOperation(runner, request)` (fail-closed до любых изменений).
   - Выполняет `work(runner)`: внутри той же транзакции проверяет отсутствие активного приглашения, проверяет `userWorkspace`, удаляет просроченные приглашения данного `email` и вставляет новое приглашение.
   - Перечитывает `afterRows` (`FOR UPDATE`), проверяет наличие созданного `invitationId`, формирует события `delete` (для удалённых просроченных приглашений) и `create` (для нового приглашения) в одном `CrmAuditTransactionContext` (единый `operationId`), отклоняет неожиданный `update` fail-closed.
   - Вызывает `audit.flush()` и перечитывает строки `core."appToken"` для `(workspaceId, lower(context->>'email'))`; при любом расхождении состояния после `flush()` бросает ошибку и откатывает транзакцию.
2. `runAuditedWorkspaceInvitationDelete`:
   - `SET LOCAL lock_timeout = '8s'`.
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет `deletedAt IS NULL`.
   - Вызывает `resolveWorkspaceDomainOperation(runner, request)` (fail-closed даже при отсутствии целевой строки).
   - Блокирует `FOR UPDATE` целевую строку по `{ id }` (с обязательной проверкой `workspaceId` и `INVITATION_APP_TOKEN_TYPES`) либо все активные приглашения по `{ email, activeOnly: true }`.
   - Выполняет `work(runner, lockedRows)`.
   - Перечитывает заблокированные ID после `work`, фиксирует `workspaceInvitation:delete` для каждой удалённой строки, вызывает `audit.flush()` и повторно проверяет отсутствие удалённых ID после `flush()`.

## Связанность и корреляция
- В `sendInvitations` / `resendWorkspaceInvitation` используется общий `correlationId` для удаления `appTokenIdToInvalidate` и создания новых приглашений.
- В `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` при вызове `invalidateWorkspaceInvitation` передаётся `auditIdentity` с общим `sharedCorrelationId`, `actor`, `initiator` и `impersonatorUserWorkspaceId` без повторного использования `operationId`.
- В `SignInUpService.signInUpWithPersonalInvitation` при вызове `invalidateWorkspaceInvitation` передаётся `{ workspaceId: invitationValidation.workspace.id, actor: { kind: 'coreUser', id: updatedUser.id } }` (на момент вызова `userWorkspace` уже создан в `signInUpOnExistingWorkspace`).
