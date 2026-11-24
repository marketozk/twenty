# Следующая граница после LOG-214

## Что закрыто в LOG-214
- Собран новый изолированный серверный образ-кандидат `marketozk/twenty:log214-server` (`sha256:337f98be0ed94b08b6556dab64568a4126fe97dbe43c569826f97b171c99110b`) с полным покрытием `LOG089`-`LOG214`.
- Пройдена реальная сквозная HTTP/JWT/GraphQL приёмка на живом сервере + воркере + PG 17 + Redis под ограниченной append-only ролью (`GET /healthz`, 27 BullMQ-подписок, логин + JWT + куки, `/admin-panel` `crmAuditHealth`, CRUD `company`/`note`/`task`/`dashboard`, post-rollback `failed` audit, `renewToken` + family revoke в `signOut`, чистый рестарт, стартовые гейты).
- Пойманы и исправлены 2 реальных production-бага (`GLOBAL_OBJECT_CONTEXT` в `VALID_COMMAND_MENU_ITEM_AVAILABILITY_TYPES` и base36-вычисление схемы `workspace_<base36>` в `navigation-menu-item-audit.ts`, `core-workflow-and-view-audit.ts` и `two-factor-authentication-audit.ts`).
- Пройдены `5/5` целевых PG 17 сьютов (`28/28` тестов PASS) и `33/33` Python-тестов на Linux (включая `7` Linux-only startup тестов); временный стенд полностью удалён (`STAND_CLEAN`).

## Оставшиеся решения и следующие этапы
1. **Закрытие `ROB-765` в Linear** (по решению владельца: изолированная приёмка завершена; живой выкат на демо не выполнялся и остаётся отдельным шагом).
2. **Следующий этап плана - `ROB-766`** (Этап 3: собственные права доступа и переходы сделок; открывает `ROB-767` просмотр/экспорт аудита и `ROB-768` коннекторы/чаты).
3. **Мелкое hardening-наблюдение из ревью `LOG-214`**: перевод `if (targetSchema)` в `core-workflow-and-view-audit.ts` и `two-factor-authentication-audit.ts` на fail-closed и вынос общего helper `resolveWorkspaceMemberSchema` (не блокирует `ROB-765`).
4. **Архитектурные ограничения, требующие отдельных решений/миграций**: `UserSessionEntity` не хранит `familyId`, `ApplicationTokenService` выпускает stateless JWT, `UserSessionCleanupCronJob` ожидает политики хранения.
