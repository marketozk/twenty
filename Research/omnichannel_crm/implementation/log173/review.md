# LOG-173 - Отчёт независимого ревью кода (`review.md`)

## 1. Вердикт

- Первичный проход: `PASS` (`0 blocker`, `0 major`, `3 minor`).
- После исправления всех 3 `minor` замечаний (`m1`–`m3`): `PASS` (`0` открытых замечаний).

## 2. Проверенные файлы

- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/core-user-and-workspace-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/role-update-audit.ts`
- `packages/twenty-server/src/engine/core-modules/crm-audit/password-update-audit.ts`
- `packages/twenty-server/src/engine/core-modules/user-workspace/user-workspace.service.ts`
- `packages/twenty-server/src/engine/core-modules/user/services/user.service.ts`
- `packages/twenty-server/src/engine/core-modules/user/user.resolver.ts`
- `packages/twenty-server/src/engine/core-modules/user/services/global-workspace-member.listener.ts`
- `packages/twenty-server/src/engine/core-modules/admin-panel/services/admin-panel-server-admin.service.ts`
- `packages/twenty-server/src/engine/core-modules/admin-panel/admin-panel.resolver.ts`
- `packages/twenty-server/src/engine/core-modules/auth/services/sign-in-up.service.ts`
- `packages/twenty-server/src/engine/core-modules/auth/controllers/sso-auth.controller.ts`
- `packages/twenty-server/test/fork-migration/crm-audit-core-user-and-workspace.postgres-spec.ts`

## 3. Замечания и их закрытие

| # | Серьёзность | Находка | Решение |
|---|---|---|---|
| m1 | `minor` | В `SignInUpService.signUpOnNewWorkspace` использовался `this.dataSource.transaction(...)` и телеметрия `saveNewUser` отправлялась до подтверждённого `COMMIT`. | `SignInUpService.signUpOnNewWorkspace` переведён на `runInCoreAuditTransaction(this.dataSource, ...)` с синхронным захватом `userData` до первого `await`, а отправка телеметрии/событий/метрик `emitNewUserSignupTelemetry` при переданном `queryRunner` вынесена после подтверждённого `COMMIT`. |
| m2 | `minor` | Повторная передача уже потреблённого `CoreUserAndWorkspaceAuditRequest` в `captureCoreUserAndWorkspaceAudit({ ..., identity })` могла создать новый запрос вместо немедленного отказа. | В `captureCoreUserAndWorkspaceAudit` добавлена проверка `consumedRequests.has(identity)` (немедленный отказ) и `activeRequests.has(identity)` (возврат того же одноразового токена без повторного обёртывания); добавлена проверка в `crm-audit-core-user-and-workspace.postgres-spec.ts`. |
| m3 | `minor` | Проверить работу обёрток `withCoreUserAndWorkspaceAudit` и одноразового потребления на сервисных и резолверных путях. | В `crm-audit-core-user-and-workspace.postgres-spec.ts` проверены многошаговый поток `withCoreUserAndWorkspaceAudit` и отказ при передаче потреблённого запроса в `userService.markEmailAsVerified`. |
