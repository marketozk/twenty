# LOG163 - дизайн аудита смены роли по умолчанию (`core.workspace."defaultRoleId"`)

## 1. Контекст

`workspace.defaultRoleId` определяет роль, которую получает каждый новый участник (приглашение по ссылке, одобренный домен, SSO), и роль, к которой перепривязываются участники при удалении их роли (`RoleService.deleteRole`). Подмена этой роли на роль с широкими правами выдаёт их всем новым участникам, поэтому это административное изменение прав (категория «Доступ» в [design/08-audit.md](../../design/08-audit.md)).

После LOG111-LOG162 все записи `core.role`, `core."roleTarget"` и прав ролей аудируются, а `defaultRoleId` пишется без аудита. Поиск по `src` (без тестов) нашёл ровно три записи в БД:

1. `WorkspaceService.updateWorkspaceById` (`workspace.service.ts:338-514`), вызывается только из `WorkspaceResolver.updateWorkspace` (`workspace.resolver.ts:173-195`). Поле проверяется `validateWorkspaceUpdatePermissions` (право `ROLES`), роль сверяется по кэшу (`RoleAssignmentValidationService.validateRoleAssignableToUsersOrThrow`), затем все поля запроса пишутся одним `workspaceRepository.update` без блокировок и без аудита. Экран настроек (`SettingsRolesDefaultRole.tsx`) шлёт только `defaultRoleId`.
2. `WorkspaceManagerService.setupDefaultRoles` (`workspace-manager.service.ts:157`): при активации пространства пишет роль Member.
3. `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace` (`dev-seeder-permissions.service.ts:266`): одним `update` пишет роль Member и `activationStatus = ACTIVE`.

`application.defaultRoleId` (роль, под которой работает приложение) пишется из установки и синхронизации приложений и их bootstrap; это следующий участок (см. [next-boundary](next-boundary.md)).

## 2. Решение

Варианты:

1. Отдельная аудируемая транзакция только для `defaultRoleId`, остальные поля запроса отдельным `update`. Две транзакции дают частичный успех. Отклонено.
2. Перед и после `update` писать аудит в отдельной транзакции. Не атомарно с изменением. Отклонено.
3. **Выбрано**: если во входе есть `defaultRoleId`, вся запись строки пространства выполняется внутри одной `runInCoreAuditTransaction`, которая блокирует строку, сверяет роль под блокировкой и пишет аудит до `COMMIT`.

### 2.1. Новый модуль `crm-audit/workspace-default-role-audit.ts`

- `captureWorkspaceDefaultRoleAudit(workspaceId, identity)` вызывается синхронно до первого `await` вызывающего. Вложенный metadata-аудит (`hasConflictingMetadataAuditScope`) отклоняется сразу. Снимок identity (`captureRoleAuditIdentity`) и операция (`captureRoleAuditOperation`) берутся в этот момент, ошибка снятия (нет identity, `pendingActivationUser`, чужое пространство) возвращается отложенно: функция возвращает thunk, который бросает её при вызове. Так существующие проверки прав по-прежнему дают пользователю свои понятные ошибки, а снимок не зависит от последующих `await`.
- `runAuditedWorkspaceDefaultRoleUpdate(dataSource, audit, defaultRoleId, work)`. Снимок одноразовый (`WeakSet`), повторное использование операции отклоняется. Внутри `runInCoreAuditTransaction`:
  1. `SET LOCAL lock_timeout = '8s'`;
  2. `SELECT "defaultRoleId","deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE`; строка должна существовать и не быть удалённой. Эта блокировка сериализует смену роли по умолчанию со всеми аудируемыми операциями ролей пространства, в том числе с `RoleService.deleteRole`, который под той же блокировкой запрещает удалять роль по умолчанию;
  3. целевой `defaultRoleId` должен быть непустым UUID (значение `null` отклоняется); всегда, в том числе при совпадении со старым значением, выполняется `SELECT to_jsonb(r) FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR SHARE`, роль должна существовать и иметь `canBeAssignedToUsers = true`. `FOR SHARE` не даёт удалить или изменить роль до `COMMIT`;
  4. инициатор при имперсонации (`resolveRoleAuditInitiator`), `CrmAuditTransactionContext`;
  5. `work(runner)`: запись, которую выполняет вызывающий своей сущностью (`runner.manager.update(WorkspaceEntity, ...)`). Модуль аудита не импортирует `WorkspaceEntity`, чтобы не добавлять рёбер к Enterprise-графу, а TypeORM по-прежнему обновляет `updatedAt` (по нему определяется зависшая активация);
  6. повторное чтение: строка на месте, `defaultRoleId` равен заявленному, строка роли не изменилась;
  7. при изменении: одна запись `workspace` / `update` с `before.defaultRoleId` и `after.defaultRoleId`, дескриптор `metadataAccess: 'currentWorkspaceAdministration'`;
  8. `flush`, повторная сверка состояния после записи аудита.
- Если значение под блокировкой уже равно новому, аудит не пишется, остальные поля запроса записываются в той же транзакции.

### 2.2. Каталог аудита

`CrmAuditResourceKind` дополняется `'workspace'`; `CATALOG.workspace = { values: ['defaultRoleId'], redacted: [] }`; `ADMINISTRATIVE_ACTIONS.workspace = ['update']`. Колонка `resourceKind` - `text` без `CHECK`, миграция не нужна. Остальные поля пространства в аудит не попадают, пока для них не определён allowlist.

### 2.3. Вызывающие

1. `WorkspaceResolver.updateWorkspace` принимает `@Context() context: { req: Request }` и передаёт `auditIdentity: roleAuditIdentityFromRequest(context.req)` (как `RoleResolver`; имперсонация даёт инициатора `coreUser`).
2. `WorkspaceService.updateWorkspaceById`: при `payload.defaultRoleId !== undefined` снимает аудит до первого `await`, предъявляет его после проверок прав и роли и до побочных эффектов DNS, выполняет запись через `runAuditedWorkspaceDefaultRoleUpdate(this.coreDataSource, ...)`. Без `defaultRoleId` путь не меняется. При `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` кэш `workspaceEntity` сбрасывается, а зарегистрированный hostname не удаляется: изменение могло зафиксироваться.
3. `WorkspaceManagerService.setupDefaultRoles`: системный actor `workspace-manager:setup-default-roles`, источник соединения `workspaceRepository.manager.connection`.
4. `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`: системный actor `dev-seeder:init-minimal-permissions`, `defaultRoleId` и `activationStatus` пишутся одним `update` в той же транзакции.

Существующая проверка `validateRoleAssignableToUsersOrThrow` (включая биллинговые права роли) остаётся; проверка под блокировкой закрывает гонку между ней и записью.

## 3. Затронутые файлы

1. `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-default-role-audit.ts` (новый)
2. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts`
3. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`
4. `packages/twenty-server/src/engine/core-modules/workspace/services/workspace.service.ts`
5. `packages/twenty-server/src/engine/core-modules/workspace/workspace.resolver.ts`
6. `packages/twenty-server/src/engine/workspace-manager/workspace-manager.service.ts`
7. `packages/twenty-server/src/engine/workspace-manager/dev-seeder/core/services/dev-seeder-permissions.service.ts`
8. `packages/twenty-server/test/fork-migration/crm-audit-workspace-default-role.postgres-spec.ts` (новый)
9. `crm-audit-system-role-and-seeder.postgres-spec.ts`, `crm-audit-bulk-role-assignment.postgres-spec.ts`: фикстуры `core.workspace` получают схему сущности, ожидания дополняются записью `workspace` / `update`.
