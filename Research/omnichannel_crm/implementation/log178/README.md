# LOG-178 - Транзакционный аудит полного жизненного цикла ИИ-навыков (`skill`, `core.skill`) и блокировка неаудируемого каскадного удаления при удалении `core.application`

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `skill`: `values: ['applicationId', 'isCustom', 'isSystem', 'isActive']`, `redacted: ['name', 'label', 'icon', 'description', 'content']`, действия `['create', 'update', 'delete']`.
2. Расширены `packages/twenty-server/src/engine/core-modules/crm-audit/navigation-menu-item-audit.ts`, `packages/twenty-server/src/engine/metadata-modules/skill/skill.service.ts` и `packages/twenty-server/src/engine/metadata-modules/skill/skill.resolver.ts`:
   - В `navigation-menu-item-audit.ts` добавлен режим `mode: 'skill'` (`assertSkillRowInvariants`, `projectSkill`, `readSkillSnapshot`, `serializeSkillSnapshot`, `expectedSkillCreateIds`, `expectedSkillUpdateIds`, `expectedSkillDeleteIds`) с блокировкой `core.skill` (`ORDER BY id FOR UPDATE`), проверкой активности приложения-владельца при активации/деактивации стандартных и сторонних навыков (`FOR NO KEY UPDATE`), запретом изменения `isCustom`/`isSystem` и запретом удаления некастомных навыков, записью `skill:create`, `skill:update`, `skill:delete` и повторной сверкой снимка после `audit.flush()`.
   - В `SkillService` (`create`, `update`, `delete`, `activate`, `deactivate`) и `SkillResolver` (`createSkill`, `updateSkill`, `deleteSkill`, `activateSkill`, `deactivateSkill`) подключён синхронный захват входных параметров и `auditIdentity` до первого `await` с передачей `authUserWorkspaceId`, `authApiKeyId`, `authApplicationId` и `impersonatorUserWorkspaceId`.
3. Расширены `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts` и `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`:
   - В `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` добавлен `'skill'` (fail-closed барьер на неаудируемые миграции `skill` в `WorkspaceMigrationRunnerService.executeRun` и автоматическая системная обёртка при `isSystemBuild: true` в `WorkspaceMigrationValidateBuildAndRunService`).
   - В `ApplicationMetadataAuditMappings` и `NavigationMenuItemAuditMappings` добавлен `skills`, заполняемый из `allFlatEntityMaps.flatSkillMaps`.
   - В `runAuditedApplicationMetadataMigration` добавлены чтение `core.skill` под `ORDER BY id FOR UPDATE`, запрет мутаций `skill` в режимах `objectDelete`/`fieldDelete`, сверка созданных и обновлённых строк с планом миграции, запись `skill:create`, `skill:update` и `skill:delete` и повторная сверка снимка после `audit.flush()`.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавлена проверка `core.skill` перед удалением `core.application` (`ApplicationService.delete`).

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `4` suites / `15` tests PASS (`9.782s`), включая `3` новых интеграционных теста в `packages/twenty-server/test/fork-migration/crm-audit-skill.postgres-spec.ts`.
- Полный регрессионный прогон: `123` suites / `3178` tests PASS (`697.768s`) - [`regression.log`](regression.log).
- Guard unit tests: `33` tests PASS (`0.190s`), `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `485` baseline / `486` current roots, `277` baseline / `277` current diagnostics, `0` новых и `0` в изменённом коде - [`typecheck-differential.json`](typecheck-differential.json).
- Снимок исходников: `8` файлов проверены по SHA-256 (LF) - [`source-snapshot.json`](source-snapshot.json).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
