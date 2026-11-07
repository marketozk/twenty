# LOG163 - Независимое код-ревью реализации (`core.workspace."defaultRoleId"`, ROB-765)

**Статус ревью:** Одобрено (замечаний и блокеров нет).

**Проверенные файлы:**
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\Research\omnichannel_crm\implementation\log163\design.md`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\Research\omnichannel_crm\implementation\log163\design-review.md`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\Research\omnichannel_crm\implementation\log163\test-research.md`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\workspace-default-role-audit.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\crm-audit.types.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\crm-audit-transaction-context.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\workspace\services\workspace.service.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\workspace\workspace.resolver.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\workspace-manager\workspace-manager.service.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\workspace-manager\dev-seeder\core\services\dev-seeder-permissions.service.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\fork-migration\crm-audit-workspace-default-role.postgres-spec.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\fork-migration\crm-audit-system-role-and-seeder.postgres-spec.ts`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\fork-migration\crm-audit-bulk-role-assignment.postgres-spec.ts`

---

## 1. Полнота охвата путей записи и отсутствие гонок на `core.workspace."defaultRoleId"`

1. **Охват всех точек записи в runtime:**
   - Поиск по `packages/twenty-server/src` подтверждает, что все три точки изменения `core.workspace."defaultRoleId"` переведены на `runAuditedWorkspaceDefaultRoleUpdate`:
     - `WorkspaceService.updateWorkspaceById` (`workspace.service.ts:345-575`), вызываемый из `WorkspaceResolver.updateWorkspace` (`workspace.resolver.ts:182-208`);
     - `WorkspaceManagerService.setupDefaultRoles` (`workspace-manager.service.ts:161-178`);
     - `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace` (`dev-seeder-permissions.service.ts:270-285`).
   - Все остальные вызовы `workspaceRepository.update` / `queryRunner.manager.update(WorkspaceEntity, ...)` изменяют только поля `allowedIframeOrigins`, `activationStatus`, `suspendedAt`, `deletedAt`, `databaseSchema`, `metadataVersion` или `isCustomDomainEnabled`.
2. **Защита от TOCTOU и мутации аргументов во время `await`:**
   - В `WorkspaceService.updateWorkspaceById` (`workspace.service.ts:360-364`) входной `rawPayload` копируется синхронно (`const payload = { ...rawPayload }`) до первого `await`, а `captureWorkspaceDefaultRoleAudit(payload.id, auditIdentity)` синхронно снимает и замораживает (`Object.freeze`) снимок субъекта аудита и идентификатор операции.
   - Мутация вызывающим кодом объекта `rawPayload` (попытка подставить `defaultRoleId` во время `await` в неаудируемый вызов) или мутация `auditIdentity` после старта `updateWorkspaceById` не влияет ни на путь выполнения, ни на сохранённый `actor` в `crm_audit."crmAuditEntry"`.
3. **Сохранение контракта `PENDING_CREATION` при fail-closed проверке `auditIdentity`:**
   - При отсутствии `auditIdentity` (`undefined`) ошибка `'Role mutation requires authenticated audit identity'` выбрасывается синхронно до обращения к БД (`workspace.service.ts:365-367`).
   - Для активного пространства (`workspace.activationStatus !== WorkspaceActivationStatus.PENDING_CREATION`) валидность `auditIdentity` проверяется на строке 379 до `validateWorkspaceUpdatePermissions` и до любых внешних вызовов.
   - Для пространства в статусе `PENDING_CREATION` сначала выполняется `validateWorkspaceUpdatePermissions` (`workspace.service.ts:382-390`), что сохраняет штатный `PermissionsException`, а последующий вызов `const defaultRoleAudit = requireDefaultRoleAudit?.()` на строке 392 гарантирует fail-closed барьер до валидации поддоменов и DNS-операций.

---

## 2. Корректность порядка блокировок, проверок назначаемости и post-update / post-flush верификации

1. **Порядок блокировок и отсутствие взаимных блокировок (deadlocks):**
   - В `runAuditedWorkspaceDefaultRoleUpdate` (`workspace-default-role-audit.ts:133-160`) внутри `runInCoreAuditTransaction` устанавливается `SET LOCAL lock_timeout = '8s'`, затем берется `FOR NO KEY UPDATE` на строку `core.workspace` (`WHERE w.id=$1`), и далее - `FOR SHARE` на строку `core.role` (`WHERE id=$1 AND "workspaceId"=$2`).
   - Порядок `core.workspace` -> `core.role` строго согласован с `runAuditedRoleDelete` (`role-update-audit.ts:532, 562`), `runAuditedUnusedAgentRoleDelete` (`role-update-audit.ts:1131, 1144`), `runAuditedRoleAssignment` (`role-assignment-audit.ts:554, 608`) и `admitOmniWorkspaceDeletion` (`omni-workspace-deletion.ts:73, 113`).
   - Блокировка `FOR NO KEY UPDATE` на `core.workspace` исключает гонку со сценарием удаления роли (в котором `RoleService.deleteRole` запрещает удалять текущую роль по умолчанию и перепривязывает участников к `defaultRoleId`), а `FOR SHARE` на `core.role` удерживается до `COMMIT` и не позволяет параллельной транзакции удалить целевую роль или сбросить `canBeAssignedToUsers` в `false`.
2. **Проверка назначаемости роли и запрет `null`:**
   - На строках 122-127 `workspace-default-role-audit.ts` целевой `defaultRoleId` проверяется на валидный UUID (`typeof defaultRoleId === 'string' && isUUID(defaultRoleId)`), поэтому `null`, `undefined` и невалидные строки отклоняются fail-closed с `'Workspace default role is unavailable or not assignable to users'`.
   - Проверка существования роли в том же рабочем пространстве и `targetRole.canBeAssignedToUsers === true` под `FOR SHARE` (строки 146-160) выполняется всегда, в том числе при идемпотентном повторе (`beforeDefaultRoleId === normalizedDefaultRoleId`).
   - Разрешение инициатора при имперсонации (`resolveRoleAuditInitiator`, строки 162-166) также выполняется до `work(runner)` независимо от того, изменилось ли значение `defaultRoleId`.
3. **Двухэтапная верификация состояния (`verifyState('update')` и `verifyState('flush')`):**
   - После выполнения `work(runner)` функция `verifyState('update')` (`workspace-default-role-audit.ts:170-199`) перечитывает `core.workspace` и `core.role` в той же транзакции и проверяет, что пространство не удалено, `defaultRoleId` действительно равен `normalizedDefaultRoleId`, а строка целевой роли побитово совпадает со снимком `targetRole` (`canonicalAuditJson`).
   - При изменении `beforeDefaultRoleId !== normalizedDefaultRoleId` записывается событие `workspace` / `update` с `before: { defaultRoleId: beforeDefaultRoleId }`, `after: { defaultRoleId: normalizedDefaultRoleId }` и `securityDescriptor: { resourceKind: 'workspace', resourceId: request.workspaceId, metadataAccess: 'currentWorkspaceAdministration' }`, вызывается `await audit.flush()`, после чего `await verifyState('flush')` повторно сверяет неизменность состояния перед `COMMIT`.
   - При совпадении `beforeDefaultRoleId === normalizedDefaultRoleId` лишняя запись в `crm_audit."crmAuditEntry"` не создается, а попутные поля запроса сохраняются в той же транзакции.
   - Повторное использование `WorkspaceDefaultRoleAuditRequest` и вложенные metadata-аудит контексты блокируются через `consumed` (`WeakSet`), `active` (`WeakSet`), `AsyncLocalStorage` и `registerMetadataAuditScopeCheck(getWorkspaceDefaultRoleAudit)`.

---

## 3. Обработка `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`, кэша и побочных эффектов `customDomain` / `logo`

1. **Чтение обновленной строки внутри транзакции:**
   - В `WorkspaceService.updateWorkspaceById` (`workspace.service.ts:519-528`) внутри `work(queryRunner)` как `update`, так и `findOneByOrFail` выполняются через `queryRunner.manager`, что исключает чтение незафиксированного состояния через другое соединение пула.
2. **Поведение при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError`:**
   - В `runInCoreAuditTransaction` при потере подтверждения `COMMIT` выбрасывается `NativeTransactionOutcomeUnknownError` без отправки `ROLLBACK` и с удалением соединения из пула (`releasePostgresConnection(new Error(...))`), а при ошибке после подтверждённого `COMMIT` выбрасывается `CoreAuditPostCommitError` без `ROLLBACK`.
   - В `WorkspaceService.updateWorkspaceById` (`workspace.service.ts:540-559`) при `mayHaveCommitted`:
     - вызывается `await this.coreEntityCacheService.invalidate('workspaceEntity', workspace.id)` внутри `try / catch`, чтобы сбросить потенциально устаревший кэш и не замаскировать исходную ошибку коммита;
     - `this.dnsManagerService.deleteHostnameSilently(payload.customDomain)` **не** вызывается, так как новый `customDomain` мог зафиксироваться в БД;
     - ошибка пробрасывается дальше, поэтому `this.fileCorePictureService.deleteCorePicture` не удаляет файл логотипа при неизвестном исходе `COMMIT`.
3. **Поведение при откате до `COMMIT` и при успешном `COMMIT`:**
   - Если транзакция откатилась до `COMMIT` (`!mayHaveCommitted`), зарегистрированный в этом вызове `customDomain` компенсируется вызовом `this.dnsManagerService.deleteHostnameSilently(payload.customDomain)`, а инвалидация кэша и удаление картинки логотипа не выполняются.
   - При успешном `COMMIT` инвалидируется кэш `workspaceEntity`, а при `payload.logo === null && isDefined(workspace.logoFileId)` после фиксации `logoFileId: null` в БД удаляется файл логотипа через `fileCorePictureService.deleteCorePicture`.

---

## 4. Соответствие правилам кода Twenty CRM (House rules) и границам Enterprise

- В новых и изменённых файлах отсутствуют JSDoc-блоки; единственный комментарий в `workspace.service.ts:550` краткий (1 строка) и объясняет только причину (`WHY`).
- Используются только именованные экспорты (`export const`, `export type`, `export class`), `type` вместо `interface`, отсутствуют `any`.
- Используются штатные утилиты проекта (`isDefined` из `twenty-shared/utils`, `isUUID` из `class-validator`).
- Модуль `workspace-default-role-audit.ts` не импортирует `WorkspaceEntity` и не создаёт новых рёбер к Enterprise-графу (`check_enterprise_dependencies.py`).
- Каталог `CATALOG.workspace = { values: ['defaultRoleId'], redacted: [] }` и `ADMINISTRATIVE_ACTIONS.workspace = ['update']` в `crm-audit-transaction-context.ts` строго ограничивают аудит пространства полем `defaultRoleId` и административной областью видимости `currentWorkspaceAdministration`.

---

## 5. Покрытие реальных путей в тестах

1. **`crm-audit-workspace-default-role.postgres-spec.ts`:**
   - Выполняется против реального PostgreSQL с ограниченной ролью БД (append-only права на `crm_audit."crmAuditEntry"`) и реальной миграцией `OmniAuditBootstrapFastInstanceCommand`.
   - Проверяет реальные реализации `WorkspaceService.updateWorkspaceById`, `WorkspaceResolver.updateWorkspace`, `WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace` и `runAuditedWorkspaceDefaultRoleUpdate`.
   - Покрывает все целевые позитивные, идемпотентные, негативные и граничные сценарии:
     - смену `defaultRoleId` напрямую через сервис и через GraphQL-резолвер (включая `roleAuditIdentityFromRequest` и разрешение инициатора `coreUser` при имперсонации);
     - идемпотентный no-op без учета регистра UUID с сохранением попутных полей (`displayName`);
     - откат под блокировкой БД при отсутствующей роли, роли чужого пространства, роли с `canBeAssignedToUsers = false` и `defaultRoleId = null`;
     - fail-closed отказ до первого `await` при отсутствии `auditIdentity`, при `pendingActivationUser`, при вложенном вызове внутри `withRoleUpdateAudit`, при повторном использовании токена, а также защиту от мутации `payload.defaultRoleId` во время `await`;
     - системную инициализацию в `WorkspaceManagerService.setupDefaultRoles` и `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`;
     - обработку `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` (отсутствие `ROLLBACK`, инвалидация кэша `workspaceEntity`, сохранение зарегистрированного `customDomain`);
     - компенсацию `customDomain` при откате до `COMMIT`, удаление логотипа после `COMMIT`, откат при незаписанном `defaultRoleId` в callback `work`, сохранение `PermissionsException` на `PENDING_CREATION` и иммутабельность захваченного `actor` при мутации `auditIdentity`.
2. **`crm-audit-system-role-and-seeder.postgres-spec.ts` и `crm-audit-bulk-role-assignment.postgres-spec.ts`:**
   - Фикстуры `core.workspace` дополнены колонками `defaultRoleId` и `activationStatus`, подключён реальный репозиторий `WorkspaceEntity`, в `beforeEach` и между последовательными вызовами `initPermissions` / `setupDefaultRoles` сбрасывается `defaultRoleId = NULL`, и проверяется запись `workspace:update` в общей последовательности аудит-событий.
