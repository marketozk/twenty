# LOG-213 - Отзыв всего семейства refresh-токенов в `signOut({ refreshToken })` и устранение PG 17 гонки детерминированного `PK` против `ON CONFLICT` в omnichannel-сервисах

- Дата: `2026-11-25`
- Задача: Linear `ROB-765` (Phase 2a, остаётся `In Progress`)
- Ветка: `codex/omnichannel-requirements`

## Изменённые файлы кода и тестов
1. `packages/twenty-server/src/engine/core-modules/user-session/services/user-session.service.ts` - `revokePresentedRefreshToken` переведён на отзыв всего семейства `familyId` в `signOut({ refreshToken })` без миграций БД:
   - строгая pre-SQL проверка `payload.workspaceId`, `payload.isImpersonating` и `payload.impersonatorUserWorkspaceId` (с 3-сторонним контрактом `undefined` / `null` / UUID);
   - предварительное чтение `initialPresented` и единый `ORDER BY token.id ASC FOR UPDATE` (включая `token.id = :tokenId` вместе со всеми активными и беспричинными неистёкшими строками того же `(userId, REFRESH_TOKEN, LOWER(context->>'familyId'))`) для исключения TOCTOU и дедлоков;
   - повторная проверка `workspaceId`, `context` и `familyId` под строковой блокировкой (fail-closed при битом не-UUID `familyId`, сохранение однострочного поведения для legacy-токенов без `familyId`);
   - проверка пост-снимков всех заблокированных строк (включая ранее отозванную `lockedPresented`), группировка `CrmAuditTransactionContext` по `workspaceId` в возрастающем порядке под единым `operationId` и `correlationId` с сохранением серверной имперсонации (без ложного запрета `impersonator.workspaceId !== wsId`) и `SAVEPOINT refresh_revocation_audit` + `REFRESH_REVOCATION_AUDIT_UNAVAILABLE`.
2. `packages/twenty-server/src/modules/omnichannel/services/admit-omni-human-text-command.ts` - `ON CONFLICT ("workspaceId","actorKind","actorId","idempotencyKey") DO NOTHING` заменён на `ON CONFLICT DO NOTHING` под `READ COMMITTED`, устраняя гонку `PK_8f710425081f885de68a1174f1b (id)` против `UQ_omniOutgoingCommand_actor_key` в PG 17 при детерминированном UUIDv5 `commandId` (неожиданные конфликты fail-closed в `replay(await findCommand())` -> `OMNI_HUMAN_TEXT_COMMAND_ROW_INTEGRITY`).
3. `packages/twenty-server/src/modules/omnichannel/services/omni-binding-config-wakeup.ts` - `ON CONFLICT ("workspaceId","eventId") DO NOTHING` заменён на `ON CONFLICT DO NOTHING` с явной fail-closed пост-проверкой существующей строки `(id, workspaceId, eventId, bindingId)` при `inserted.length === 0` (`OMNI_BINDING_CONFIG_WAKEUP_ENQUEUE_POSTCONDITION`).
4. `packages/twenty-server/src/modules/omnichannel/services/apply-omni-history-receipt.ts` - `ON CONFLICT ("workspaceId","bindingId","providerChatId") DO NOTHING` заменён на `ON CONFLICT DO NOTHING` для закрытия аналогичной гонки детерминированного `PK(creatorConversationId)` под `READ COMMITTED`.
5. `packages/twenty-server/test/fork-migration/crm-audit-session-lifecycle-hardening.postgres-spec.ts` - добавлены PG 17 регрессии на отзыв всего семейства в `signOut({ refreshToken })`, частичный отзыв с сохранением исходной `revokedReason`, серверную имперсонацию, workspace-agnostic семейство, битый `familyId`, legacy-токен с uppercase UUID, невалидные/несовпадающие `workspaceId`/`impersonator` клеймы и выживание через `SAVEPOINT`.
6. `packages/twenty-server/test/fork-migration/crm-audit-refresh-logout.postgres-spec.ts` - обновлён тест конкурентного `renew` + `signOut` под новый контракт отзыва дочернего токена семейства (`verifyRefreshToken(successor)` -> `revoked`, `4` записи аудита).
7. `packages/twenty-server/test/fork-migration/omni-binding-config-wakeup.postgres-spec.ts` - добавлены тест реальной гонки `INSERT ... ON CONFLICT DO NOTHING` в `reconcileOmniBindingConfigWakeups` (с проверкой `scannedCount === 1` на обеих транзакциях) и триггерный тест fail-closed ветки `OMNI_BINDING_CONFIG_WAKEUP_ENQUEUE_POSTCONDITION`.

## Артефакты
- [design.md](design.md)
- [test-research.md](test-research.md)
- [design-review.md](design-review.md)
- [review.md](review.md)
- [results.json](results.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
