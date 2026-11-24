# LOG-211 - Нативный аудит CRM для `dashboard` и всех 4 прямых runtime-писателей

- Дата: `2026-11-24`
- Задача: Linear `ROB-765` (Phase 2a, остаётся `In Progress`)
- Ветка: `codex/omnichannel-requirements`

## Изменённые и добавленные файлы кода и тестов
1. `packages/twenty-server/src/engine/twenty-orm/types/workspace-transaction-lifecycle.type.ts` - определены `NativeCrmAuditBinding` и поле `nativeAuditBinding?: NativeCrmAuditBinding` в `WorkspaceTransactionOptions` (без новых Enterprise-рёбер).
2. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-record.ts` - добавлен `dashboard: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.dashboard` в `AUDITED_OBJECTS` (полное покрытие CRUD, Branch A `ShareWithService`, `MERGE_MANY`, `DESTROY` + FK `attachment` CASCADE с `FILES` / `timelineActivity` SET NULL, `TrashCleanupService` и post-rollback `denied`/`failed`).
3. `packages/twenty-server/src/engine/core-modules/crm-audit/native-crm-audit-transaction.ts` - добавлены `captureNativeCrmAuditBindingFromNavigationIdentity` и `assertTrustedNativeCrmAuditBinding` с модульными `WeakSet` (`trustedNavigationBindings` и одноразовый `consumedNavigationBindings`) для безопасного моста `NavigationMenuItemAuditIdentity` + `authUserWorkspaceId` в `system`-транзакции без маскирования ALS (`withCrmAuditRequest`), с проверкой принадлежности `workspaceMember` к `core."userWorkspace"` и поддержкой `coreUser`-имперсонации.
4. `packages/twenty-server/src/engine/core-modules/crm-audit/post-rollback-crm-audit-attempt.ts` - добавлена симметричная поддержка `pendingAuthUserWorkspaceId` (включая проверку `"workspace_<base36>"."workspaceMember"`), `coreUser`-имперсонации и новых сообщений невалидной атрибуции в `INVALID_NATIVE_ATTRIBUTION_MESSAGES`.
5. `packages/twenty-server/src/engine/twenty-orm/datasource/workspace-data-source.ts` - поддержка `options.nativeAuditBinding` (взаимоисключительно с `options.nativeAudit`, только при `authContext.type === 'system'`, валидация через `assertTrustedNativeCrmAuditBinding`).
6. `packages/twenty-server/src/modules/dashboard/services/dashboard-duplication.service.ts` - строгий транзакционный аудит дублирования дашбордов (`nativeAudit`, `systemActorId: 'dashboard-duplication:duplicate'` при `system`-аутентификации, ранняя проверка атрибуции до `pageLayoutDuplicationService.duplicate`, проброс `impersonatorUserWorkspaceId`/`correlationId`/`causationId` в `layoutAuditIdentity`, post-rollback `denied`/`failed` без дублирования, отказ от компенсационного удаления `pageLayout` при `isTransactionUnsafeToRetry(error)` и передача `isLinkedDashboardAlreadyDestroyed: true`).
7. `packages/twenty-server/src/modules/dashboard/tools/create-complete-dashboard.tool.ts` - ранний fail-closed захват `nativeAuditBinding` до `pageLayoutService.create`, сохранение нативного `buildSystemAuthContext` (без регрессии RLS), вынос `buildRecordPosition` до транзакции, строгий аудит вставки, post-rollback attempt и защита компенсационного `pageLayoutService.destroy` через `!isTransactionUnsafeToRetry(error)`.
8. `packages/twenty-server/src/modules/dashboard-sync/services/dashboard-sync.service.ts` - строгий системный аудит (`systemActorId: 'dashboard-sync:update-linked-dashboards'`, чанкование по `200` строк под `QUERY_MAX_RECORDS`, наследование ambient `correlationId`, in-context post-rollback attempt с сохранением best-effort семантики).
9. `packages/twenty-server/src/engine/metadata-modules/page-layout/services/page-layout.service.ts` - ранний захват `dashboardAuditBinding` в `destroy` до `validateBuildAndRunWorkspaceMigration`, чанкованное удаление (по `1000`) связанных дашбордов в `destroyAssociatedDashboards` под `nativeAuditBinding` с каскадами `attachment` (`FILES`) / `timelineActivity` и in-context post-rollback attempt.
10. `packages/twenty-server/src/modules/dashboard/tools/__tests__/create-complete-dashboard.tool.spec.ts` - обновлены моки под `runInWorkspaceTransaction` и добавлены unit-тесты на `nativeAuditBinding`, `agentId`, `NativeTransactionOutcomeUnknownError` и ранний fail-closed отказ.
11. `packages/twenty-server/test/fork-migration/crm-audit-custom-record.postgres-spec.ts` - `dashboard` убран из списка непокрытых стандартных объектов.
12. `packages/twenty-server/test/fork-migration/crm-audit-page-layout.postgres-spec.ts` - обновлён мок `workspaceOrmManager` в тесте `DashboardToolWorkspaceService` (`runInWorkspaceTransaction`, `getObjectMetadataId`).
13. `packages/twenty-server/test/fork-migration/crm-audit-dashboard.postgres-spec.ts` (новый) - 7 комплексных PG 17 сценариев: метаданные и fail-closed отказы `nativeAuditBinding`, CRUD + Branch A `ShareWithService` + `attachment` CASCADE (`FILES` intent) + `timelineActivity` SET NULL + `MERGE_MANY` + `TrashCleanupService` + `denied`, `DashboardDuplicationService`, `createCreateCompleteDashboardTool`, `DashboardSyncService`, `PageLayoutService.destroy -> destroyAssociatedDashboards`, а также все edge-инварианты ревью кода.

## Артефакты
- [design.md](design.md)
- [test-research.md](test-research.md)
- [design-review.md](design-review.md)
- [review.md](review.md)
- [results.json](results.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
