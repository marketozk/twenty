# LOG165 - аудит записей метаданных ролей, прав и `roleTarget` при установке, синхронизации и удалении приложений

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG165 закрывает все оставшиеся пакетные пути записи метаданных ролей (`core.role`), привязок агентов (`core."roleTarget"`) и пяти таблиц прав (`core."rolePermissionFlag"`, `core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"`, `core."rowLevelPermissionPredicate"`) при операциях над приложениями: синхронизацию манифеста в `ApplicationManifestMigrationService.syncMetadataFromManifest`, удаление приложения в `ApplicationSyncService.uninstallApplication` (`runUninstall`) + `ApplicationService.delete` и синхронизацию стандартного приложения `twenty-standard` в `TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`, а также fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun`.

В `application-metadata-audit.ts` реализованы `captureApplicationMetadataAudit`, `withApplicationMetadataAudit`, `runAuditedApplicationMetadataMigration`, `assertNoRemainingApplicationRoleOrPermissionMetadata` и `reconcileApplicationRoleAndPermissionOperations`. Внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`ORDER BY id FOR UPDATE`) и всех существующих в БД из 7 таблиц ролей, привязок и прав (`ORDER BY id FOR UPDATE`). Проверяется запрет удаления активных `defaultRoleId` и ролей, назначенных участникам или API-ключам, запрет скрытого каскадного удаления soft-deleted строк предикатов, сохранение привязки `core."roleTarget"` при одновременном удалении старой роли и перепривязке агента (`role.delete` перед `roleTarget.update`), учёт `ON DELETE SET NULL` на `workspaceMemberFieldMetadataId` и редактирование литерального поля `value`. Состояние всех 7 таблиц сверяется после `work(runner)` и повторно после `audit.flush()`. В `WorkspaceMigrationRunnerService.executeRun` поддерживаются смешанные миграции (DDL, `searchFieldMetadata`, `deferredActions`), корректная обработка `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` и отказ при любой неаудируемой попытке изменить 7 таблиц ролей и прав.

3120 tests/110 suites PASS (682.085s). 202 targeted/12 PostgreSQL suites PASS (22.704s), 6 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 466/468 roots, baseline 236 / current 234 diagnostics, 0 новых/changed-code. Совпали 7 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [оставшиеся открытые критерии ROB765](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
