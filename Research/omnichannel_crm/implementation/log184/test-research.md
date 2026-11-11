# LOG184 - Исследование тестового контура (`emailingDomain`, `dpaAgreement`)

## 1. Существующие тесты

- `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` - проверяет `approvedAccessDomain` и `publicDomain` на реальном PostgreSQL с `OmniAuditBootstrapFastInstanceCommand`.
- Unit-тесты в `packages/twenty-server/src/engine/core-modules/dpa/utils/__tests__/`:
  - `render-dpa-to-html.util.spec.ts`
  - `resolve-dpa.util.spec.ts`

## 2. План интеграционного тестирования PostgreSQL

В `packages/twenty-server/test/fork-migration/crm-audit-workspace-domain.postgres-spec.ts` добавляются интеграционные сценарии PostgreSQL для `LOG184`:
1. Полный жизненный цикл `emailingDomain` через `EmailingDomainResolver` и `EmailingDomainService`:
   - `createEmailingDomain` (с синхронизацией `unsubscribeHostnameService.sync`), проверка записи `emailingDomain:create` и `emailingDomain:update`, проверка сокрытия `domain`, `verificationRecords`, `unsubscribeHostname`, `unsubscribeHostnameId`.
   - `verifyEmailingDomain` и фоновый прогон `CheckEmailingDomainVerificationCronJob` (`refreshUnverifiedDomains` и `refreshPendingUnsubscribeHostnames`) с системным субъектом.
   - Пакетное обновление `tenantStatus` через `EmailingDomainTenantStatusService.setTenantStatusForWorkspace` и `OutboundSendingStateHandlerService.handle` (пропуск доменов в статусе `SANDBOX`, запись `emailingDomain:update` только для изменившихся строк).
   - `ensureEmailingDomain` и `deleteEmailingDomainByDomainIfExists` (путь `MessageChannelMetadataService`), а также `deleteEmailingDomain` и `seedEmailingDomains`.
   - Защита от удаления внешнего домена при `NativeTransactionOutcomeUnknownError` (потеря подтверждения `COMMIT`) и откат при post-flush модификации строки триггером.
2. Полный жизненный цикл `dpaAgreement` через `DpaResolver.generateSignedDpa` и `DpaService.generateSignedDpa`:
   - Создание подписанного DPA (`SIGNED`), проверка записи `dpaAgreement:create`, проверка открытых полей (`type`, `templateVersion`, `region`, `signedFileId`, `acceptedByUserId`) и сокрытия чувствительных полей (`processorEntity`, `customerLegalEntityName`, `signatoryName`, `signatoryTitle`, `acceptedByEmail`, `acceptedAt`).
   - Откат при несовпадении субъекта, при post-flush модификации строки триггером и проброс `NativeTransactionOutcomeUnknownError` при потере `COMMIT`.
