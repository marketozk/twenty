# Design LOG-199: транзакционный аудит шаринга записей (`recordShare`)

## 1. Цель и границы участка
Закрыть транзакционный аудит управления доступом к отдельным записям (`workspace_*."recordShare"`) в двух критических контурах:
1. Публичный GraphQL API и AI-инструмент управления шарами записи:
   - `RecordSharingResolver` (`setRecordGeneralAccess`, `setRecordShare`, `removeRecordShare`)
   - `RecordSharingService` (`setGeneralAccess`, `setShare`, `removeShare`, `changeSharing`)
   - `ShareRecordTool` (`execute`)
   - `RecordShareStorageService.setManualShare`
2. Передача владения шарами записей при удалении участника рабочего пространства:
   - `RecordShareOwnershipTransferService.transferRecordSharesToCustodian`
   - `RecordShareStorageService.transferMemberGrants`
   - Проброс `auditOperation` из `UserService.removeUserFromWorkspaceAndPotentiallyDeleteWorkspace` и `WorkspaceMemberDeleteOnePostQueryHook`

### Явно вне границ LOG-199 (остаётся для LOG-200)
- `ShareWithService.insertRecordSharesForCreatedRecords` (вызывается из `CommonCreateManyQueryRunnerService` при создании записей с `shareWith`).
- `WorkflowRunRecordShareService.replaceShares` (фоновая/отложенная синхронизация шаров `workflowRun`).
- `AgentChatSharingService.deleteByRecordIdsInTransaction` и `AgentChatChannelGrantService.replaceGrantsInTransaction` (системные `RULE`-гранты чатов ИИ).
- Неаудируемые вспомогательные методы `RecordShareStorageService` (`insertMany`, `deleteByRecordIds`, `deleteByRecordIdsInTransaction`, `deleteMatching`, `deleteBySourceId`).

## 2. Модель аудита (`crm-audit.types.ts`, `crm-audit-transaction-context.ts`)
- `CrmAuditResourceKind`: добавить `'recordShare'`.
- `CATALOG.recordShare`:
  - `values`: `['objectMetadataId', 'recordId', 'principalId', 'principalType', 'accessLevel', 'rowCause', 'sourceId']`
  - `redacted`: `[]` (таблица содержит только UUID и enum-токены политики доступа, без текстов и секретов)
- `ADMINISTRATIVE_ACTIONS.recordShare = ['create', 'update', 'delete']`.
- `securityDescriptor`:
  ```ts
  {
    resourceKind: 'recordShare',
    resourceId: rowId,
    metadataAccess: 'currentWorkspaceAdministration',
  }
  ```

## 3. Граница Enterprise
- `record-share-storage.service.ts` и `record-share-ownership-transfer.service.ts` сохраняют маркер `/* @license Enterprise */`.
- Новый модуль `packages/twenty-server/src/engine/core-modules/crm-audit/record-share-audit.ts` не импортирует ни одного файла из `record-share/*`, `twenty-orm/types/workspace-transaction-scope.type`, `twenty-orm/workspace-orm.manager` или `auth/types/workspace-auth-context.type` (включая `import type`). Используются структурные типы (`Parameters<typeof createCrmAuditWorkspaceExecutor>[0]` и структурный `RecordShareAuthContext`) и локальные множества строковых литералов.
- Импорты направлены строго `record-share/* -> crm-audit/record-share-audit.ts` (`EE -> non-EE`), что гарантирует `0` нарушений в `check_enterprise_dependencies.py --verify-baseline`.

## 4. Атрибуция и захват идентичности (`record-share-audit.ts`)
- `captureRecordShareAudit({ workspaceId, authContext, agentId?, requestContext? })`:
  - Вызывается синхронно до первого `await` в `setGeneralAccess`, `setShare`, `removeShare`.
  - Нормализует все UUID к нижнему регистру; валидирует `authContext.type === 'user'`, совпадение `authContext.workspace.id === workspaceId`, валидность `user.id`, `workspaceMemberId`, `userWorkspaceId`.
  - Читает ambient-контекст `captureCurrentCrmAuditOperation(normalizedWorkspaceId)` как источник `correlationId`/`causationId` и fallback/кросс-проверку `impersonatorUserWorkspaceId` (fail-closed при конфликте между `requestContext` и ALS).
  - Fail-closed отклоняет:
    - разные `authContext.application.id` и `authContext.viaApplication.id`, когда оба заданы;
    - разные `args.agentId` и `authContext.agentId`, когда оба заданы;
    - наличие `impersonatorUserWorkspaceId` одновременно с `agentId` или `application`/`viaApplication`.
  - Определяет `actor` / `initiator`:
    - Если задан `agentId` (из `args.agentId` или `authContext.agentId`): `actor = { kind: 'agent', id }`, `initiator = { kind: 'workspaceMember', id: workspaceMemberId }`.
    - Иначе если задан `applicationId` (из `authContext.application?.id ?? authContext.viaApplication?.id`): `actor = { kind: 'application', id: applicationId }`, `initiator = { kind: 'workspaceMember', id: workspaceMemberId }`.
    - Иначе: `actor = { kind: 'workspaceMember', id: workspaceMemberId }`, `initiator` при наличии `impersonatorUserWorkspaceId` разрешается внутри транзакции из `core."userWorkspace"`.
  - Одноразовая защита (`consumed` WeakSet) исключает повторное использование `operationId`.
- `RecordSharingResolver`: передаёт `@Context() context?: { req?: RecordShareRequestContext }` в `setRecordGeneralAccess`, `setRecordShare`, `removeRecordShare`.
- `ShareRecordTool`: проверяет совпадение `context.workspaceId` и `authContext.workspace.id` до поиска объекта и условно передаёт `...(context.agentId ? { agentId: context.agentId } : {})` в `recordSharingService.setShare`.

## 5. Строгие транзакции, порядок блокировок и инварианты снимков
### 5.1. `RecordShareStorageService.setManualShare`
- При `enabled: true`: внутри `withRepository` выполняется `repository.find({ where: { objectMetadataId, recordId, principalId, principalType, rowCause: MANUAL }, withDeleted: true })`.
  - Если найдена ровно 1 живая строка (`deletedAt == null`) и `existing.sourceId.toLowerCase() === share.sourceId.toLowerCase()`:
    - при `existing.accessLevel === share.accessLevel` - idempotent no-op (0 записей аудита);
    - иначе - `repository.update({ id: existing.id }, { accessLevel: share.accessLevel })` с сохранением `id` (в аудите чистый `update`).
  - Иначе - `delete` + `insert`.
- При `enabled: false`: прежний `delete`.

### 5.2. `RecordSharingService.changeSharing` -> `runAuditedRecordShareScopeMutation`
- Перевести `runInWorkspaceTransaction` на `{ commitOutcome: 'strict' }`.
- Глобальный порядок блокировок (исключает AB-BA дедлоки):
  1. `SET LOCAL lock_timeout = '8s'`
  2. Проверка `core.workspace` (`FOR NO KEY UPDATE`, `deletedAt IS NULL`) и разрешение `impersonatorUserWorkspaceId` в `core."userWorkspace"` (`deletedAt IS NULL`).
  3. `pg_advisory_xact_lock(hashtextextended(buildRecordShareLockKey(...), 0))`
  4. `SELECT id FROM <ws>.<table> WHERE id = $1 FOR UPDATE`
  5. Проверки прав (`writableIds`, `isObjectOperationPermittedByRole('update')`, `getRecordShares` - при этом `findCreatorWorkspaceMemberId` читает через `transactionScope`, не открывая второе соединение).
  6. Снимок `before` всех строк `workspace_*."recordShare"` для `(objectMetadataId, recordId)` **без** `WHERE "deletedAt" IS NULL` с `ORDER BY id FOR UPDATE`; `assertRecordShareRowInvariants` fail-closed отклоняет любую строку с `deletedAt !== null`.
  7. Выполнение `await write(...)`.
  8. Снимок `after` по тому же запросу (`ORDER BY id`) и `assertRecordShareRowInvariants`.
  9. Проверка инвариантов `expectedScope` (все UUID в lowercase):
     - `manualPrincipal` (`setShare` / `removeShare`):
       - затронутые строки обязаны иметь `rowCause === 'MANUAL'`, `principalId === expected.principalId`, `principalType === expected.principalType`;
       - для `create`/`update`: `after.sourceId === recordId`; при `update` изменяется только `accessLevel`;
       - для `delete`: валидный UUID `before.sourceId` (допускает удаление строк `shareWith`, созданных с `sourceId = creatorWorkspaceMemberId`);
       - для `removeShare`: `create` и `update` запрещены.
     - `generalAccess` (`setGeneralAccess`):
       - `EVERYONE` / `MANUAL` строка (`principalId === EVERYONE_PRINCIPAL_ID`): для `create`/`update` требуется `after.sourceId === recordId` и `after.accessLevel === expected.accessLevel` (и `!isDefaultAccess`), для `delete` - валидный UUID `before.sourceId`;
       - `WORKSPACE_MEMBER` / `OWNER` строки: `update` запрещён; `delete` разрешён только при `sharingMode === 'OPEN_BY_DEFAULT' && isDefaultAccess`; `create` разрешён только при `sharingMode === 'OPEN_BY_DEFAULT' && (accessLevel === 'NONE' || accessLevel === 'READ')` с `after.principalId` в `allowedOwnerPrincipalIds`, `after.accessLevel === 'FULL'` и `after.sourceId === recordId`.
  10. Запись `create`/`update`/`delete` в `CrmAuditTransactionContext(createCrmAuditWorkspaceExecutor(transactionScope), operation)` -> `await audit.flush()` (строго fail-closed без `SAVEPOINT`) -> `SET CONSTRAINTS ALL IMMEDIATE` -> повторная проверка `core.workspace` и `postFlush` snapshot `recordShare`.

### 5.3. `RecordShareOwnershipTransferService.transferRecordSharesToCustodian` и `RecordShareStorageService.transferMemberGrants`
- Добавить `auditOperation?: CrmAuditOperation` в `transferRecordSharesToCustodian` и `transferMemberGrants` (пробрасывается из `UserService.removeUserFromWorkspaceAndPotentiallyDeleteWorkspace` и `WorkspaceMemberDeleteOnePostQueryHook`).
- В `transferRecordSharesToCustodian` до раннего `return` при `objectMetadataIds.length === 0`:
  - валидировать `auditOperation` (если передан: валидный объект и совпадение `workspaceId`) и запретить `uuid(fromWorkspaceMemberId) === uuid(toWorkspaceMemberId)` (после разрешения `toWorkspaceMemberId`).
- В `transferMemberGrants`:
  - Запретить `uuid(fromWorkspaceMemberId) === uuid(toWorkspaceMemberId)` до открытия транзакции.
  - Перевести `runInWorkspaceTransaction` на `{ commitOutcome: 'strict' }`.
  - Внутри `runAuditedRecordShareTransfer`:
    - `SET LOCAL lock_timeout = '8s'`, `core.workspace FOR NO KEY UPDATE`.
    - Снять `before` snapshot строк `workspace_*."recordShare"` для `objectMetadataId = ANY($1::uuid[]) AND "principalType" = 'WORKSPACE_MEMBER' AND "principalId" = ANY($2::uuid[]) AND "rowCause" IN ('OWNER', 'MANUAL') ORDER BY id FOR UPDATE` без фильтра `deletedAt` (`assertRecordShareRowInvariants` отклоняет `deletedAt !== null`).
    - Зафиксировать два множества по `fromWorkspaceMemberId` с `accessLevel === 'FULL'`:
      - `fromFullSourceKeys` (4-кортеж `objectMetadataId:recordId:rowCause:sourceId`) для допустимых `create` у custodian;
      - `fromFullRowKeys` (3-кортеж `objectMetadataId:recordId:rowCause`) для допустимых `update` (`accessLevel -> FULL`) существующих строк custodian.
    - Выполнить transfer -> снять `after` snapshot -> проверить инварианты (ни одной переносимой строки `fromWorkspaceMemberId` в `after`; при отсутствии `toWorkspaceMemberId` только `delete`; при наличии `toWorkspaceMemberId` у него только `create` `FULL` из `fromFullSourceKeys` и `update` `before.accessLevel !== 'FULL' -> 'FULL'` из `fromFullRowKeys`).
    - Запись и `audit.flush()` + `SET CONSTRAINTS ALL IMMEDIATE` + `core.workspace`/snapshot recheck выполняются под `SAVEPOINT record_share_transfer_audit` (с логированием `RECORD_SHARE_TRANSFER_AUDIT_UNAVAILABLE` при откате SAVEPOINT, как в `transfer-connected-accounts-with-audit.ts`, чтобы сбой аудита не блокировал отзыв членства; при этом post-savepoint `verify()` всё равно подтверждает целостность transfer).
