# LOG176 - транзакционный аудит обновлений переменных приложений уровня рабочего пространства (`applicationVariable`) и жизненного цикла флагов функций (`featureFlag`)

Дата: 09.11.2026
Задача: ROB-765 (Этап 2a - сбор и достоверность аудита действий)
Статус: Design

## 1. Контекст и проблема

После закрытия `LOG167` (`applicationAuthorization` и пользовательских значений `userApplicationVariableValue`) и `LOG175` (`webhook`) в `packages/twenty-server` остаются открытыми две тесно связанные поверхности конфигурации приложений и рабочего пространства в схеме `core`:

1. **Прямое обновление значений переменных приложений уровня рабочего пространства (`core."applicationVariable"`, `scope <> 'USER'`)**:
   - В `LOG167` был подключён аудит пользовательских значений `core."userApplicationVariableValue"` (`UserApplicationVariableValueService.updateMyUserApplicationVariable`), а также блокировка и проверка `core."applicationVariable"` при пакетных миграциях манифеста в `runAuditedApplicationMetadataMigration`.
   - Однако прямое обновление зашифрованного значения (`value`, формат `enc:v2:...`) переменной приложения уровня рабочего пространства через `ApplicationVariableEntityResolver.updateOneApplicationVariable` -> `ApplicationVariableEntityService.update` (`packages/twenty-server/src/engine/core-modules/application/application-variable/application-variable.service.ts`) выполняется вне `runInCoreAuditTransaction`, без захвата субъекта аудита до первого `await`, без блокировки строк `core.workspace`, `core.application` и `core."applicationVariable"`, без записи события `applicationVariable:update` в `crm_audit."crmAuditEntry"` и без инвалидации кэша `'flatApplicationVariableMaps'` при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`.
   - Кроме того, проверка существования переменной и условия `existingVariable.scope !== 'USER'` в `ApplicationVariableEntityService.update` отделена от последующего `applicationVariableRepository.update` (окно TOCTOU).

2. **Жизненный цикл флагов функций рабочего пространства (`core."featureFlag"`)**:
   - Таблица `core."featureFlag"` (`FeatureFlagEntity`: `id`, `workspaceId`, `key`, `value`, уникальное ограничение `("key", "workspaceId")`) управляет включением экспериментальных и административных возможностей рабочего пространства.
   - Мутации `core."featureFlag"` выполняются через:
     - `LabResolver.updateLabPublicFeatureFlag` (`packages/twenty-server/src/engine/core-modules/lab/lab.resolver.ts`) -> `FeatureFlagService.upsertWorkspaceFeatureFlag` (`shouldBePublic: true`);
     - `AdminPanelResolver.updateWorkspaceFeatureFlag` (`packages/twenty-server/src/engine/core-modules/admin-panel/admin-panel.resolver.ts`) -> `FeatureFlagService.upsertWorkspaceFeatureFlag` (серверный администратор может изменять флаги как своего, так и другого рабочего пространства, включая сессии под имперсонацией);
     - `FeatureFlagService.enableFeatureFlags` (`packages/twenty-server/src/engine/core-modules/feature-flag/services/feature-flag.service.ts`), вызываемый из `WorkspaceService.activateWorkspace` и команд обновления.
   - Сейчас `FeatureFlagService.upsertWorkspaceFeatureFlag` и `FeatureFlagService.enableFeatureFlags` выполняют неатомарное чтение и `upsert` вне `runInCoreAuditTransaction`, не захватывают субъекта аудита до первого `await`, не записывают `featureFlag:create` / `featureFlag:update` в `crm_audit."crmAuditEntry"` и не инвалидируют `'featureFlagsMap'` при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`.

## 2. Варианты решения

### Вариант 1 (Рекомендуемый): Расширить `crm-audit.types.ts`, `crm-audit-transaction-context.ts` и `application-authorization-and-variable-audit.ts` с подключением `ApplicationVariableEntityService`, `ApplicationVariableEntityResolver`, `FeatureFlagService`, `LabResolver`, `AdminPanelResolver` и `WorkspaceService`
- В `crm-audit.types.ts` добавить `'applicationVariable'` и `'featureFlag'` в `CrmAuditResourceKind`.
- В `crm-audit-transaction-context.ts`:
  - `CATALOG.applicationVariable = { values: ['applicationId', 'scope', 'isSecret'], redacted: ['key', 'value'] }`;
  - `CATALOG.featureFlag = { values: ['key', 'value'], redacted: [] }`;
  - `ADMINISTRATIVE_ACTIONS.applicationVariable = ['update']` (создание и удаление определений `applicationVariable` в миграциях манифеста уже верифицируются снимком `FullMetadataSnapshot` в `runAuditedApplicationMetadataMigration` без генерации отдельных записей, сохраняя инварианты `LOG167`);
  - `ADMINISTRATIVE_ACTIONS.featureFlag = ['create', 'update']`.
- В `application-authorization-and-variable-audit.ts`:
  - Расширить `resolveOperationFromIdentity` для поддержки request-подобных объектов и `{ auth: { type: 'user', workspace: { id }, user: { id } } }` (для кросс-воркспейсных операций серверного администратора без `workspaceMemberId` в целевом пространстве).
  - Добавить `captureApplicationVariableUpdateAudit`, `projectApplicationVariable` и `runAuditedApplicationVariableUpdate`:
    - Внутри `runInCoreAuditTransaction` устанавливается `SET LOCAL lock_timeout = '8s'`, захватываются блокировки `core.workspace FOR NO KEY UPDATE` (с проверкой `deletedAt IS NULL`) и `core.application FOR NO KEY UPDATE` (по `id` и `workspaceId`, с проверкой `deletedAt IS NULL`).
    - При отсутствии приложения в целевом `workspaceId` или отсутствии строки `core."applicationVariable"` возвращается `{ status: 'not_found' }` без записи в журнал аудита, чтобы `ApplicationVariableEntityService.update` выбросил канонический `ApplicationVariableEntityExceptionCode.APPLICATION_VARIABLE_NOT_FOUND`.
    - Если строка `core."applicationVariable"` найдена под `FOR UPDATE`, проверяется совпадение `uuid(beforeRow.workspaceId) === request.workspaceId`; при `beforeRow.scope === 'USER'` возвращается `{ status: 'user_variable' }`, чтобы сервис выбросил канонический `ApplicationVariableEntityExceptionCode.INVALID_APPLICATION_VARIABLE_INPUT`.
    - При `request.operation.actor.kind === 'application'` под блокировкой БД проверяется `uuid(request.operation.actor.id) === normalizedApplicationId`.
    - Выполняется `UPDATE core."applicationVariable" SET "value"=$1, "updatedAt"=now() WHERE id=$2 AND "workspaceId"=$3 AND "applicationId"=$4 AND scope <> 'USER' RETURNING to_jsonb("applicationVariable") AS row`, проверяются инварианты `afterRow` (включая неизменность остальных столбцов и префикс `enc:v2:`), при изменении проекции записывается `applicationVariable:update` (где `key` и `value` редактируются до хешей), вызывается `audit.flush()` и повторно сверяется снимок строки после flush.
  - Добавить `captureFeatureFlagAudit`, `projectFeatureFlag`, `runAuditedFeatureFlagUpsert` и `runAuditedFeatureFlagsEnable`:
    - `captureFeatureFlagAudit` синхронно до первого `await` проверяет отсутствие конфликтующих областей аудита и извлекает субъекта из явного `auditIdentity`, контекста ALS (`captureCurrentCrmAuditOperation`) или (только для `enableFeatureFlags`) системного `fallbackSystemActorId`.
    - `runAuditedFeatureFlagUpsert` под `SET LOCAL lock_timeout = '8s'` блокирует `core.workspace FOR NO KEY UPDATE` (`deletedAt IS NULL`) и существующую строку `core."featureFlag" WHERE "workspaceId"=$1 AND key=$2 FOR UPDATE`. Если строка уже существует и `Boolean(beforeRow.value) === value`, возвращается `{ row: beforeRow, mutated: false }` без лишней записи в БД и без шумовой записи аудита. Иначе выполняется атомарный `INSERT ... ON CONFLICT ("key","workspaceId") DO UPDATE SET "value"=EXCLUDED."value", "updatedAt"=now() RETURNING to_jsonb("featureFlag") AS row`, записывается `featureFlag:create` или `featureFlag:update`, вызывается `audit.flush()` и повторно сверяется снимок строки после flush.
    - `runAuditedFeatureFlagsEnable` блокирует `core.workspace FOR NO KEY UPDATE` и существующие строки `core."featureFlag"` по списку ключей (`ORDER BY id FOR UPDATE`), создаёт или обновляет только те флаги, у которых `value !== true`, записывает `featureFlag:create` / `featureFlag:update` в одном `CrmAuditTransactionContext`, вызывает `audit.flush()` и повторно сверяет снимки всех затронутых строк после flush.
- Подключить точки входа:
  - `ApplicationVariableEntityService.update` и `ApplicationVariableEntityResolver.updateOneApplicationVariable` (включая передачу `callingApplicationId` и инвалидацию `'flatApplicationVariableMaps'` при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`);
  - `FeatureFlagService.upsertWorkspaceFeatureFlag` и `FeatureFlagService.enableFeatureFlags` (с синхронной валидацией ключа и захвата субъекта до первого `await`, а также инвалидацией `'featureFlagsMap'` при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`);
  - `LabResolver.updateLabPublicFeatureFlag`;
  - `AdminPanelResolver.updateWorkspaceFeatureFlag` (с корректной атрибуцией как внутри текущего рабочего пространства, так и при кросс-воркспейсном управлении серверным администратором и под имперсонацией);
  - `WorkspaceService.activateWorkspace` (`systemActorId: 'workspace-service:activate-workspace'`).

### Вариант 2: Отдельный модуль `feature-flag-audit.ts` со своим `AsyncLocalStorage`
- Плюсы: физическое разделение файлов.
- Минусы: дублирование инфраструктуры `withExclusiveAuditScope`, `resolveOperationFromIdentity` и регистрации в `registerMetadataAuditScopeCheck`, которая уже компактно реализована в `application-authorization-and-variable-audit.ts`.

**Решение:** Выбран Вариант 1.

## 3. Порядок блокировок и инварианты безопасности

1. **Порядок блокировок**:
   - Для `applicationVariable`: `core.workspace FOR NO KEY UPDATE` -> `core.application FOR NO KEY UPDATE` -> `core."applicationVariable" FOR UPDATE`.
   - Для `featureFlag`: `core.workspace FOR NO KEY UPDATE` -> `core."featureFlag" ORDER BY id FOR UPDATE`.
2. **Редактирование секретов**:
   - В `CATALOG.applicationVariable` поля `'key'` и `'value'` находятся в `redacted`: ни открытый текст, ни шифротекст `enc:v2:...`, ни имя ключа не попадают в `redactedDiff.values`.
   - В `runAuditedApplicationVariableUpdate` проверяется, что сохраняемое значение начинается с `'enc:v2:'`.
3. **Защита от TOCTOU и гонок**:
   - Проверки существования приложения/переменной и `scope !== 'USER'` выполняются внутри транзакции под блокировками `FOR NO KEY UPDATE` / `FOR UPDATE`.
   - Проверка `existingFeatureFlag?.value === value` выполняется внутри транзакции под `FOR UPDATE`, исключая потерю события при конкурентном переключении флага.
4. **Неопределённый исход коммита (`NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`)**:
   - В `ApplicationVariableEntityService.update` и `FeatureFlagService` (`upsertWorkspaceFeatureFlag`, `enableFeatureFlags`) при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` принудительно инвалидируются соответствующие ключи кэша (`'flatApplicationVariableMaps'`, `'featureFlagsMap'`) без подавления первичной ошибки.
5. **Граница Enterprise**:
   - Ни один из изменяемых модулей не импортирует файлы с `/* @license Enterprise */`.
