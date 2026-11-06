# LOG159 — дизайн аудита пакетного и первичного назначения ролей участникам (`assignRoleToManyUserWorkspace`)

## Контекст и проблема

После `LOG113`, `LOG156`, `LOG157` и `LOG158` закрыты одиночные назначения ролей участникам (`UserRoleService.assignRoleToWorkspaceMember` / `AssignRoleToWorkspaceMemberTool`), агентам (`AiAgentRoleService.assignRoleToAgent` / `removeRoleFromAgent`) и API-ключам (`ApiKeyRoleService.assignRoleToApiKey` и `ApiKeyService.create`), а также создание/обновление/удаление ролей и upsert всех видов прав ролей.

При этом метод `UserRoleService.assignRoleToManyUserWorkspace` (`packages/twenty-server/src/engine/metadata-modules/user-role/user-role.service.ts:120-161`) и его прямые вызовы вне `assignRoleToWorkspaceMember` остаются открытыми в четырёх точках:

1. **Прямые вызовы `assignRoleToManyUserWorkspace` без активного контекста аудита**:
   - `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` (`packages/twenty-server/src/engine/core-modules/user-workspace/user-workspace.service.ts:301-305`) — назначение начальной роли (`roleId ?? workspace.defaultRoleId`) при вступлении пользователя в воркспейс по приглашению / SSO / регистрации после `createWorkspaceMember`.
   - `WorkspaceManagerService.setupDefaultRoles` (`packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts:117-121`) — назначение роли `Admin` создателю воркспейса при инициализации (`init`) до создания `workspaceMember`.
   - `DevSeederPermissionsService.initPermissions` (`packages/twenty-server/src/engine/workspace-manager/dev-seeder/core/services/dev-seeder-permissions.service.ts:114-177`) — пакетное и одиночное назначение ролей участникам при сидировании воркспейса.
2. **Ограничение `role-assignment-audit.ts` одной целью `userWorkspaceId`**:
   - `withRoleAssignmentAudit` и `runAuditedRoleAssignment` в `packages/twenty-server/src/engine/core-modules/crm-audit/role-assignment-audit.ts` принимают только одиночную цель (`creates.length === 1 && deletes.length <= 1`) и не поддерживают пакетную замену `K >= 1` целей `userWorkspaceId` в одной транзакции `RoleTargetService.createMany`.
3. **Уязвимость пакетного разжалования всех администраторов в `validateAssignRoleInputsAndGetUserWorkspaceIdsToAssign`**:
   - В `packages/twenty-server/src/engine/metadata-modules/user-role/user-role.service.ts:408-425` и `429-448` метод `validateMoreThanOneWorkspaceMemberHasAdminRoleOrThrow` проверяет только `workspaceMembersWithAdminRole.length === 1`. Если в воркспейсе 2 администратора и оба переданы в одном вызове `assignRoleToManyUserWorkspace({ userWorkspaceIds: [admin1, admin2], roleId: memberRoleId })`, проверка пропускает вызов, оставляя воркспейс с `0` администраторов.
   - Кроме того, `assignRoleToManyUserWorkspace` при прямом вызове не вызывает `roleAssignmentValidationService.validateRoleAssignableToUsersOrThrow`, не нормализует/дедуплицирует `userWorkspaceIds` и не проверяет принадлежность `userWorkspace.workspaceId === workspaceId` и `userWorkspace.deletedAt === null`.

## Варианты решения

### Вариант 1 (выбран): Расширение `role-assignment-audit.ts` (`withBulkUserRoleAssignmentAudit` и ветка `targetKind === 'userWorkspaceBulk'` в `runAuditedRoleAssignment`) и закрытие `UserRoleService.assignRoleToManyUserWorkspace`

1. **`withBulkUserRoleAssignmentAudit` и `runAuditedRoleAssignment` в `role-assignment-audit.ts`**:
   - Добавить тип цели `BulkUserAssignmentTarget`:
     ```ts
     export type BulkUserAssignmentTarget = Readonly<{
       userWorkspaceId: string;
       userId: string;
       workspaceMemberId?: string | null;
     }>;
     ```
     и `withBulkUserRoleAssignmentAudit`:
     ```ts
     export const withBulkUserRoleAssignmentAudit = async <T>(
       input: {
         workspaceId: string;
         roleId: string;
         targets: readonly BulkUserAssignmentTarget[];
         actingUserWorkspaceId?: string;
         requireWorkspaceMember?: boolean;
       },
       identity: RoleUpdateAuditIdentity,
       work: () => Promise<T>,
     ): Promise<T>
     ```
   - До первого `await` в `withBulkUserRoleAssignmentAudit`:
     - Проверить отсутствие активного или конфликтующего контекста аудита (`storage.getStore()`, `getRoleMutationAudit`, `hasConflictingMetadataAuditScope`).
     - Проверить `targets.length >= 1`, валидность и уникальность всех `userWorkspaceId` (и `workspaceMemberId`, если заданы).
     - Если `requireWorkspaceMember !== false` (по умолчанию `true`), каждый элемент `targets` обязан содержать валидный UUID `workspaceMemberId`.
     - Если `requireWorkspaceMember === false` (разрешено только для bootstrap-инициализации до создания `workspaceMember`), проверить, что `identity.auth.type === 'system'`; для любого не-системного субъекта выбрасывать ошибку до старта миграции.
   - В `runAuditedRoleAssignment` для `request.targetKind === 'userWorkspaceBulk'`:
     - Проверить, что `creates.length === request.targets.length`, `deletes.length <= request.targets.length`, `actions.length === creates.length + deletes.length`, все `actions` имеют `metadataName === 'roleTarget'`, и все `deletes` предшествуют `creates`.
     - Проверить однозначное соответствие `creates` набору `request.targets` (`userWorkspaceId`, `roleId`, `applicationUniversalIdentifier`, `apiKeyId === null`, `agentUniversalIdentifier === null`, валидные `createdAt` и `updatedAt`) и отсутствие дубликатов `id` / `universalIdentifier` в `creates` и `deletes`.
     - Внутри `runInCoreAuditTransaction`:
       1. `SET LOCAL lock_timeout = '8s'`.
       2. Заблокировать `core.workspace` (`FOR NO KEY UPDATE`, `deletedAt === null`, при `requireWorkspaceMember !== false` также `Boolean(workspace.databaseSchema)`).
       3. Проверить `core.application` (`FOR SHARE`, `verifyRoleAuditApplication`).
       4. Заблокировать все целевые строки `core."userWorkspace"` (`WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`) и проверить совпадение `id`, `userId`, `workspaceId` и `deletedAt === null` для всех `request.targets`.
       5. Для всех целей с `requireWorkspaceMember !== false` (или непустым `workspaceMemberId`) заблокировать строки `${memberTable}` (`WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`) и проверить совпадение `id`, `userId` и `deletedAt === null`.
       6. Проверить запрет самоназначения (`actingUserWorkspaceId`, `actor.id`, `initiator.id`) по всем элементам `request.targets`.
       7. Заблокировать существующие строки `core."roleTarget"` (`WHERE "workspaceId" = $1 AND ("userWorkspaceId" = ANY($2::uuid[]) OR id = ANY($3::uuid[])) ORDER BY id FOR UPDATE`) и сверить точное совпадение набора `beforeRows` с `plannedDeletes`.
       8. Заблокировать `core.role` (`FOR SHARE`) для целевой роли и всех исходных ролей `beforeRows`, проверив `destination.canBeAssignedToUsers === true` и совпадение `universalIdentifier`.
       9. Если среди `beforeRows` есть строки с ролью `STANDARD_ROLE.admin.universalIdentifier`, а целевая роль не является `Admin`, проверить под блокировками БД, что число остающихся активных администраторов вне множества разжалуемых `demotedAdminUserWorkspaceIds` (`NOT (u.id = ANY($3::uuid[]))`) не меньше `1` (`remaining >= 1`).
       10. Выполнить `await work(runner)`, перечитать `core."roleTarget"` (`FOR UPDATE`), сверить все созданные строки и микросекундные `createdAt`/`updatedAt`, отсутствие удалённых строк, записать в `audit` все `delete` и `create` записи `roleTarget` с общим `operationId`, вызвать `await audit.flush()` и повторно сверить состояние после `audit.flush()`.
2. **Закрытие `UserRoleService.assignRoleToManyUserWorkspace` (`user-role.service.ts`)**:
   - Когда `assignRoleToManyUserWorkspace` вызывается внутри уже открытого одиночного контекста `getRoleAssignmentAudit(workspaceId)` (из `assignRoleToWorkspaceMember`), проверить соответствие активного контекста (`targetKind === 'userWorkspace'`, `roleId`, единственного `userWorkspaceId`) и выполнить `roleTargetService.createMany` внутри существующего контекста.
   - Когда `assignRoleToManyUserWorkspace` вызывается напрямую (вне `assignRoleToWorkspaceMember`):
     - До первого `await` клонировать и дедуплицировать `userWorkspaceIds`, провалидировать `auditIdentity` через `captureRoleAuditIdentity` и `captureRoleAuditOperation` (и отклонить `requireWorkspaceMember === false` при `auth.type !== 'system'`).
     - Проверить `validateNotSelfAssignmentOrThrow` и `validateRoleAssignableToUsersOrThrow`.
     - В `validateAssignRoleInputsAndGetUserWorkspaceIdsToAssign` проверять принадлежность всех `userWorkspace` текущему `workspaceId` и `(userWorkspace.deletedAt ?? null) === null`, а при разжаловании `M >= 1` администраторов проверять `workspaceMembersWithAdminRole.length - M >= 1`.
     - Разрешить `workspaceMemberId` для каждого `userWorkspaceId` из `userWorkspaceIdsToAssign` (через `flatWorkspaceMemberMaps` или `workspaceOrmManager` при `requireWorkspaceMember !== false`), проверить запрет самоназначения по `workspaceMemberId` и обернуть `roleTargetService.createMany` в `withBulkUserRoleAssignmentAudit`.
3. **Обновление точек вызова**:
   - `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace`: передавать `auditIdentity: { auth: { workspace: { id: workspace.id }, type: 'system' }, systemActorId: 'user-workspace:add-user-to-workspace' }` (с `requireWorkspaceMember: true`, так как `createWorkspaceMember` и инвалидация `flatWorkspaceMemberMaps` выполняются непосредственно перед вызовом).
   - `WorkspaceManagerService.setupDefaultRoles`: передавать `requireWorkspaceMember: false` и `auditIdentity: { auth: { workspace: { id: workspaceId }, type: 'system' }, systemActorId: 'workspace-manager:setup-default-roles' }`.
   - `DevSeederPermissionsService.initPermissions`: передавать `requireWorkspaceMember: false` и `auditIdentity: { auth: { workspace: { id: workspaceId }, type: 'system' }, systemActorId: 'dev-seeder:init-permissions' }`.

### Вариант 2 (отклонён): Последовательный вызов `assignRoleToWorkspaceMember` в цикле для каждого `userWorkspaceId`

- Разбивает пакетную операцию `assignRoleToManyUserWorkspace` на `K` независимых транзакций и `K` миграций воркспейса, нарушая атомарность пакета и не работая в `WorkspaceManagerService.setupDefaultRoles` (где `workspaceMember` создаётся после `init`).
