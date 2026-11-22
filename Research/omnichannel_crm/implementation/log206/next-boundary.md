# Следующая граница после LOG-206

## Что закрыто в LOG-206
- `TrashCleanupService` переведён на `nativeAudit` (`systemActorId: 'trash_cleanup'`, общий `correlationId` на прогон воркспейса) для покрытых CRM-объектов (`isNativeCrmAuditMetadata`) с поштучной fail-closed изоляцией poison-pill записей (непокрытые входящие FK / невалидный `core.file`), сохранением fail-closed отказа при общем `fileId`, пробросом аудитных/инфраструктурных ошибок и `NativeTransactionOutcomeUnknownError`.
- `UPDATE` `toRemove` в `native-crm-audit-files.ts` подключён к тому же долговечному owner `delete_filesFieldFiles` (`settings.toDelete: true` + атомарная вставка намерения в `core."deferredWorkspaceMigrationAction"` + пост-коммитный `FilesFieldDeletionListener.handleUpdatedEvent` -> `workspaceQueue`).
- Согласована регистронезависимая обработка UUID (`fileId`) между `WorkspaceRepository`, `FilesFieldSync` и `createNativeCrmAuditFilesStore` (включая предсуществующие uppercase `fileId` в БД).
- Строка `File hard-delete` в `rob765-progress.md` закрыта для всех покрытых CRM-путей (`DELETE`, `DESTROY`, `MERGE`, `TrashCleanupService`, `UPDATE` `toRemove`).

## Оставшиеся открытые границы ROB-765
1. **Session lifecycle (оставшиеся пробелы)**: family revoke при повторном использовании отозванного refresh-токена, stateless application JWT / concurrent-sign-in / in-flight fencing, оставшиеся пути выпуска/отзыва токенов и имперсонации.
2. **Post-rollback denied/failed audit и health/alerting**: общий post-rollback аудит отклонённых/неуспешных операций и алертинг.
3. **Оставшиеся native/core/metadata writers и FK-покрытие `prepareNativeCrmDeleteEffects`**: расширение покрытия входящих FK (`timelineActivity`, `noteTarget`, `taskTarget`, `attachment`, email `messageParticipant`) для удаления/очистки корзины, а также оставшиеся неподключённые native/core/metadata writers.
4. **Build / deployment / full HTTP/JWT acceptance**: сборка нового образа, полная сквозная HTTP/JWT приёмка и выкат (текущий собранный кандидат - `LOG088`).

## Рекомендуемый следующий срез (LOG-207)
- Закрыть оставшиеся пробелы **Session lifecycle** (refresh token family revoke + concurrent-sign-in / in-flight fencing / оставшиеся token/session writers) либо перейти к **post-rollback denied/failed audit** по приоритету `phase_2_audit.md`.
