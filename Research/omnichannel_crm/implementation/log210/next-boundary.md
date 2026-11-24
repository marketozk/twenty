# Следующая граница после LOG-210

## Что закрыто в LOG-210
- **Полное транзакционное аудирование стандартных CRM-объектов `note` и `task`** (`AUDITED_OBJECTS`):
  - Покрыты все 11 корневых публичных мутаций (`CREATE_ONE/MANY`, `UPDATE_ONE/MANY`, `UPSERT`, `DELETE_ONE/MANY`, `RESTORE_ONE/MANY`, `DESTROY_ONE/MANY`, `MERGE_MANY`), `TrashCleanupService`, post-rollback `denied`/`failed` и `omniConversationTarget`-защита.
  - Композитное поле `bodyV2` (`RICH_TEXT`: `blocknote`/`markdown`/`tiptap`) и `title` полностью поддерживаются без утечки текстов в `crmAuditEntry` (`crmRecord` редактирует все значения полей).
- **Включён атомарный Branch A аудит `ShareWithService` на покрытых `CREATE` (`isNativeAuditCreateEligible`)**:
  - Убрана устаревшая pre-Branch-A проверка `resolveShareWithToWrite(...) !== null`: `INHERITED` (`note`, `task`), `PRIVATE` и покрытые `OPEN`-объекты с явным `shareWith` теперь атомарно пишут `crmRecord:create` и `recordShare:create` под одним `operationId` (непокрытые объекты сохраняют standalone Branch B).
- **Аудит каскадных хуков `NotePostQueryHookService` и `TaskPostQueryHookService` (`noteTarget` / `taskTarget`)**:
  - Строгая `nativeAudit` транзакция с `runInNativeCrmTargetLifecycleScope` (взаимное исключение с `mergeChildScopes` и `delegatedRecordShareExecutors`, только `noteTarget`/`taskTarget`), `WorkspaceOrmManager.getObjectMetadataId` (`Object.hasOwn`, 0 Enterprise-нарушений), fail-closed валидация UUID `payload` и `workspace.id`, каноническая блокировка только переходящих строк (`ORDER BY id FOR UPDATE`) + чанкование по `1000` (сохраняет database batch events `DELETED`/`RESTORED` и исключает лимит 65 535 bind-параметров), наследование ALS (`correlationId`, имперсонация) и `recordPostRollbackNativeCrmAuditAttempt`.

## Оставшиеся открытые границы ROB-765
1. **Оставшийся не-системный объект `dashboard`** (включая `DashboardDuplicationService`, `createCreateCompleteDashboardTool` и связь `correlationId` с `pageLayout` в `core`) и durable cache; `workflow` относится к контуру `ROB-769`.
2. **Подключение `CrmAuditHealthService` к защищённому административному API (`AdminPanelGuard` / `ROB-767`) и внешнему sink алертинга**: `GET /healthz` оставлен zero-IO liveness.
3. **Архитектурные ограничения Session lifecycle**: `UserSessionEntity` не хранит `familyId`, `signOut({ refreshToken })` отзывает только предъявленный токен, `ApplicationTokenService` выпускает stateless JWT без DB-отзыва, `UserSessionCleanupCronJob` ожидает утверждения политики хранения.
4. **Build / deployment / full HTTP/JWT acceptance**: сборка нового изолированного серверного кандидата (текущий - `LOG088`), полная сквозная HTTP/JWT приёмка накопленного покрытия `LOG089`-`LOG210` и выкат.

## Рекомендуемый следующий срез (LOG-211)
- Аудит `dashboard` (включая `DashboardDuplicationService` и `createCreateCompleteDashboardTool`) для закрытия последнего пользовательского стандартного CRM-объекта вне `workflow`, либо сборка нового изолированного кандидата и сквозная HTTP/JWT приёмка `ROB-765` по приоритету владельца.
