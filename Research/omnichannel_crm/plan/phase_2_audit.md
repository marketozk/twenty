# Этап 2. Аудит действий — обязательный

Нормативные определения: [индекс владельцев](contracts/README.md). Этот документ содержит производные работы и проверочные сценарии; изменение семантики вносится у владельца и затем отражается в сценарии.

Подробный действующий контракт: [implementation-spec.md](implementation-spec.md), включая обязательные уточнения раздела 15, схему, транзакции, API, lifecycle и T01–T33. Этот краткий этап читается вместе с ним; готовность реализации по наличию плана не заявляется.

Спецификация: [design/08-audit.md](../design/08-audit.md). Статус: ROB-765 In Progress, реализация начата после подтверждённой приёмки ROB-764 (LOG088). ROB-767 остаётся Backlog. 2a зависит от 1; 2b зависит от собственной политики этапа 3. Остальные этапы дополняют аудит своими событиями.

Основа уже реализована в ROB-764 / LOG-022: CrmAuditEntry, транзакционный context,
append-only writer, безопасный diff и проверка DB privileges. Каталог до начала ROB-765 охватывал 23 вида ресурсов; собственные omni operations, native Message
composition, receipts/outbox/revisions используют общий atomic audit context (LOG028–087).
ROB-765 расширяет этот механизм на CRM/ORM/merge/bulk/session/metadata; ROB-767
добавляет просмотр и экспорт после собственных прав. ROB-765 начат; ROB-767 остаётся Backlog до собственных прав.
[Результат и границы LOG-022](../implementation/log022/README.md).

## Файлы

Существующая основа: server `engine/core-modules/crm-audit/{crm-audit-transaction-context.ts,append-crm-audit-entry.ts,crm-audit-canonical-json.ts,crm-audit.types.ts,verify-crm-audit-privileges.ts,entities/crm-audit-entry.entity.ts}`.
Audit entity размещена в отдельной schema `crm_audit` той же БД; она не является
workspace CRUD object. Второй writer/redaction protocol не создаётся.

Native/core adapters и каталог частично реализованы в том же модуле. Предстоят остальные owners,
query service/resolvers; front `src/modules/crm-audit/{pages/,components/,hooks/}`.
Общие типы выносятся в `twenty-shared` по необходимости потребителей.
Дополнительные индексы workspace/time/actor/entity/correlation — через fork migrations.

Опоры для интеграции: `engine/twenty-orm/workspace-orm.manager.ts`, `engine/api/common/common-query-runners/common-base-query-runner.service.ts`, `engine/core-modules/user-session/`, `engine/metadata-modules/role/`, workflow builder/executor, own access service. Полный перечень writers берётся из integration-map. Existing `event-logs/event-logs.service.ts` — Enterprise, его не подключаем и не переписываем license gate. EventEmitter2 не обеспечивает надёжность записи.

## 2a. Сбор и достоверность

Точные стыки — [integration-map](../implementation/integration-map.md) и [source audit](../implementation/transactions-audit-source.md). Audit entity в `crm_audit`; workspace writes должны использовать тот же pg executor через scope.executeRawQuery. Адаптер к workspace scope уже реализован в LOG028 и используется omni writers; автоматическое native покрытие частично реализовано; точный остаток — в [единственной таблице приёмки](../implementation/rob765-progress.md). Metadata/roles — QueryRunner migration runner до commit; session create/revoke — core transaction owner. FilesFieldSync для covered native CREATE/UPDATE использует тот же executor (LOG092/096); это не покрывает последующее физическое удаление файлов. Не использовать afterCommit/EventEmitter как долговечный writer.

- Writer принимает server-derived actor/context и transaction scope. Успешные mutations пишут audit в том же commit; при невозможности аудита критичная операция не подтверждается.
- Для session/core/metadata операций отдельно использовать их transaction owner; интерфейс writer не должен обещать атомарность через две connections. Отказ фиксировать после rollback, не терять событие вместе с отменённой mutation.
- Allowlist полей diff, redaction секретов/личных текстов/signed URLs; actor user/AI/workflow/import/API, initiating actor, outcome, reasonCode, IDs и policyVersion. Тексты чатов и prompts не дублируются в журнале.
- Lifecycle отправки/AI/workflow как связанные события, не один «успешно» в момент постановки. Provider outcome не откатывается из-за сбоя audit: retry только persistence receipt, не повтор внешней отправки.
- Append-only API и DB grants; migration/retention role отдельно. Не обещать криптографическую неизменность от superuser. Обязательный alert о недоступности; logout/revoke не удерживать ради журнала.

**Verify 2a:** отказ writer откатывает изменение; повтор даёт один success; rolled-back mutation не выглядит успешной; событие denial отдельно; secrets absent; crash после provider send не повторяет send; инициатор не подменяется browser payload.

ROB-764 уже вводит минимальный audit transaction context для omni-мутаций. ROB-765 распространяет его на native ORM/merge/bulk. Единый flush до COMMIT по spec §15.27: повторное изменение строки одним action внутри merge/bulk агрегируется first-before/last-after, не конфликтует по eventKey и не переносится в afterCommit. T06 проверяет flush failure и реальный rollback.

## 2b. Просмотр и экспорт

- Собственный экран «Аудит действий» и панель истории объекта: время/кто/что/источник/результат/безопасный diff/цепочка correlation.
- `audit.read/export/manageRetention`; фильтрация области и полей до выборки, count и экспорта. Исторический доступ не оставляет бессрочного права после увольнения/передачи клиента; deleted entities используют текущую административную политику и сохранённый security descriptor.
- Срок хранения и backup ещё выбираются; до решения не запускать автоматическую очистку. Экспорт и retention jobs сами аудируются без рекурсии.

**Verify 2b:** менеджер не видит чужой объект/имя/значение/count через audit query/export; revoke работает; application role не update/delete журнал; restore сохраняет связи событий; UI и API показывают одинаковый разрешённый набор.

**Done when:** карточка, сообщение, роль и workflow из тестовых сценариев имеют доказуемую цепочку автора и результата; журнал доступен без Enterprise key.

**Rollback:** отключение UI не отключает сбор; исправление событий добавлением нового correction-event, не редактированием истории. Для schema rollback сначала резервная копия и проверка потери полей/событий.

LOG087 adds bounded parent delete audit and retained current-administrative deletedParent scope, including multi-binding manifest hash. Native/custom FK effects without an audited writer refuse the operation. ROB765 must preserve this contract while broadening native ORM/lifecycle coverage; new destroy is not proof that generic native audit is complete.

## Актуальное покрытие и оставшиеся критерии

ROB765 остаётся In Progress. Подтверждённые участки и остаток перечислены только
в [rob765-progress](../implementation/rob765-progress.md).
Последние результаты и текущий шаг — в [STATUS](../STATUS.md);
история реализации, проверок и публикаций — в [DEVLOG](../DEVLOG.md).

В LOG134 подключён общий orphan sweep с единым аудитом и реальные jobs/CLI.
LOG136/137 подключают адресные messaging callers и blocklist. LOG138 добавляет
calendar-channel association owner и первый job call. LOG139 проверяет closed candidate
Event owner с фактическим каскадом и сохранением CallRecording; LOG140 подключает
единый global sweep и три jobs. LOG141 подключает оба provider/import cleanup caller
к общему аудиту Association и orphan Event, сохраняя unsafe outcomes. LOG142
объединяет public settings/reset и audit; cache-only действие выполняется после
подтверждённого COMMIT, прежние права/ответ/коды ошибок сохранены. LOG143 объединяет
provider Event/Association/Participant save с аудитом; фактические данные, источники,
generated fields и late effects проверены. Ручной provider success сохранён.
LOG144 объединяет import matching Participant/CalendarEventTarget и аудит;
source SHARE, actual effects и queue-before-matching сохранены. LOG145 подключает
фоновые rematch pages и исправляет stale-member-link; режимы сохраняют противоположные связи.
LOG146 закрывает календарные person-company targets с current source/parent proof,
actual effects и generated/FK проверками. LOG147 подключает messaging target pages
к существующему owner с current selector proof и отдельным аудитом каждой страницы.
LOG148 подключает оба режима messaging rematch job, исправляет stale-member-link
и проверяет реальные связи, APP policy и источники до изменения Participant, перед
расчётом Target и после deferred drain. LOG149 подключает post-save import matching
после сохранения сообщений для provider, inbound, sent, sent-tool и application с
манифестом затронутых участников до очереди контактов, проверкой полномочий источника
и сохранением успешной внешней отправки. LOG150 переводит первоначальное сохранение
обычных сообщений (пять таблиц записи и неизменный `messageThreadTarget`) на закрытый
owner с единым аудитом в одной strict/exclusive транзакции, выделяет read-only
планировщики для совместимости с каноническими omni receipts и формирует проверенный
манифест затронутых участников. LOG151 сохраняет этот манифест как долговечное намерение
`reconcile_messageImportMatching` в `core.deferredWorkspaceMigrationAction` внутри
транзакции сохранения, атомарно продвигает `nextPageIndex` или удаляет завершённое
намерение в каждой транзакции страницы сопоставления, блокирует `unsafeOutcome` и
восстанавливает незавершённые страницы с проверкой актуальных полномочий. LOG152
закрывает двухфазное автоматическое создание компаний и контактов (`CreateCompanyAndContactJob`,
`CreateCompanyAndPersonService`) для `EMAIL` и `CALENDAR` в strict/exclusive транзакции с
предвыборкой внешних метаданных домена вне блокировок БД, проверкой актуальных `core`-полномочий,
дедупликацией восстановления и пробросом `unsafeOutcome`. LOG153 сохраняет манифест сопоставления
календаря как долговечное намерение `reconcile_calendarImportMatching` в транзакции сохранения
`CalendarSaveEventsService`, атомарно удаляет завершённое намерение в коммите сопоставления,
блокирует `unsafeOutcome` и восстанавливает незавершённые намерения с проверкой актуальных
полномочий канала и аккаунта. LOG154 подключает `DeferredWorkspaceMigrationActionRunnerService`,
`DeferredWorkspaceMigrationActionRecoveryService` и `DeferredWorkspaceMigrationActionHandlerRegistryService`
к намерениям `reconcile_messageImportMatching` и `reconcile_calendarImportMatching` через обработчики
с `managesOwnPersistence = true` и защищает `resetStaleInProgressActions`, `enqueueWorkspacesWithPendingActions`
и `retryFailedActions` условием `NOT (payload ? 'unsafeOutcome')`. LOG155 закрывает транзакционную
свежесть import policy и `blocklist` (`import-policy-proof.ts`) при сохранении сообщений
(`saveOrdinaryMessageBatchWithAudit`, `InboundEmailImportService`), сохранении событий календаря
(`CalendarSaveEventsService`) и очистке связей синхронизации календаря
(`deleteOrdinarySyncCalendarAssociationsWithAudit`). LOG156 закрывает атомарный аудит удаления
ролей (`RoleService.deleteRole`, `RoleResolver.deleteOneRole`, `DeleteRoleTool.execute`) с
проверкой перепривязки активных участников, агентов и API-ключей к `defaultRoleId`, а также
назначение и снятие ролей агентов (`AiAgentRoleService`) и API-ключей (`ApiKeyRoleService`).
LOG157 закрывает атомарный аудит всех четырёх поверхностей изменения прав роли
(`RolePermissionFlagService.upsertPermissionFlags`, `ObjectPermissionService.upsertObjectPermissions`,
`FieldPermissionService.upsertFieldPermissions`, `RowLevelPermissionPredicateService.upsertRowLevelPermissionPredicates`,
`UpsertObjectPermissionsTool`, `UpsertRowLevelPermissionRulesTool`) с блокировками БД,
защитой от самоблокировки, проверкой зеркальных полей связей, защитой от `ON DELETE CASCADE`
и редактированием литерального фильтра `value`.
LOG158 закрывает атомарный аудит создания, обновления и отзыва API-ключей
(`ApiKeyService.create` / `update` / `revoke`, `ApiKeyResolver.createApiKey` / `updateApiKey` / `revokeApiKey`,
`ApiKeyController.create` / `update` / `remove`, `GenerateApiKeyCommand`) с однотранзакционной
привязкой `core."roleTarget"` и запретом реактивации отозванного ключа под блокировкой БД.
LOG159 закрывает атомарный аудит всех прямых и пакетных назначений ролей участникам
(`UserRoleService.assignRoleToManyUserWorkspace`, `UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace`,
`WorkspaceManagerService.setupDefaultRoles`, `DevSeederPermissionsService.initPermissions`)
с блокировками БД и защитой от пакетного разжалования всех администраторов.
LOG160 закрывает атомарный аудит системного и bootstrap-создания ролей
(`RoleService.createRole` / `createMemberRole` / `createGuestRole` / `createWorkspaceCustomApplicationRole` с `isEditable: false`),
согласование `applicationUniversalIdentifier` в `RoleTargetService.createMany` и системный аудит в
`WorkspaceManagerService` и `DevSeederPermissionsService`.
LOG161 закрывает атомарный аудит удаления неиспользуемых агентских ролей
(`AiAgentRoleService.deleteAgentOnlyRoleIfUnused` / `runAuditedUnusedAgentRoleDelete`),
безусловную fail-closed валидацию `AiAgentRoleService.assignRoleToAgent` и системный аудит
операций ролей агентов в `WorkflowVersionStepOperationsWorkspaceService` (`createDraftStep`, `runWorkflowVersionStepDeletionSideEffects`).
LOG162 закрывает атомарный аудит встроенных привязок `roleTarget` в `AgentService`
(`createOneAgent`, `updateOneAgent`, `deleteOneAgent`, `deleteManyAgents`, `withAgentMetadataRoleTargetAudit`):
смена роли агента - `delete` + `create`, удаление агента всегда аудируется и сверяет привязки в БД,
`auditIdentity` передают resolver, AI-инструменты и шаги workflow.
LOG163 закрывает атомарный аудит смены роли по умолчанию рабочего пространства
(`core.workspace."defaultRoleId"` в `WorkspaceService.updateWorkspaceById` / `WorkspaceResolver.updateWorkspace`,
`WorkspaceManagerService.setupDefaultRoles` и `DevSeederPermissionsService.initMinimalPermissionsAndActivateWorkspace`,
`runAuditedWorkspaceDefaultRoleUpdate` в `workspace-default-role-audit.ts`).
LOG164 закрывает атомарный аудит смены роли приложения по умолчанию
(`core.application."defaultRoleId"` в `ApplicationService.update`,
`RoleService.createWorkspaceCustomApplicationRole`,
`TwentyStandardApplicationService.setStandardApplicationDefaultRoleOrThrow` и
`ApplicationManifestMigrationService.syncApplicationReferencesFromManifest`,
`runAuditedApplicationDefaultRoleUpdate` в `application-default-role-audit.ts`).
LOG165 закрывает атомарный аудит пакетных миграций метаданных ролей (`core.role`),
привязок агентов (`core."roleTarget"`) и 5 таблиц прав (`core."rolePermissionFlag"`,
`core."objectPermission"`, `core."fieldPermission"`, `core."rowLevelPermissionPredicateGroup"`,
`core."rowLevelPermissionPredicate"`) при синхронизации манифеста, стандартного приложения и
удалении приложений (`ApplicationManifestMigrationService.syncMetadataFromManifest`,
`ApplicationSyncService.uninstallApplication`, `ApplicationService.delete`,
`TwentyStandardApplicationService.synchronizeTwentyStandardApplicationOrThrow`,
fail-closed барьер в `WorkspaceMigrationRunnerService.executeRun` и
`runAuditedApplicationMetadataMigration` в `application-metadata-audit.ts`).
LOG166 закрывает атомарный аудит каскадного удаления и обнуления записей прав
(`core."objectPermission"`, `core."fieldPermission"`,
`core."rowLevelPermissionPredicateGroup"`, `core."rowLevelPermissionPredicate"`) при
отдельном удалении объектов (`ObjectMetadataService.deleteOneObject` / `deleteManyObjectMetadatas`,
резолвер, контроллер, AI-инструмент) и полей (`FieldMetadataService.deleteOneField`, резолвер,
контроллер, AI-инструмент), разрешение каскадного удаления прав на нередактируемых ролях при
удалении целевого объекта или поля (`FlatObjectPermissionValidatorService`,
`FlatFieldPermissionValidatorService`), инвалидацию кэшей прав и `rolesPermissions` и
fail-closed барьер на неаудируемые удаления `objectMetadata`, `fieldMetadata`, `permissionFlag`
и `agent` в `WorkspaceMigrationRunnerService.executeRun`.
LOG167 закрывает атомарный аудит жизненного цикла (`create`, `update`, `delete`) и каскадного
удаления пользовательских OAuth-согласий приложений (`core."applicationAuthorization"` в
`ApplicationAuthorizationService`, `ApplicationAuthorizationResolver.revokeApplicationAuthorization`,
`OAuthService`, `ApplicationService.delete`, `ApplicationSyncService.uninstallApplication`) и
пользовательских значений переменных приложений (`core."userApplicationVariableValue"` в
`UserApplicationVariableValueService.updateMyUserApplicationVariable`,
`UserApplicationVariableValueResolver.updateMyUserApplicationVariable`,
`runAuditedApplicationMetadataMigration`, `ApplicationService.delete`) с редактированием
секретных полей `scopes` и `value` и fail-closed барьером на неаудируемые удаления
`applicationVariable` в `WorkspaceMigrationRunnerService.executeRun`.
LOG168 закрывает атомарный аудит жизненного цикла (`create`, `update`, `delete`) методов
двухфакторной аутентификации (`core."twoFactorAuthenticationMethod"` в
`TwoFactorAuthenticationService`, `TwoFactorAuthenticationResolver` и
`TwoFactorAuthenticationRecoveryService.redeemRecoveryCode`) и пакетного отзыва
`core."appToken"` (`RefreshToken`) при погашении кода восстановления с редактированием
секрета `secret`.
LOG169 закрывает атомарный аудит смены владельца (`createdByUserWorkspaceId`) и видимости
(`visibility`) рабочих процессов (`core.workflow` в
`CoreWorkflowMutationWorkspaceService.updateWorkflowVisibility` /
`CoreWorkflowResolver.updateCoreWorkflowVisibility` и `runAuditedApplicationMetadataMigration`)
и представлений (`core.view` в `ViewService.updateOne`, `ViewResolver.updateView`,
`ViewController.update`, `UpdateViewTool.execute` и `runAuditedApplicationMetadataMigration`),
долговечное намерение пересчёта шар запусков (`sync_workflowRunShares` в
`core."deferredWorkspaceMigrationAction"`) с постановкой в очередь после миграций манифеста и
очисткой после синхронного пересчёта, а также fail-closed барьер на неаудируемые обновления
`visibility` и `createdByUserWorkspaceId` в `WorkspaceMigrationRunnerService.executeRun`.
LOG170 закрывает транзакционный аудит полного жизненного цикла (`create`, `update`, `delete`) и
каскадных удалений пунктов навигационного меню (`core."navigationMenuItem"` в
`NavigationMenuItemService`, `NavigationMenuItemResolver`, AI-инструментах,
`NavigationMenuItemDeletionService`, `ObjectMetadataService`, `FieldMetadataService`,
`ViewService`, `PageLayoutService`, `AgentChatChannelMetadataService`, `seedPageLayouts`,
`runAuditedApplicationMetadataMigration` и `WorkspaceMigrationRunnerService.executeRun`) с
редактированием отображаемых полей `['name', 'link', 'icon', 'color', 'position']`.
LOG171 закрывает транзакционный аудит смены и сброса пароля (`AuthService.updatePassword`,
`AuthResolver.updatePasswordViaResetToken`, `ResetPasswordService`,
`password-update-audit.ts`) с пакетным отзывом `core."appToken"` (`RefreshToken` и
`PasswordResetToken`) и записью `refreshToken:update` с причиной `PASSWORD_CHANGED` (включая
токены в окне `REFRESH_TOKEN_REUSE_GRACE_PERIOD`), сериализацией через
`acquireUserAuthenticationLock` (`RefreshTokenService`, `UserSessionService`,
`ResetPasswordService`) и передачей `initiator` при отзыве сессий под имперсонацией
(`UserSessionResolver`, `UserSessionService`).
LOG172 закрывает транзакционный аудит полного жизненного цикла (`create`, `update`, `delete`) и
каскадных удалений каналов чата ИИ (`core."agentChatChannel"`) и их ролевых правил доступа
(`core."agentChatChannelRole"` в `AgentChatChannelMetadataService`, `AgentChatChannelService`,
`AgentChatChannelResolver`, `AgentChatChannelRoleAccessListener`, `RoleService.deleteManyRoles`,
`AiAgentRoleService.deleteAgentOnlyRoleIfUnused`, `runAuditedApplicationMetadataMigration`,
`WorkspaceMigrationValidateBuildAndRunService` и `WorkspaceMigrationRunnerService.executeRun`) с
редактированием отображаемых полей канала `['name', 'icon', 'color', 'position']`.
LOG173 закрывает транзакционный аудит полного жизненного цикла членства в рабочем пространстве
(`core."userWorkspace"` `create` и `update` локали в `UserWorkspaceService.create`,
`UserWorkspaceService.updateUserWorkspaceLocaleForUserWorkspace`,
`UserWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace`,
`UserResolver.updateWorkspaceMemberSettings`, `GlobalWorkspaceMemberListener.syncUserWorkspaceLocale`
и `SignInUpService.signUpOnNewWorkspace`) и всех активных обновлений учётной записи (`core."user"`
`update` для `canAccessFullAdminPanel`, `canImpersonate`, `isEmailVerified`, `email`, `passwordHash`
в `AdminPanelServerAdminService.updateServerAdminAccess`,
`AdminPanelResolver.updateServerAdminAccess`, `UserService.markEmailAsVerified`,
`UserService.updateEmailFromVerificationToken`, `UserService.updateUserEmail`,
`UserResolver.updateUserEmail`, `SignInUpService.signInUpWithPersonalInvitation`,
`SSOAuthController` и `runAuditedPasswordUpdate`) с редактированием `email`, `passwordHash` и
`defaultAvatarUrl`.
LOG174 закрывает транзакционный аудит полного жизненного цикла доменов одобренного доступа
(`core."approvedAccessDomain"` в `ApprovedAccessDomainService`, `ApprovedAccessDomainResolver`) и
публичных доменов приложений (`core."publicDomain"` в `PublicDomainService`, `PublicDomainResolver`,
`CheckPublicDomainsValidRecordsCronJob`, `DnsCloudflareService` и каскадного удаления при удалении
`core.application` в `ApplicationService.delete` / `runAuditedApplicationDelete`) с редактированием
`domain`.
LOG175 закрывает транзакционный аудит полного жизненного цикла исходящих вебхуков
(`core.webhook` в `WebhookService`, `WebhookResolver`, `WebhookController`, `CreateWebhookTool`,
`UpdateWebhookTool`, `DeleteWebhookTool`, `runAuditedApplicationMetadataMigration`,
`assertNoRemainingApplicationRoleOrPermissionMetadata` и `WorkspaceMigrationRunnerService.executeRun`)
с редактированием `targetUrl`, `operations`, `description` и `secret`.
LOG176 закрывает транзакционный аудит обновления секретных и конфигурационных переменных приложений
уровня рабочего пространства (`core."applicationVariable"` `update` в
`ApplicationVariableEntityService.update`, `ApplicationVariableEntityResolver.updateOneApplicationVariable`
с редактированием `key` и `value`) и полного жизненного цикла флагов функциональности
(`core."featureFlag"` `create`, `update` в `FeatureFlagService.upsertWorkspaceFeatureFlag`,
`FeatureFlagService.enableFeatureFlags`, `LabResolver.updateLabPublicFeatureFlag`,
`AdminPanelResolver.updateWorkspaceFeatureFlag` и `WorkspaceService.activateWorkspace`).
LOG177 закрывает транзакционный аудит полного жизненного цикла провайдеров подключений приложений
(`core."connectionProvider"` `create`, `update`, `delete` в `runAuditedApplicationMetadataMigration`,
`assertNoRemainingApplicationRoleOrPermissionMetadata` и `WorkspaceMigrationRunnerService.executeRun`
с редактированием `oauthConfig`, `name`, `displayName`, `logo` и UUID хуков) и отчётов об отказе
авторизации подключений приложений (`ApplicationConnectionAuthFailureService.reportAuthFailureOrThrow`,
`ApplicationConnectionsResolver.reportAppConnectionAuthFailure` -> `connectedAccount:update` с
редактированием `authFailedAt` и `authFailedReason`).
LOG178 закрывает транзакционный аудит полного жизненного цикла ИИ-навыков
(`core.skill` `create`, `update`, `delete` в `SkillService`, `SkillResolver`,
`navigation-menu-item-audit.ts`, `runAuditedApplicationMetadataMigration`,
`assertNoRemainingApplicationRoleOrPermissionMetadata` и `WorkspaceMigrationRunnerService.executeRun`)
с редактированием текста промпта `content`, а также `name`, `label`, `icon` и `description`.
LOG179 закрывает транзакционный аудит полного жизненного цикла фронтенд-компонентов приложений
(`core."frontComponent"` `create`, `update`, `delete` в `FrontComponentService`,
`FrontComponentResolver`, `PrefillFrontComponentService.ensureSeeded`, `navigation-menu-item-audit.ts`,
`runAuditedApplicationMetadataMigration`, `assertNoRemainingApplicationRoleOrPermissionMetadata` и
`WorkspaceMigrationRunnerService.executeRun` с редактированием `name`, `description`,
`sourceComponentPath`, `builtComponentPath`, `componentName`, `builtComponentChecksum` и
`widgetAvailability`) и пунктов меню настроек (`core."settingsMenuItem"` `create`, `update`, `delete`
и каскадное удаление при удалении `frontComponent` с редактированием `title`, `icon` и `position`).
LOG180 закрывает транзакционный аудит полного жизненного цикла серверных функций
(`core."logicFunction"` `create`, `update`, `delete` в `LogicFunctionFromSourceHelperService`,
`LogicFunctionFromSourceService`, `LogicFunctionResolver`, `PrefillLogicFunctionService.ensureSeeded`,
`createUpdateLogicFunctionSourceTool`, `CodeStepBuildService`,
`WorkflowVersionStepOperationsWorkspaceService`, каскадном удалении при удалении `workflow` /
`workflowVersion` в `WorkflowCoreSyncService.deleteFromCore` и
`CoreWorkflowMutationWorkspaceService.discardDraftVersion`,
`ApplicationManifestMigrationService.syncPreInstallLogicFunctionFromManifest`,
`navigation-menu-item-audit.ts`, `runAuditedApplicationMetadataMigration`,
`assertNoRemainingApplicationRoleOrPermissionMetadata` и `WorkspaceMigrationRunnerService.executeRun`
с редактированием `name`, `description`, `sourceHandlerPath`, `builtHandlerPath`, `handlerName`,
`checksum` и всех 6 JSONB-конфигураций триггеров).
LOG181 закрывает транзакционный аудит полного жизненного цикла типов событий таймлайна
(`core."timelineActivityType"` `create`, `update`, `delete` в `TimelineActivityTypeResolver`,
`TimelineActivityTypeService`, `navigation-menu-item-audit.ts`,
`runAuditedApplicationMetadataMigration`, `assertNoRemainingApplicationRoleOrPermissionMetadata` и
`WorkspaceMigrationRunnerService.executeRun` с редактированием `name`, `label`, `icon`,
`triggerFieldUniversalIdentifiers` и `overrides`).
Оставшиеся native/core writers и durable cache открыты.
Далее - [следующая граница ROB765](../implementation/log181/next-boundary.md).
Этот результат не закрывает весь аудит, HTTP/JWT приёмку или выкат.
Просмотр/экспорт остаётся ROB767 после собственных прав ROB766; AI/workflow/connector
дополняют события в ROB768/769. GitHub Actions не используется.
