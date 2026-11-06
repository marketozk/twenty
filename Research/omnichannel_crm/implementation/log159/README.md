# LOG159 - аудит пакетного и первичного назначения ролей участникам (`assignRoleToManyUserWorkspace`)

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG159 закрывает все прямые и пакетные вызовы `UserRoleService.assignRoleToManyUserWorkspace`: первичное назначение роли участнику при вступлении в воркспейс (`UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace`), bootstrap-назначения при инициализации воркспейса (`WorkspaceManagerService.setupDefaultRoles`) и сидировании (`DevSeederPermissionsService.initPermissions`), а также любые прямые одиночные и пакетные вызовы `assignRoleToManyUserWorkspace`.

В `role-assignment-audit.ts` добавлены `BulkUserAssignmentTarget`, `withBulkUserRoleAssignmentAudit` и ветка `targetKind === 'userWorkspaceBulk'` в `runAuditedRoleAssignment`. Внутри единой транзакции `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), всех целевых `core."userWorkspace"` (`FOR SHARE`), всех целевых `workspaceMember` (`FOR SHARE` при `requireWorkspaceMember !== false`), существующих `core."roleTarget"` (`FOR UPDATE`) и `core.role` (`FOR SHARE`). Проверяются `canBeAssignedToUsers === true`, запрет самоназначения по `actingUserWorkspaceId`, `actor` и `initiator`, а также защита от одновременного разжалования всех администраторов воркспейса (`NOT (u.id=ANY($3::uuid[]))`). После выполнения обработчиков `DeleteRoleTargetActionHandlerService` и `CreateRoleTargetActionHandlerService` перечитываются строки `core."roleTarget"`, сверяются все скалярные поля и микросекундные `createdAt`/`updatedAt`, записываются события `roleTarget` (`delete` и `create`) с единым `operationId` и выполняется повторная верификация после `audit.flush()`.

В `UserRoleService.assignRoleToManyUserWorkspace` входной массив `userWorkspaceIds` и `auditIdentity` захватываются синхронно до первого `await`. При вызове внутри уже открытого одиночного контекста `withRoleAssignmentAudit` (делегирование из `assignRoleToWorkspaceMember`) строго проверяется совпадение `workspaceId`, `roleId`, единственного `userWorkspaceId` и `actingUserWorkspaceId`. При прямом вызове `auditIdentity` обязателен даже для пустого массива или полного no-op, а `requireWorkspaceMember: false` разрешён исключительно для `auth.type === 'system'`.

4805 tests/164 suites PASS (1395.066s). 262 targeted/7 suites PASS (23.74s), 12 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 457/458 roots, baseline 237 / current 237 diagnostics, 0 новых/changed-code. Совпали 7 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [аудит оставшихся метаданных и привязок `roleTarget` (`DevSeederPermissionsService` API-key seed / прочие metadata writers)](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
