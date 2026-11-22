# LOG-206 Independent Design Review

## Verdict
Первичный вердикт независимого адверсариального ревью: `NEEDS_REVISION` (`1` Blocker, `2` Major, `4` Minor).
Все 7 находок разобраны и закрыты в обновлённых `design.md` и `test-research.md` до начала реализации.

## Findings and Resolutions

| ID | Severity | Finding | Resolution in Design |
|---|---|---|---|
| B1 | Blocker | Poison pill / DoS в `TrashCleanupService`: 1 мягко-удалённая запись с непокрытым входящим FK (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment`, email `messageParticipant`), транзитивным FK, omni-защищённым `CASCADE`-потомком или невалидным `core.file` откатывает весь батч до 1000 записей и обрывает очистку всех остальных объектов воркспейса. | В `TrashCleanupService.deleteSoftDeletedRecords` добавлен узкий whitelist `isTrashAuditCoverageRejection` (строго исключающий `isTransactionUnsafeToRetry` и инфраструктурные/аудитные ошибки) с поштучным аудируемым fallback и `warn`-логом для проблемной записи: чистые записи удаляются с полным аудитом, проблемная запись остаётся нетронутой (fail-closed), курсор продвигается дальше. |
| M1 | Major | Несогласованность регистра UUID (`fileId`) в `UPDATE`/`updateMany`: `runInsert` нормализует `file.fileId.toLowerCase()`, а `runBatchUpdate` и `runMutation(update)` - нет; при смешанном регистре `FilesFieldSync.computeFilesFieldDiff` и `existingFileMap` расходятся с `createNativeCrmAuditFilesStore`. | В `workspace-repository.ts` добавлена нормализация `normalizeNativeFilesFieldIds` в `runBatchUpdate` и `runMutation(update)` по аналогии с `runInsert`; в `createNativeCrmAuditFilesStore` добавлена валидация `UUID_PATTERN` и полная нормализация ключей в нижний регистр. |
| M2 | Major | Неточное утверждение в `design.md` п. 2.2 о нулевой стоимости `nativeAudit` на пустых страницах (`withNativeCrmAuditTransaction` выполняет `pg_advisory_xact_lock`, проверку `operationId` и `verifyCrmAuditPrivileges` даже при 0 записях). | Утверждение исправлено в `design.md` п. 2.2; зафиксировано осознанное решение сохранить 1 транзакцию на страницу (суточный cron + сохранение 1 `pool.connect()` для race-теста `omni-parent-lifecycle` без TOCTOU). |
| m1 | Minor | Стандартный FK `opportunity.companyId` имеет `ON DELETE SET NULL`, а не `CASCADE`. | В `test-research.md` для проверки `CASCADE` + `FILES` используется `_customCase.companyId` с явным `ON DELETE CASCADE`, а `person`/`opportunity` проверяют `SET NULL`. |
| m2 | Minor | Крайние случаи `FilesFieldDeletionListener.handleUpdatedEvent`: `events.length === 0` до чтения кэша, `before !== null`, `before[fieldName] === undefined` при наличии поля в `updatedFields`. | Все 3 крайних случая явно добавлены в `design.md` п. 2.5. |
| m3 | Minor | Отсутствовал явный fail-closed запрет `mode === 'create' && action === 'toRemove'` в `createNativeCrmAuditFilesStore`. | Добавлена явная проверка с `throw new Error('Native file insert cannot remove files')`. |
| m4 | Minor | В `crm-audit-native-files.postgres-spec.ts:654,904` копирование `core.file` не включало `"applicationId"`, и не было теста на `BEFORE UPDATE` триггер, подменяющий `settings` при `toRemove`. | Добавлено обновление копирования `"applicationId"` и новый тест на пост-условие `settings.toDelete === true` при `toRemove`. |
