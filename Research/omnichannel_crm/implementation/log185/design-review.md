# LOG185 - Независимое ревью дизайна (`unsubscribeTopic`, `ssoIdentityProvider`)

## Вердикт
`pass` (блокеров нет)

## Проверенные аспекты

| Аспект | Результат | Комментарий |
|---|---|---|
| Полнота охвата точек мутации `core."unsubscribeTopic"` и `core."workspaceSSOIdentityProvider"` | `pass` | Охвачены `UnsubscribeTopicResolver` (`createUnsubscribeTopic`, `updateUnsubscribeTopic`, `deleteUnsubscribeTopic`), `UnsubscribeTopicService` (`createUnsubscribeTopic`, `updateUnsubscribeTopic`, `deleteUnsubscribeTopic`), `seedUnsubscribeTopics`, `SsoResolver` (`createOIDCIdentityProvider`, `createSAMLIdentityProvider`, `editSSOIdentityProvider`, `deleteSSOIdentityProvider`) и `SsoService` (`createOidcIdentityProvider`, `createSamlIdentityProvider`, `editSsoIdentityProvider`, `deleteSsoIdentityProvider`). |
| Сокрытие секретов OIDC/SAML и текстовых полей тем отписки | `pass` | В `CATALOG.ssoIdentityProvider` секреты и идентификаторы (`clientSecret`, `certificate`, `fingerprint`, `clientID`, `issuer`, `ssoURL`, `name`) помещены в `redacted`, а в `values` оставлены только `['type', 'status']`. В `CATALOG.unsubscribeTopic` `name` и `description` помещены в `redacted`, а в `values` оставлено только `['visibility']`. |
| Отсутствие сетевых вызовов внутри транзакции БД и сохранение контракта ошибок | `pass` | В `SsoService.createOidcIdentityProvider` проверка `isSsoEnabled` и сетевой вызов `discoverOidcIssuer` выполняются до открытия `runInCoreAuditTransaction`. В `SsoService.createSamlIdentityProvider` конфликт первичного ключа (`23505` не на таблице `crmAuditEntry`) по-прежнему преобразуется в `SsoException(IDENTITY_PROVIDER_ALREADY_EXISTS)`. |
| Соблюдение границы `@license Enterprise` | `pass` | `workspace-domain-audit.ts` не импортирует `@license Enterprise` файлы; `sso.service.ts` и `sso.resolver.ts` сохраняют маркер `/* @license Enterprise */`. |
