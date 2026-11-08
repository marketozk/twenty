# LOG-173 - Транзакционный аудит полного жизненного цикла `userWorkspace` и всех активных обновлений `coreUser`

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `coreUser`: `values: ['isEmailVerified', 'canAccessFullAdminPanel', 'canImpersonate']`, `redacted: ['email', 'passwordHash', 'deletedAt']`, действия `['update']`.
   - `userWorkspace`: `values: ['userId', 'locale']`, `redacted: ['defaultAvatarUrl', 'deletedAt']`, действия `['create', 'update', 'delete']`.
2. Добавлен модуль `packages/twenty-server/src/engine/core-modules/crm-audit/core-user-and-workspace-audit.ts`:
   - `captureCoreUserAndWorkspaceAudit` и `withCoreUserAndWorkspaceAudit` (`AsyncLocalStorage`) для синхронного захвата серверной атрибуции (`actor`, `initiator`, `impersonatorUserWorkspaceId`, `correlationId`, `causationId`, `workspaceId`) до первого `await` с защитой от повторного потребления одноразовых запросов (`WeakSet`).
   - `recordAuditedUserWorkspaceCreate`: транзакционная запись `userWorkspace` (`create`) на активном `QueryRunner` (как в собственной `runInCoreAuditTransaction`, так и на внешнем `queryRunner` при `SignInUpService.signUpOnNewWorkspace`) с проверкой активности `core."user"` (`FOR SHARE`) и `core.workspace`, сверкой сохранённой строки до и после `context.flush()` и редактированием `defaultAvatarUrl`.
   - `runAuditedUserWorkspaceLocaleUpdate`: транзакционное обновление `locale` (`userWorkspace` `update`) под `FOR NO KEY UPDATE` на `core."userWorkspace"` с проверкой активности пользователя и рабочего пространства, пропуском no-op изменений, сверкой до и после `context.flush()` и гарантированной инвалидацией кэша `userWorkspaceEntity` в `finally`.
   - `recordAuditedCoreUserUpdate`: транзакционная запись `coreUser` (`update`) во все активные рабочие пространства пользователя (`FOR KEY SHARE OF uw`) и явные рабочие пространства операции (включая `actorWorkspaceId` при `updateServerAdminAccess`), пропуская мягко удалённые рабочие пространства и связывая записи общим `correlationId`.
3. Подключены все входные точки создания и обновления `userWorkspace` и активных обновлений `coreUser`:
   - `UserWorkspaceService.create`, `UserWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace`, `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` (с общим `correlationId` между `userWorkspace` `create` и `roleTarget` `create` через `role-update-audit.ts`).
   - `UserResolver.updateWorkspaceMemberSettings` (пользовательская сессия, имперсонация с разрешением `initiator`, API-ключ, приложение с инициатором) и `GlobalWorkspaceMemberListener.syncUserWorkspaceLocale`.
   - `AdminPanelServerAdminService.updateServerAdminAccess` и `AdminPanelResolver.updateServerAdminAccess`.
   - `UserService.updateActiveUser` (`markEmailAsVerified`, `updateEmailFromVerificationToken`), `UserService.updateUserEmail` и `UserResolver.updateUserEmail` (включая имперсонацию).
   - `SignInUpService.signInUpWithPersonalInvitation`, `SignInUpService.signUpOnNewWorkspace` (переведён на `runInCoreAuditTransaction` с отправкой телеметрии `saveNewUser` после `COMMIT`), `SSOAuthController` и `runAuditedPasswordUpdate` (`password-update-audit.ts`).

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `17` suites / `396` tests PASS (`36.618s`), включая `3` новых интеграционных теста в `packages/twenty-server/test/fork-migration/crm-audit-core-user-and-workspace.postgres-spec.ts`.
- Полный регрессионный прогон: `118` suites / `3163` tests PASS (`698.449s`) - [`regression.log`](regression.log).
- Guard unit tests: `33` tests PASS (`0.185s`), `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `483` baseline / `485` current roots, `303` baseline / `303` current diagnostics, `0` новых и `0` в изменённом коде - [`typecheck-differential.json`](typecheck-differential.json).
- Снимок исходников: `13` файлов проверены по SHA-256 (LF) - [`source-snapshot.json`](source-snapshot.json).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
