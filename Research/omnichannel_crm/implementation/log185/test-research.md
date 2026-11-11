# LOG185 - План тестирования (`unsubscribeTopic`, `ssoIdentityProvider`)

## Интеграционные сценарии PostgreSQL (`crm-audit-workspace-domain.postgres-spec.ts`)

1. **Жизненный цикл `unsubscribeTopic` (`core."unsubscribeTopic"`)**:
   - Сидирование тем отписки через `seedUnsubscribeTopics` записывает `unsubscribeTopic:create` с системным субъектом `dev-seeder:seed-unsubscribe-topics`, повторный вызов идемпотентен и не создаёт дубликатов.
   - Создание темы через `UnsubscribeTopicResolver.createUnsubscribeTopic` (под имперсонацией) записывает `unsubscribeTopic:create` с `visibility` в `values` и хешированными `name`/`description` в `redacted` (открытые строки отсутствуют в `redactedDiff.values`).
   - Обновление `name`, `description` и `visibility` через `UnsubscribeTopicResolver.updateUnsubscribeTopic` записывает `unsubscribeTopic:update` с точными `changedFields`; повторное обновление без изменений не создаёт лишней записи.
   - Удаление через `UnsubscribeTopicResolver.deleteUnsubscribeTopic` записывает `unsubscribeTopic:delete`.
   - Пост-флаш искажение (`AFTER INSERT ON crm_audit."crmAuditEntry"` триггер, подменяющий `visibility` в `core."unsubscribeTopic"`) откатывает транзакцию целиком.
2. **Жизненный цикл `ssoIdentityProvider` (`core."workspaceSSOIdentityProvider"`)**:
   - Создание OIDC-провайдера через `SsoResolver.createOIDCIdentityProvider` записывает `ssoIdentityProvider:create` (`type: 'OIDC'`, `status: 'Active'`), скрывая `clientSecret`, `clientID`, `issuer` и `name`.
   - Создание SAML-провайдера через `SsoResolver.createSamlIdentityProvider` записывает `ssoIdentityProvider:create` (`type: 'SAML'`, `status: 'Active'`), скрывая `certificate`, `fingerprint`, `ssoURL`, `issuer` и `name`; повторная вставка с тем же `id` возвращает `SsoException(IDENTITY_PROVIDER_ALREADY_EXISTS)` и откатывает транзакцию.
   - Обновление статуса (`Active` -> `Inactive`) через `SsoResolver.editSSOIdentityProvider` записывает `ssoIdentityProvider:update` (`changedFields: ['status']`).
   - Удаление через `SsoResolver.deleteSSOIdentityProvider` записывает `ssoIdentityProvider:delete`.
   - Повторное использование контекста запроса и пост-флаш искажение (`AFTER INSERT ON crm_audit."crmAuditEntry"` триггер, подменяющий `status` в `core."workspaceSSOIdentityProvider"`) откатывают транзакцию целиком.
