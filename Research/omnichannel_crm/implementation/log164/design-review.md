# LOG164 - независимое ревью дизайна и плана тестирования (`core.application."defaultRoleId"`)

## Вердикт

Архитектура решения в `design.md` и покрытие в `test-research.md` (а также текущая реализация в рабочем дереве) в целом корректны, непротиворечивы и закрывают транзакционный контур CRM-аудита для `core.application."defaultRoleId"`.

Ниже приведены ответы по всем пяти контрольным вопросам и перечень точечных замечаний (`R1`-`R5`), которые рекомендуется учесть перед финальной приёмкой.

---

## 1. Полнота охвата runtime-путей записи `core.application."defaultRoleId"`

Проверка всех обращений к `ApplicationEntity`, `core.application`, `applicationRepository`, `applicationService` и `defaultRoleId` в `packages/twenty-server/src` подтверждает:

1. В runtime (за пределами исторических upgrade-команд `2-19`, `2-43`, `2-51`, которые по правилам репозитория не модифицируются) поле `core.application."defaultRoleId"` изменяется исключительно через `ApplicationService.update` из трёх мест:
   - `RoleService.createWorkspaceCustomApplicationRole` (`role.service.ts:641`);
   - `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow` (`twenty-standard-application.service.ts:181`), вызываемый из `synchronizeTwentyStandardApplicationOrThrow` (`WorkspaceManagerService.init` на `workspace-manager.service.ts:70` и `DevSeederWorkspaceService.seedDev` на `dev-seeder.workspace-service.ts:139`);
   - `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest` (`application-manifest-migration.service.ts:450`), вызываемый из `syncMetadataFromManifest`.
2. Все вызовы `ApplicationService.create` (`createTwentyStandardApplication`, `createWorkspaceCustomApplication`, `OAuthService.findOrCreateOAuthApplication`, `ApplicationInstallService.ensureApplicationExists`, `ApplicationDevelopmentService.createDevelopmentApplication`) создают строку приложения с `defaultRoleId = null`.
3. Прямые вызовы `applicationRepository.update` (`sdk-client-archive.service.ts:123`, `application-uninstall.service.ts:77`) и `queryRunner.manager.update(ApplicationEntity, ...)` (`application.service.ts:717, 859`) изменяют только файловые и технические поля (`packageJsonFileId`, `yarnLockFileId`, чексуммы, `uninstallHookCompletedForRequestedAt`).
4. Все фоновые задачи и CLI-команды жизненного цикла приложений (`TriggerInstallApplicationJob`, `TriggerUpgradeApplicationJob`, `TriggerUninstallApplicationJob`, `UpgradeWorkspaceApplicationJob`, `InstallApplicationCommand`, `PreInstalledAppsService`, `OAuthService`) уже оборачивают выполнение в `withCrmAuditIdentity`, а HTTP/GraphQL-запросы (`ApplicationDevelopmentResolver.syncApplication`, `ApplicationInstallResolver`, `ApplicationUpgradeResolver`) проходят через `WorkspaceAuthContextMiddleware` -> `withCrmAuditRequest`.

### Найденные замечания по путям записи

- **R1 (Важное - пропуск сброса `defaultRoleId` в `null` в `syncApplicationReferencesFromManifest`)**:
  В `application-manifest-migration.service.ts:466` передача `defaultRoleId` в `this.applicationService.update` записана как:
  ```ts
  ...(isDefined(defaultRoleId) ? { defaultRoleId } : {}),
  ```
  Поскольку `isDefined(null)` возвращает `false`, если у приложения ранее была установлена роль по умолчанию (`isDefined(ownerFlatApplication.defaultRoleId)`), а в новой версии манифеста при `inferDeletionFromMissingEntities === true` поле `defaultRoleUniversalIdentifier` удалено (`defaultRoleId === null`), то `syncApplicationReferencesFromManifest` не передаёт `{ defaultRoleId: null }` в `this.applicationService.update`. Если старая роль одновременно удаляется из `manifest.roles`, `DeleteRoleActionHandlerService` удалит её из `core.role` (на `core.application."defaultRoleId"` нет внешнего ключа БД), а `core.application."defaultRoleId"` останется висячей ссылкой без сброса в `null` и без записи `application:update` в аудит.
  Кроме того, если в `manifest.application.defaultRoleUniversalIdentifier` указан UUID, которого нет в `manifest.roles`, цикл `for (const role of manifest.roles)` пропускает его без вызова `resolveApplicationReferenceIdOrThrow`.
  **Рекомендация**:
  1. Если `isDefined(manifest.application.defaultRoleUniversalIdentifier) && !isDefined(defaultRoleId)`, вызывать `resolveApplicationReferenceIdOrThrow` с `ownerApplicationId`, чтобы ссылка на роль вне `manifest.roles` детерминированно отклонялась с `ApplicationExceptionCode.ENTITY_NOT_FOUND`.
  2. Передавать `defaultRoleId` в `this.applicationService.update` также при сбросе ранее установленной роли:
     ```ts
     ...(isDefined(defaultRoleId) ||
     (inferDeletionFromMissingEntities &&
       isDefined(ownerFlatApplication.defaultRoleId))
       ? { defaultRoleId }
       : {}),
     ```
     Проверка `isDefined(ownerFlatApplication.defaultRoleId)` гарантирует, что манифесты без ролей, у которых `defaultRoleId` уже равен `null`, не инициируют лишний вызов ролевого аудита, тогда как реальный сброс ранее назначенной роли проходит через `ApplicationService.update` с `defaultRoleId: null` и фиксируется в аудите.

- **R2 (Защитная проверка в `ApplicationService.create`)**:
  `ApplicationService.create` принимает `Partial<ApplicationEntity> & { workspaceId: string }`. Хотя текущие вызывающие сервисы не передают `defaultRoleId`, рекомендуется в начале `ApplicationService.create` добавить синхронную проверку `if (data.defaultRoleId !== undefined && data.defaultRoleId !== null) throw new Error('Application creation cannot assign defaultRoleId without audit')`, чтобы исключить обход `runAuditedApplicationDefaultRoleUpdate` через `create`.

- **R3 (Точность именования в `design.md`)**:
  В `design.md` (разделы 1 и 2.3) указан `DevSeederService.seedTwentyStandardApplication`, тогда как в коде вызов находится в `DevSeederWorkspaceService.seedDev` (`packages/twenty-server/src/engine/workspace-manager/dev-seeder/services/dev-seeder.workspace-service.ts:139`). В самом файле `dev-seeder.workspace-service.ts` проброс `auditIdentity` с `systemActorId: 'dev-seeder:seed-twenty-standard-application'` выполнен в правильном месте.

---

## 2. Блокировки БД, проверка принадлежности роли и верификация состояния

1. **Отсутствие гонок и взаимных блокировок (deadlocks)**:
   В `runAuditedApplicationDefaultRoleUpdate` блокировки берутся строго в порядке:
   - `SET LOCAL lock_timeout = '8s'`;
   - `SELECT id,to_jsonb(w)->>'deletedAt' AS "deletedAt" FROM core.workspace w WHERE w.id=$1 FOR NO KEY UPDATE`;
   - `SELECT id,"workspaceId","universalIdentifier",to_jsonb(a)->>'defaultRoleId' AS "defaultRoleId",to_jsonb(a)->>'deletedAt' AS "deletedAt" FROM core.application a WHERE a.id=$1 AND a."workspaceId"=$2 FOR UPDATE`;
   - при `normalizedDefaultRoleId !== null`: `SELECT to_jsonb(r) AS row FROM core.role r WHERE id=$1 AND "workspaceId"=$2 FOR SHARE`.
   Этот порядок полностью совпадает с иерархией блокировок в `workspace-default-role-audit.ts`, `role-update-audit.ts`, `role-permission-audit.ts` и `role-assignment-audit.ts` (`core.workspace` -> `core.application` -> `core.role`). Сериализация на строке `core.workspace FOR NO KEY UPDATE` и разделяемая блокировка `core.role FOR SHARE` исключают параллельное удаление или модификацию целевой роли во время привязки.
2. **Проверка владения ролью (`targetRole.applicationId === application.id`)**:
   Проверка `roleRows.length !== 1 || !targetRole || uuid(targetRole.applicationId) !== request.applicationId` под `FOR SHARE` гарантирует fail-closed отказ при попытке назначить несуществующую роль, роль другого workspace, глобальную пользовательскую роль (`applicationId = null`) или роль чужого приложения (например, стандартную роль `Admin` стороннему приложению).
3. **Двухфазная верификация (`verifyState('update')` и `verifyState('flush')`)**:
   Проверяет, что строка `core.application` не удалена (`deletedAt === null`), её `universalIdentifier` не изменился, `defaultRoleId` равен ожидаемому `normalizedDefaultRoleId`, а канонический снимок целевой строки `core.role` (`canonicalAuditJson`) не изменился ни во время `work(runner)`, ни во время `audit.flush()`.
4. **Защита от повторного использования и вложенных контекстов**:
   Регистрация `registerMetadataAuditScopeCheck(getApplicationDefaultRoleAudit)` и множества `active` / `consumed` (`WeakSet`) корректно блокируют вложенные вызовы внутри других ролевых/метаданных аудит-контекстов и повторное использование токена `request`.

### Замечание по валидации явного `MembershipCleanupIdentity`

- **R4 (Требование `workspaceId` для явного `MembershipCleanupIdentity`)**:
  В `application-default-role-audit.ts:74-89` при передаче явного `identity` типа `MembershipCleanupIdentity` вызывается `membershipCleanupOperation(normalizedWorkspaceId, identity)`. Внутри `copyMembershipCleanupIdentity` (`membership-cleanup-identity.ts:62`) допускается `identity.workspaceId === undefined`, если `actor.kind === 'coreUser'` (для глобальных операций над `coreUser`). В `withCrmAuditIdentity` (`crm-audit-attribution-context.ts:75`) это закрыто явной проверкой `if (captured && captured.workspaceId !== scope) throw new Error('CRM audit context requires scoped identity')`.
  **Рекомендация**: в `resolveCapturedOperation` (`application-default-role-audit.ts`) для ветки `'actor' in identity` также проверить, что `identity.workspaceId !== undefined` (либо что `copyMembershipCleanupIdentity(identity, normalizedWorkspaceId)?.workspaceId === normalizedWorkspaceId`), чтобы отклонять unscoped `MembershipCleanupIdentity`.

---

## 3. Безопасность `ApplicationService.update` (кэш, события и неопределённость коммита)

1. **TOCTOU-защита входного `data`**:
   В `ApplicationService.update` (`application.service.ts:818`) синхронно до первого `await` создаётся поверхностная копия `const capturedData = { ...data }`, которая затем используется во всех ветках (как при наличии `defaultRoleId`, так и без него, включая вычисление `updatedFields`). Мутация входного объекта вызывающим кодом после старта промиса не влияет ни на запрос к БД, ни на аудит, ни на событие broadcast.
2. **Порядок инвалидации кэша и отправки событий**:
   - В ветке с `defaultRoleId` вызов `workspaceCacheService.invalidateAndRecompute(capturedData.workspaceId, ['flatApplicationMaps'])` выполняется после завершения `runAuditedApplicationDefaultRoleUpdate` (то есть после подтверждённого `COMMIT`), что предотвращает прогрев кэша устаревшим значением из пула соединений до коммита транзакции.
   - При возникновении `NativeTransactionOutcomeUnknownError` или `CoreAuditPostCommitError` кэш `['flatApplicationMaps']` принудительно инвалидируется в защищённом `try / catch`, `ROLLBACK` не выполняется, событие `broadcastApplicationEvent` не отправляется, а исходная ошибка пробрасывается вызывающему коду.
   - При откате транзакции до `COMMIT` ни пересчёт кэша, ни отправка события не выполняются.
   - В ветке без `defaultRoleId` (`capturedData.defaultRoleId === undefined`) существующее поведение полностью сохранено.

---

## 4. Соответствие `scripts/omnichannel/check_enterprise_dependencies.py`

Изменения в `crm-audit.types.ts`, `crm-audit-transaction-context.ts`, `crm-audit-attribution-context.ts`, новый модуль `application-default-role-audit.ts` и его подключение в `application.service.ts`, `application-manifest-migration.service.ts`, `role.service.ts`, `twenty-standard-application.service.ts`, `workspace-manager.service.ts`, `dev-seeder.workspace-service.ts` полностью удовлетворяют правилам `scripts/omnichannel/check_enterprise_dependencies.py`:

1. Ни один из модулей `src/engine/core-modules/crm-audit/*`, `core-audit-post-commit.error.ts`, `native-transaction-outcome-unknown.error.ts` не содержит `@license Enterprise` и не входит в обратное замыкание `reaches_enterprise` из `Research/omnichannel_crm/implementation/enterprise-dependency-baseline.json`.
2. Следовательно, новые рёбра импортов из `application.service.ts`, `application-manifest-migration.service.ts` и `twenty-standard-application.service.ts` на модули `crm-audit` не создают новых элементов в `runtime_enterprise_reachable` или `enterprise_edges`.
3. В коде отсутствуют конструкции, порождающие `opaque_dependencies` (динамические `import`/`require`, шаблонные литералы с `import`/`require`, сложные выражения в `@Inject(...)`, вызовы `moduleRef.get/resolve/create`) и `unresolved_local_imports`.

---

## 5. Анализ `test-research.md` и тестов `crm-audit-application-default-role.postgres-spec.ts`

План тестирования в `test-research.md` и реализованный набор `crm-audit-application-default-role.postgres-spec.ts` охватывают все основные позитивные, идемпотентные и негативные сценарии на реальном PostgreSQL с ограниченной ролью БД (append-only права на `crm_audit."crmAuditEntry"`).

- **R5 (Дополнение тестовых сценариев в `crm-audit-application-default-role.postgres-spec.ts`)**:
  1. В `test-research.md` (раздел 1, п. 2) заявлена проверка сброса `defaultRoleId` в `null` при синхронизации манифеста (`ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`), но в `crm-audit-application-default-role.postgres-spec.ts:872` сброс в `null` сейчас вызывается напрямую через `applicationService.update(...)` вместо `applicationManifestMigrationService.syncMetadataFromManifest(...)` (вследствие замечания `R1`). После исправления `R1` в `syncApplicationReferencesFromManifest` рекомендуется вызывать в этом тесте именно `applicationManifestMigrationService.syncMetadataFromManifest` с `defaultRoleUniversalIdentifier: undefined`, `inferDeletionFromMissingEntities: true` и `ownerFlatApplication.defaultRoleId = manifestRoleTwoId`.
  2. Рекомендуется добавить в первый тест проверку дефолтной системной атрибуции `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow({ workspaceId })` (без передачи `auditIdentity`, ожидается `actor: { kind: 'system', id: 'twenty-standard-application:sync' }`) и идемпотентного пропуска `setStandardApplicationDefaultRoleOrThrow`, когда `twentyStandardFlatApplication.defaultRoleId` уже установлен.
