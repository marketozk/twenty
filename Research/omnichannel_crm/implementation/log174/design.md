# LOG-174 - Проектирование транзакционного аудита полного жизненного цикла `approvedAccessDomain` и `publicDomain` (включая каскадное удаление при удалении `core.application`)

## 1. Контекст и проблема

В рамках `ROB-765` (Этап 2a - сбор аудита действий):
- В `LOG-170` был внедрён транзакционный аудит `applicationAuthorization` и `userApplicationVariableValue`, а также каскадного удаления `applicationAuthorization` при удалении `core.application` (`ApplicationService.delete` -> `runAuditedApplicationDelete`).
- В `LOG-171`, `LOG-172`, `LOG-173` были закрыты транзакционный аудит смены/сброса пароля, жизненного цикла `agentChatChannel` / `agentChatChannelRole` и полного жизненного цикла `userWorkspace` и активных обновлений `coreUser`.
- При этом две ключевые административные сущности доменного контура рабочего пространства в схеме `core` остаются без транзакционного аудита в `crm_audit."crmAuditEntry"`:
  1. `core."approvedAccessDomain"` (`ApprovedAccessDomainEntity` - домены корпоративной почты, дающие право автоматического вступления в рабочее пространство):
     - `ApprovedAccessDomainService.createApprovedAccessDomain` (`ApprovedAccessDomainResolver.createApprovedAccessDomain`) вставляет строку через `approvedAccessDomainRepository.insertAndReturnOne` без записи `crm_audit."crmAuditEntry"` и отправляет письмо подтверждения после вставки вне единой транзакции.
     - `ApprovedAccessDomainService.validateApprovedAccessDomain` (`ApprovedAccessDomainResolver.validateApprovedAccessDomain`) проверяет JWT-токен подтверждения и обновляет `isValidated = true` через `approvedAccessDomainRepository.update` без блокировки строки `FOR UPDATE`, без сверки `currentWorkspace.id` резолвера с `payload.workspaceId` и без записи `crm_audit."crmAuditEntry"`.
     - `ApprovedAccessDomainService.deleteApprovedAccessDomain` (`ApprovedAccessDomainResolver.deleteApprovedAccessDomain`) удаляет строку через `approvedAccessDomainRepository.delete` без записи `crm_audit."crmAuditEntry"`.
  2. `core."publicDomain"` (`PublicDomainEntity` - публичные домены приложений рабочего пространства с `ON DELETE CASCADE` на `core.application(id)`):
     - `PublicDomainService.createPublicDomain` (`PublicDomainResolver.createPublicDomain`) регистрирует домен в `DnsManagerService.registerHostname`, затем вставляет строку через `publicDomainRepository.insert` без записи `crm_audit."crmAuditEntry"`, причём предварительная проверка дубликата `publicDomainRepository.findOne(workspace.id, { where: { domain } })` ограничена текущим рабочим пространством, хотя ограничение `UQ_1311e24fbd049c561c53a274f2a` на `core."publicDomain"."domain"` является глобальным.
     - `PublicDomainService.checkPublicDomainValidRecords` (`PublicDomainResolver.checkPublicDomainValidRecords`, `CheckPublicDomainsValidRecordsCronJob.handle`, `DnsCloudflareService.checkHostname`) обновляет `isValidated` через `publicDomainRepository.update` по не заблокированному состоянию в памяти без `FOR UPDATE` и без записи `crm_audit."crmAuditEntry"`.
     - `PublicDomainService.deletePublicDomain` (`PublicDomainResolver.deletePublicDomain`) вызывает `DnsManagerService.deleteHostnameSilently` до проверки существования и принадлежности домена текущему рабочему пространству в БД и удаляет строку через `publicDomainRepository.delete` без записи `crm_audit."crmAuditEntry"`.
     - При удалении приложения (`ApplicationService.delete` / `ApplicationSyncService.uninstallApplication`) внешний ключ `FK_39f1ad35993f3994cd5400e81a0` (`ON DELETE CASCADE`) каскадно удаляет все строки `core."publicDomain"` этого приложения, но `runAuditedApplicationDelete` фиксирует только каскадные удаления `applicationAuthorization` и не записывает события `publicDomain` (`delete`).

## 2. Варианты архитектуры

### Вариант A (Рекомендуемый): Расширение каталога `approvedAccessDomain` и `publicDomain` + транзакционный модуль `workspace-domain-audit.ts` + расширение `runAuditedApplicationDelete`

1. Расширить `CrmAuditResourceKind` (`crm-audit.types.ts`), `CATALOG` и `ADMINISTRATIVE_ACTIONS` (`crm-audit-transaction-context.ts`):
   - `approvedAccessDomain`:
     - `values: ['isValidated']`
     - `redacted: ['domain']` (корпоративный домен хешируется в `redactedDiff` и никогда не сохраняется в открытом виде в `redactedDiff.values`)
     - `ADMINISTRATIVE_ACTIONS.approvedAccessDomain = ['create', 'update', 'delete']`
   - `publicDomain`:
     - `values: ['applicationId', 'isValidated']`
     - `redacted: ['domain']` (публичный домен хешируется в `redactedDiff` и никогда не сохраняется в открытом виде в `redactedDiff.values`)
     - `ADMINISTRATIVE_ACTIONS.publicDomain = ['create', 'update', 'delete']`
   - Оба ресурса используют `securityDescriptor: { resourceKind, resourceId, metadataAccess: 'currentWorkspaceAdministration' }`.
2. Создать модуль `packages/twenty-server/src/engine/core-modules/crm-audit/workspace-domain-audit.ts`:
   - Поддержка синхронного захвата серверной атрибуции до первого `await` (`captureWorkspaceDomainAudit`, `withWorkspaceDomainAudit`), одноразового потребления листовых запросов (`WeakSet`), разрешения инициатора имперсонации через `resolveRoleAuditInitiator`, а также проверки активных субъектов (`core."user"`, `core."userWorkspace"`, `core."apiKey"`, `core.application`) внутри транзакции с защитами `to_regclass(...) IS NOT NULL` и `to_jsonb(...)->>'deletedAt'` для совместимости с синтетическими схемами.
   - Корректное извлечение идентичности для всех типов субъектов (`userSession`, `impersonated userSession`, `apiKey`, `oauthClient` / `application` как в режиме `withUser` с `actor: { kind: 'application' }, initiator: { kind: 'coreUser' }`, так и `withoutUser`, `agent`, `system`), с отказом на неоднозначные комбинации (`apiKey` + `user`/`application`, `impersonationContext` + `apiKey`/`application`, `agentId` без `application`).
   - Разделение многоразового ambient-скоупа (`withWorkspaceDomainAudit`) и одноразового токена `WorkspaceDomainAuditRequest` от эксклюзивного транзакционного скоупа `withExclusiveAuditScope` (зарегистрированного в `registerMetadataAuditScopeCheck(getWorkspaceDomainAudit)`), чтобы передача захваченного в резолвере запроса в сервис работала штатно, а любая реентерабельная мутация внутри `onAfterAuditFlush` (`sendApprovedAccessDomainValidationEmail`) блокировалась.
   - Единый строгий порядок блокировок для исключения взаимных блокировок (в том числе из-за встречного FK `core.application."primaryPublicDomainId" -> core."publicDomain"(id) ON DELETE SET NULL`):
     `pg_advisory_xact_lock` -> `core.workspace` (`FOR NO KEY UPDATE`) -> таблицы субъекта аудита (`FOR KEY SHARE`) -> целевой `core.application` (`FOR NO KEY UPDATE` / `FOR UPDATE`) -> `core."applicationAuthorization"` (`ORDER BY id FOR UPDATE`) -> `core."publicDomain"` (`ORDER BY id FOR UPDATE`) -> `core."approvedAccessDomain"` (`FOR UPDATE`).
   - Гидратация полей `createdAt` и `updatedAt` как экземпляров `Date` при формировании `ApprovedAccessDomainEntity` и `PublicDomainEntity` из `to_jsonb(...)`.
   - `runAuditedApprovedAccessDomainCreate`:
     - Выполняется внутри `runInCoreAuditTransaction` с `SET LOCAL lock_timeout = '8s'`.
     - Сериализует конкурентную регистрацию одного и того же домена в рабочем пространстве через `pg_advisory_xact_lock(hashtext('approved_access_domain'), hashtext(workspaceId || ':' || domain))`.
     - Блокирует `core.workspace` (`FOR NO KEY UPDATE`, `to_jsonb(w)->>'deletedAt' IS NULL`).
     - Проверяет и разрешает субъекта аудита (`resolveWorkspaceDomainOperation`).
     - Проверяет отсутствие существующей записи `core."approvedAccessDomain"` для `(domain, workspaceId)` (при наличии выбрасывает `ApprovedAccessDomainException(APPROVED_ACCESS_DOMAIN_ALREADY_REGISTERED)`).
     - Вставляет строку `core."approvedAccessDomain"`, записывает событие `approvedAccessDomain` (`create`), выполняет `audit.flush()` и сверку снимка после `flush()`, после чего внутри транзакции вызывает `onAfterAuditFlush(createdEntity)` (отправка письма подтверждения `sendApprovedAccessDomainValidationEmail`) и повторно сверяет снимок строки перед `COMMIT`. Благодаря этому при сбое `audit.flush()` письмо не отправляется, а при ошибке валидации/отправки письма вся транзакция (и строка домена, и запись аудита) атомарно откатывается.
   - `runAuditedApprovedAccessDomainValidate`:
     - Выполняется внутри `runInCoreAuditTransaction`, блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет субъекта аудита и блокирует целевую строку `core."approvedAccessDomain"` (`FOR UPDATE`).
     - Проверяет существование строки (`APPROVED_ACCESS_DOMAIN_NOT_FOUND`), совпадение `workspaceId` и `domain` с JWT-токеном и контекстом рабочего пространства (`APPROVED_ACCESS_DOMAIN_VALIDATION_TOKEN_INVALID`), и флаг `isValidated === false` (`APPROVED_ACCESS_DOMAIN_ALREADY_VALIDATED`).
     - Обновляет `isValidated = true`, записывает и сбрасывает (`flush`) событие `approvedAccessDomain` (`update`), и повторно сверяет состояние строки после `flush()`.
   - `runAuditedApprovedAccessDomainDelete`:
     - Выполняется внутри `runInCoreAuditTransaction`, блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет субъекта аудита и блокирует целевую строку `core."approvedAccessDomain"` (`FOR UPDATE` по `id` и `workspaceId`, выбрасывая `APPROVED_ACCESS_DOMAIN_NOT_FOUND` при отсутствии).
     - Удаляет строку, проверяет физическое отсутствие строки, записывает и сбрасывает (`flush`) событие `approvedAccessDomain` (`delete`), и проверяет отсутствие строки после `flush()`.
   - `runAuditedPublicDomainCreate`:
     - Выполняется внутри `runInCoreAuditTransaction`, сериализует конкурентную регистрацию домена через `pg_advisory_xact_lock(hashtext('public_domain'), hashtext(formattedDomain))`, блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет субъекта аудита и блокирует целевое `core.application` (`FOR NO KEY UPDATE`, проверяя принадлежность `workspaceId` и `to_jsonb(a)->>'deletedAt' IS NULL`).
     - Проверяет глобальное отсутствие `to_jsonb(w)->>'customDomain' = formattedDomain` в `core.workspace` (`DOMAIN_ALREADY_REGISTERED_AS_CUSTOM_DOMAIN`) и глобальное отсутствие `domain = formattedDomain` в `core."publicDomain"` (`PUBLIC_DOMAIN_ALREADY_REGISTERED`).
     - Вставляет строку `core."publicDomain"`, записывает и сбрасывает (`flush`) событие `publicDomain` (`create`) и сверяет состояние строки после `flush()`.
     - В `PublicDomainService.createPublicDomain` предварительная проверка дубликата использует глобальный `publicDomainRepositoryUnscoped.findOne({ where: { domain: formattedDomain } })`, а в блоке `catch` вокруг `runAuditedPublicDomainCreate` компенсирующий вызов `dnsManagerService.deleteHostnameSilently` выполняется только тогда, когда ошибка не является `NativeTransactionOutcomeUnknownError`, `CoreAuditPostCommitError` или `PublicDomainException` с кодом `PUBLIC_DOMAIN_ALREADY_REGISTERED` / `DOMAIN_ALREADY_REGISTERED_AS_CUSTOM_DOMAIN` (чтобы конкурирующий дубликат никогда не удалил существующий боевой хост в Cloudflare).
   - `runAuditedPublicDomainValidationUpdate`:
     - Вызывается в `PublicDomainService.checkPublicDomainValidRecords` безусловно при наличии `coreDataSource` (сравнение `isValidated` выполняется внутри транзакции по заблокированной `FOR UPDATE` строке БД, а не по потенциально устаревшему значению в памяти).
     - Блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет субъекта аудита (`resolveWorkspaceDomainOperation`), блокирует целевое `core.application` (`FOR NO KEY UPDATE`) и строку `core."publicDomain"` (`FOR UPDATE` по `id` и `workspaceId`).
     - Если `Boolean(beforeRow.isValidated) === isValidated`, завершает транзакцию без лишнего `UPDATE` и без пустой записи аудита.
     - Если `Boolean(beforeRow.isValidated) !== isValidated`, обновляет `isValidated`, записывает и сбрасывает (`flush`) событие `publicDomain` (`update`) и сверяет строку после `flush()`.
   - `runAuditedPublicDomainDelete`:
     - Выполняется внутри `runInCoreAuditTransaction`, блокирует `core.workspace` (`FOR NO KEY UPDATE`), проверяет субъекта аудита (`resolveWorkspaceDomainOperation`), при наличии записи в `core."publicDomain"` блокирует связанное `core.application` (`FOR NO KEY UPDATE` до `DELETE FROM core."publicDomain"`, соблюдая канонический порядок блокировок `core.application -> core."publicDomain"` для триггера `ON DELETE SET NULL` на `primaryPublicDomainId`) и строку `core."publicDomain"` (`FOR UPDATE`).
     - Если строка в данном `workspaceId` отсутствует, возвращает `{ deleted: false }` без фиктивной записи аудита; при этом `PublicDomainService.deletePublicDomain` вызывает `dnsManagerService.deleteHostnameSilently` только после успешного `COMMIT` при `deleted === true`.
3. Расширить `runAuditedApplicationDelete` в `application-authorization-and-variable-audit.ts`:
   - До вызова `work(runner)` (если таблица `core."publicDomain"` существует в схеме) блокировать все строки `core."publicDomain"` с `"applicationId" = $1 ORDER BY pd.id FOR UPDATE` и проверять совпадение их `"workspaceId"` с `request.workspaceId`.
   - Требовать аутентифицированный `request.operation`, если `beforeAuthorizations.size > 0 || beforePublicDomains.size > 0`.
   - После `work(runner)` проверять, что все строки `core."publicDomain"` для `applicationId` были каскадно удалены, записывать `publicDomain` (`delete`) для каждой удалённой строки в тот же `CrmAuditTransactionContext`, выполнять `audit.flush()` и проверять отсутствие строк как в `core."applicationAuthorization"` (`if (hasAuthTable)`), так и в `core."publicDomain"` (`if (hasPublicDomainTable)`) после `flush()`.

### Вариант B: Запись аудита только в GraphQL-резолверах `ApprovedAccessDomainResolver` и `PublicDomainResolver`
- Отвергнут: пропускает фоновые и вебхук-обновления `PublicDomainService.checkPublicDomainValidRecords` (`CheckPublicDomainsValidRecordsCronJob`, `DnsCloudflareService`), каскадное удаление `core."publicDomain"` при `ApplicationService.delete`, и не обеспечивает атомарности с изменениями в БД.

### Вариант C: Хранение `domain` в открытом виде в `CATALOG.*.values`
- Отвергнут: доменные имена клиентов и рабочих пространств относятся к идентифицирующим данным арендатора и по конвенции `CATALOG` должны храниться в `redacted` (с криптографическим хешем `sha256` и фиксацией имени поля в `changedFields`).

## 3. Точки интеграции и инварианты безопасности

1. **Синхронный захват атрибуции до первого `await`**:
   - В `ApprovedAccessDomainResolver` (`createApprovedAccessDomain`, `deleteApprovedAccessDomain`, `validateApprovedAccessDomain`) и `PublicDomainResolver` (`createPublicDomain`, `deletePublicDomain`, `checkPublicDomainValidRecords`) идентичность захватывается синхронно в начале метода до любых асинхронных вызовов (`workspaceOrmManager.executeInWorkspaceContext`, `publicDomainRepository.findOne`, `dnsManagerService.refreshHostname`).
   - В `CheckPublicDomainsValidRecordsCronJob.handle` явно передаётся `auditIdentity: { workspaceId: publicDomain.workspaceId, actor: { kind: 'system', id: CheckPublicDomainsValidRecordsCronJob.name } }`, а в `DnsCloudflareService.checkHostname` явно передаётся `auditIdentity: { workspaceId: publicDomain.workspaceId, actor: { kind: 'system', id: 'DnsCloudflareService.checkHostname' } }`; `PublicDomainService.checkPublicDomainValidRecords` не допускает неявного fallback'а на `system`.
   - В `ApprovedAccessDomainService` и `PublicDomainService` `captureWorkspaceDomainAudit` вызывается синхронно до первого `await` (`verifyValidationTokenOrThrow`, `dnsManagerService.*`, предварительных запросов).
2. **Изоляция рабочих пространств и нормализация домена**:
   - В `ApprovedAccessDomainResolver.validateApprovedAccessDomain` передаётся `workspaceId: currentWorkspace.id`, и `ApprovedAccessDomainService.validateApprovedAccessDomain` отвергает токен, если `payload.workspaceId` или `approvedAccessDomain.workspaceId` не совпадает с `workspaceId` вызывающего рабочего пространства.
   - В `PublicDomainResolver.checkPublicDomainValidRecords` и `PublicDomainService.findByDomain` входной `domain` нормализуется через `domain.trim().toLowerCase()`.
   - В `PublicDomainService.deletePublicDomain` внешний вызов `dnsManagerService.deleteHostnameSilently` выполняется только после подтверждённого удаления строки `core."publicDomain"` в рамках `workspace.id`.
3. **Соблюдение границы Enterprise**:
   - Новый модуль `workspace-domain-audit.ts` не импортирует `DnsManagerService`, `DnsCloudflareController` или другие файлы с заголовком `/* @license Enterprise */`.
