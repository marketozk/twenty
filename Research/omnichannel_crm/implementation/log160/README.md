# LOG160 - аудит системного и bootstrap-создания ролей, прав и привязок `roleTarget`

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG160 закрывает все системные и bootstrap-пути создания ролей, прав и привязок `roleTarget` в `RoleService`, `RoleTargetService`, `WorkspaceManagerService` и `DevSeederPermissionsService`: `RoleService.createRole`, `RoleService.createMemberRole`, `RoleService.createGuestRole`, `RoleService.createWorkspaceCustomApplicationRole` (`isEditable: false`), согласование `applicationUniversalIdentifier` в `RoleTargetService.createMany` при явном `applicationId` и системную передачу `auditIdentity` во всех вызовах `WorkspaceManagerService.init` / `setupDefaultRoles` и `DevSeederPermissionsService.initPermissions` / `initMinimalPermissionsAndActivateWorkspace` / `createImpersonateOnlyRoleForSeedWorkspace` / `createLimitedRoleForSeedWorkspace`.

В `role-update-audit.ts` в `withRoleCreateAudit` до проверки полей синхронно валидируется `capturedIdentity = captureRoleAuditIdentity(identity)`, а значение `expected.isEditable === false` разрешено строго тогда и только тогда, когда `capturedIdentity.auth.type === 'system'` и `expected.universalIdentifier === WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()` (`'b5b505e2-8834-457f-a301-f1f4694fe365'`). Любые другие субъекты или `universalIdentifier` с `isEditable: false` синхронно отвергаются.

В `RoleService` методы `createRole`, `createMemberRole`, `createGuestRole` и `createWorkspaceCustomApplicationRole` синхронно до первого `await` проверяют отсутствие конфликтующих аудит-контекстов и валидируют `auditIdentity` (включая идемпотентную ветку `createWorkspaceCustomApplicationRole`, когда роль уже существует). В `RoleTargetService.createMany` при совпадении `applicationUniversalIdentifier` у всех создаваемых целей в `validateBuildAndRunWorkspaceMigration` передаётся именно этот `applicationUniversalIdentifier`, что обеспечивает консистентность проверки `verifyRoleAuditApplication` при создании `roleTarget` с явным `applicationId` (`twentyStandardFlatApplication.id` в `DevSeederPermissionsService`).

3079 tests/105 suites PASS (679.211s). 270 targeted/8 suites PASS (24.892s), 9 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 458/459 roots, baseline 237 / current 237 diagnostics, 0 новых/changed-code. Совпали 7 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [оставшиеся операции ролей агентов в шагах workflow и core/native writers](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
