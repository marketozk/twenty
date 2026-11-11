# Следующий участок после LOG184

После закрытия `LOG184` (`emailingDomain` и `dpaAgreement` в `EmailingDomainService`, `EmailingDomainResolver`, `EmailingDomainTenantStatusService`, `CheckEmailingDomainVerificationCronJob`, `OutboundSendingStateHandlerService`, `MessageChannelMetadataService`, `seedEmailingDomains`, `DpaService`, `DpaResolver` и `workspace-domain-audit.ts`) следующая открытая граница в рамках `ROB-765`:
- `LOG185`: транзакционный аудит полного жизненного цикла тем отписки (`unsubscribeTopic` в `core."unsubscribeTopic"`) и SSO-провайдеров рабочего пространства (`ssoIdentityProvider` в `core."ssoIdentityProvider"`) через `UnsubscribeTopicService`, `UnsubscribeTopicResolver`, `seedUnsubscribeTopics`, `SsoService`, `SsoResolver` и `workspace-domain-audit.ts`.
