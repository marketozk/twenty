# LOG-207 - Усиление Session lifecycle (refresh token family revoke, active subject fencing, атрибуция и блокировки `stopImpersonation` / `Superseded` / `signOut`)

- Дата: `2026-11-23`
- Задача: Linear `ROB-765` (Phase 2a, остаётся `In Progress`)
- Ветка: `codex/omnichannel-requirements`

## Изменённые и добавленные файлы кода и тестов
1. `packages/twenty-server/src/engine/core-modules/user-session/types/user-session-revoked-reason.type.ts` - добавлена причина `RefreshTokenReuseDetected = 'REFRESH_TOKEN_REUSE_DETECTED'`.
2. `packages/twenty-server/src/engine/core-modules/app-token/app-token.entity.ts` - добавлено опциональное поле `familyId?: string` в `context`.
3. `packages/twenty-server/src/engine/core-modules/auth/token/services/refresh-token.service.ts` - генерация и наследование `familyId` (включая legacy-токены при ротации), обнаружение post-grace replay в `verifyRefreshToken` (до `userRepository.findOneBy`, с проверкой `jti`/`sub`/`userId`/`workspaceId`/`type`) и `rotateRefreshToken` (с освобождением `shared`-блокировки до `revokeRefreshTokenFamilyOnReuse`), атомарный отзыв всех активных и неистёкших токенов семейства под `acquireUserAuthenticationLock('exclusive')` с группировкой `CrmAuditTransactionContext` по `workspaceId` и `SAVEPOINT refresh_family_revocation_audit` (без `FOR SHARE` на `userWorkspace` внутри `SAVEPOINT`), `lockAndCheckActiveSubject` в каноническом порядке `W (FOR KEY SHARE) -> U (FOR SHARE, deletedAt IS NULL и не disabled) -> UW (FOR SHARE OF uw + проверка активности core."user" имперсонатора)` с отложенным `throw subject.error` в `rotateRefreshToken`, fail-fast валидация `tokenId` и UUID-полей.
4. `packages/twenty-server/src/engine/core-modules/user-session/services/user-session.service.ts` - проверка активного `core."user"` (`deletedAt IS NULL`, не `disabled`) и `core.workspace` (`FOR KEY SHARE`, `deletedAt IS NULL`) и активности `core."user"` имперсонатора (`FOR SHARE OF uw`) при создании сессии, `lockUserId` (всегда `session.userId`) и безусловная проверка `row.userId === lockedUserId` в `revokeSessionsWithAudit`, fail-fast валидация `actingUserId`, `correlationId` и UUID-полей до транзакции и `SAVEPOINT`, безусловная fail-closed проверка `assertImpersonationEndedTarget` для `ImpersonationEnded` (с отклонением пустых строк и несовпадений `workspaceId`/`impersonatedUserWorkspaceId`), сквозной `correlationId` в `issueSessionForTokenPair` и `signOut`.
5. `packages/twenty-server/src/engine/core-modules/impersonation/services/impersonation.service.ts` - fail-fast UUID-проверка `impersonatorUserWorkspaceId` и `impersonatedUserWorkspaceId` в `stopImpersonation` и передача `initiatorMembershipId`, `expectedWorkspaceId`, `expectedImpersonatedUserWorkspaceId` вместо `actingUserId` (каноническая пара `actor = targetUserId`, `initiator = impersonatorUserId`).
6. `packages/twenty-server/src/engine/core-modules/auth/utils/__tests__/is-revoked-refresh-token-still-renewable.util.spec.ts` - добавлен явный кейс для `RefreshTokenReuseDetected`.
7. `packages/twenty-server/test/fork-migration/crm-audit-refresh-logout.postgres-spec.ts`, `crm-audit-user-session.postgres-spec.ts`, `crm-audit-password-update.postgres-spec.ts` - обновлены моки (`deletedAt`), `userWorkspace` seed и `GRANT UPDATE` на `core."user"`, `core.workspace`, `core."userWorkspace"`.
8. `packages/twenty-server/test/fork-migration/crm-audit-session-lifecycle-hardening.postgres-spec.ts` (новый) - 7 PostgreSQL 17 сценариев (family revoke, legacy `familyId`, конкурентный replay, `SAVEPOINT`, активный субъект/членство/имперсонатор, реальная гонка `FOR UPDATE` без advisory lock, `stopImpersonation`, `Superseded` lock, сквозной `correlationId`, триггерная порча и fail-fast UUID).

## Артефакты
- [design.md](design.md)
- [test-research.md](test-research.md)
- [design-review.md](design-review.md)
- [review.md](review.md)
- [results.json](results.json)
- [typecheck-differential.json](typecheck-differential.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
