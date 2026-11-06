# LOG159 — независимое критическое ревью дизайна и плана тестирования (`assignRoleToManyUserWorkspace`)

## Вердикт

Дизайн (`design.md`) и план проверок (`test-research.md`) для `LOG159` архитектурно согласованы с закрытыми в `LOG111`–`LOG113` и `LOG156`–`LOG158` механизмами транзакционного CRM-аудита и одобрены к реализации с учётом обязательных инвариантов реализации, перечисленных ниже.

---

## 1. Проверка совместимости `assignRoleToWorkspaceMember` и прямых вызовов `assignRoleToManyUserWorkspace`

### Анализ пути выполнения
- `UserRoleService.assignRoleToWorkspaceMember` (`packages/twenty-server/src/engine/metadata-modules/user-role/user-role.service.ts:98-115`) открывает одиночный контекст `withRoleAssignmentAudit` (`targetKind: 'userWorkspace'`, `mode: 'assign'`) и внутри него делегирует выполнение в `this.assignRoleToManyUserWorkspace({ workspaceId, userWorkspaceIds: [userWorkspace.id], roleId, actingUserWorkspaceId })`.
- Прямые вызовы `assignRoleToManyUserWorkspace` происходят вне активного `withRoleAssignmentAudit` в трёх runtime-точках:
  1. `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` (`user-workspace.service.ts:301-305`)
  2. `WorkspaceManagerService.setupDefaultRoles` (`workspace-manager.service.ts:117-121`)
  3. `DevSeederPermissionsService.initPermissions` (`dev-seeder-permissions.service.ts:114, 127, 139, 160, 172`)

### Обязательные инварианты на границе `assignRoleToManyUserWorkspace`
1. **Синхронный захват и дедупликация входов до первого `await`**:
   - Входной массив `userWorkspaceIds` должен клонироваться и дедуплицироваться синхронно в начале метода (`const normalizedUserWorkspaceIds = [...new Set(Array.from(userWorkspaceIds))]`), чтобы мутация массива вызывающим кодом после старта промиса или дублирующиеся ID не исказили план миграции и набор целей `targets`.
2. **Строгая верификация при наличии открытого одиночного контекста `getRoleAssignmentAudit(workspaceId)`**:
   - Если `getRoleAssignmentAudit(workspaceId)` возвращает активный запрос `existingAudit`, метод обязан проверить:
     - `existingAudit.targetKind === 'userWorkspace'` и `existingAudit.mode === 'assign'`;
     - `requireWorkspaceMember !== false` (флаг bootstrap-режима недопустим внутри `assignRoleToWorkspaceMember`);
     - `existingAudit.workspaceId === workspaceId.toLowerCase()` и `existingAudit.roleId === roleId.toLowerCase()`;
     - `normalizedUserWorkspaceIds.length === 1` и `normalizedUserWorkspaceIds[0].toLowerCase() === existingAudit.userWorkspaceId`;
     - совпадение `actingUserWorkspaceId?.toLowerCase()` с `existingAudit.actingUserWorkspaceId`.
   - При любом расхождении выбрасывается ошибка до обращения к БД/кэшу.
   - Повторный вызов `this.roleAssignmentValidationService.validateRoleAssignableToUsersOrThrow` внутри уже открытого одиночного контекста выполнять не следует, так как `assignRoleToWorkspaceMember` уже вызывает его на строке 94 (существующий интеграционный тест в `crm-audit-role-assignment.postgres-spec.ts:985` проверяет `toHaveBeenCalledTimes(1)`).
3. **Прямой вызов вне `withRoleAssignmentAudit`**:
   - До первого `await` (и до раннего выхода `if (normalizedUserWorkspaceIds.length === 0) return;`) необходимо:
     - проверить отсутствие конфликтующего контекста аудита (`getRoleMutationAudit(workspaceId)` и `hasConflictingMetadataAuditScope(workspaceId, getRoleAssignmentAudit)`);
     - провалидировать `auditIdentity` через `captureRoleAuditIdentity` и `captureRoleAuditOperation(workspaceId, capturedIdentity)`, чтобы вызов без `auditIdentity` или с невалидным `auditIdentity` гарантированно отклонялся даже при пустом массиве `userWorkspaceIds` или фактическом no-op;
     - проверить ограничение `if (requireWorkspaceMember === false && capturedIdentity.auth.type !== 'system') throw new Error(...)`.
   - Вызов `validateRoleAssignableToUsersOrThrow({ roleId, workspaceId })` в прямом пути должен выполняться после `if (userWorkspaceIdsToAssign.length === 0) return;`, чтобы полный no-op не обращался к валидатору назначения роли (в соответствии с контрактом `crm-audit-role-assignment.postgres-spec.ts:1000`).

---

## 2. Защита от пакетного разжалования всех администраторов (Multi-Admin Demotion Protection)

### Уровень 1 — предмиграционная проверка в `validateAssignRoleInputsAndGetUserWorkspaceIdsToAssign`
- В текущей реализации (`user-role.service.ts:408-448`) проверяется только `workspaceMembersWithAdminRole.length === 1`, что пропускает одновременное разжалование `2` из `2` (или `M` из `M`) администраторов в одном батче.
- **Требование к реализации**:
  - В `validateAssignRoleInputsAndGetUserWorkspaceIdsToAssign` необходимо сначала проверить, что для каждого запрошенного `userWorkspaceId` найдена запись `userWorkspace` с `userWorkspace.workspaceId === workspaceId` и `(userWorkspace.deletedAt ?? null) === null` (иначе выбрасывать `PermissionsExceptionCode.USER_WORKSPACE_NOT_FOUND`).
  - Собрать множество всех `demotedAdminUserWorkspaceIds` среди `userWorkspaceIdsToAssign`, у которых текущая роль имеет `universalIdentifier === STANDARD_ROLE.admin.universalIdentifier`, а целевая `roleId !== currentRole.id`.
  - Если `demotedAdminUserWorkspaceIds.size > 0`, определить число остающихся активных администраторов воркспейса. Для точности рекомендуется проверять не просто арифметическую разность `workspaceMembersWithAdminRole.length - demotedAdminUserWorkspaceIds.size`, а то, что среди `userWorkspaceIdsAssignedToRole(adminRoleId, workspaceId)`, **не входящих** в `demotedAdminUserWorkspaceIds` и имеющих активного `workspaceMember` в `flatWorkspaceMemberMaps`, остаётся как минимум `1` администратор (`remainingAdminCount >= 1`). Если меньше `1` — выбрасывать `PermissionsException(PermissionsExceptionMessage.CANNOT_UNASSIGN_LAST_ADMIN, PermissionsExceptionCode.CANNOT_UNASSIGN_LAST_ADMIN, ...)`.

### Уровень 2 — транзакционная проверка под блокировками БД в `runAuditedRoleAssignment`
- Внутри `runInCoreAuditTransaction` после захвата блокировок `core.workspace` (`FOR NO KEY UPDATE`), `core."userWorkspace"` (`FOR SHARE`), `${memberTable}` (`FOR SHARE`), `core."roleTarget"` (`FOR UPDATE`) и `core.role` (`FOR SHARE`):
- Если среди заблокированных существующих `beforeRows` есть хотя бы одна строка с ролью `STANDARD_ROLE.admin.universalIdentifier`, а целевая роль `destination` не является `Admin`:
  1. Проверить `if (!memberTable) throw new Error('Role assignment cannot remove the last administrator')`, чтобы исключить выполнение SQL-запроса с пустым именем таблицы `${memberTable}` при отсутствии `workspace.databaseSchema`.
  2. Выполнить запрос с явным исключением всех разжалуемых `userWorkspaceId` пакета (`$3::uuid[]`):
     ```sql
     SELECT count(DISTINCT u.id)::int AS total
     FROM core."roleTarget" t
     JOIN core.role r ON r.id=t."roleId" AND r."workspaceId"=t."workspaceId"
     JOIN core."userWorkspace" u ON u.id=t."userWorkspaceId" AND u."workspaceId"=t."workspaceId" AND u."deletedAt" IS NULL
     JOIN ${memberTable} m ON m."userId"=u."userId" AND m."deletedAt" IS NULL
     WHERE t."workspaceId"=$1
       AND r."universalIdentifier"=$2
       AND NOT (u.id = ANY($3::uuid[]))
     ```
  3. Если `count.total < 1`, выбросить `new Error('Role assignment cannot remove the last administrator')`. Это закрывает как однопакетное разжалование всех администраторов, так и конкурентные гонки между несколькими транзакциями (сериализуемые через `FOR NO KEY UPDATE` на `core.workspace`).

---

## 3. Разграничение `requireWorkspaceMember: false` и `requireWorkspaceMember: true`

### Проверка реального порядка инициализации в кодовой базе
1. **`WorkspaceManagerService.setupDefaultRoles` (`workspace-manager.service.ts:97-138`)**:
   - Вызывается из `WorkspaceService.activateWorkspace` (`workspace.service.ts:564`) внутри `workspaceManagerService.init(...)`, тогда как `this.userWorkspaceService.createWorkspaceMember(workspace.id, user)` вызывается позже на строке `574`.
   - Следовательно, на момент назначения роли `Admin` создателю воркспейса запись в `core."userWorkspace"` уже существует, `core.workspace.databaseSchema` уже заполнен (строка `58`), но строка в `${memberTable}` ещё не создана. Использование `requireWorkspaceMember: false` и системного субъекта `systemActorId: 'workspace-manager:setup-default-roles'` полностью обосновано.
2. **`DevSeederPermissionsService.initPermissions` (`dev-seeder-permissions.service.ts:51-178`)**:
   - Вызывается из `DevSeederWorkspaceService.seedDev` на строке `171` после `seedCoreSchema` (строка `111`) и записи `databaseSchema` (строка `128`), но до `devSeederDataService.seed` (строка `226`), где создаются записи `workspaceMember`.
   - Использование `requireWorkspaceMember: false` и системного субъекта `systemActorId: 'dev-seeder:init-permissions'` для всех пяти вызовов `assignRoleToManyUserWorkspace` (строки `114`, `127`, `139`, `160`, `172`) также полностью обосновано.
3. **`UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` (`user-workspace.service.ts:269-317`)**:
   - На строках `288–299` последовательно выполняются `this.create(...)`, `this.createWorkspaceMember(workspace.id, user)` и `this.workspaceCacheService.invalidateAndRecompute(workspace.id, ['flatWorkspaceMemberMaps'])`.
   - К моменту вызова `this.userRoleService.assignRoleToManyUserWorkspace` на строке `301` и `userWorkspace`, и `workspaceMember` уже зафиксированы в БД и прогреты в кэше `flatWorkspaceMemberMaps`.
   - Поэтому использование режима по умолчанию `requireWorkspaceMember: true` с системным субъектом `systemActorId: 'user-workspace:add-user-to-workspace'` корректно и обеспечивает полную двухтабличную верификацию (`core."userWorkspace"` + `${memberTable}`).

### Защита от неправомерного использования `requireWorkspaceMember: false`
- Ограничение `requireWorkspaceMember === false` только для `identity.auth.type === 'system'` должно проверяться дважды:
  1. На входе в `UserRoleService.assignRoleToManyUserWorkspace` до первого `await`.
  2. На входе в `withBulkUserRoleAssignmentAudit` до первого `await`.
- При `requireWorkspaceMember !== false` каждый элемент `targets` обязан иметь валидный UUID `workspaceMemberId`, который проверяется под блокировкой `FOR SHARE` в `${memberTable}` на совпадение `id`, `userId` и `deletedAt === null`.

---

## 4. Изоляция enterprise-зависимостей (`check_enterprise_dependencies.py`)

- Проверен скрипт `scripts/omnichannel/check_enterprise_dependencies.py`.
- Все модифицируемые файлы (`role-assignment-audit.ts`, `user-role.service.ts`, `user-workspace.service.ts`, `workspace-manager.service.ts`, `dev-seeder-permissions.service.ts`) входят в runtime-граф `packages/twenty-server/src/`.
- Дизайн не вводит новых импортов в сторону `@license Enterprise` файлов, динамических `import()` / `require()`, непрозрачных `@Inject(...)` токенов или вызовов `moduleRef.get/resolve/create`. Изоляция enterprise-зависимостей полностью сохраняется.

---

## 5. Замечания и дополнения к плану тестирования (`test-research.md`)

1. **Обновление существующего теста в `crm-audit-role-assignment.postgres-spec.ts:1081-1093`**:
   - В `packages/twenty-server/test/fork-migration/crm-audit-role-assignment.postgres-spec.ts` на строках `1081–1093` находится тест `keeps bulk bootstrap assignment on its explicit legacy path`, который вызывает `service.assignRoleToManyUserWorkspace` без `auditIdentity` и ожидает пустой массив `audits()`.
   - После закрытия `assignRoleToManyUserWorkspace` в `LOG159` этот тест необходимо обновить, чтобы он проверял отказ при вызове без `auditIdentity` и запись атомарного аудита при передаче валидного `auditIdentity`.
2. **Проверка несовпадающего вложенного контекста `withRoleAssignmentAudit`**:
   - В `crm-audit-bulk-role-assignment.postgres-spec.ts` следует добавить проверку того, что вызов `assignRoleToManyUserWorkspace` внутри уже открытого `withRoleAssignmentAudit` с несовпадающим `roleId`, несовпадающим `userWorkspaceId`, массивом из `> 1` элементов или `requireWorkspaceMember: false` немедленно отклоняется без выполнения миграции.
3. **Соседнее наблюдение вне scope LOG159**:
   - В `DevSeederPermissionsService.initPermissions` (`dev-seeder-permissions.service.ts:74-82`) остаётся прямой вызов `this.roleTargetService.create` для привязки `API_KEY_DATA_SEED_IDS.ID_1` к роли `adminRole`. В рамках `LOG159` (`assignRoleToManyUserWorkspace`) трогать его не нужно (согласно дисциплине scope), но его стоит учитывать при последующем закрытии bootstrap/seed контуров в `ROB765`.
