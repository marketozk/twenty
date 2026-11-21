# Test Research LOG-198

## Целевой новый PostgreSQL-спек
`packages/twenty-server/test/fork-migration/crm-audit-validation-rule.postgres-spec.ts` (4 сценария, least-privilege runtime роль, строгий guard `FORK_MIGRATION_TEST_URL`):
1. Прямой CRUD и AI tools:
   - `ValidationRuleResolver` -> `ValidationRuleService` (`createValidationRule` с имперсонацией и редактированием `name`/`description`/`icon`/`expression`/`bindings`/`message`, `updateValidationRule`, `deleteValidationRule`).
   - `CreateValidationRuleTool` и `UpdateValidationRuleTool` с `userId + agentId` (`actor: agent`, `initiator: coreUser`).
2. Fail-closed барьер и инварианты:
   - Отказ `WorkspaceMigrationRunnerService.run` на `validationRule` `create`/`update`/`delete` без audit scope.
   - Отказ `ValidationRuleService.create` без аутентифицированной идентичности.
   - Отказ в `navigation-menu-item-audit` `cascade` при `validationRule:create`/`delete`, `validationRule:update` без `fieldMetadata:update`, и при нарушении side-effect инвариантов (`isActive: false -> true`, изменение `name`).
3. Side-effects, пакетные миграции, FK-каскады и остатки при удалении приложения:
   - `navigation-menu-item-audit` `cascade`: cross-app side-effect `validationRule:update` при `fieldMetadata:update`.
   - `application-metadata-audit` `manifest`: `create`, cross-app side-effect `update`, cross-app `objectMetadata:delete` cascade.
   - `application-metadata-audit` `fieldDelete`: неявный FK `ON DELETE SET NULL` на `errorFieldMetadataId` + явный side-effect `isActive: false` (и отказ при изменении `expression`).
   - `application-metadata-audit` `objectDelete`: неявный FK `ON DELETE CASCADE` чужого правила.
   - `assertNoRemainingApplicationRoleOrPermissionMetadata`: блокировка по `applicationId`, `objectMetadataId`, `errorFieldMetadataId` и 2-hop `fieldMetadata -> objectMetadata`.
   - `reconcileApplicationRoleAndPermissionOperations`: каскадное добавление `validationRule` в `flatEntityToDelete` при удалении объекта.
4. Атомарность и откат:
   - Откат при сбое `audit.flush()` и при post-flush row drift в `core."validationRule"`.

## Связанные регрессионные спеки для таргетного прогона
- `packages/twenty-server/test/fork-migration/crm-audit-validation-rule.postgres-spec.ts` (новый)
- `packages/twenty-server/test/fork-migration/crm-audit-core-view-lifecycle.postgres-spec.ts` (`LOG197`)
- `packages/twenty-server/test/fork-migration/crm-audit-index-metadata.postgres-spec.ts` (`LOG196`)
- `packages/twenty-server/test/fork-migration/crm-audit-navigation-menu-item.postgres-spec.ts` (`LOG170`)
- `packages/twenty-server/test/fork-migration/crm-audit-object-and-field-delete-permissions.postgres-spec.ts` (`LOG166`)
