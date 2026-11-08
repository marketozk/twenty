# LOG-174 - Транзакционный аудит полного жизненного цикла `approvedAccessDomain` и `publicDomain` (включая каскадное удаление при удалении `core.application`)

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `approvedAccessDomain`: `values: ['isValidated']`, `redacted: ['domain']`, действия `['create', 'update', 'delete']`.
   - `publicDomain`: `values: ['applicationId', 'isValidated']`, `redacted: ['domain']`, действия `['create', 'update', 'delete']`.
2. Добавлен модуль `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-domain-audit.ts`:
   - `captureWorkspaceDomainAudit`, `withWorkspaceDomainAudit`, `consumeWorkspaceDomainAuditRequest` с синхронным захватом серверной атрибуции до первого `await`, поддержкой всех видов субъектов (`userSession`, `impersonated userSession` с разрешением `initiator`, `apiKey`, `oauthClient` / `application` в режимах `withUser` и `withoutUser`, `agent`, `system`), одноразовым потреблением листовых запросов (`WeakSet`) и регистрацией эксклюзивного транзакционного скоупа в `registerMetadataAuditScopeCheck(getWorkspaceDomainAudit)`.
   - `runAuditedApprovedAccessDomainCreate`, `runAuditedApprovedAccessDomainValidate`, `runAuditedApprovedAccessDomainDelete`: транзакционные операции жизненного цикла `core."approvedAccessDomain"` с сериализацией `pg_advisory_xact_lock`, блокировками `core.workspace` (`FOR NO KEY UPDATE`), таблиц субъекта (`FOR KEY SHARE`) и `core."approvedAccessDomain"` (`FOR UPDATE`), отправкой письма подтверждения внутри транзакции после `audit.flush()` и повторной сверкой снимка перед `COMMIT`.
   - `runAuditedPublicDomainCreate`, `runAuditedPublicDomainValidationUpdate`, `runAuditedPublicDomainDelete`: транзакционные операции жизненного цикла `core."publicDomain"` с сериализацией `pg_advisory_xact_lock`, соблюдением канонического порядка блокировок `core.application` (`FOR NO KEY UPDATE`) -> `core."publicDomain"` (`FOR UPDATE`), глобальной проверкой уникальности домена и конфликта с `customDomain` рабочего пространства, пропуском no-op обновлений `isValidated` и вызовом `deleteHostnameSilently` только после подтверждённого удаления строки своего рабочего пространства.
3. Расширен `runAuditedApplicationDelete` (`packages/twenty-server/src/engine/core-modules/crm-audit/application-authorization-and-variable-audit.ts`):
   - При удалении `core.application` (`ApplicationService.delete` / `ApplicationSyncService.uninstallApplication`) атомарно фиксирует каскадные удаления всех связанных строк `core."publicDomain"` (`publicDomain` `delete`) вместе с `core."applicationAuthorization"` (`applicationAuthorization` `delete`) в одном `CrmAuditTransactionContext` с общим `operationId` и `correlationId`.
4. Подключены все входные точки создания, проверки и удаления доменов:
   - `ApprovedAccessDomainService` (`createApprovedAccessDomain`, `validateApprovedAccessDomain`, `deleteApprovedAccessDomain`) и `ApprovedAccessDomainResolver` (с проверкой принадлежности `workspaceId` в `validateApprovedAccessDomain`).
   - `PublicDomainService` (`createPublicDomain`, `checkPublicDomainValidRecords`, `deletePublicDomain`, `findByDomain`), `PublicDomainResolver`, `CheckPublicDomainsValidRecordsCronJob.handle` (`actor: { kind: 'system', id: 'CheckPublicDomainsValidRecordsCronJob' }`) и `DnsCloudflareService.checkHostname` (`actor: { kind: 'system', id: 'DnsCloudflareService.checkHostname' }`).

## 2. Доказательства и проверки на Schrodinger

- Целевой PostgreSQL прогон: `17` suites / `255` tests PASS (`30.787s`), включая `3` новых интеграционных теста в `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts`.
- Полный регрессионный прогон: `119` suites / `3166` tests PASS (`698.803s`) - [`regression.log`](regression.log).
- Guard unit tests: `33` tests PASS (`0.193s`), `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `483` baseline / `485` current roots, `278` baseline / `277` current diagnostics, `0` новых и `0` в изменённом коде - [`typecheck-differential.json`](typecheck-differential.json).
- Снимок исходников: `11` файлов проверены по SHA-256 (LF) - [`source-snapshot.json`](source-snapshot.json).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
