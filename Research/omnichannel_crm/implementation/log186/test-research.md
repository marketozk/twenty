# LOG186 - План тестирования (`core.workspace` settings & domains)

## Интеграционные сценарии PostgreSQL (`crm-audit-workspace-default-role.postgres-spec.ts`)

1. **Обновление настроек, безопасности, доменов и ИИ-моделей (`WorkspaceResolver.updateWorkspace` / `WorkspaceService.updateWorkspaceById`)**:
   - Обновление без `defaultRoleId` (`displayName`, `subdomain`, `customDomain`, `inviteHash`, `allowImpersonation`, `isPublicInviteLinkEnabled`, `isTwoFactorAuthenticationEnforced`, `trashRetentionDays`, `eventLogRetentionDays`, `aiChatModelTier`, `aiAdditionalInstructions`, `editableProfileFields`, `aiModelIdByTier`) через `WorkspaceResolver.updateWorkspace` (под имперсонацией) записывает `workspace:update` с открытыми скалярными флагами в `values` и хешированными чувствительными полями в `redacted` (открытые строки `displayName`, `customDomain`, `inviteHash`, `aiAdditionalInstructions` отсутствуют в `redactedDiff.values`).
   - Повторный вызов с теми же значениями не создаёт дублирующей записи в `crm_audit."crmAuditEntry"`.
2. **Обновление `allowedIframeOrigins` (`WorkspaceResolver.updateWorkspaceAllowedIframeOrigins` / `WorkspaceService.updateWorkspaceAllowedIframeOrigins`)**:
   - Операции `add` и `remove` через `WorkspaceResolver.updateWorkspaceAllowedIframeOrigins` записывают `workspace:update` с `changedFields: ['allowedIframeOrigins']` и скрытием URL источников (`values: {}`), инвалидируют `workspaceEntity` кэш и пропускают запись при идемпотентном повторном `add`.
   - Превышение `MAX_ALLOWED_IFRAME_ORIGINS` откатывает транзакцию без записи аудита.
3. **Проверка и переключение `isCustomDomainEnabled` (`CustomDomainManagerService.checkCustomDomainValidRecords`)**:
   - Вызовы через `WorkspaceResolver.checkCustomDomainValidRecords`, `CheckCustomDomainValidRecordsCronJob.handle` (`actor: { kind: 'system', id: 'CheckCustomDomainValidRecordsCronJob' }`) и `DnsCloudflareService.checkHostname` (`actor: { kind: 'system', id: 'DnsCloudflareService.checkHostname' }`) записывают `workspace:update` (`changedFields: ['isCustomDomainEnabled']`, `before: false -> after: true` и `true -> false`) и инвалидируют кэш `workspaceEntity`.
   - Пост-флаш искажение (`AFTER INSERT ON crm_audit."crmAuditEntry"` триггер, меняющий `isCustomDomainEnabled` в `core.workspace`) откатывает транзакцию целиком.
