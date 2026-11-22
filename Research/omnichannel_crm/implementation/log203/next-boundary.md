# Следующий участок после LOG203

После подключения всех публичных мутирующих CRM query runners (`CREATE`/`UPDATE`/`DELETE`/`RESTORE`/`DESTROY`/`MERGE`, `LOG203`: `CommonMergeManyQueryRunnerService` и `CommonBaseQueryRunnerService`) ближайшая открытая сквозная граница публичного CRM-слоя в рамках `ROB-765`:
- `LOG204`:
  1. Проброс ALS-атрибуции (`impersonatorUserWorkspaceId` -> `initiator`, `viaApplication`, `correlationId`) и проверка ALS-контекста в `CommonBaseQueryRunnerService` / `captureNativeCrmAuditOperation` для всех публичных нативных CRM-мутаций (`CREATE_ONE`, `CREATE_MANY`, `UPDATE_ONE`, `UPDATE_MANY`, `DELETE_ONE`, `DELETE_MANY`, `RESTORE_ONE`, `RESTORE_MANY`, `DESTROY_ONE`, `DESTROY_MANY`, `MERGE_MANY`).
  2. Проброс `NativeTransactionOutcomeUnknownError` без маскирования в `{ success: false }` во всех оставшихся мутирующих сервисах `record-crud` (`CreateRecordService`, `CreateManyRecordsService`, `UpdateRecordService`, `UpdateManyRecordsService`, `DeleteManyRecordsService`, `UpsertRecordService`, `UpsertManyRecordsService`).
