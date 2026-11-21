# Design LOG-198: транзакционный аудит правил валидации метаданных (`validationRule` в `core."validationRule"`)

## Цель и граница
Закрыть транзакционный аудит полного жизненного цикла правил валидации метаданных (`validationRule` в `core."validationRule"`), включая прямой CRUD, AI-инструменты, побочные обновления/удаления при мутациях объектов и полей, пакетные миграции приложений и fail-closed барьер.

## Архитектура и граница Enterprise
Все модули в `packages/twenty-server/src/engine/metadata-modules/validation-rule/*` помечены `/* @license Enterprise */`.
- Маркеры `/* @license Enterprise */` сохраняются нетронутыми.
- Новый раннер `packages/twenty-server/src/engine/core-modules/crm-audit/validation-rule-audit.ts` работает с `to_jsonb(vr)` и `Record<string, unknown>`, импортируя только модули из `crm-audit/*`, `class-validator`, `typeorm` и `node:*` (ни одного импорта в `validation-rule/*`). Таким образом, `validation-rule-audit.ts` остаётся вне `reaches_enterprise`, а вызов из `validation-rule/*` (EE -> non-EE) не создаёт новых `enterprise_edges`.

## Компоненты
1. **`crm-audit.types.ts` и `crm-audit-transaction-context.ts`**:
   - Добавить `'validationRule'` в `CrmAuditResourceKind`.
   - `CATALOG.validationRule`:
     - `values`: `['applicationId', 'objectMetadataId', 'errorFieldMetadataId', 'isActive']`
     - `redacted`: `['name', 'description', 'icon', 'expression', 'bindings', 'message']`
   - `ADMINISTRATIVE_ACTIONS.validationRule`: `['create', 'update', 'delete']`.

2. **Новый раннер `packages/twenty-server/src/engine/core-modules/crm-audit/validation-rule-audit.ts`**:
   - `ValidationRuleAuditIdentity` (поддерживает `RoleUpdateAuditIdentity`, `CrmAuditOperation`, request-like с `workspace?`, `user?`, `workspaceMemberId?`, `apiKey?`, `application?`, `agentId?`, `impersonationContext?`, `impersonatorUserWorkspaceId?`).
   - `ValidationRuleAuditRequest`: `workspaceId`, `expectedAction: 'create' | 'update' | 'delete'`, `expectedId?: string`, `expectedObjectMetadataId?: string`, `operation`, `impersonatorUserWorkspaceId?`.
   - `projectValidationRule(row)`: каноническая проекция всех полей `CATALOG.validationRule` (`applicationId`, `objectMetadataId`, `errorFieldMetadataId`, `isActive`, `name`, `description`, `icon`, `expression`, `bindings`, `message`).
   - `captureValidationRuleAudit({ workspaceId, expectedAction, expectedId, expectedObjectMetadataId, auditIdentity })`: синхронный захват `operation` до первого `await`; для `create` поддерживает привязку `expectedId` перед запуском миграции (или через возвращаемую фабрику `(expectedId?: string) => ValidationRuleAuditRequest`).
   - `withValidationRuleAudit`, `getValidationRuleAudit`, регистрация через `registerMetadataAuditScopeCheck(getValidationRuleAudit)`.
   - `runAuditedValidationRuleMigration(dataSource, request, actions, mappings, execute)`:
     - Проверяет ровно 1 action с `metadataName === 'validationRule'` и `type === request.expectedAction` (с case-insensitive поиском в `mappings.validationRules`).
     - Внутри `runInCoreAuditTransaction`: `SET LOCAL lock_timeout = '8s'`, блокирует `core.workspace` `FOR KEY SHARE` и `core.application` `FOR KEY SHARE` (сверка `workspaceId`, `universalIdentifier`, `deletedAt IS NULL`), делает workspace-wide snapshot `core."validationRule"` `FOR UPDATE`.
     - Выполняет `execute(runner)`, сверяет post-state snapshot `core."validationRule"` (ровно 1 create / update / delete на целевой строке, отсутствие мутаций других строк, неизменность `applicationId` и `objectMetadataId` при `update`), записывает аудит (`before: null` на `create`, `after: null` на `delete`), вызывает `audit.flush()` и делает пост-flush сверку всего snapshot `core."validationRule"`.

3. **Подключение callers**:
   - `ValidationRuleResolver`: добавить `@Context() context?: { req?: ValidationRuleAuditIdentity }` в `createValidationRule`, `updateValidationRule`, `deleteValidationRule`, передать `auditIdentity: context?.req`.
   - `ValidationRuleService`: принять `auditIdentity?: ValidationRuleAuditIdentity` в `create`, `update`, `delete`; синхронно захватить аудит до первого `await` (до `assertHasValidationRulesEntitlement`); обернуть `runValidationRuleMigration` в `withValidationRuleAudit(...)`.
   - `CreateValidationRuleTool` и `UpdateValidationRuleTool`: условно передать `auditIdentity` из `ToolExecuteArgs.context` (при наличии `authContext`, `userId`, `actorContext?.workspaceMemberId`, `application?.id` или `agentId`).

4. **Side-effects в `navigation-menu-item-audit.ts` (`mode: 'cascade'`)**:
   - Добавить `'validationRule'` в `CASCADE_ALLOWED_METADATA_NAMES`.
   - В `cascade`: разрешать только `validationRule: update` (побочные обновления правил при `fieldMetadata: update` / `objectMetadata: update` из `fieldValidationRulesOnUpdateSideEffectHandler`), отклонять `validationRule: create` и `validationRule: delete`.
   - Добавить `hasValidationRuleTable` в `to_regclass`-проверку; при `hasValidationRuleTable && (plannedValidationRuleUpdates.size > 0 || actions.some(a => a.metadataName === 'validationRule'))` снимать workspace-wide snapshot `core."validationRule"` `FOR UPDATE`, после `execute(runner)` сверять отсутствие create/delete и неизменность `applicationId`/`objectMetadataId`, записывать `validationRule:update` в общий `CrmAuditTransactionContext`, и выполнять пост-flush сверку.

5. **`application-metadata-audit.ts` и fail-closed барьер**:
   - Добавить `'validationRule'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` (автоматически активирует fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun` и `WorkspaceMigrationValidateBuildAndRunService.needsSystemApplicationAudit`).
   - Добавить `to_regclass('core."validationRule"') IS NOT NULL AS "validationRule"` в `readExistingTables`.
   - В `runAuditedApplicationMetadataMigration`:
     - `manifest`: `create` (`plannedValidationRuleCreatesByUniversalId`), `update` (`plannedValidationRuleUpdates`), `delete` (`plannedValidationRuleDeletes`).
     - `objectDelete`: разрешить `validationRule: delete` (для `objectMetadataId ∈ plannedObjectDeletes`, включая чужой `applicationId`) и `validationRule: update` (побочное обновление от `plannedFieldDeletes`).
     - `fieldDelete`: разрешить `validationRule: update` (побочное обновление от `fieldValidationRulesOnDeleteSideEffectHandler` или FK `ON DELETE SET NULL` на `errorFieldMetadataId`, включая чужой `applicationId`).
     - Сверка `beforeValidationRules` vs `afterValidationRules`, запись `validationRule:create` / `update` / `delete`, и пост-flush сверка.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata`:
     - Добавить `'validationRule'` в прямую проверку по `applicationId`.
     - Добавить каскадные проверки `core."validationRule"` по `objectMetadataId` (`ON DELETE CASCADE`) и `errorFieldMetadataId` (`ON DELETE SET NULL`).
   - В `WorkspaceMigrationRunnerService.executeRun`:
     - Подключить `validationRuleAudit = getValidationRuleAudit(workspaceId)` в эксклюзивные владельцы аудита, передать `validationRules: allFlatEntityMaps.flatValidationRuleMaps?.byUniversalIdentifier ?? {}` в `mappings` для всех веток (`validationRuleAudit`, `navigationMenuItemAudit`, `applicationMetadataAudit`).
