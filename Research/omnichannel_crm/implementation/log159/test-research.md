# LOG159 — план проверок аудита пакетного и первичного назначения ролей участникам (`assignRoleToManyUserWorkspace`)

## Реальные пути выполнения (Real-Path Gate)

1. **`UserRoleService.assignRoleToManyUserWorkspace` (прямой пакетный вызов) -> `withBulkUserRoleAssignmentAudit` -> `RoleTargetService.createMany` -> `WorkspaceMigrationRunnerService.executeRun` -> `runAuditedRoleAssignment` (`targetKind: 'userWorkspaceBulk'`)**:
   - В одной транзакции `runInCoreAuditTransaction` блокирует `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR SHARE`), все целевые `core."userWorkspace"` (`FOR SHARE`), все целевые `${memberTable}` (`FOR SHARE`), существующие `core."roleTarget"` (`FOR UPDATE`) и `core.role` (`FOR SHARE`), проверяет запрет самоназначения и остаток `>= 1` активного администратора при пакетном разжаловании, выполняет удаление старых и вставку новых `core."roleTarget"`, записывает атомарные события `roleTarget` (`delete` и `create`) с общим `operationId` до `COMMIT` и повторно сверяет состояние после `audit.flush()`.
2. **`UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` -> `UserRoleService.assignRoleToManyUserWorkspace`**:
   - После создания `userWorkspace`, `workspaceMember` и инвалидации `flatWorkspaceMemberMaps` назначает роль с системным субъектом `{ kind: 'system', id: 'user-workspace:add-user-to-workspace' }` и полной проверкой `userWorkspace` + `workspaceMember` в БД.
3. **`WorkspaceManagerService.setupDefaultRoles` / `DevSeederPermissionsService.initPermissions` -> `UserRoleService.assignRoleToManyUserWorkspace` (`requireWorkspaceMember: false`, `auth.type === 'system'`)**:
   - Назначает роль `Admin` / роли сидера с системным субъектом `{ kind: 'system', id: 'workspace-manager:setup-default-roles' }` / `'dev-seeder:init-permissions'` и проверкой `core."userWorkspace"` под блокировкой `FOR SHARE`.

## Матрица интеграционных проверок PostgreSQL (`crm-audit-bulk-role-assignment.postgres-spec.ts`)

1. **Пакетное назначение роли нескольким участникам (`assignRoleToManyUserWorkspace` с заменой существующих `roleTarget` и созданием новых, плюс пропуск участников, уже имеющих целевую роль)**:
   - В одной транзакции заменяет `roleTarget` у участников с другой ролью, создаёт `roleTarget` для участника без роли, пропускает участника, уже имеющего `destinationId`, и записывает все события `roleTarget` (`delete` и `create`) с единым `operationId`.
2. **Первичное назначение роли при вступлении в воркспейс (`UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace`) и при инициализации воркспейса (`WorkspaceManagerService.setupDefaultRoles`)**:
   - Проверяет запись аудита с акторами `{ kind: 'system', id: 'user-workspace:add-user-to-workspace' }` и `{ kind: 'system', id: 'workspace-manager:setup-default-roles' }`.
3. **Запрет пакетного разжалования всех администраторов (когда 2 из 2 администраторов разжалуются в одном батче, и когда 1 из 2 разжалуется успешно)**:
   - При передаче обоих администраторов `[admin1, admin2]` выбрасывается ошибка (как на предмиграционной проверке, так и под блокировками БД при конкурентном удалении третьего администратора) без изменения `core."roleTarget"` и без записи аудита; при передаче одного из двух администраторов `[admin1, nonAdmin]` транзакция проходит успешно.
4. **Запрет `requireWorkspaceMember: false` для не-системного субъекта (`user` / `apiKey` / `application`) и отказ при отсутствии `auditIdentity`**:
   - Отклоняет вызов до любых обращений к кэшу и БД.
5. **Запрет самоназначения в пакете (`actingUserWorkspaceId` или `actor.id === workspaceMemberId` одного из участников пакета)**:
   - Отклоняет весь пакет до миграции и под блокировками БД.
6. **Отказ при деактивированном/удалённом `userWorkspace` или `workspaceMember`, чужом `workspaceId`, `canBeAssignedToUsers === false` или мутации `oldTarget` в БД**:
   - Полный откат всего пакета без частичного применения.
7. **Защита от мутации входного массива `userWorkspaceIds` (и дубликатов в массиве) после старта вызова, потеря ACK `COMMIT` (`NativeTransactionOutcomeUnknownError`) и триггерное искажение после `audit.flush()`**:
   - Мутация входного массива после старта промиса не влияет на план; при потере ACK `COMMIT` инвалидируется кэш и выбрасывается `NativeTransactionOutcomeUnknownError`; при модификации `core."roleTarget"` триггером во время `audit.flush()` вся пакетная транзакция откатывается.
