# LOG181 - Транзакционный аудит полного жизненного цикла типов событий таймлайна (`timelineActivityType`, `core."timelineActivityType"`) и каскадов удаления приложений

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `timelineActivityType`: `values: ['applicationId', 'action', 'frontComponentUniversalIdentifier', 'objectUniversalIdentifier', 'targetRelationFieldUniversalIdentifier', 'happensAtFieldUniversalIdentifier', 'replacesTimelineActivityTypeUniversalIdentifier', 'isActive']`, `redacted: ['name', 'label', 'icon', 'triggerFieldUniversalIdentifiers', 'overrides']`, действия `['create', 'update', 'delete']`.
2. Расширены `packages/twenty-server/src/engine/core-modules/crm-audit/navigation-menu-item-audit.ts`, `packages/twenty-server/src/engine/metadata-modules/timeline-activity-type/timeline-activity-type.service.ts` и `packages/twenty-server/src/engine/metadata-modules/timeline-activity-type/timeline-activity-type.resolver.ts`:
   - В `navigation-menu-item-audit.ts` добавлен режим `mode: 'timelineActivityType'` (`assertTimelineActivityTypeRowInvariants`, `projectTimelineActivityType`, `readTimelineActivityTypeSnapshot`, `serializeTimelineActivityTypeSnapshot`, `expectedTimelineActivityTypeCreateIds`, `expectedTimelineActivityTypeUpdateIds`, `expectedTimelineActivityTypeDeleteIds`) с блокировкой `core."timelineActivityType"` (`ORDER BY id FOR UPDATE`), проверкой активности приложения-владельца при переопределении/сбросе (`overrides` / `reset`) стандартных или сторонних типов событий таймлайна, сверкой созданных/обновлённых/удалённых строк, записью `timelineActivityType:create`, `timelineActivityType:update`, `timelineActivityType:delete` и повторной сверкой снимка после `audit.flush()`.
   - В `TimelineActivityTypeResolver` (`updateTimelineActivityType`, `resetTimelineActivityType`) и `TimelineActivityTypeService` (`update`, `reset` -> `persistUpdate`) подключён синхронный захват входных параметров и `auditIdentity` до первого `await`.
3. Расширены `packages/twenty-server/src/engine/core-modules/crm-audit/application-metadata-audit.ts` и `packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service.ts`:
   - В `AUDITED_ROLE_AND_PERMISSION_METADATA_NAMES` добавлен `'timelineActivityType'` (fail-closed барьер на неаудируемые миграции в `WorkspaceMigrationRunnerService.executeRun` и автоматическая системная обёртка при `isSystemBuild: true` в `WorkspaceMigrationValidateBuildAndRunService`).
   - В `runAuditedApplicationMetadataMigration` добавлены чтение `core."timelineActivityType"` под `ORDER BY id FOR UPDATE`, запрет её мутаций в режимах `objectDelete`/`fieldDelete`, сверка созданных, обновлённых и удалённых строк, запись событий аудита и повторная сверка снимка после `audit.flush()`.
   - В `assertNoRemainingApplicationRoleOrPermissionMetadata` добавлена проверка `core."timelineActivityType"` перед удалением `core.application` (`ApplicationService.delete`).

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `4` suites / `15` tests PASS (`10.516s`), включая `3` новых интеграционных теста в `packages/twenty-server/test/fork-migration/crm-audit-timeline-activity-type.postgres-spec.ts`.
- Полный регрессионный прогон: `126` suites / `3187` tests PASS (`711.226s`) - [`regression.log`](regression.log).
- Guard unit tests: `33` tests PASS (`0.184s`), `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `488` baseline / `489` current roots, `262` baseline / `262` current diagnostics, `0` новых и `0` в изменённом коде - [`typecheck-differential.json`](typecheck-differential.json).
- Снимок исходников: `8` файлов проверены по SHA-256 (LF) - [`source-snapshot.json`](source-snapshot.json).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
