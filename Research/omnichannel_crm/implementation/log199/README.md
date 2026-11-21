# LOG-199: транзакционный аудит шаринга записей (`recordShare` в `workspace_*."recordShare"`)

## Объём изменений
- `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit.types.ts` и `crm-audit-transaction-context.ts`: добавлен ресурс `recordShare` (`values`: `objectMetadataId`, `recordId`, `principalId`, `principalType`, `accessLevel`, `rowCause`, `sourceId`; `redacted`: `[]`) и `ADMINISTRATIVE_ACTIONS.recordShare` (`['create', 'update', 'delete']`).
- `packages/twenty-server/src/engine/core-modules/crm-audit/record-share-audit.ts`: реализован модульный транзакционный раннер и валидатор без единого Enterprise-ребра (`assertRecordShareRowInvariants` с fail-closed отказом на `deletedAt !== null`, `projectRecordShare`, `captureRecordShareAudit` со сверкой ALS-контекста `captureCurrentCrmAuditOperation` и одноразовым захватом, `beginRecordShareAuditTransaction` с каноническим порядком блокировок `SET LOCAL lock_timeout = '8s'` -> `core.workspace FOR NO KEY UPDATE` -> разрешение имперсонатора, `runAuditedRecordShareScopeMutation` с проверкой `accessLevel`, `sourceId`, `rowCause`, полноты итогового состояния `after` и пост-flush проверкой после `SET CONSTRAINTS ALL IMMEDIATE`, а также `validateRecordShareTransferAuditInput` и `runAuditedRecordShareTransfer` с 3/4-кортежными инвариантами и offboarding `SAVEPOINT record_share_transfer_audit`).
- `packages/twenty-server/src/engine/core-modules/record-share/resolvers/record-sharing.resolver.ts`, `services/record-sharing.service.ts`, `utils/build-record-share-lock-key.util.ts` и `packages/twenty-server/src/engine/core-modules/tool/tools/share-record-tool/share-record-tool.ts`: подключён синхронный захват аудита в `setGeneralAccess`, `setShare`, `removeShare`, строгая транзакция `{ commitOutcome: 'strict' }`, чтение `findCreatorWorkspaceMemberId` через `transactionScope`, проброс `@Context()` из резолвера и проверка `workspaceId` + условный проброс `agentId` из `ShareRecordTool`.
- `packages/twenty-server/src/engine/core-modules/record-share/services/record-share-storage.service.ts` и `services/record-share-ownership-transfer.service.ts` (`/* @license Enterprise */` сохранены): `setManualShare` переведён на in-place `update` при совпадающем `sourceId` и idempotent no-op при неизменном `accessLevel` (с `withDeleted: true`); `transferMemberGrants` переведён на `{ commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' }` и `runAuditedRecordShareTransfer`; `transferRecordSharesToCustodian` валидирует `auditOperation` и запрет self-transfer до раннего возврата при пустом списке объектов.
- `packages/twenty-server/src/engine/core-modules/user/services/user.service.ts` и `packages/twenty-server/src/modules/workspace-member/query-hooks/workspace-member-delete-one.post-query.hook.ts`: проброшен `auditOperation` в `recordShareOwnershipTransferService.transferRecordSharesToCustodian`.
- `packages/twenty-server/test/fork-migration/crm-audit-record-share.postgres-spec.ts` и `crm-audit-membership-entrypoints.spec.ts`: 4 реальных PostgreSQL-сценария жизненного цикла `recordShare` (публичный API, `shareWith`-замена, `setGeneralAccess`, `ShareRecordTool`, OAuth/App, перенос владения при удалении участника, устойчивость `SAVEPOINT`, fail-closed инварианты и rollback при сбое flush / post-flush drift) + assertions на передачу `auditOperation` в `transferRecordSharesToCustodian`.

## Артефакты
- [design.md](design.md)
- [design-review.md](design-review.md)
- [test-research.md](test-research.md)
- [review.md](review.md)
- [results.json](results.json)
- [source-snapshot.json](source-snapshot.json)
- [typecheck-differential.json](typecheck-differential.json)
- [regression.log](regression.log)
- [next-boundary.md](next-boundary.md)
