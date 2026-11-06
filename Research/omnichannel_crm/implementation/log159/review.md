# LOG159 — независимое критическое ревью кода и безопасности (`assignRoleToManyUserWorkspace`)

## Вердикт

**Одобрено (PASS).** Реализация `LOG159` («Audited bulk and initial member role assignments via `UserRoleService.assignRoleToManyUserWorkspace`») закрывает все прямые и пакетные пути назначения ролей участникам воркспейса, соблюдает транзакционные инварианты CRM-аудита и правила репозитория. Критических и блокирующих замечаний нет.

---

## 1. Проверка обязательных инвариантов безопасности и корректности

### 1.1. Обязательность `auditIdentity` и кооперация с `assignRoleToWorkspaceMember`
- **Файл**: `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\metadata-modules\user-role\user-role.service.ts` (строки `127–335`).
- **Синхронный захват входных данных до первого `await`**:
  - На строках `142–149` синхронно проверяется `Array.isArray(userWorkspaceIds)`, фиксируются скалярные аргументы и создаётся дедуплицированная копия `const capturedUserWorkspaceIds = [...new Set(Array.from(userWorkspaceIds))]`. Мутация входного массива или объекта `auditIdentity` вызывающим кодом после старта промиса не влияет на выполнение (подтверждено тестом в `crm-audit-bulk-role-assignment.postgres-spec.ts:1190-1223`).
- **Кооперация с открытым одиночным контекстом `withRoleAssignmentAudit` (`assignRoleToWorkspaceMember`)**:
  - На строках `151–199` при наличии активного `existingAudit = getRoleAssignmentAudit(capturedWorkspaceId)` строго проверяется:
    - `existingAudit.targetKind === 'userWorkspace'` и `existingAudit.mode === 'assign'`;
    - `capturedRequireWorkspaceMember === true` (`requireWorkspaceMember: false` внутри одиночного контекста отклоняется);
    - регистронезависимое совпадение `workspaceId`, `roleId`, единственного `userWorkspaceId` (`capturedUserWorkspaceIds.length === 1`) и `actingUserWorkspaceId`.
  - При любом расхождении выбрасывается `Error('Bulk role assignment conflicts with active role assignment audit scope')` до любых обращений к БД или кэшу.
  - Внутри уже открытого одиночного контекста повторный вызов `validateRoleAssignableToUsersOrThrow` не выполняется, что сохраняет инвариант одиночного вызова из `assignRoleToWorkspaceMember`.
- **Прямой вызов вне `withRoleAssignmentAudit`**:
  - На строках `201–227` до проверки `if (capturedUserWorkspaceIds.length === 0) return;` и до вычисления no-op (`if (userWorkspaceIdsToAssign.length === 0) return;`) синхронно проверяются конфликтующие контексты (`getRoleMutationAudit`, `hasConflictingMetadataAuditScope`) и валидируется `auditIdentity` через `captureRoleAuditIdentity` + `captureRoleAuditOperation`.
  - Вызов без `auditIdentity`, с чужим `workspace.id`, с `pendingActivationUser` или с `type: 'system'` без валидного `systemActorId` гарантированно отклоняется даже на пустом массиве `userWorkspaceIds: []` или полном no-op.

### 1.2. Транзакционные блокировки и верификация в `runAuditedRoleAssignment` (`targetKind === 'userWorkspaceBulk'`)
- **Файл**: `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\role-assignment-audit.ts` (строки `316–715`).
- **Предтранзакционная проверка плана миграции (строки `317–399`)**:
  - Проверяется активность и однократность использования `request` (`consumed.add(request)`).
  - Проверяется `creates.length === request.targets.length`, `deletes.length <= request.targets.length`, `actions.length === creates.length + deletes.length`, `metadataName === 'roleTarget'` для всех действий, и порядок: все `delete` строго перед всеми `create`.
  - Проверяется отсутствие дубликатов `id`, `universalIdentifier` и `userWorkspaceId`, принадлежность каждого `create` множеству `request.targets`, совпадение `roleId` и `applicationUniversalIdentifier`, равенство `apiKeyId === null` и `agentUniversalIdentifier === null`, валидность ISO-меток `createdAt` и `updatedAt`.
- **Внутри единой транзакции `runInCoreAuditTransaction` (строки `400–714`)**:
  1. Устанавливается `SET LOCAL lock_timeout = '8s'`.
  2. Блокируется `core.workspace` (`FOR NO KEY UPDATE`, строки `402–411`) с проверкой `deletedAt === null` и наличия `databaseSchema` при `requireWorkspaceMember === true`.
  3. Блокируется и верифицируется `core.application` (`FOR SHARE` через `verifyRoleAuditApplication`, строки `412–419`).
  4. Блокируются все целевые строки `core."userWorkspace"` (`WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`, строки `432–451`) с проверкой точного совпадения количества, `userId`, `workspaceId` и `deletedAt === null`.
  5. При `request.requireWorkspaceMember || targetMemberIds.length > 0` блокируются все целевые строки `${memberTable}` (`WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`, строки `452–490`) с проверкой `userId` и `deletedAt === null`.
  6. Проверяется запрет самоназначения по `actingUserWorkspaceId`, `operation.actor` и `operation.initiator` для каждой цели пакета (строки `494–505`).
  7. Блокируются существующие строки `core."roleTarget"` (`WHERE "workspaceId"=$1 AND ("userWorkspaceId"=ANY($2::uuid[]) OR id=ANY($3::uuid[])) ORDER BY id FOR UPDATE`, строки `507–542`) с проверкой точного биективного соответствия `plannedDeletes` и отсутствия `agentId` / `apiKeyId`.
  8. Блокируются целевая и исходные роли в `core.role` (`WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, строки `544–573`) с проверкой `destination.canBeAssignedToUsers === true` и совпадения `universalIdentifier`.
  9. После выполнения `await work(runner)` перечитываются строки `core."roleTarget"` (`FOR UPDATE`), сверяются все скалярные поля через `canonicalAuditJson` и микросекундные `createdAt`/`updatedAt` (`$2::timestamptz`, `$3::timestamptz`), проверяется отсутствие удалённых `id`, записываются события аудита `delete` и `create` с единым `operationId`, выполняется `await audit.flush()` и проводится полная пост-флаш верификация (`roleTarget`, `role`, `verifyBulkTargetOwners`, `verifyApplication`).

### 1.3. Защита от пакетного разжалования всех администраторов
- **Предмиграционный уровень** (`user-role.service.ts:581–641`):
  - В `validateAssignRoleInputsAndGetUserWorkspaceIdsToAssign` проверяется принадлежность каждого `userWorkspace` текущему `workspaceId` и `(userWorkspace.deletedAt ?? null) === null`.
  - Собирается множество `demotedAdminUserWorkspaceIds` всех участников батча, теряющих роль `Admin`, и в `validateMoreThanOneWorkspaceMemberHasAdminRoleOrThrow` проверяется `workspaceMembersWithAdminRole.length <= demotedCount` (`demotedAdminUserWorkspaceIds?.size ?? 1`), что блокирует одновременное разжалование всех администраторов до запуска миграции.
- **Транзакционный уровень под блокировками БД** (`role-assignment-audit.ts:575–604`):
  - Вычисляется массив `demotedAdminUserWorkspaceIds` по заблокированным `beforeTargets` и `roleById`.
  - Если `demotedAdminUserWorkspaceIds.length > 0`, проверяется наличие `memberTable` и выполняется SQL-запрос с исключением всех разжалуемых в пакете `userWorkspaceId`:
    ```sql
    SELECT count(DISTINCT u.id)::int AS total
    FROM core."roleTarget" t
    JOIN core.role r ON r.id=t."roleId" AND r."workspaceId"=t."workspaceId"
    JOIN core."userWorkspace" u ON u.id=t."userWorkspaceId" AND u."workspaceId"=t."workspaceId" AND u."deletedAt" IS NULL
    JOIN ${memberTable} m ON m."userId"=u."userId" AND m."deletedAt" IS NULL
    WHERE t."workspaceId"=$1
      AND r."universalIdentifier"=$2
      AND NOT (u.id=ANY($3::uuid[]))
    ```
  - При `(count?.total ?? 0) < 1` транзакция откатывается с ошибкой `'Role assignment cannot remove the last administrator'`. Это закрывает как однопакетное разжалование `M` из `M` администраторов, так и конкурентные гонки с удалением/разжалованием другого администратора.

### 1.4. Ограничение `requireWorkspaceMember: false` только для `auth.type === 'system'`
- Проверяется дважды до первого `await`:
  1. В `UserRoleService.assignRoleToManyUserWorkspace` (`user-role.service.ts:216–223`).
  2. В `withRoleAssignmentAudit` (`role-assignment-audit.ts:126–130`).
- Все точки вызова в runtime-коде используют корректный режим:
  - `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace` (`user-workspace.service.ts:301–312`) — вызывает `assignRoleToManyUserWorkspace` с `requireWorkspaceMember: true` (по умолчанию) и `systemActorId: 'user-workspace:add-user-to-workspace'` после создания `userWorkspace`, `workspaceMember` и инвалидации `flatWorkspaceMemberMaps`.
  - `WorkspaceManagerService.setupDefaultRoles` (`workspace-manager.service.ts:117–129`) — передаёт `requireWorkspaceMember: false` и `systemActorId: 'workspace-manager:setup-default-roles'` (так как `createWorkspaceMember` вызывается в `WorkspaceService.activateWorkspace` после `workspaceManagerService.init`).
  - `DevSeederPermissionsService.initPermissions` (`dev-seeder-permissions.service.ts:114, 135, 155, 184, 204`) — передаёт `requireWorkspaceMember: false` и `systemActorId: 'dev-seeder:init-permissions'` (так как `initPermissions` выполняется до `devSeederDataService.seed`).

### 1.5. Соблюдение правил репозитория (House Rules)
- Использование `any` отсутствует во всех изменённых и добавленных файлах.
- Проверка изоляции Enterprise-зависимостей (`python -I -X utf8 scripts/omnichannel/check_enterprise_dependencies.py`) проходит успешно (`"status": "pass"`, `0` нарушений).
- Комментарии краткие, только по существу (`//`), без JSDoc-блоков и без AI-атрибуции.

---

## 2. Покрытие тестами

- В `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\fork-migration\crm-audit-bulk-role-assignment.postgres-spec.ts` проверены:
  1. Первичное назначение роли участнику без существующего `roleTarget` (`user-workspace:add-user-to-workspace`).
  2. Bootstrap-назначение с `requireWorkspaceMember: false` до создания `workspaceMember` (`dev-seeder:init-permissions` и `WorkspaceManagerService.setupDefaultRoles`).
  3. Отказ при `requireWorkspaceMember: false` для не-системного субъекта (`user`).
  4. Смешанный пакет (замена роли + первичное назначение + пропуск no-op + дедупликация дубликатов `userWorkspaceId`) с единым `operationId`.
  5. Отказ при отсутствии или невалидности `auditIdentity` даже при `userWorkspaceIds: []` или полном no-op.
  6. Блокировка пакетного разжалования всех администраторов как на предмиграционной проверке, так и под блокировками БД при конкурентной деактивации третьего администратора.
  7. Запрет самоназначения через `actingUserWorkspaceId` и через `actor.workspaceMemberId`.
  8. Отказ при `canBeAssignedToUsers === false`, удалённом `userWorkspace` и отсутствующем `workspaceMember` при `requireWorkspaceMember: true`.
  9. Полный откат `core."roleTarget"` и `crm_audit."crmAuditEntry"` при сбое обработчика или искажении плана миграции.
  10. Отказ при вложенных/конфликтующих контекстах аудита и при несовпадающей делегации внутри `withRoleAssignmentAudit`.
  11. Защита от мутации входного массива `userWorkspaceIds` и объекта `auditIdentity` после старта промиса.
  12. Подавление `ROLLBACK` и инвалидация кэша при `NativeTransactionOutcomeUnknownError` после потери подтверждения `COMMIT`.
- В `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\fork-migration\crm-audit-role-assignment.postgres-spec.ts` (строки `1081–1103`) обновлён тест прямого вызова `assignRoleToManyUserWorkspace`: проверяется отказ без `auditIdentity` и запись атомарного аудита при передаче валидного `auditIdentity`.

---

## 3. Неблокирующие наблюдения

1. **Предмиграционная проверка `validateMoreThanOneWorkspaceMemberHasAdminRoleOrThrow` (`user-role.service.ts:615–641`)**:
   - Метод сравнивает общую численность `workspaceMembersWithAdminRole.length <= demotedCount`. Если в кэше числится администратор, не входящий в `flatWorkspaceMemberMaps`, численное сравнение в кэше менее точно, чем проверка пересечения множеств. На безопасность это не влияет, поскольку при `requireWorkspaceMember: true` наличие `workspaceMember` у всех целей проверяется до миграции, а внутри `runAuditedRoleAssignment` (`role-assignment-audit.ts:587–604`) выполняется точный SQL-запрос под блокировками БД с `NOT (u.id=ANY($3::uuid[]))`.
2. **Соседний вызов вне scope `LOG159`**:
   - В `DevSeederPermissionsService.initPermissions` (`dev-seeder-permissions.service.ts:74–82`) остаётся прямой вызов `this.roleTargetService.create` для seed API-ключа `API_KEY_DATA_SEED_IDS.ID_1`. В соответствии с дисциплиной scope `LOG159` он обоснованно не затронут.
