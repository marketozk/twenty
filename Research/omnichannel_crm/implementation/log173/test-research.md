# LOG-173 - Исследование тестового покрытия и сценариев проверки

## 1. Существующие тесты

1. `packages/twenty-server/test/fork-migration/crm-audit-membership-create.postgres-spec.ts` (`LOG-119`):
   - Проверяет `UserWorkspaceService.create` (сохранение членства, отказ для отсутствующего/удалённого пользователя, захват скалярных полей до `await avatar`, работа с переданным `queryRunner`, триггеры повреждения `INSERT`, конкурентные гонки с `deactivateCoreUserWithAudit`, потерянный `COMMIT ACK`) и `UserWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace` (обновление `locale` и инвалидация кэша, невозможность воскрешения параллельно удалённого членства, no-op для отсутствующей записи).
   - Схема `crm_audit` и роль с правами `SELECT, INSERT ON crm_audit."crmAuditEntry"` уже развёрнуты в `beforeAll`.
2. `packages/twenty-server/test/fork-migration/crm-audit-active-core-user.postgres-spec.ts` (`LOG-120`):
   - Проверяет `UserService.markEmailAsVerified`, `UserService.updateEmailFromVerificationToken` и `AdminPanelServerAdminService.updateServerAdminAccess` (узкие обновления, работа с переданным `queryRunner`, отказ на удалённом/отсутствующем пользователе, параллельные несвязанные обновления, гонки с `deactivateCoreUserWithAudit`, пересчёт флагов и защиты последнего администратора после `OTP`, подавление записи триггером, потерянный `COMMIT ACK`, ошибки инвалидации кэша).
3. `packages/twenty-server/test/fork-migration/crm-audit-core-user-deactivation.postgres-spec.ts` (`LOG-118`):
   - Проверяет `deactivateCoreUserWithAudit` и отсутствие строк `private@|secret-password|passwordHash|email` в сериализованном выводе `crm_audit."crmAuditEntry"` при деактивации.
4. `packages/twenty-server/test/fork-migration/crm-audit-membership-owner.postgres-spec.ts` (`LOG-115`) и `crm-audit-password-update.postgres-spec.ts` (`LOG-171`):
   - Проверяют каскадное/мягкое удаление `userWorkspace` и смену/сброс пароля с отзывом токенов.

## 2. Новые интеграционные тесты PostgreSQL (`crm-audit-core-user-and-workspace.postgres-spec.ts`)

Создать `packages/twenty-server/test/fork-migration/crm-audit-core-user-and-workspace.postgres-spec.ts`, проверяющий на реальной PostgreSQL БД с непривилегированной ролью `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`:

1. **Полный жизненный цикл `userWorkspace` (`create` и `update` локали)**:
   - `UserWorkspaceService.create` (напрямую, через `addUserToWorkspaceIfUserNotInWorkspace` с общей `correlationId` между `userWorkspace` `create` и `roleTarget` `create`, и через внешний `QueryRunner` как в `SignInUpService.signUpOnNewWorkspace`) записывает `userWorkspace` `create` с `values: { userId, locale }` и редактирует `defaultAvatarUrl` / `deletedAt`.
   - `UserResolver.updateWorkspaceMemberSettings` (пользовательская сессия, имперсонация с разрешением `initiator`, API-ключ, приложение с инициатором-пользователем) и `GlobalWorkspaceMemberListener.syncUserWorkspaceLocale` записывают `userWorkspace` `update` при фактической смене `locale` и не создают пустых записей при неизменном `locale`.
   - Захват идентичности происходит синхронно до первого `await` (мутация входного объекта во время `computeDefaultAvatarUrl` или проверки прав не меняет `actor`/`initiator` в журнале).
2. **Активные обновления `coreUser` (`updateServerAdminAccess`, `markEmailAsVerified`, `updateEmailFromVerificationToken`, `updateUserEmail`, `updatePassword`)**:
   - `AdminPanelResolver.updateServerAdminAccess` / `AdminPanelServerAdminService.updateServerAdminAccess` записывает `coreUser` `update` с `values: { canAccessFullAdminPanel, canImpersonate }` в рабочее пространство актора и во все активные рабочие пространства целевого пользователя с общим `correlationId`, пропуская мягко удалённые рабочие пространства.
   - `UserService.markEmailAsVerified` (`AuthResolver.verifyEmailAndGetLoginToken`, `SignInUpService.signInUpWithPersonalInvitation`, `SSOAuthController`) записывает `coreUser` `update` с `values: { isEmailVerified: { before: false, after: true } }`.
   - `UserService.updateEmailFromVerificationToken` и `UserResolver.updateUserEmail` (включая сессию под имперсонацией) записывают `coreUser` `update` с `changedFields: ['email']`, `values: {}` (адреса электронной почты до и после никогда не попадают в открытом виде в `crm_audit."crmAuditEntry"`).
   - `runAuditedPasswordUpdate` записывает `coreUser` `update` с `changedFields: ['passwordHash']`, `values: {}` во все активные рабочие пространства пользователя даже при отсутствии активных `refreshToken`.
3. **Откат при сбое аудита, защита от повреждения триггером после `flush()` и классификация `NativeTransactionOutcomeUnknownError`**:
   - При отзыве `INSERT` на `crm_audit."crmAuditEntry"` операции `UserWorkspaceService.create`, `updateUserWorkspaceLocaleForUserWorkspace`, `markEmailAsVerified`, `updateEmailFromVerificationToken` и `updateServerAdminAccess` полностью откатывают изменения в `core."userWorkspace"` и `core."user"` и не публикуют побочных эффектов (очередь смены email, события и письма администраторам).
   - Триггер `AFTER INSERT ON crm_audit."crmAuditEntry"`, пытающийся изменить `core."userWorkspace"` или `core."user"` после `audit.flush()`, обнаруживается финальной сверкой снимка и откатывает транзакцию.
   - Потеря подтверждения `COMMIT` (`NativeTransactionOutcomeUnknownError`) классифицируется корректно, инвалидирует кэш и не запускает дублирующих побочных эффектов.
