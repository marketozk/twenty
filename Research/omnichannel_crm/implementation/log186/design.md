# LOG186 - Транзакционный аудит обновлений настроек и доменов рабочего пространства (`core.workspace`)

## 1. Контекст и цель

После закрытия `LOG163` (`core.workspace."defaultRoleId"`), `LOG174` (`approvedAccessDomain`, `publicDomain`), `LOG184` (`emailingDomain`, `dpaAgreement`) и `LOG185` (`unsubscribeTopic`, `ssoIdentityProvider`) в контуре настроек и доменов рабочего пространства (`core.workspace`, `WorkspaceEntity`) остаются без транзакционного аудита `crm_audit."crmAuditEntry"`:
1. Обновление настроек рабочего пространства (`WorkspaceResolver.updateWorkspace` -> `WorkspaceService.updateWorkspaceById`):
   - Поля настроек, безопасности, доменов, удержания и ИИ-моделей (`displayName`, `subdomain`, `customDomain`, `isCustomDomainEnabled`, `logo`, `logoFileId`, `inviteHash`, `allowImpersonation`, `isPublicInviteLinkEnabled`, `isCampaignClickTrackingEnabled`, `isCampaignOpenTrackingEnabled`, `workspaceDiscoverability`, `trashRetentionDays`, `eventLogRetentionDays`, `isGoogleAuthEnabled`, `isGoogleAuthBypassEnabled`, `isMicrosoftAuthEnabled`, `isMicrosoftAuthBypassEnabled`, `isPasswordAuthEnabled`, `isPasswordAuthBypassEnabled`, `isTwoFactorAuthenticationEnforced`, `editableProfileFields`, `isInternalMessagesImportEnabled`, `aiChatModelTier`, `aiAgentModelTier`, `isAutoModelSelectionEnabled`, `aiModelIdByTier`, `aiEvaluationModelId`, `aiAdditionalInstructions`) изменяются без записи `workspace:update`, если запрос не включает `defaultRoleId`, а при комбинированном запросе с `defaultRoleId` фиксировалось только изменение `defaultRoleId`.
2. Обновление разрешённых источников встраивания (`WorkspaceResolver.updateWorkspaceAllowedIframeOrigins` -> `WorkspaceService.updateWorkspaceAllowedIframeOrigins`):
   - Мутация массива `core.workspace."allowedIframeOrigins"` выполняется без записи `workspace:update` в `crm_audit."crmAuditEntry"`.
3. Проверка и активация/деактивация пользовательского домена (`CustomDomainManagerService.checkCustomDomainValidRecords`):
   - Вызовы из `WorkspaceResolver.checkCustomDomainValidRecords`, `CheckCustomDomainValidRecordsCronJob.handle` и `DnsCloudflareService.checkHostname` изменяют `core.workspace."isCustomDomainEnabled"` без транзакционного аудита.

## 2. Варианты архитектуры

### Вариант 1 (выбран): Расширение каталога `workspace` и модуля `workspace-default-role-audit.ts`
- Расширить `CATALOG.workspace` в `crm-audit-transaction-context.ts`:
  - `values`:
    - `'defaultRoleId'`,
    - `'logoFileId'`,
    - `'allowImpersonation'`,
    - `'isPublicInviteLinkEnabled'`,
    - `'isCampaignClickTrackingEnabled'`,
    - `'isCampaignOpenTrackingEnabled'`,
    - `'workspaceDiscoverability'`,
    - `'trashRetentionDays'`,
    - `'eventLogRetentionDays'`,
    - `'isGoogleAuthEnabled'`,
    - `'isGoogleAuthBypassEnabled'`,
    - `'isTwoFactorAuthenticationEnforced'`,
    - `'isPasswordAuthEnabled'`,
    - `'isPasswordAuthBypassEnabled'`,
    - `'isMicrosoftAuthEnabled'`,
    - `'isMicrosoftAuthBypassEnabled'`,
    - `'isCustomDomainEnabled'`,
    - `'isInternalMessagesImportEnabled'`,
    - `'aiChatModelTier'`,
    - `'aiAgentModelTier'`,
    - `'isAutoModelSelectionEnabled'`,
    - `'aiEvaluationModelId'`.
  - `redacted`:
    - `'displayName'`,
    - `'subdomain'`,
    - `'customDomain'`,
    - `'logo'`,
    - `'inviteHash'`,
    - `'allowedIframeOrigins'`,
    - `'editableProfileFields'`,
    - `'aiModelIdByTier'`,
    - `'aiAdditionalInstructions'`.
  - `ADMINISTRATIVE_ACTIONS.workspace: ['update']`.
- Расширить `workspace-default-role-audit.ts` (сохраняя 0 импортов `@license Enterprise`):
  - В `runAuditedWorkspaceDefaultRoleUpdate` добавить режим частичной проекции по реально переданным в `changedKeys` полям (`defaultRoleId` по умолчанию при смене роли по умолчанию), чтобы в `before`/`after` попадали все затронутые колонки `core.workspace`, нормализованные через `projectWorkspaceAuditFields`.
  - Добавить `runAuditedWorkspaceSettingsUpdate` для транзакционного обновления настроек, `allowedIframeOrigins` и `isCustomDomainEnabled` под блокировкой `FOR NO KEY UPDATE` на `core.workspace` (с проверкой `deletedAt IS NULL`), разрешением инициатора (`resolveRoleAuditInitiator`), записью `workspace:update` при фактическом изменении проецируемых полей и повторной сверкой снимка `core.workspace` после `audit.flush()`.
- Подключить точки входа:
  - `WorkspaceResolver.updateWorkspace`, `WorkspaceResolver.updateWorkspaceAllowedIframeOrigins`, `WorkspaceResolver.checkCustomDomainValidRecords`: передавать `auditIdentity: roleAuditIdentityFromRequest(context.req)`.
  - `WorkspaceService.updateWorkspaceById`: выполнять запись через `runAuditedWorkspaceDefaultRoleUpdate` (если задан `defaultRoleId`, передавая список всех обновляемых ключей) или `runAuditedWorkspaceSettingsUpdate` (если `defaultRoleId` не задан, а передан `auditIdentity` или активен контекст аудита на активированном пространстве).
  - `WorkspaceService.updateWorkspaceAllowedIframeOrigins`: захватывать `auditIdentity` до первого `await`, вычислять `allowedIframeOrigins` под блокировкой `FOR NO KEY UPDATE` внутри `runAuditedWorkspaceSettingsUpdate`, проверять лимит `MAX_ALLOWED_IFRAME_ORIGINS`, обновлять строку, записывать `workspace:update` и инвалидировать кэш `workspaceEntity` (включая `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`).
  - `CustomDomainManagerService.checkCustomDomainValidRecords`, `CheckCustomDomainValidRecordsCronJob.handle` и `DnsCloudflareService.checkHostname`: выполнять проверку DNS вне транзакции БД, а при изменении `isCustomDomainEnabled` обновлять `core.workspace` внутри `runAuditedWorkspaceSettingsUpdate` (с системным субъектом для cron и Cloudflare webhook) и отправлять событие `eventLogContext.insertWorkspaceEvent` только после подтверждённого коммита.

### Вариант 2: Запись всех 31 полей `core.workspace` в каждое событие `workspace:update`
- Отклонён: если при узком обновлении (например, `defaultRoleId` в `setupDefaultRoles` или `isCustomDomainEnabled` в `checkCustomDomainValidRecords`) подавать все поля в `before`/`after`, это усложняет частичные фикстуры БД и смешивает независимые срезы обновления. Проекция по набору затрагиваемых полей (`changedKeys`) даёт точный минимальный diff и полную обратную совместимость с `LOG163`.

## 3. Инварианты безопасности и целостности

1. **Сокрытие секретов, доменов и пользовательских текстов**:
   - Поля `displayName`, `subdomain`, `customDomain`, `logo`, `inviteHash`, `allowedIframeOrigins`, `editableProfileFields`, `aiModelIdByTier` и `aiAdditionalInstructions` находятся в `redacted` и хешируются при расчёте `redactedDiff`, никогда не сохраняясь в открытом виде в `redactedDiff.values`.
2. **Внешние вызовы вне блокировок БД и защита при неизвестном исходе коммита**:
   - Проверки и регистрация DNS (`dnsManagerService`, `customDomainManagerService.setCustomDomain`, `getHostnameWithRecords`, `isHostnameWorking`) выполняются до открытия `runInCoreAuditTransaction`.
   - При `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError` кэш `workspaceEntity` инвалидируется, а зарегистрированный `customDomain` и старый файл логотипа не удаляются.
3. **Соблюдение границы Enterprise**:
   - `workspace-default-role-audit.ts` не импортирует ни одного `@license Enterprise` файла; `check_enterprise_dependencies.py --verify-baseline` проходит с `0` нарушений.
