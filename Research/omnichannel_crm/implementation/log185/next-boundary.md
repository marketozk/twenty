# Следующий участок после LOG185

После закрытия `LOG185` (`unsubscribeTopic` и `ssoIdentityProvider` в `UnsubscribeTopicService`, `UnsubscribeTopicResolver`, `seedUnsubscribeTopics`, `SsoService`, `SsoResolver` и `workspace-domain-audit.ts`) следующая открытая граница в рамках `ROB-765`:
- `LOG186`: транзакционный аудит обновлений настроек и доменов рабочего пространства (`core.workspace` в `WorkspaceService.updateWorkspaceById`, `WorkspaceService.updateWorkspaceAllowedIframeOrigins`, `WorkspaceResolver.updateWorkspace`, `WorkspaceResolver.updateWorkspaceAllowedIframeOrigins`, `CheckCustomDomainValidRecordsCronJob` и `DnsCloudflareService`).
