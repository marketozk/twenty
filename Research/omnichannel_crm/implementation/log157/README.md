# LOG157 - аудит upsert флагов прав, объектных/полевых прав и предикатов строкового доступа роли

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG157 закрывает все четыре публичные и AI-точки изменения прав роли: upsert флагов прав (`RolePermissionFlagService.upsertPermissionFlags`, `RoleResolver.upsertPermissionFlags`), upsert объектных прав (`ObjectPermissionService.upsertObjectPermissions`, `RoleResolver.upsertObjectPermissions`, `UpsertObjectPermissionsTool.execute`), upsert полевых прав (`FieldPermissionService.upsertFieldPermissions`, `RoleResolver.upsertFieldPermissions`) и upsert групп и предикатов строкового доступа (`RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`, `UpsertRowLevelPermissionRulesTool.execute`).

В `crm-audit.types.ts` и `crm-audit-transaction-context.ts` добавлены пять административных видов ресурсов (`rolePermissionFlag`, `objectPermission`, `fieldPermission`, `rowLevelPermissionPredicateGroup`, `rowLevelPermissionPredicate`) с обязательным дескриптором `{ resourceKind, resourceId, metadataAccess: 'currentWorkspaceAdministration' }` и редактированием литерального фильтра `value` и `deletedAt` в предикатах строкового доступа.

В `role-permission-audit.ts` и `WorkspaceMigrationRunnerService` добавлены `withRolePermissionFlagUpsertAudit`, `withObjectPermissionUpsertAudit`, `withFieldPermissionUpsertAudit`, `withRowLevelPermissionUpsertAudit` и `runAuditedRolePermissionUpsert`, а также сброс кэша `rolesPermissions` при изменении `flatRowLevelPermissionPredicateMaps` и `flatRowLevelPermissionPredicateGroupMaps`. Внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), `core.role` (`FOR UPDATE`, проверка `isEditable === true` и принадлежности `applicationId`), целевых и ссылочных таблиц (`FOR UPDATE` / `FOR SHARE`), проверяются защита от снятия собственного флага `ROLES` при `canUpdateAllSettings !== true`, согласованность флагов чтения/записи `objectPermission`, принадлежность несистемных объектов и полей (включая зеркальные поля связей) для `fieldPermission`, отсутствие каскадного удаления дочерних предикатов и групп `ON DELETE CASCADE` и принадлежность `workspaceMemberFieldMetadataId` объекту `workspaceMember` для RLS, записываются атомарные записи аудита до `COMMIT` и повторно проверяется состояние после `audit.flush()`.

3046 tests/102 suites PASS (678.027s). 128 targeted/4 suites PASS (9.811s), 11 unit/1 suite PASS (4.922s), 12 новых PostgreSQL случаев. 26 guard tests PASS, 10 migration checksums неизменны. Types 458/460 roots, baseline 250 / current 250 diagnostics, 0 новых/changed-code. Совпали 13 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [аудит создания, обновления и отзыва API-ключей с атомарной привязкой roleTarget](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
