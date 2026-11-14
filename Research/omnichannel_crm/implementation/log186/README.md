# LOG186 - Транзакционный аудит обновлений настроек, разрешённых iframe-источников и статуса кастомного домена рабочего пространства (`workspace`, `core.workspace`)

## 1. Выполнено

1. Расширен каталог полей ресурса `workspace` (`core.workspace`) в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `values`: `['defaultRoleId', 'logoFileId', 'allowImpersonation', 'isPublicInviteLinkEnabled', 'isCampaignClickTrackingEnabled', 'isCampaignOpenTrackingEnabled', 'workspaceDiscoverability', 'trashRetentionDays', 'eventLogRetentionDays', 'isGoogleAuthEnabled', 'isGoogleAuthBypassEnabled', 'isTwoFactorAuthenticationEnforced', 'isPasswordAuthEnabled', 'isPasswordAuthBypassEnabled', 'isMicrosoftAuthEnabled', 'isMicrosoftAuthBypassEnabled', 'isCustomDomainEnabled', 'isInternalMessagesImportEnabled', 'aiChatModelTier', 'aiAgentModelTier', 'isAutoModelSelectionEnabled', 'aiEvaluationModelId']`.
   - `redacted`: `['displayName', 'subdomain', 'customDomain', 'logo', 'inviteHash', 'allowedIframeOrigins', 'editableProfileFields', 'aiModelIdByTier', 'aiAdditionalInstructions']`.
2. Расширен `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-default-role-audit.ts`:
   - Добавлены `projectWorkspaceAuditFields`, `captureWorkspaceSettingsAudit` и `runAuditedWorkspaceSettingsUpdate`, а также расширен `runAuditedWorkspaceDefaultRoleUpdate` для совместного проецирования `defaultRoleId` и сопутствующих обновляемых полей `core.workspace` под блокировкой `FOR NO KEY UPDATE` с перепроверкой состояния после `audit.flush()`.
3. Подключены точки входа и вызывающие сервисы:
   - `WorkspaceResolver` (`updateWorkspace`, `updateWorkspaceAllowedIframeOrigins`, `checkCustomDomainValidRecords`) и `WorkspaceService` (`updateWorkspaceById`, `updateWorkspaceAllowedIframeOrigins`).
   - `CustomDomainManagerService.checkCustomDomainValidRecords`, `CheckCustomDomainValidRecordsCronJob.handle` и `DnsCloudflareService.checkHostname`.

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `packages/twenty-server/test/fork-migration/crm-audit-workspace-default-role.postgres-spec.ts` (`9` тестов / `1` сьют PASS за `6.095 s`, включая новый сценарий `LOG186`).
- Полный регрессионный прогон: `3201` tests / `128` suites PASS за `715.516 s` ([`regression.log`](regression.log)).
- Guard unit tests: `33` tests PASS, `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `pass-no-new-diagnostics`, `492/492` roots, `264` baseline / `262` current diagnostics, `0` новых/changed-code ([`typecheck-differential.json`](typecheck-differential.json)).
- Снимок исходников: `8` совпавших LF SHA-256 ([`source-snapshot.json`](source-snapshot.json)).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
