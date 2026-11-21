# Test Research LOG-199

## Целевой новый PostgreSQL-спек
`packages/twenty-server/test/fork-migration/crm-audit-record-share.postgres-spec.ts` (4 сценария, least-privilege runtime роль, строгий guard `FORK_MIGRATION_TEST_URL`):
1. Публичный API и AI tool (`RecordSharingResolver` -> `RecordSharingService`, `ShareRecordTool`):
   - `setRecordShare`: `create` нового MANUAL-гранта для `WORKSPACE_MEMBER` (`READ`) с имперсонацией (`actor: workspaceMember`, `initiator: coreUser`), повторный `setRecordShare` с тем же `READ` (idempotent no-op, 0 новых записей), обновление `READ -> READ_WRITE` на месте (`update` с сохранением `resourceId`), и `removeRecordShare` (`delete`).
   - `setRecordGeneralAccess` на `OPEN_BY_DEFAULT` объекте: ограничение `NONE` создаёт `EVERYONE/MANUAL` (`NONE`) и `OWNER` (`FULL`) строки под одним `operationId`, возврат к `READ_WRITE` удаляет их под одним `operationId`.
   - `ShareRecordTool.execute` с `agentId` (`actor: agent`, `initiator: workspaceMember`).
   - OAuth/App-with-user контекст (`application` в `authContext`): `actor: application`, `initiator: workspaceMember`.
2. Передача владения шарами при удалении участника (`RecordShareOwnershipTransferService` + `RecordShareStorageService.transferMemberGrants`):
   - Перенос `FULL` грантов уходящего участника custodian-у: создание недостающего `FULL` гранта (`create`), повышение существующего `READ` гранта custodian-а до `FULL` (`update`), удаление всех `OWNER`/`MANUAL` грантов уходящего (`delete`), всё в одной транзакции под одним `operationId`.
   - Удаление грантов без custodian (`toWorkspaceMemberId: undefined`): только `delete` грантов уходящего.
   - Fail-closed при отсутствии `auditOperation` и при `fromWorkspaceMemberId === toWorkspaceMemberId`.
3. Инварианты, границы и fail-closed проверки:
   - Отклонение имперсонации при наличии `agentId` или `application`.
   - Отклонение несанкционированной мутации не-`MANUAL` строки (`APPLICATION` / `RULE`) или чужого принципала внутри `runAuditedRecordShareScopeMutation`.
   - Отклонение `setShare` на не-`strict` транзакции (проверка `commitOutcome: 'strict'`).
   - Проверка одноразовости захвата `captureRecordShareAudit`.
4. Атомарность и откат:
   - Откат `setRecordShare` и `transferMemberGrants` при сбое `audit.flush()` (триггер `BEFORE INSERT ON crm_audit."crmAuditEntry"`): ни строки в `workspace_*."recordShare"`, ни записи в `crm_audit."crmAuditEntry"`.
   - Откат при post-flush row drift в `workspace_*."recordShare"` (триггер `AFTER INSERT ON crm_audit."crmAuditEntry"`).

## Связанные регрессионные спеки для таргетного прогона
- `packages/twenty-server/test/fork-migration/crm-audit-record-share.postgres-spec.ts` (новый)
- `packages/twenty-server/test/fork-migration/crm-audit-membership-entrypoints.spec.ts` (точки входа удаления участника)
- `packages/twenty-server/test/fork-migration/crm-audit-membership-cleanup.postgres-spec.ts` (очистка членства)
- `packages/twenty-server/test/fork-migration/crm-audit-validation-rule.postgres-spec.ts` (`LOG198`)
- `packages/twenty-server/src/engine/core-modules/tool/tools/share-record-tool/__tests__/share-record-tool.spec.ts` (unit-тесты `ShareRecordTool`)
