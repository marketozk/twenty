# LOG184 - Транзакционный аудит полного жизненного цикла почтовых доменов (`emailingDomain`, `core."emailingDomain"`) и соглашений об обработке данных (`dpaAgreement`, `core."dpaAgreement"`)

## 1. Выполнено

1. Расширен каталог ресурсов и административных действий в `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-transaction-context.ts`:
   - `emailingDomain` (`core."emailingDomain"`): `values: ['status', 'tenantStatus', 'unsubscribeHostnameStatus']`, `redacted: ['domain', 'verificationRecords', 'verifiedAt', 'unsubscribeHostname', 'unsubscribeHostnameId']`, действия `['create', 'update', 'delete']`.
   - `dpaAgreement` (`core."dpaAgreement"`): `values: ['type', 'templateVersion', 'region', 'signedFileId', 'acceptedByUserId']`, `redacted: ['processorEntity', 'customerLegalEntityName', 'signatoryName', 'signatoryTitle', 'acceptedByEmail', 'acceptedAt']`, действия `['create']`.
2. Расширен `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-domain-audit.ts`:
   - Добавлены `projectEmailingDomain`, `projectDpaAgreement`, `runAuditedEmailingDomainCreate`, `runAuditedEmailingDomainUpdate`, `runAuditedEmailingDomainTenantStatusUpdate`, `runAuditedEmailingDomainDelete` и `runAuditedDpaAgreementCreate` с блокировкой строк `core.workspace` (`FOR NO KEY UPDATE`) и целевых строк (`FOR UPDATE`), проверкой субъекта операции (`resolveWorkspaceDomainOperation`), записью событий аудита и перепроверкой состояния после `audit.flush()`.
   - Добавлен параметр `defaultSystemActorId` в `captureWorkspaceDomainAudit` для фоновых задач и вебхуков.
3. Подключены точки входа и вызывающие сервисы:
   - `EmailingDomainResolver` (`createEmailingDomain`, `deleteEmailingDomain`, `verifyEmailingDomain`), `EmailingDomainService` (`createEmailingDomain`, `ensureEmailingDomain`, `verifyEmailingDomain`, `deleteEmailingDomain`, `deleteEmailingDomainByDomainIfExists`, `syncUnsubscribeHostname`), `EmailingDomainTenantStatusService.setTenantStatusForWorkspace`, `OutboundSendingStateHandlerService.handle`, `CheckEmailingDomainVerificationCronJob` (`refreshUnverifiedDomains`, `refreshPendingUnsubscribeHostnames`), `MessageChannelMetadataService` (`createEmailGroupChannel`, `deleteEmailGroupChannel`) и сидер `seedEmailingDomains`.
   - `DpaResolver.generateSignedDpa` и `DpaService.generateSignedDpa`.

## 2. Доказательства и проверки на Schrodinger

- Целевой прогон: `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` и `packages/twenty-server/test/fork-migration/crm-audit-email-group-deletion.spec.ts` (`14` тестов / `2` сьюта PASS за `6.808 s`, включая `2` новых интеграционных сценария PostgreSQL `LOG184`).
- Полный регрессионный прогон: `3198` tests / `128` suites PASS за `711.165 s` ([`regression.log`](regression.log)).
- Guard unit tests: `33` tests PASS, `10` migration checksums неизменны, `0` нарушений границы Enterprise.
- Дифференциальный typecheck: `pass-no-new-diagnostics`, `496/496` roots, `262/262` diagnostics, `0` новых/changed-code ([`typecheck-differential.json`](typecheck-differential.json)).
- Снимок исходников: `14` совпавших LF SHA-256 ([`source-snapshot.json`](source-snapshot.json)).
- Артефакты проектирования и ревью: [`design.md`](design.md), [`design-review.md`](design-review.md), [`review.md`](review.md), [`test-research.md`](test-research.md), [`next-boundary.md`](next-boundary.md), [`results.json`](results.json).
