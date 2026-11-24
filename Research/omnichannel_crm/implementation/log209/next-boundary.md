# Следующая граница после LOG-209

## Что закрыто в LOG-209
- **Полное FK-покрытие всех 10 стандартных системных дочерних таблиц (`noteTarget`, `taskTarget`, `attachment`, `timelineActivity`, `agentChatThreadTarget`, `calendarEventTarget`, `calendarEventParticipant`, `messageThreadTarget`, `messageParticipant`, `messageListMember`)** в `prepareNativeCrmDeleteEffects` (`DESTROY_ONE`/`DESTROY_MANY`, внутренний hard-delete, `TrashCleanupService`) и `MERGE_MANY`:
  - Все 10 таблиц остаются вне `isNativeCrmAuditMetadata` (обычные прямые записи и синк-воркеры не затронуты; прямые записи внутри `nativeAudit` по-прежнему fail-closed), но разрешены строго под `allowFkChildDeleteEffect: true` либо под узким грантом `runInNativeCrmMergeChildScope` (`kind: 'soft-delete'` либо `kind: 'update'` ровно одной колонки `allowedJoinColumnName` в `allowedTargetRecordId: priorityRecordId`).
  - `attachment.file` (`FILES`) при `CASCADE`-удалении родителя автоматически уходит в `prepareNativeCrmDeleteFiles` (`crmFile:update` + долговечное намерение `delete_filesFieldFiles` + пробуждение `FilesFieldDeletionListener.handleDestroyedEvent` -> `workspaceQueue`), а при миграции живого `attachment` в `MERGE_MANY` остаётся `UPLOADED` и нетронутым.
  - Защита omni-владения усилена на обеих ветках `CASCADE` и `SET NULL` (`assertChildMutationAllowed` с fail-closed проверкой обязательных колонок владения `messageId`/`messageThreadId`), включая кастомные объекты с морф-FK и `SET NULL` FK.
  - `TrashCleanupService` теперь полностью очищает soft-deleted `person`/`company`/`opportunity`/кастомные записи, на которые ссылаются любые из этих 10 стандартных дочерних таблиц (включая `attachment` с файлами и обычные email `messageParticipant`), продолжая блокировать omni-owned записи и непокрытые/транзитивные FK.

## Оставшиеся открытые границы ROB-765
1. **Остальные неподключённые native/core/metadata writers** (например `note`, `task`, `dashboard`, `workflow`, `workflowVersion`, `workflowRun` как корневые сущности - по приоритету и интеграционной карте) и durable cache.
2. **Подключение `CrmAuditHealthService` к защищённому административному API (`AdminPanelGuard` / `ROB-767`) и внешнему sink алертинга**: `GET /healthz` намеренно оставлен zero-IO liveness; защищённый health-эндпоинт и экспортёр метрик подключаются с учётом прав администратора.
3. **Архитектурные ограничения Session lifecycle**: `UserSessionEntity` не хранит `familyId`, `signOut({ refreshToken })` отзывает только предъявленный токен, `ApplicationTokenService` выпускает stateless JWT без DB-отзыва, `UserSessionCleanupCronJob` ожидает утверждения политики хранения.
4. **Build / deployment / full HTTP/JWT acceptance**: сборка нового изолированного кандидата (текущий - `LOG088`), полная сквозная HTTP/JWT приёмка накопленного покрытия `LOG089`-`LOG209` и выкат.

## Рекомендуемый следующий срез (LOG-210)
- Сборка нового изолированного серверного кандидата и сквозная HTTP/JWT приёмка накопленного покрытия `ROB-765` (`LOG089`-`LOG209`), либо закрытие оставшихся корневых native CRM writers (`note`/`task`) по приоритету владельца.
