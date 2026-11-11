# LOG184 - Проектирование транзакционного аудита почтовых доменов (`emailingDomain`, `core."emailingDomain"`) и соглашений об обработке данных (`dpaAgreement`, `core."dpaAgreement"`)

## 1. Контекст и охват

В рамках `ROB-765` (фаза 2a - сбор аудита действий) `LOG174` закрыл аудит `approvedAccessDomain` (`core."approvedAccessDomain"`) и `publicDomain` (`core."publicDomain"`) через `workspace-domain-audit.ts`. В схеме `core` остаются две связанные таблицы доменного и юридического администрирования рабочего пространства:
- `core."emailingDomain"` (`EmailingDomainEntity`) - почтовые домены рабочего пространства для групповой рассылки и входящих/исходящих каналов (`EmailingDomainService`, `EmailingDomainResolver`, `EmailingDomainTenantStatusService`, `CheckEmailingDomainVerificationCronJob`, `OutboundSendingStateHandlerService`, `MessageChannelMetadataService`, `seedEmailingDomains`, а также синхронизация хоста отписки через `UnsubscribeHostnameService`).
- `core."dpaAgreement"` (`DpaAgreementEntity`) - подписанные соглашения об обработке персональных данных рабочего пространства (`DpaService.generateSignedDpa`, `DpaResolver.generateSignedDpa`).

Важное ограничение границы лицензий: файл `packages/twenty-server/src/engine/core-modules/emailing-domain/services/unsubscribe-hostname.service.ts` помечен заголовком `/* @license Enterprise */`. В соответствии с правилами проекта (`07-license-boundary.md`) файлы `@license Enterprise` не модифицируются, а новые рёбра зависимостей в `@license Enterprise` не добавляются. Перехват и транзакционный аудит обновлений `unsubscribeHostname` / `unsubscribeHostnameId` / `unsubscribeHostnameStatus` выполняется на стороне вызывающих `EmailingDomainService` и `CheckEmailingDomainVerificationCronJob` без изменения `unsubscribe-hostname.service.ts`.

## 2. Каталог ресурсов и правила редактирования

### 2.1. `emailingDomain` (`core."emailingDomain"`)
- `values` (открытые скаляры в `redactedDiff.values`):
  - `'status'` (`'PENDING' | 'VERIFIED' | 'FAILED' | 'TEMPORARY_FAILURE'`)
  - `'tenantStatus'` (`'ACTIVE' | 'UNDER_REVIEW' | 'PAUSED' | 'SANDBOX'`)
  - `'unsubscribeHostnameStatus'` (`'PENDING' | 'ACTIVE' | null`)
- `redacted` (чувствительные доменные имена, DNS-записи/токены верификации, внешний ID хоста и временная метка):
  - `'domain'`
  - `'verificationRecords'`
  - `'verifiedAt'`
  - `'unsubscribeHostname'`
  - `'unsubscribeHostnameId'`
- `ADMINISTRATIVE_ACTIONS.emailingDomain`: `['create', 'update', 'delete']`.

### 2.2. `dpaAgreement` (`core."dpaAgreement"`)
- `values` (открытые скаляры в `redactedDiff.values`):
  - `'type'` (`'CLICK_THROUGH' | 'SIGNED'`)
  - `'templateVersion'` (версия шаблона DPA)
  - `'region'` (`'EU' | 'US'`)
  - `'signedFileId'` (UUID файла подписанного PDF или `null`)
  - `'acceptedByUserId'` (UUID пользователя, подписавшего соглашение, или `null`)
- `redacted` (персональные данные подписанта, наименование юрлица, email и точное время подписания):
  - `'processorEntity'`
  - `'customerLegalEntityName'`
  - `'signatoryName'`
  - `'signatoryTitle'`
  - `'acceptedByEmail'`
  - `'acceptedAt'`
- `ADMINISTRATIVE_ACTIONS.dpaAgreement`: `['create']`.

## 3. Архитектура транзакционного владельца (`workspace-domain-audit.ts`)

1. **`runAuditedEmailingDomainCreate`**:
   - Выполняется внутри `withExclusiveAuditScope` и `runInCoreAuditTransaction`.
   - Берёт транзакционную блокировку `pg_advisory_xact_lock(hashtext('emailing_domain'), hashtext(domain))` и блокирует строку `core.workspace` (`FOR NO KEY UPDATE`).
   - Разрешает и проверяет субъекта операции через `resolveWorkspaceDomainOperation(runner, request)`.
   - Проверяет глобальную уникальность `domain` в `core."emailingDomain"` под `FOR UPDATE`.
   - Выполняет `INSERT INTO core."emailingDomain" ... RETURNING to_jsonb("emailingDomain") AS row`, проверяет инварианты вставленной строки, записывает `emailingDomain:create` в `CrmAuditTransactionContext`, вызывает `audit.flush()` и перепроверяет снимок строки после `audit.flush()`.
2. **`runAuditedEmailingDomainUpdate`**:
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`) и целевую строку `core."emailingDomain"` (`WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE`).
   - Применяет частичное обновление (`status`, `verificationRecords`, `verifiedAt`, `unsubscribeHostname`, `unsubscribeHostnameId`, `unsubscribeHostnameStatus`), перечитывает строку, при изменении проекции записывает `emailingDomain:update`, вызывает `audit.flush()` и перепроверяет снимок после `audit.flush()`.
3. **`runAuditedEmailingDomainTenantStatusUpdate`**:
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`) и все строки `core."emailingDomain"` рабочего пространства с `"tenantStatus"::text <> 'SANDBOX'` (`ORDER BY id ASC FOR UPDATE`).
   - Обновляет `tenantStatus`, записывает `emailingDomain:update` для каждой фактически изменившейся строки, вызывает `audit.flush()` и перепроверяет снимки всех затронутых строк после `audit.flush()`.
4. **`runAuditedEmailingDomainDelete`**:
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`) и целевую строку `core."emailingDomain"` (`FOR UPDATE` по `id` или по `domain` + `workspaceId`).
   - Удаляет строку, проверяет её отсутствие, записывает `emailingDomain:delete`, вызывает `audit.flush()` и повторно проверяет отсутствие строки после `audit.flush()`.
5. **`runAuditedDpaAgreementCreate`**:
   - Блокирует `core.workspace` (`FOR NO KEY UPDATE`), разрешает субъекта операции через `resolveWorkspaceDomainOperation(runner, request)`, проверяет согласованность `acceptedByUserId` с субъектом запроса (`expectedUserId`), выполняет `INSERT INTO core."dpaAgreement" ... RETURNING to_jsonb("dpaAgreement") AS row`, записывает `dpaAgreement:create`, вызывает `audit.flush()` и перепроверяет снимок строки после `audit.flush()`.

## 4. Точки подключения

- `EmailingDomainResolver` (`createEmailingDomain`, `deleteEmailingDomain`, `verifyEmailingDomain`) -> проброс `context?.req` в `EmailingDomainService`.
- `EmailingDomainService` (`createEmailingDomain`, `ensureEmailingDomain`, `verifyEmailingDomain`, `deleteEmailingDomain`, `deleteEmailingDomainByDomainIfExists`, `syncUnsubscribeHostname`) -> синхронный захват контекста аудита до первого `await`, вызов транзакционных функций `workspace-domain-audit.ts`, защита от удаления внешнего домена при `NativeTransactionOutcomeUnknownError` / `CoreAuditPostCommitError`, аудируемое выполнение обновлений `UnsubscribeHostnameService.sync`.
- `CheckEmailingDomainVerificationCronJob` (`refreshUnverifiedDomains`, `refreshPendingUnsubscribeHostnames`) -> передача системного субъекта `CheckEmailingDomainVerificationCronJob`.
- `EmailingDomainTenantStatusService.setTenantStatusForWorkspace` и `OutboundSendingStateHandlerService.handle` -> транзакционный пакетный аудит смены `tenantStatus`.
- `MessageChannelMetadataService` (`createEmailGroupChannel`, `deleteEmailGroupChannel`) -> передача `{ workspaceId, userWorkspaceId }` в `ensureEmailingDomain` и `deleteEmailingDomainByDomainIfExists`.
- `seedEmailingDomains` -> запись `emailingDomain:create` при начальном заполнении в dev-seeder.
- `DpaResolver.generateSignedDpa` и `DpaService.generateSignedDpa` -> синхронный захват контекста аудита до первого `await` и запись `dpaAgreement:create` через `runAuditedDpaAgreementCreate`.
