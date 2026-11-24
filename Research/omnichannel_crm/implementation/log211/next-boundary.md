# Следующая граница после LOG-211

## Что закрыто в LOG-211
- **Полное транзакционное аудирование последнего пользовательского стандартного CRM-объекта вне `workflow` (`dashboard`)**:
  - `dashboard` добавлен в `AUDITED_OBJECTS` (полный CRUD, Branch A `ShareWithService`, `MERGE_MANY`, `DESTROY` + FK `attachment` CASCADE с `FILES` intent `delete_filesFieldFiles` и `timelineActivity` SET NULL, `TrashCleanupService` и post-rollback `denied`/`failed`).
- **Мост `nativeAuditBinding` (`WeakSet`-верифицированный, одноразовый)**:
  - `captureNativeCrmAuditBindingFromNavigationIdentity` и `assertTrustedNativeCrmAuditBinding` переносят `NavigationMenuItemAuditIdentity` + `authUserWorkspaceId` в `system`-контекст транзакций без маскирования ALS (`withCrmAuditRequest`), с проверкой принадлежности `workspaceMember` к `core."userWorkspace"` и поддержкой `coreUser`-имперсонации.
- **Все 4 runtime прямых писателя в `dashboard` переведены на строгие аудированные транзакции**:
  - `DashboardDuplicationService.duplicateDashboard` (ранняя проверка атрибуции, `systemActorId`, проброс `impersonatorUserWorkspaceId`/`correlationId`/`causationId` в `layoutAuditIdentity`, post-rollback `denied`/`failed`, защита компенсации через `!isTransactionUnsafeToRetry`).
  - `createCreateCompleteDashboardTool` (ранняя валидация до `pageLayoutService.create`, сохранение RLS-семантики, `buildRecordPosition` вне транзакции, post-rollback attempt, защита компенсации через `!isTransactionUnsafeToRetry`).
  - `DashboardSyncService.updateLinkedDashboardsUpdatedAtByPageLayoutId` (`systemActorId: 'dashboard-sync:update-linked-dashboards'`, чанкование по `200`, наследование `correlationId`, in-context post-rollback attempt).
  - `PageLayoutService.destroy -> destroyAssociatedDashboards` (ранняя валидация до `validateBuildAndRunWorkspaceMigration`, чанкованное удаление по `1000` с каскадами `attachment`/`timelineActivity`, in-context post-rollback attempt).

## Оставшиеся открытые границы ROB-765
1. **Защищённый административный health-эндпоинт и внешний sink алертинга (`CrmAuditHealthService` / `AdminPanelGuard` / `ROB-767`)**: `GET /healthz` остаётся zero-IO liveness.
2. **Архитектурные ограничения Session lifecycle**: `UserSessionEntity` не хранит `familyId`, `signOut({ refreshToken })` отзывает только предъявленный токен, `ApplicationTokenService` выпускает stateless JWT без DB-отзыва, `UserSessionCleanupCronJob` ожидает утверждения политики хранения.
3. **Предсуществующая гонка в `omni-human-text-command.postgres-spec.ts:668`** (`PK` vs `ON CONFLICT` в `admit-omni-human-text-command.ts` под PG 17, вне контура `LOG-211`): стоит проверить отдельно при работе с omni-командами.
4. **Build / deployment / full HTTP/JWT acceptance**: сборка нового изолированного серверного кандидата (текущий - `LOG088`), полная сквозная HTTP/JWT приёмка накопленного покрытия `LOG089`-`LOG211` и выкат.
5. **Workflow (`workflow`/`workflowVersion`/`workflowRun`/`workflowAutomatedTrigger`)**: относится к контуру `ROB-769`.

## Рекомендуемый следующий срез (LOG-212)
- Защищённый административный health-эндпоинт `CrmAuditHealthService` (с `AdminPanelGuard`) и конфигурация внешнего sink алертинга, либо сборка нового изолированного серверного кандидата и сквозная HTTP/JWT приёмка `ROB-765` по приоритету владельца.
