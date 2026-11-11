# LOG185 - Транзакционный аудит полного жизненного цикла тем отписки (`unsubscribeTopic`, `core."unsubscribeTopic"`) и SSO-провайдеров рабочего пространства (`ssoIdentityProvider`, `core."workspaceSSOIdentityProvider"`)

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `unsubscribeTopic` (`core."unsubscribeTopic"`): `values: ['visibility']`, `redacted: ['name', 'description']`, действия `['create', 'update', 'delete']`.
   - `ssoIdentityProvider` (`core."workspaceSSOIdentityProvider"`): `values: ['type', 'status']`, `redacted: ['name', 'issuer', 'clientID', 'clientSecret', 'ssoURL', 'certificate', 'fingerprint']`, действия `['create', 'update', 'delete']`.
2. Расширен `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-domain-audit.ts`:
   - Добавлены `projectUnsubscribeTopic`, `projectSsoIdentityProvider`, `runAuditedUnsubscribeTopicCreate`, `runAuditedUnsubscribeTopicUpdate`, `runAuditedUnsubscribeTopicDelete`, `runAuditedSsoIdentityProviderCreate`, `runAuditedSsoIdentityProviderUpdate` и `runAuditedSsoIdentityProviderDelete` с блокировкой `core.workspace` (`FOR NO KEY UPDATE`) и целевых строк (`FOR UPDATE`), проверкой субъекта операции (`resolveWorkspaceDomainOperation`), записью событий аудита и перепроверкой состояния после `audit.flush()`.
3. Подключены точки входа и вызывающие сервисы:
   - `UnsubscribeTopicResolver` (`createUnsubscribeTopic`, `updateUnsubscribeTopic`, `deleteUnsubscribeTopic`), `UnsubscribeTopicService` (`createUnsubscribeTopic`, `updateUnsubscribeTopic`, `deleteUnsubscribeTopic`) и сидер `seedUnsubscribeTopics`.
   - `SsoResolver` (`createOIDCIdentityProvider`, `createSAMLIdentityProvider`, `editSSOIdentityProvider`, `deleteSSOIdentityProvider`) и `SsoService` (`createOidcIdentityProvider`, `createSamlIdentityProvider`, `editSsoIdentityProvider`, `deleteSsoIdentityProvider`).

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` (`7` тестов / `1` сьют PASS за `6.711 s`, включая `2` новых сценария `LOG185`).
- Полный регрессионный прогон: `3200` tests / `128` suites PASS за `711.253 s` ([`regression.log`](regression.log)).
- Guard unit tests: `33` tests PASS, `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `pass-no-new-diagnostics`, `493/493` roots, `263/263` diagnostics, `0` новых/changed-code ([`typecheck-differential.json`](typecheck-differential.json)).
- Снимок исходников: `9` совпавших LF SHA-256 ([`source-snapshot.json`](source-snapshot.json)).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
