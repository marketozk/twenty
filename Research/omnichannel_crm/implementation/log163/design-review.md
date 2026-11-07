# LOG163 - Независимое критическое ревью дизайна и тест-плана (`core.workspace."defaultRoleId"`)

**Объект ревью:**
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\Research\omnichannel_crm\implementation\log163\design.md`
- `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\Research\omnichannel_crm\implementation\log163\test-research.md`
- Проверенные исходные файлы:
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\workspace\services\workspace.service.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\workspace\workspace.resolver.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\workspace-manager\workspace-manager.service.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\workspace-manager\dev-seeder\core\services\dev-seeder-permissions.service.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\role-update-audit.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\crm-audit-transaction-context.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\crm-audit.types.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\run-in-core-audit-transaction.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\scripts\omnichannel\check_enterprise_dependencies.py`

**Итоговый вердикт:** Дизайн (`design.md`) и план тестирования (`test-research.md`) архитектурно корректны, закрывают все пути записи `core.workspace."defaultRoleId"` и согласованы с существующим транзакционным контуром `crm-audit`. По результатам прямой проверки кода выявлены **4 важных уточнения для реализации** и **4 дополнения к тестовым сценариям**, которые необходимо учесть при написании кода и тестов.

---

## 1. Полнота охвата путей записи `core.workspace."defaultRoleId"`

Проверка всех вхождений `defaultRoleId`, `WorkspaceEntity` и SQL-обращений к `core.workspace` по `packages/twenty-server/src` подтверждает, что в runtime существуют ровно три точки записи `core.workspace."defaultRoleId"`:

1. `WorkspaceService.updateWorkspaceById` (`workspace.service.ts:338-514`), вызываемый исключительно из `WorkspaceResolver.updateWorkspace` (`workspace.resolver.ts:173-195`).
2. `WorkspaceManagerService.setupDefaultRoles` (`workspace-manager.service.ts:157-159`), вызываемый из `WorkspaceManagerService.init` (`workspace-manager.service.ts:97`) при активации рабочего пространства (`WorkspaceService.activateWorkspace`, `workspace.service.ts:564`).
3. `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace` (`dev-seeder-permissions.service.ts:266-271`), вызываемый из `DevSeederPermissionsService.initPermissions` (`dev-seeder-permissions.service.ts:217`).

Дополнительные проверенные пути:
- Первичное создание строки `core.workspace` в `SignInUpService` (`sign-in-up.service.ts:693-709`) и `createWorkspace` (`seed-workspace.util.ts:16-28`, `seeder-workspaces.constant.ts:5-14`) создаёт пространство со статусом `PENDING_CREATION` и `defaultRoleId = NULL` (допустимо по ограничению `onboarded_workspace_requires_default_role`).
- На колонке `core.workspace."defaultRoleId"` нет внешнего ключа с `ON DELETE SET NULL` или `ON DELETE CASCADE`, а `runAuditedRoleDelete` (`role-update-audit.ts:532-546`) и `runAuditedUnusedAgentRoleDelete` (`role-update-audit.ts:1131-1141`) под блокировкой `FOR NO KEY UPDATE` запрещают удаление роли, являющейся `defaultRoleId`.
- Все остальные `.update(...)` по `WorkspaceEntity` в `src` изменяют только `allowedIframeOrigins`, `activationStatus`, `suspendedAt`, `deletedAt`, `databaseSchema`, `metadataVersion` или `isCustomDomainEnabled`.
- Все остальные записи `defaultRoleId` в `src` относятся к `core.application."defaultRoleId"` (`ApplicationService.update`, `RoleService.createWorkspaceCustomApplicationRole`, `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow`, `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`, `ApplicationSyncService`), что корректно выделено в `next-boundary.md`.

---

## 2. Проверка блокировок БД, `canBeAssignedToUsers === true` и fail-closed верификаций

### 2.1. Сериализация и отсутствие взаимных блокировок (deadlocks)
- Внутри `runInCoreAuditTransaction` устанавливается `SET LOCAL lock_timeout = '8s'`, затем захватывается `FOR NO KEY UPDATE` на `core.workspace`, после чего - `FOR SHARE` на `core.role`.
- Порядок захвата блокировок `core.workspace` -> `core.role` строго совпадает с порядком в `runAuditedRoleDelete` (`role-update-audit.ts:532, 562`), `runAuditedUnusedAgentRoleDelete` (`role-update-audit.ts:1131, 1144`) и `runAuditedRoleAssignment` (`role-assignment-audit.ts:554, 608`), что исключает взаимные блокировки при параллельных операциях над ролями и пространством.
- `FOR NO KEY UPDATE` на `core.workspace` сериализует смену `defaultRoleId` относительно:
  - параллельных вызовов `runAuditedWorkspaceDefaultRoleUpdate`;
  - удаления роли в `RoleService.deleteRole` и `AiAgentRoleService.deleteAgentOnlyRoleIfUnused` (исключая гонку, при которой удаляемая роль одновременно назначается ролью по умолчанию или участники удаляемой роли перепривязываются к устаревшему `defaultRoleId`);
  - мягкого удаления пространства (`admitOmniWorkspaceDeletion` в `omni-workspace-deletion.ts:73, 113`, берущего `FOR UPDATE` на `core.workspace`).
- `FOR SHARE` на целевой строке `core.role` удерживается до `COMMIT` и не позволяет параллельной транзакции удалить роль или сбросить `canBeAssignedToUsers` в `false` между проверкой и фиксацией.

### 2.2. Уточнение 1 (Обязательно при реализации): Запрет `defaultRoleId: null` как целевого значения в `runAuditedWorkspaceDefaultRoleUpdate`
- В `design.md` (раздел 2.1, п. 3) сформулировано: «если значение меняется и новое значение не `null`: `SELECT to_jsonb(r) FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR SHARE`». В то же время в `test-research.md` (раздел 1, п. 3) указано: «попытка записать `defaultRoleId: null` на активном пространстве отклоняется (`'Workspace default role is unavailable or not assignable to users'`)».
- В GraphQL-типе `UpdateWorkspaceInput` (`update-workspace-input.ts:110-113`) поле `@Field(() => UUIDScalarType, { nullable: true })` в сочетании с `@IsOptional()` в `class-validator` пропускает `{ defaultRoleId: null }`, а в `WorkspaceService.updateWorkspaceById` (`workspace.service.ts:385-392`) условие `isDefined(payload.defaultRoleId)` пропускает предварительную проверку `validateRoleAssignableToUsersOrThrow` при `payload.defaultRoleId === null`.
- Ни один легитимный сценарий не может записывать `defaultRoleId = null` (значение `null` возможно только у `before.defaultRoleId` до первой активации).
- **Требование к реализации:** в `runAuditedWorkspaceDefaultRoleUpdate` целевой `defaultRoleId` должен проверяться на непустой валидный UUID (`typeof defaultRoleId === 'string' && isUUID(defaultRoleId)`). Если передан `null` или невалидный UUID, либо если строка в `core.role` (`WHERE id=$1 AND "workspaceId"=$2 FOR SHARE`) отсутствует или имеет `canBeAssignedToUsers !== true`, необходимо выбрасывать `new Error('Workspace default role is unavailable or not assignable to users')`. Проверку существования и `canBeAssignedToUsers === true` под `FOR SHARE` рекомендуется выполнять и при совпадении нового значения со старым, чтобы не пропускать невалидную роль при идемпотентном повторе.

### 2.3. Уточнение 2 (Обязательно при реализации): Защита от TOCTOU входного `payload` и регистрация scope-проверки
- В `WorkspaceService.updateWorkspaceById` флаг `const hasDefaultRoleUpdate = payload.defaultRoleId !== undefined;` и значение `const requestedDefaultRoleId = payload.defaultRoleId;` должны фиксироваться синхронно до первого `await`. В неаудируемой ветке (`!hasDefaultRoleUpdate`) необходимо исключать `defaultRoleId` из объекта обновления (например, через деструктуризацию), чтобы мутация объекта `payload` во время промежуточных `await` не могла записать `defaultRoleId` в обход `runAuditedWorkspaceDefaultRoleUpdate`.
- В `workspace-default-role-audit.ts` рекомендуется также зарегистрировать проверку активного scope через `registerMetadataAuditScopeCheck` на время выполнения `work(runner)`, чтобы исключить запуск вложенного metadata-аудита в обоих направлениях.
- Если в `captureWorkspaceDefaultRoleAudit` передан `impersonatorUserWorkspaceId`, разрешение инициатора `resolveRoleAuditInitiator(runner, ...)` внутри `runAuditedWorkspaceDefaultRoleUpdate` следует выполнять до `work(runner)` даже в случае идемпотентного no-op, чтобы невалидный/удалённый `impersonatorUserWorkspaceId` всегда отклонялся fail-closed.

---

## 3. Проверка `WorkspaceService.updateWorkspaceById`: `customDomain`, `logo === null`, инвалидация кэша и ошибки `COMMIT`

1. **Порядок предъявления `auditIdentity` и DNS-эффектов:**
   - Снимок `captureWorkspaceDefaultRoleAudit(payload.id, auditIdentity)` создаётся синхронно до `this.workspaceRepository.findOneBy({ id: payload.id })`.
   - Thunk предъявления вызывается после `validateWorkspaceUpdatePermissions`, `validateSubdomainOrThrow`, `validateRetentionUpdateOrThrow`, `validateRoleAssignableToUsersOrThrow` и синхронных проверок `authProvidersBySystem` / `validateAiModelIdByTier` / `validateAiEvaluationModelId`, но **до** `dnsManagerService.deleteHostnameSilently` и `customDomainManagerService.setCustomDomain`.
   - Благодаря этому:
     - при `workspace.activationStatus === WorkspaceActivationStatus.PENDING_CREATION` пользователь со статусом `pendingActivationUser` по-прежнему получает штатный `PermissionsException` из `validateWorkspaceUpdatePermissions`;
     - при вызове `updateWorkspaceById` с `defaultRoleId` без валидного `auditIdentity` ошибка выбрасывается до любых внешних вызовов DNS и до открытия транзакции БД.
2. **Уточнение 3 (Обязательно при реализации): Чтение `updatedWorkspace` внутри `work(runner)` через `runner.manager`:**
   - В текущем коде (`workspace.service.ts:480-489`) после `this.workspaceRepository.update(...)` вызывается `this.workspaceRepository.findOneByOrFail({ id: workspace.id })`.
   - В аудируемой ветке внутри `work(runner)` как `update`, так и `findOneByOrFail` обязаны выполняться через `runner.manager` (`await runner.manager.update(WorkspaceEntity, workspace.id, updateData)` и `await runner.manager.findOneByOrFail(WorkspaceEntity, { id: workspace.id })`). Вызов `this.workspaceRepository.findOneByOrFail` внутри незафиксированной транзакции `work(runner)` обратился бы к другому соединению пула и прочитал бы старое состояние строки до `COMMIT`.
3. **Обработка `customDomain`, `coreEntityCacheService.invalidate` и `logo === null` при ошибках транзакции:**
   - Если `runAuditedWorkspaceDefaultRoleUpdate` завершается обычной ошибкой до `COMMIT` (транзакция откачена):
     - при `payload.customDomain && customDomainRegistered` в `catch` вызывается `this.dnsManagerService.deleteHostnameSilently(payload.customDomain)` для компенсации зарегистрированного домена;
     - `coreEntityCacheService.invalidate` и `fileCorePictureService.deleteCorePicture` не вызываются.
   - Если выбрасывается `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` (изменение в БД могло зафиксироваться или уже зафиксировано):
     - `deleteHostnameSilently(payload.customDomain)` в `catch` **не** вызывается, так как `customDomain` мог сохраниться в `core.workspace`;
     - перед повторным выбросом ошибки обязательно вызывается `await this.coreEntityCacheService.invalidate('workspaceEntity', workspace.id)` (с защитой `try / catch`, чтобы сбой инвалидации кэша не замаскировал `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`);
     - ошибка пробрасывается дальше, поэтому `fileCorePictureService.deleteCorePicture` при неизвестном исходе `COMMIT` не удаляет файл логотипа вслепую.
   - При успешном завершении транзакции выполняются `coreEntityCacheService.invalidate('workspaceEntity', workspace.id)` и, если `payload.logo === null && isDefined(workspace.logoFileId)`, удаление старого файла через `fileCorePictureService.deleteCorePicture`.

---

## 4. Проверка типизации, `CrmAuditResourceKind` и `check_enterprise_dependencies.py`

1. **`CrmAuditResourceKind`, `CATALOG` и `ADMINISTRATIVE_ACTIONS`:**
   - Добавление `'workspace'` в `CrmAuditResourceKind` (`crm-audit.types.ts`), `CATALOG.workspace = { values: ['defaultRoleId'], redacted: [] }` и `ADMINISTRATIVE_ACTIONS.workspace = ['update']` (`crm-audit-transaction-context.ts`) полностью удовлетворяет типизации `Record<CrmAuditResourceKind, ...>`.
   - Поиск по репозиторию показал отсутствие exhaustive `switch` по `CrmAuditResourceKind` в других модулях.
   - В функции `capture` (`crm-audit-transaction-context.ts:769-776`) значения из `catalog.values` допускают `null` и JSON-скаляры (`string`, `boolean`, `number`), поэтому как переход `null -> memberRole.id` (при инициализации пространства), так и `oldRoleId -> newRoleId` корректно формируют `changedFields: ['defaultRoleId']` и `values: { defaultRoleId: { before, after } }`.
   - В `omni-audit-bootstrap.migration.ts:15` колонка `"resourceKind"` имеет тип `text NOT NULL` без `CHECK`-ограничений на перечень ресурсов; изменения файлов миграций не требуются, `check_fork_migration_sources.py` не затрагивается.
2. **Границы Enterprise (`scripts/omnichannel/check_enterprise_dependencies.py`):**
   - Файлы `workspace.entity.ts`, `workspace.service.ts` и `workspace.resolver.ts` входят в `enterprise-dependency-baseline.json` (`reaches_enterprise`).
   - Поскольку новый модуль `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-default-role-audit.ts` не импортирует `WorkspaceEntity` (`workspace.entity.ts`) или другие файлы из `reaches_enterprise`, а использует только `node:async_hooks`, `node:crypto`, `class-validator`, `typeorm` и модули `src/engine/core-modules/crm-audit/*`, сам `workspace-default-role-audit.ts` не попадает в `reaches_enterprise`.
   - Следовательно, импорт `workspace-default-role-audit.ts` в `workspace.service.ts`, `workspace.resolver.ts`, `workspace-manager.service.ts` и `dev-seeder-permissions.service.ts` не создаёт ни одного нового `runtime_enterprise_reachable` узла и ни одного нового ребра в `enterprise_edges`.
   - Использование `this.workspaceRepository.manager.connection` в `WorkspaceManagerService.setupDefaultRoles` позволяет обойтись без добавления новых `@Inject(...)` параметров в конструктор `WorkspaceManagerService`.

---

## 5. Анализ `test-research.md` и необходимые дополнения к тестам

План в `test-research.md` покрывает основные позитивные и негативные сценарии. При реализации тестов необходимо учесть следующие 4 момента:

1. **Уточнение 4 (Критично для существующих `.postgres-spec.ts` из раздела 2 `test-research.md`):**
   - В `crm-audit-bulk-role-assignment.postgres-spec.ts:521` таблица `core.workspace` сейчас создаётся как `CREATE TABLE core.workspace(id uuid PRIMARY KEY,"databaseSchema" text,"deletedAt" timestamptz)` - в ней отсутствует колонка `"defaultRoleId" uuid`. При подключении реального репозитория `WorkspaceEntity` необходимо добавить `"defaultRoleId" uuid` (и согласовать определение `EntitySchema` для `WorkspaceEntity` с `owner.synchronize()`, чтобы `owner.synchronize()` и ручной `CREATE TABLE core.workspace` не конфликтовали по `relation "workspace" already exists`).
   - В `crm-audit-system-role-and-seeder.postgres-spec.ts:958-1005` в одном тесте последовательно вызываются `seeder.initPermissions` и `workspaceManager.setupDefaultRoles` на одном и том же `workspaceId`. Поскольку `seeder.initPermissions` вызывает `initMinimalPermissionsAndActivateWorkspace` и устанавливает `core.workspace."defaultRoleId" = memberRole.id`, последующий вызов `workspaceManager.setupDefaultRoles` в том же тесте найдёт ту же самую роль `memberRole.id` и увидит, что `core.workspace."defaultRoleId"` уже равен `memberRole.id` (no-op без записи `workspace:update`), если перед вызовом `setupDefaultRoles` (и в `beforeEach` обоих файлов) не сбрасывать `UPDATE core.workspace SET "defaultRoleId" = NULL, "activationStatus" = NULL WHERE id = $1`.
2. **Дополнение к сценарию 3 в `crm-audit-workspace-default-role.postgres-spec.ts` (компенсация `customDomain` при откате до `COMMIT` и удаление `logo` после `COMMIT`):**
   - Проверить, что если `runAuditedWorkspaceDefaultRoleUpdate` откатывается до `COMMIT` (например, целевая роль оказалась не назначаемой пользователям под блокировкой), то зарегистрированный в этом вызове `customDomain` **удаляется** через `dnsManagerService.deleteHostnameSilently(payload.customDomain)`, а `coreEntityCacheService.invalidate` не вызывается (в отличие от сценария 6 с `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`, где `deleteHostnameSilently` не вызывается, а кэш инвалидируется).
   - Проверить совместную передачу `defaultRoleId` и `logo: null` при наличии `workspace.logoFileId`: в `core.workspace` атомарно с новым `defaultRoleId` записывается `logoFileId = null`, а после `COMMIT` вызывается `fileCorePictureService.deleteCorePicture`.
3. **Дополнение к сценарию 3/4 (одноразовость токена и пост-проверка записи):**
   - Проверить, что повторный вызов `runAuditedWorkspaceDefaultRoleUpdate` с тем же снимком операции отклоняется (`WeakSet`), а если callback `work(runner)` не записал ожидаемый `defaultRoleId` в `core.workspace`, транзакция откатывается на пост-проверке до `audit.flush()`.
4. **Дополнение к сценарию 4 (сохранение ошибки прав при `PENDING_CREATION` и защита от мутации аргументов после старта):**
   - Проверить, что при `workspace.activationStatus === WorkspaceActivationStatus.PENDING_CREATION` вызов `updateWorkspaceById` с `defaultRoleId` и `pendingActivationUser` выбрасывает `PermissionsException` из `validateWorkspaceUpdatePermissions` (а не ошибку захвата `auditIdentity`), сохраняя контракт `workspace-update-before-activation.integration-spec.ts`.
   - Проверить, что мутация объекта `auditIdentity` после старта `updateWorkspaceById` (во время `await`) не влияет на сохранённый `actor` в `crm_audit."crmAuditEntry"`.
