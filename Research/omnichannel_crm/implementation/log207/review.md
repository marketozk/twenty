# LOG-207 Independent Code Review

## Verdict
Первичный вердикт независимого адверсариального ревью кода: `NEEDS_FIX` (`2` Blocker, `4` Major, `3` Minor).
Все 9 находок исправлены и подтверждены повторным прогоном `guards` (`0` Enterprise violations, `33/33` Python tests), `6/6` целевых PG 17 сьютов (`139/139` PASS) и финальным дифференциальным `typecheck` (`pass-no-new-diagnostics`, `0/0/0`).

## Findings and Resolutions

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| B1 | Blocker | Инверсия порядка блокировок (`AT -> UW`) и лишний `FOR SHARE` в `RefreshTokenService.revokeRefreshTokenFamilyOnReuse` внутри `SAVEPOINT` (риск deadlock с `DELETE FROM core.workspace` и контенции с `FOR NO KEY UPDATE` на `userWorkspace`). | Убран `FOR SHARE` из чтения `core."userWorkspace"` внутри `SAVEPOINT refresh_family_revocation_audit` (по аналогии с `UserSessionService.revokePresentedRefreshToken` и `revokeSessionsWithAudit`). |
| B2 | Blocker | Отсутствовала валидация `input.actingUserId` до `SAVEPOINT` в `UserSessionService.revokeSessionsWithAudit`, из-за чего невалидный `actingUserId` при заданном `lockUserId` вызывал откат `SAVEPOINT` и тихую потерю аудита вместо fail-fast отказа. | Добавлена fail-fast проверка `isNonEmptyString(input.actingUserId) && isUUID(input.actingUserId)` до старта транзакции и `SAVEPOINT` + PG-регрессия. |
| M1 | Major | `assertImpersonationEndedTarget` молча пропускал пустые строки `""`, а `stopImpersonation` не требовал валидного UUID для `impersonatorUserWorkspaceId` и `impersonatedUserWorkspaceId`. | В `assertImpersonationEndedTarget` проверки переведены на `!== undefined` с обязательной `isUUID`-валидацией; в `ImpersonationService.stopImpersonation` требуются валидные UUID обоих идентификаторов. |
| M2 | Major | Отсутствовала `isUUID`-валидация до старта транзакции в `UserSessionService.saveAuditedWorkspaceSession` и для `tokenId` в `RefreshTokenService.rotateRefreshToken`. | Добавлены fail-fast проверки `isUUID` до входа в `runInCoreAuditTransaction` + PG-регрессии. |
| M3 | Major | Отключённый/деактивированный аккаунт имперсонатора (`core."user".disabled = true` / `deletedAt IS NOT NULL`) не блокировался при проверке `initiatorMembership` в `lockAndCheckActiveSubject` и `saveAuditedWorkspaceSession`. | Добавлен `LEFT JOIN core."user" u` с проверкой `u."deletedAt" IS NULL AND COALESCE((to_jsonb(u)->>'disabled')::boolean, false) = false` и блокировкой строго `FOR SHARE OF uw` (сохраняя порядок `W -> U -> UW`) + PG-регрессия. |
| M4 | Major | Пробелы в тестовом покрытии `crm-audit-session-lifecycle-hardening.postgres-spec.ts` (deleted membership, rotate при удалённом workspace, impersonation family replay + deleted initiator, `stopImpersonation` workspace/target/retry, триггерная порча/воскрешение `appToken`, fail-fast UUID). | Все 5 групп сценариев добавлены в `crm-audit-session-lifecycle-hardening.postgres-spec.ts` (`7/7` тестов PASS). |
| m1 | Minor | Несогласованность проверок JWT-клеймов `userId`/`workspaceId`/`isImpersonating` в `verifyRefreshToken`. | Добавлены проверки совпадения `jwtPayload.userId === sub`, `jwtPayload.workspaceId === token.workspaceId` и передача `impersonatorUserWorkspaceId` только при `jwtPayload.isImpersonating === true`. |
| m2 | Minor | Инвариант `row.userId.toLowerCase() === lockedUserId` в `revokeSessionsWithAudit` проверялся только при `isDefined(input.sessionId)`. | Условие `isDefined(input.sessionId)` снято: инвариант проверяется безусловно для всех режимов отзыва. |
| m3 | Minor | В `is-revoked-refresh-token-still-renewable.util.spec.ts` не было явного кейса для `UserSessionRevokedReason.RefreshTokenReuseDetected`. | Добавлен параметризованный кейс с `RefreshTokenReuseDetected`. |
