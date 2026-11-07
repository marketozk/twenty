# LOG163 - аудит смены роли по умолчанию (`core.workspace."defaultRoleId"`)

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG163 закрывает все три runtime-пути записи `core.workspace."defaultRoleId"`: публичное изменение через `WorkspaceService.updateWorkspaceById` (`WorkspaceResolver.updateWorkspace`) и первичную установку при инициализации рабочего пространства в `WorkspaceManagerService.setupDefaultRoles` и `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`.

В `workspace-default-role-audit.ts` добавлены захват операции `captureWorkspaceDefaultRoleAudit` (с регистрацией `registerMetadataAuditScopeCheck`) и закрытая однотранзакционная функция `runAuditedWorkspaceDefaultRoleUpdate`. Внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`, сериализующая смену роли по умолчанию со всеми операциями удаления и перепривязки ролей) и `core.role` (`FOR SHARE`, удерживающая целевую роль и `canBeAssignedToUsers === true` до `COMMIT`). Значение `null` и невалидные UUID отклоняются fail-closed. После выполнения `work(runner)` и повторно после `audit.flush()` проверяется сохранённое состояние строки `core.workspace` и неизменность целевой роли. При фактическом изменении `defaultRoleId` записывается событие `workspace` (`update`, `changedFields: ['defaultRoleId']`, `metadataAccess: 'currentWorkspaceAdministration'`); идемпотентный повтор обновляет попутные поля запроса без ложной записи в журнал.

В `WorkspaceService.updateWorkspaceById` входной `payload` и снимок `auditIdentity` фиксируются синхронно до первого `await` (исключая TOCTOU-мутацию аргументов во время проверок), на пространстве со статусом `PENDING_CREATION` сохраняется штатный `PermissionsException` из `validateWorkspaceUpdatePermissions`, а для активных пространств невалидный или отсутствующий `auditIdentity` отклоняется до проверок прав и до внешних вызовов DNS. При `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` кэш `workspaceEntity` инвалидируется в защищённом `try / catch`, а зарегистрированный `customDomain` не удаляется в `catch`.

3107 tests/108 suites PASS (679.92s). 189 targeted/10 PostgreSQL suites PASS (19.504s), 8 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 460/462 roots, baseline 237 / current 236 diagnostics, 0 новых/changed-code. Совпали 10 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [аудит `core.application."defaultRoleId"` и записей метаданных при установке, синхронизации и удалении приложений](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
