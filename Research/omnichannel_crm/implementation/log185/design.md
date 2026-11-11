# LOG185 - Транзакционный аудит полного жизненного цикла тем отписки (`unsubscribeTopic`, `core."unsubscribeTopic"`) и SSO-провайдеров рабочего пространства (`ssoIdentityProvider`, `core."workspaceSSOIdentityProvider"`)

## 1. Контекст и цель

После закрытия `LOG174` (`approvedAccessDomain`, `publicDomain`) и `LOG184` (`emailingDomain`, `dpaAgreement`) в `workspace-domain-audit.ts` в контуре настроек доменов, почтовых рассылок и безопасности рабочего пространства остаются без транзакционного аудита `crm_audit."crmAuditEntry"`:
1. Темы отписки рассылок (`core."unsubscribeTopic"`, `UnsubscribeTopicEntity`):
   - Создание (`UnsubscribeTopicResolver.createUnsubscribeTopic` -> `UnsubscribeTopicService.createUnsubscribeTopic`),
   - Обновление (`UnsubscribeTopicResolver.updateUnsubscribeTopic` -> `UnsubscribeTopicService.updateUnsubscribeTopic`),
   - Удаление (`UnsubscribeTopicResolver.deleteUnsubscribeTopic` -> `UnsubscribeTopicService.deleteUnsubscribeTopic`),
   - Сидирование (`seedUnsubscribeTopics` в `seed-unsubscribe-topics.util.ts`).
2. SSO-провайдеры рабочего пространства (`core."workspaceSSOIdentityProvider"`, `WorkspaceSsoIdentityProviderEntity`):
   - Создание OIDC-провайдера (`SsoResolver.createOIDCIdentityProvider` -> `SsoService.createOidcIdentityProvider`),
   - Создание SAML-провайдера (`SsoResolver.createSAMLIdentityProvider` -> `SsoService.createSamlIdentityProvider`),
   - Обновление статуса провайдера (`SsoResolver.editSSOIdentityProvider` -> `SsoService.editSsoIdentityProvider`),
   - Удаление провайдера (`SsoResolver.deleteSSOIdentityProvider` -> `SsoService.deleteSsoIdentityProvider`).

## 2. Варианты архитектуры

### Вариант 1 (выбран): Расширение `workspace-domain-audit.ts` с поддержкой `unsubscribeTopic` и `ssoIdentityProvider`
- Расширить `CrmAuditResourceKind` (`crm-audit.types.ts`) и `CATALOG` / `ADMINISTRATIVE_ACTIONS` (`crm-audit-transaction-context.ts`):
  - `unsubscribeTopic`:
    - `values: ['visibility']`
    - `redacted: ['name', 'description']`
    - `ADMINISTRATIVE_ACTIONS: ['create', 'update', 'delete']`
  - `ssoIdentityProvider`:
    - `values: ['type', 'status']`
    - `redacted: ['name', 'issuer', 'clientID', 'clientSecret', 'ssoURL', 'certificate', 'fingerprint']`
    - `ADMINISTRATIVE_ACTIONS: ['create', 'update', 'delete']`
- В `workspace-domain-audit.ts` (без импорта каких-либо `@license Enterprise` модулей, сохраняя 0 нарушений границы Enterprise):
  - Реализовать `projectUnsubscribeTopic`, `projectSsoIdentityProvider`, `runAuditedUnsubscribeTopicCreate`, `runAuditedUnsubscribeTopicUpdate`, `runAuditedUnsubscribeTopicDelete`, `runAuditedSsoIdentityProviderCreate`, `runAuditedSsoIdentityProviderUpdate` и `runAuditedSsoIdentityProviderDelete`.
  - Внутри `runInCoreAuditTransaction` блокировать `core.workspace` (`FOR NO KEY UPDATE`, `deletedAt IS NULL`) и целевые строки `core."unsubscribeTopic"` / `core."workspaceSSOIdentityProvider"` (`FOR UPDATE`), разрешать серверную атрибуцию через `resolveWorkspaceDomainOperation`, сверять сохранённые/обновлённые/удалённые строки до и после `audit.flush()`.
- В `UnsubscribeTopicResolver`, `UnsubscribeTopicService`, `seedUnsubscribeTopics`, `SsoResolver` и `SsoService`:
  - Захватывать `captureWorkspaceDomainAudit(workspaceId, options?.auditIdentity)` синхронно до первого `await`.
  - В `SsoService.createOidcIdentityProvider` выполнять внешнее HTTP-обнаружение `discoverOidcIssuer` до входа в `runInCoreAuditTransaction`, не удерживая блокировки БД на время сетевого вызова.

### Вариант 2: Отдельные модули аудита для каждого сервиса
- Отклонён: порождает дублирование логики блокировки `core.workspace`, проверки субъекта операции (`resolveWorkspaceDomainOperation`), защиты `WeakSet` от повторного использования `req` и post-flush верификации, которые уже централизованы в `workspace-domain-audit.ts`.

## 3. Инварианты безопасности и целостности

1. **Сокрытие секретов, сертификатов и текстовых метаданных**:
   - Для `unsubscribeTopic` в открытом виде (`values`) сохраняется только `visibility` (`'PUBLIC' | 'PRIVATE'`); поля `name` и `description` хешируются в `redacted`.
   - Для `ssoIdentityProvider` в открытом виде (`values`) сохраняются только перечисления `type` (`'OIDC' | 'SAML'`) и `status` (`'Active' | 'Inactive' | 'Error'`); поля `name`, `issuer`, `clientID`, `clientSecret`, `ssoURL`, `certificate` и `fingerprint` хешируются в `redacted` и никогда не попадают в открытом виде в `crm_audit."crmAuditEntry"`.
2. **Граница Enterprise**:
   - `workspace-domain-audit.ts` не импортирует ни одного файла с `@license Enterprise` и работает с `core."workspaceSSOIdentityProvider"` через параметризованный SQL (`to_jsonb`).
   - `sso.service.ts` и `sso.resolver.ts` сохраняют свои заголовки `/* @license Enterprise */` и добавляют только исходящий импорт в не-Enterprise модуль `workspace-domain-audit.ts`, что полностью удовлетворяет `check_enterprise_dependencies.py --verify-baseline`.
3. **Защита от подмены субъекта, повторного использования контекста и post-flush искажений**:
   - Идентичность вызывающего субъекта захватывается синхронно до первого `await`; повторное использование того же объекта запроса отвергается (`Workspace domain audit request context cannot be reused`).
   - После `audit.flush()` состояние строки в `core."unsubscribeTopic"` и `core."workspaceSSOIdentityProvider"` повторно считывается и сверяется с записанным в аудит снимком.
