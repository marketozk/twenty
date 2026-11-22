# LOG-206 Independent Code Review

## Verdict
Первичный вердикт независимого адверсариального ревью кода: `NEEDS_FIX` (`0` Blocker, `2` Major, `4` Minor).
Все 6 находок исправлены и подтверждены повторным прогоном `guards`, `7/7` целевых PG 17 сьютов (`277/277` PASS) и дифференциальным `typecheck` (`pass-no-new-diagnostics`, `0/0/0`).

## Findings and Resolutions

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| M1 | Major | Предсуществующий uppercase `fileId` в JSONB `FILES` в БД блокируется для audited `update`/`updateMany` из-за регистрозависимого `FilesFieldSync.computeFilesFieldDiff` и `existingFileMap.get(file.fileId)` (при переименовании даёт одновременные `toAdd` + `toRemove`, при `documents: []` даёт `Attached file is missing or temporary`). | В `packages/twenty-server/src/engine/twenty-orm/field-operations/files-field-sync/files-field-sync.ts` ключи `existingFileMap`, `newFileMap`, `fileIdToFieldUniversalIdentifier`, `toAddMap`, `toUpdateMap` и все поиски переведены на `.toLowerCase()`. Добавлен PG-тест на предсуществующий uppercase `fileId` в БД (переименование, добавление файла и удаление через `updateMany` без мутации входного объекта). |
| M2 | Major | 1-by-1 fallback в `TrashCleanupService` обходит межзаписную проверку `Native file must have one unambiguous owner`, если две soft-deleted записи на странице делят один `fileId`: первая запись удалится и уничтожит файл, оставив вторую со ссылкой на удалённый файл. | `'Native file must have one unambiguous owner'` удалено из `TRASH_AUDIT_COVERAGE_REJECTION_MESSAGES` в `trash-cleanup.service.ts`: батч с общим файлом откатывается целиком (fail-closed) без перехода в поштучный fallback. Добавлен PG-тест. |
| m1 | Minor | Мёртвая строка `'OMNI_NATIVE_WRITE_OWNED_BY_DOMAIN_COMMAND'` в `TRASH_AUDIT_COVERAGE_REJECTION_MESSAGES` (реальная ошибка называется `'OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND'`). | Заменена на `'OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND'`. |
| m2 | Minor | Пробелы в тестовом покрытии (`JSON.stringify(intents)` в тесте 1, одиночный poison pill + курсор через страницы, shared `fileId` в `TrashCleanupService`, legacy uppercase `fileId` + `updateMany` + иммутабельность caller input, fail-open ветки `FilesFieldDeletionListener.handleUpdatedEvent`). | Все 5 групп сценариев добавлены в `crm-audit-trash-and-file-remove.postgres-spec.ts` (`9/9` тестов PASS). |
| m3 | Minor | Недетерминированный порядок чтения строк `core.file` в `createNativeCrmAuditFilesStore.apply` (без `ORDER BY id` и без сортировки `$2`). | Добавлены `ORDER BY id` и `[...owners.keys()].sort()`. |
| m4 | Minor | Избыточные проверки `=== null` / `!== null` после `isDefined(...)` в `FilesFieldDeletionListener.hasPotentialFilesFieldRemoval`. | Избыточные проверки удалены. |
