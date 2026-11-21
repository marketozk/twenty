# LOG-198: транзакционный аудит правил валидации метаданных (`validationRule` в `core."validationRule"`)

## Объём изменений
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `crm-audit-transaction-context.ts`: добавлен ресурс `validationRule` (`values`: `applicationId`, `objectMetadataId`, `errorFieldMetadataId`, `isActive`; `redacted`: `name`, `description`, `icon`, `expression`, `bindings`, `message`) и `ADMINISTRATIVE_ACTIONS.validationRule` (`['create', 'update', 'delete']`).
- `packages/twenty-server/src/engine/core-modules/crm-audit/validation-rule-audit.ts`: реализован модульный транзакционный раннер и валидатор без единого импорта Enterprise-модулей (`assertValidationRuleRowInvariants`, `projectValidationRule`, `doesValidationRuleReferenceAnyField`, `assertValidationRuleSideEffectUpdateInvariants`, `lookupValidationRuleMapping`, `captureValidationRuleAudit` с одноразовой фабрикой и строгой валидацией принципалов/имперсонации, `withValidationRuleAudit`, `getValidationRuleAudit` и `runAuditedValidationRuleMigration` с workspace-wide блокировкой `core."validationRule" FOR UPDATE`, блокировками `core.workspace`/`core.application` и пост-flush сверкой).
- `packages/twenty-server/src/engine/metadata-modules/validation-rule/validation-rule.resolver.ts`, `validation-rule.service.ts`, `tools/create-validation-rule.tool.ts`, `tools/update-validation-rule.tool.ts`: сохранены маркеры `/* @license Enterprise */`; подключён синхронный захват `auditIdentity` до первого `await` в `create`/`update`/`delete`, проброс `@Context()` из резолвера и условный проброс `auditIdentity` (включая `agentId` и `ambientOperation.impersonatorUserWorkspaceId`) из AI tools.
- `packages/twenty-server/src/engine/core-modules/crm-audit/navigation-menu-item-audit.ts`: в режиме `cascade` поддержаны cross-app side-effect `validationRule:update` при `fieldMetadata:update` с проверкой привязки правила к обновляемому полю (`doesValidationRuleReferenceAnyField`), запретом активации и изменения display/immutable полей, детерминированной предблокировкой сторонних `core.application` (`ORDER BY a.id FOR NO KEY UPDATE`) и пост-flush сверкой.
- `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts`: добавлено `'validationRule'` в `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES`; в `runAuditedApplicationMetadataMigration` поддержаны `create`/`update`/`delete`, cross-app side-effect updates с проверкой привязки к обновлённым/удалённым полям, неявные FK-каскады `ON DELETE CASCADE` (`objectMetadataId`) и `ON DELETE SET NULL` (`errorFieldMetadataId`) и пост-flush сверка; в `assertNoRemainingApplicationRoleOrPermissionMetadata` добавлены прямые, 1-hop и 2-hop (`validationRule -> fieldMetadata -> objectMetadata`) проверки остатков; в `reconcileApplicationRoleAndPermissionOperations` добавлено каскадное удаление `validationRule` по `flatValidationRuleMaps`.
- `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`: подключён `getValidationRuleAudit` / `runAuditedValidationRuleMigration`, передача `validationRules` в оба блока `mappings` и `'validationRule'` в `permissionCascadeMetadataNames` для `hasObjectOrFieldDeleteAction`.
- `packages/twenty-server/test/fork-migration/crm-audit-validation-rule.postgres-spec.ts`: 4 реальных PostgreSQL-сценария (CRUD через резолвер и AI tools с имперсонацией/агентской атрибуцией/редактированием формул, fail-closed барьер и инварианты принципалов/фабрики/каскадов, cross-app side-effects/manifest/FK-каскады/reconciler/остатки при удалении приложения, rollback при сбое flush и post-flush row drift).

## Артефакты
- [design.md](design.md)
- [design-review.md](design-review.md)
- [test-research.md](test-research.md)
- [review.md](review.md)
- [results.json](results.json)
- [source-snapshot.json](source-snapshot.json)
- [typecheck-differential.json](typecheck-differential.json)
- [regression.log](regression.log)
- [next-boundary.md](next-boundary.md)
