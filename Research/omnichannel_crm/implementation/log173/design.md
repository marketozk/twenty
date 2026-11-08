# LOG-173 - Проектирование транзакционного аудита полного жизненного цикла `userWorkspace` и активных обновлений `coreUser`

## 1. Контекст и проблема

В рамках `ROB-765` (Этап 2a - сбор аудита действий):
- В `LOG-115` / `LOG-117` подключён транзакционный аудит мягкого (`update`) и жёсткого (`delete`) удаления `core."userWorkspace"` (`deleteUserWorkspaceTransaction`, `membership-cleanup-audit.ts`).
- В `LOG-118` подключён транзакционный аудит мягкого отключения `core."user"` (`deactivateCoreUserWithAudit`).
- В `LOG-119` и `LOG-120` пути создания членства (`UserWorkspaceService.create`), смены локали членства (`UserWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace`), подтверждения и смены адреса электронной почты (`UserService.markEmailAsVerified`, `UserService.updateEmailFromVerificationToken`) и изменения полномочий серверного администратора (`AdminPanelServerAdminService.updateServerAdminAccess`) были переведены на узкие транзакционные проверки активной записи (`runInCoreAuditTransaction`, блокировки `FOR SHARE` / `FOR UPDATE`), но тогда ещё не записывали события `crm_audit."crmAuditEntry"`.
- В `LOG-171` (`password-update-audit.ts`) смена и сброс пароля были переведены на транзакционный аудит отзыва `refreshToken` и `PasswordResetToken`, но сама мутация `core."user"."passwordHash"` не записывала событие `coreUser` (`update`) в `crm_audit."crmAuditEntry"`.

В результате:
1. В `crm-audit-transaction-context.ts`:
   - `CATALOG.coreUser` содержит только `{ values: [], redacted: ['deletedAt'] }`, поэтому изменения `isEmailVerified`, `canAccessFullAdminPanel`, `canImpersonate`, `email` и `passwordHash` не представлены в каталоге.
   - `CATALOG.userWorkspace` содержит только `{ values: ['userId'], redacted: ['deletedAt'] }`, а `ADMINISTRATIVE_ACTIONS.userWorkspace` разрешает только `['update', 'delete']`, поэтому создание членства (`create`) и смена `locale` (`update`) не аудируются, а `defaultAvatarUrl` не включён в `redacted`.
2. Прямые и опосредованные вызовы `UserWorkspaceService.create`, `UserWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace`, `UserService.markEmailAsVerified`, `UserService.updateEmailFromVerificationToken`, `UserService.updateUserEmail`, `AdminPanelServerAdminService.updateServerAdminAccess`, `AdminPanelResolver.updateServerAdminAccess`, `UserResolver.updateWorkspaceMemberSettings`, `UserResolver.updateUserEmail`, `AuthResolver.verifyEmailAndGetLoginToken`, `AuthResolver.verifyEmailAndGetWorkspaceAgnosticToken`, `SignInUpService.signInUpWithPersonalInvitation`, `SignInUpService.signUpOnNewWorkspace` и `SSOAuthController` не формируют записей `crm_audit."crmAuditEntry"` для `userWorkspace` (`create` / `update`) и `coreUser` (`update`).

## 2. Варианты архитектуры

### Вариант A (Рекомендуемый): Расширение каталога `coreUser` и `userWorkspace` + единый транзакционный модуль `core-user-and-workspace-audit.ts`
- Расширить `CATALOG` и `ADMINISTRATIVE_ACTIONS` в `crm-audit-transaction-context.ts`:
  - `coreUser`:
    - `values: ['isEmailVerified', 'canAccessFullAdminPanel', 'canImpersonate']`
    - `redacted: ['email', 'passwordHash', 'deletedAt']`
    - `ADMINISTRATIVE_ACTIONS.coreUser: ['update']`
  - `userWorkspace`:
    - `values: ['userId', 'locale']`
    - `redacted: ['defaultAvatarUrl', 'deletedAt']`
    - `ADMINISTRATIVE_ACTIONS.userWorkspace: ['create', 'update', 'delete']`
- Выделить модуль `packages/twenty-server/src/engine/core-modules/crm-audit/core-user-and-workspace-audit.ts`:
  - `captureCoreUserAndWorkspaceAudit` и `withCoreUserAndWorkspaceAudit` (`AsyncLocalStorage`) для синхронного захвата серверной атрибуции (`actor`, `initiator`, `impersonatorUserWorkspaceId`, `correlationId`, `causationId`, `workspaceId`) до первого `await`. В `AsyncLocalStorage` хранится многоразовый в рамках вызова ambient-контекст с общим `correlationId`, а защита `WeakSet` от повторного потребления применяется к каждому листовому объекту `CoreUserAndWorkspaceAuditRequest`. Контекст не регистрируется в `registerMetadataAuditScopeCheck`, а в `role-update-audit.ts` (`RoleUpdateAuditIdentity`, `captureRoleAuditIdentity`, `captureRoleAuditOperation`) поддерживаются `correlationId` и `causationId`.
  - `recordAuditedUserWorkspaceCreate`: вызывается внутри `UserWorkspaceService.create` на активном `QueryRunner` (как в собственной `runInCoreAuditTransaction`, так и на переданном `queryRunner` при `signUpOnNewWorkspace`), проверяет активность `core."user"` (`FOR SHARE`) и `core.workspace` (если присутствует в БД, через `to_jsonb(w)->>'deletedAt' IS NULL`), сверяет сохранённую строку `core."userWorkspace"` (читая `to_jsonb(membership)->>'locale'` и `to_jsonb(membership)->>'defaultAvatarUrl'`), записывает и сбрасывает (`flush`) событие `userWorkspace` (`create`) и повторно сверяет строку после `flush()`.
  - `runAuditedUserWorkspaceLocaleUpdate`: вызывается из `UserWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace`, открывает `runInCoreAuditTransaction`, блокирует целевую строку `core."userWorkspace" FOR NO KEY UPDATE` (конфликтует с `DELETE` и `UPDATE`, но совместим с `FOR KEY SHARE OF uw`, исключая AB-BA deadlock с обновлениями `core."user"`), проверяет отсутствие `deletedAt` у членства и пользователя и совпадение `workspaceId` (если передан), при фактическом изменении `locale` выполняет `UPDATE`, сверяет `before`/`after`, записывает и сбрасывает (`flush`) событие `userWorkspace` (`update`), повторно сверяет состояние после `flush()`, и в `finally` инвалидирует кэш `userWorkspaceEntity` при попытке/подтверждении записи.
  - `runAuditedActiveCoreUserUpdate` и `recordAuditedCoreUserUpdate`: используются в `UserService.updateActiveUser` (`markEmailAsVerified`, `updateEmailFromVerificationToken`), `AdminPanelServerAdminService.updateServerAdminAccess` и `runAuditedPasswordUpdate` (`password-update-audit.ts`). Снимок `before` читается строго после `FOR UPDATE` на `core."user"`, а опциональные колонки `core."userWorkspace"` и `core.workspace` читаются через `to_jsonb(uw)->>'workspaceId'` и `to_jsonb(w)->>'deletedAt'`. При фактическом изменении отслеживаемых полей для каждого активного рабочего пространства пользователя (плюс `actorWorkspaceId` при `updateServerAdminAccess` или явный `workspaceId` из контекста) записывают событие `coreUser` (`update`) с общей `correlationId` и индивидуальным `operationId` на каждое рабочее пространство, а после `flush()` повторно сверяют снимок `core."user"`.

### Вариант B: Запись аудита в резолверах после завершения сервисных методов
- Отвергнут: нарушает требование атомарности бизнес-изменения и записи `crm_audit."crmAuditEntry"` в одной PostgreSQL транзакции до `COMMIT` и пропускает внутренние вызовы (`SignInUpService`, `GlobalWorkspaceMemberListener`, `SSOAuthController`).

### Вариант C: Введение отдельных видов ресурсов для каждого поля `coreUser`
- Отвергнут: избыточно усложняет схему и нарушает существующий контракт `resourceKind: 'coreUser'` / `'userWorkspace'`.

## 3. Точки интеграции и инварианты безопасности

1. **Защита от утечки PII и секретов**:
   - Поля `email`, `passwordHash` и `deletedAt` в `coreUser` находятся в `redacted`: в `redactedDiff` попадают только имена реально изменившихся полей в `changedFields` (например, `['email']` при смене почты или `['passwordHash']` при смене пароля), а сами значения хешируются при расчёте diff и никогда не сохраняются в `redactedDiff.values`.
   - При деактивации пользователя (`deactivateCoreUserWithAudit`), где меняются только `deletedAt` и `updatedAt`, `changedFields` по-прежнему равен `['deletedAt']`, а имена `email` и `passwordHash` не попадают в запись журнала.
   - Поле `defaultAvatarUrl` в `userWorkspace` находится в `redacted` и не сохраняется в открытом виде в `redactedDiff.values`.
2. **Точная область рабочих пространств (`workspaceId`)**:
   - Для `userWorkspace` (`create` и `update`) `workspaceId` однозначно определяется самой строкой `core."userWorkspace"`.
   - Для `AdminPanelServerAdminService.updateServerAdminAccess` аудит записывается в `actorWorkspaceId` (если рабочее пространство активно) и во все активные рабочие пространства целевого пользователя `targetUserId` (под `FOR KEY SHARE OF uw`), объединяя их общим `correlationId`.
   - Для `UserService.markEmailAsVerified` и `UserService.updateEmailFromVerificationToken` аудит записывается во все активные рабочие пространства пользователя (`core."userWorkspace"` под `FOR KEY SHARE OF uw`) и явный/ambient `workspaceId` (если передан и активен); для полностью безворкспейсного аккаунта (без членств и без рабочего пространства в контексте) фиктивный `workspaceId` не выдумывается.
   - Для `runAuditedPasswordUpdate` (`password-update-audit.ts`) запись `coreUser` (`update`) добавляется в контекст каждого активного рабочего пространства пользователя вместе с отзывами `refreshToken`.
3. **Захват атрибуции до первого `await` и поддержка имперсонации**:
   - `UserResolver.updateWorkspaceMemberSettings`, `UserResolver.updateUserEmail`, `AdminPanelResolver.updateServerAdminAccess`, `AdminPanelServerAdminService.updateServerAdminAccess`, `UserWorkspaceService.create`, `UserWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace`, `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace`, `UserService.markEmailAsVerified`, `UserService.updateEmailFromVerificationToken`, `UserService.updateUserEmail`, `GlobalWorkspaceMemberListener.syncUserWorkspaceLocale`, `AuthResolver.verifyEmailAndGetLoginToken`, `AuthResolver.verifyEmailAndGetWorkspaceAgnosticToken`, `SignInUpService.signInUpWithPersonalInvitation`, `SignInUpService.signUpOnNewWorkspace` и `SSOAuthController` захватывают идентичность до первого `await`.
   - При наличии `impersonatorUserWorkspaceId` инициатор (`initiator: { kind: 'coreUser', id: impersonatorUserId }`) разрешается внутри транзакции через `resolveRoleAuditInitiator` по активной строке `core."userWorkspace"`.
   - В `SignInUpService.signUpOnNewWorkspace` транзакция переводится на `runInCoreAuditTransaction(this.dataSource, ...)`, а отправка телеметрии/событий/метрик `saveNewUser` при переданном `queryRunner` выполняется после подтверждённого `COMMIT`.
