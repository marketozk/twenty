# LOG164 - аудит смены роли приложения по умолчанию (`core.application."defaultRoleId"`)

Проверки доработки завершены. ROB765 остаётся In Progress.
[Дизайн](design.md), [ревью решения](design-review.md), [ревью кода](review.md), [план проверок](test-research.md).

LOG164 закрывает все runtime-пути записи `core.application."defaultRoleId"` в `ApplicationService.update`: назначение системной роли кастомному приложению в `RoleService.createWorkspaceCustomApplicationRole`, установку роли `Admin` стандартному приложению в `TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow` (`WorkspaceManagerService.init`, `DevSeederWorkspaceService.seedDev`) и синхронизацию роли из манифеста в `ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`.

В `crm-audit.types.ts` и `crm-audit-transaction-context.ts` подключён вид ресурса `'application'` (`CATALOG.application = { values: ['defaultRoleId'], redacted: [] }`, `ADMINISTRATIVE_ACTIONS.application = ['update']`), а в `crm-audit-attribution-context.ts` добавлен синхронный захват `captureCurrentCrmAuditOperation`. В `application-default-role-audit.ts` реализованы `captureApplicationDefaultRoleAudit` (с регистрацией `registerMetadataAuditScopeCheck`, поддержкой явного `RoleUpdateAuditIdentity` / scoped `MembershipCleanupIdentity` и контекстов `withCrmAuditRequest` / `withCrmAuditIdentity`) и закрытая однотранзакционная функция `runAuditedApplicationDefaultRoleUpdate`. Внутри `runInCoreAuditTransaction` захватываются блокировки `core.workspace` (`FOR NO KEY UPDATE`), `core.application` (`FOR UPDATE`) и `core.role` (`FOR SHARE`, проверка принадлежности роли тому же приложению `targetRole.applicationId === applicationId`). Состояние `core.application` и `core.role` сверяется после `work(runner)` и повторно после `audit.flush()`. В `ApplicationService.create` заблокировано создание приложения с непустым `defaultRoleId`, а в `ApplicationService.update` при `NativeTransactionOutcomeUnknownError` и `CoreAuditPostCommitError` кэш `flatApplicationMaps` инвалидируется в защищённом `try / catch` без отправки ложного события `broadcastApplicationEvent`.

3114 tests/109 suites PASS (679.207s). 196 targeted/11 PostgreSQL suites PASS (20.845s), 7 новых PostgreSQL случаев. 33 guard tests PASS, 10 migration checksums неизменны, 0 нарушений границы Enterprise. Types 465/467 roots, baseline 245 / current 245 diagnostics, 0 новых/changed-code. Совпали 12 local/remote source hashes.

[Результаты](results.json), [сверка исходников](source-snapshot.json),
[типы](typecheck-differential.json), [регрессия](regression.log).

Далее - [аудит записей метаданных ролей, прав и `roleTarget` при установке, синхронизации и удалении приложений](next-boundary.md). Полный HTTP/JWT контроль и выкат остаются открытыми критериями. GitHub Actions не используется.
