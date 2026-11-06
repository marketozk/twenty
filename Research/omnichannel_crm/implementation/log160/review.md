# LOG160 — Независимое критическое ревью кода и безопасности

## Вердикт

Реализация `LOG160` («Audited system and bootstrap role creation, permission upserts, and roleTarget bindings in RoleService, WorkspaceManagerService, DevSeederPermissionsService, and RoleTargetService») полностью соответствует утверждённому дизайну (`design.md`, `design-review.md`) и тестовому плану (`test-research.md`). Блокеров, уязвимостей обхода транзакционного CRM-аудита и нарушений архитектурных или проектных правил не обнаружено. **Изменения одобрены.**

---

## 1. Проверка строгой изоляции `expected.isEditable === false` в `withRoleCreateAudit`

- **Файл**: `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\core-modules\crm-audit\role-update-audit.ts` (строки `6`, `201–260`, `965–975`, `1038–1075`).
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  1. До проверки полей `flatRole` синхронно вызывается `const capturedIdentity = captureRoleAuditIdentity(identity)` (строка `206`), что гарантирует валидацию `identity.auth` и непустого `systemActorId` (длиной `1..256`) при `auth.type === 'system'`.
  2. Поля `id`, `workspaceId`, `universalIdentifier`, `applicationId` и `applicationUniversalIdentifier` нормализуются через `uuid(...)` (`isUUID` + `.toLowerCase()`, строки `222–229`).
  3. Допуск `expected.isEditable === false` (строки `230–236`) разрешён **исключительно** при одновременном выполнении двух условий:
     - `capturedIdentity.auth.type === 'system'`;
     - `expected.universalIdentifier === WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER.toLowerCase()` (`'b5b505e2-8834-457f-a301-f1f4694fe365'`, импортируется напрямую из `src/engine/core-modules/application/constants/workspace-custom-application-role.constant`).
  4. Для всех остальных типов субъектов (`user`, `apiKey`, `application`, `pendingActivationUser`) и для любых других `universalIdentifier` (включая `MEMBER_ROLE_UNIVERSAL_IDENTIFIER` или произвольные роли даже с `auth.type === 'system'`) требуется строго `expected.isEditable === true`; иначе синхронно выбрасывается `Error('Role create audit requires normalized scalar fields')` (строка `245`).
  5. В `runAuditedRoleMutation` (`action === 'create'`) значение `isEditable` из `request.expected` повторно сверяется как с `action.flatEntity` до выполнения миграции (строки `969–974`), так и с фактически записанной строкой `core.role` внутри транзакции (строки `1039–1075`).

---

## 2. Проверка синхронной валидации `auditIdentity` и конфликтующих контекстов до первого `await` в `RoleService`

- **Файл**: `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\metadata-modules\role\role.service.ts` (строки `188–240`, `559–721`).
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  1. **`RoleService.createRole` (строки `188–220`)**:
     - До построения `flatRoleToCreate` и до первого `await` синхронно проверяет `getRoleMutationAudit(workspaceId)` и `hasConflictingMetadataAuditScope(workspaceId, getRoleMutationAudit)` (при конфликте выбрасывает `'Nested role audit is unsupported'`).
     - Синхронно захватывает `const capturedIdentity = captureRoleAuditIdentity(auditIdentity as RoleUpdateAuditIdentity)` и проверяет `captureRoleAuditOperation(workspaceId, capturedIdentity)` (валидируя совпадение `workspaceId`, тип аутентификации и `systemActorId`).
     - После этого оборачивает `this.createRoleFromFlat(flatRoleToCreate)` в `withRoleCreateAudit(flatRoleToCreate, capturedIdentity, ...)`.
  2. **`RoleService.createAuditedRole` (строки `222–239`)**, **`createMemberRole` (строки `559–591`)** и **`createGuestRole` (строки `692–721`)**:
     - Делегируют напрямую в `this.createRole({ ..., auditIdentity })` без предшествующих `await`, тем самым наследуя синхронную fail-closed проверку до любых асинхронных операций.
  3. **`RoleService.createWorkspaceCustomApplicationRole` (строки `593–645`)**:
     - В самом начале метода (строки `602–612`), **до** первого `await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(...)`, синхронно проверяет отсутствие активного/конфликтующего аудит-контекста и валидирует `capturedIdentity = captureRoleAuditIdentity(...)` + `captureRoleAuditOperation(workspaceId, capturedIdentity)`.
     - Даже если роль кастомного приложения уже существует в кэше (идемпотентный повторный вызов), невалидный или отсутствующий `auditIdentity`, равно как и вложенный аудит-контекст, отклоняется до обращения к кэшу или БД.
     - Если роль ещё не создана, `capturedIdentity` передаётся в `createWorkspaceCustomApplicationFlatRole` (строки `647–690`), где `validateBuildAndRunWorkspaceMigration` выполняется внутри `withRoleCreateAudit`.

---

## 3. Проверка разрешения `applicationUniversalIdentifier` в `RoleTargetService.createMany`

- **Файл**: `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\metadata-modules\role-target\services\role-target.service.ts` (строки `76–123`).
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  1. Для каждого элемента `createRoleTargetInputs` при наличии `createRoleTargetInput.applicationId` выбирается `flatApplication = flatApplicationMaps.byId[createRoleTargetInput.applicationId]`, и создаваемый `flatRoleTargetToCreate` получает `applicationId` и `applicationUniversalIdentifier` этого приложения (либо `workspaceCustomFlatApplication` по умолчанию).
  2. В строках `95–106` вычисляется `uniqueApplicationUniversalIdentifiers` по всем `allFlatRoleTargetsToCreate`. Если все создаваемые цели принадлежат одному приложению (`uniqueApplicationUniversalIdentifiers.length === 1`), его `applicationUniversalIdentifier` передаётся в `validateBuildAndRunWorkspaceMigration` (строка `121`); иначе используется `workspaceCustomFlatApplication.universalIdentifier`.
  3. Это устраняет расхождение между `flatRoleTargetToCreate.applicationUniversalIdentifier` (`twentyStandardFlatApplication.universalIdentifier`) и `mappings.application.universalIdentifier` в `WorkspaceMigrationRunnerService` при создании `roleTarget` для seed API-ключа в `DevSeederPermissionsService.initPermissions` под `withApiKeyRoleAssignmentAudit`.

---

## 4. Проверка точек вызова в `WorkspaceManagerService` и `DevSeederPermissionsService`

- **Файлы**:
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\workspace-manager\workspace-manager.service.ts` (строки `85–95`, `145–155`)
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\src\engine\workspace-manager\dev-seeder\core\services\dev-seeder-permissions.service.ts` (строки `75–100`, `127–131`, `246–264`, `287–320`, `332–449`)
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  - Все системные и bootstrap-вызовы создания ролей (`createWorkspaceCustomApplicationRole`, `createMemberRole`, `createGuestRole`, `createRole`), привязки `roleTarget` к seed API-ключу (`withApiKeyRoleAssignmentAudit` вокруг `roleTargetService.create`) и upsert прав ролей (`upsertPermissionFlags`, `upsertObjectPermissions`, `upsertFieldPermissions`) передают корректный системный `auditIdentity` с явным `systemActorId` (`'workspace-manager:init'`, `'workspace-manager:setup-default-roles'`, `'dev-seeder:init-permissions'`, `'dev-seeder:init-minimal-permissions'`).
  - Историческая команда `packages/twenty-server/src/database/commands/upgrade-version-command/2-50/2-50-workspace-command-1792413669590-backfill-member-role-universal-identifier.command.ts` осталась нетронутой благодаря опциональности `auditIdentity?: RoleUpdateAuditIdentity` в сигнатуре TypeScript при строгой runtime-проверке.

---

## 5. Проверка тестового покрытия и соблюдения проектных правил (House Rules)

- **Тестовые файлы**:
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\fork-migration\crm-audit-system-role-and-seeder.postgres-spec.ts`
  - `C:\Users\regis\OneDrive\Рабочий стол\Twenty CRM\packages\twenty-server\test\fork-migration\crm-audit-role-update.postgres-spec.ts` (строки `985–1020`)
- **Результат проверки**: **ПОДТВЕРЖДЕНО**.
  1. Покрыты все целевые и негативные сценарии из `test-research.md` и `design-review.md`, включая:
     - создание `Member` и `Guest` ролей с системным актором;
     - создание системной роли кастомного приложения (`isEditable: false`), идемпотентный повторный вызов, синхронный отказ без `auditIdentity` до обращения к `flatEntityMapsCache` и отказ при вложенном аудит-контексте (`Nested role audit is unsupported`);
     - отказ `withRoleCreateAudit` при `isEditable: false` для `auth.type === 'user'` и для `auth.type === 'system'` с произвольным `universalIdentifier`;
     - отказ `createRole`, `createMemberRole`, `createGuestRole` без `auditIdentity` или без `systemActorId`;
     - аудит создания `roleTarget` для API-ключа с явным `applicationId: standardAppId` (`RoleTargetService.createMany`);
     - сквозной прогон `DevSeederPermissionsService.initPermissions`, `WorkspaceManagerService.setupDefaultRoles`, `createImpersonateOnlyRoleForSeedWorkspace` и `createLimitedRoleForSeedWorkspace`;
     - полный откат `core.role` и `crm_audit."crmAuditEntry"` при сбое обработчика миграции.
  2. **House rules и архитектурные проверки**:
     - В изменённых и добавленных файлах нет `any`, запрещённых Enterprise-импортов, JSDoc-блоков, избыточных комментариев и AI-атрибуции.
     - Проверки `python -I -X utf8 scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline` (`status: "pass"`, `violations: {}`) и `python -I -X utf8 scripts/omnichannel/check_fork_migration_sources.py` (`Verified 10 fork migration source(s)`) пройдены успешно.
