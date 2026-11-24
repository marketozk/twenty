# Следующая граница после LOG-213

## Что закрыто в LOG-213
- **Отзыв всего семейства refresh-токенов в `UserSessionService.signOut({ refreshToken })`**:
  - Под `acquireUserAuthenticationLock(userId, 'exclusive')` и единой восходящей блокировкой `ORDER BY token.id ASC FOR UPDATE` (включая `token.id = :tokenId` для исключения TOCTOU) отзываются все активные и беспричинные неистёкшие токены того же `familyId` с `UserSessionRevokedReason.UserSignOut`, сохраняя прежние `revokedReason`, серверную имперсонацию, единый `operationId`/`correlationId` и `SAVEPOINT refresh_revocation_audit`.
  - Введена строгая pre-SQL и пост-блокировочная валидация `workspaceId`, `isImpersonating`/`impersonatorUserWorkspaceId` и fail-closed обработка битого `familyId`; legacy-токены без `familyId` сохраняют однострочный отзыв.
- **Устранены все 3 гонки детерминированного `PK(id)` против `ON CONFLICT (...)` в PG 17**:
  - `admit-omni-human-text-command.ts:461` (`omni-human-text-command.postgres-spec.ts` полностью зелёный - устранён единственный сбой полного регресса `206/207`).
  - `omni-binding-config-wakeup.ts:378` (с fail-closed проверкой `OMNI_BINDING_CONFIG_WAKEUP_ENQUEUE_POSTCONDITION` и реальным тестом гонки `scannedCount === 1`).
  - `apply-omni-history-receipt.ts:506` (`omni-history-apply.postgres-spec.ts` полностью зелёный).

## Оставшиеся открытые границы ROB-765
1. **Сборка нового серверного кандидата (`LOG089`-`LOG213`) и сквозная HTTP/JWT приёмка + выкат**: текущий собранный изолированный кандидат - `LOG088`; все программные задачи фазы `ROB-765` без миграций БД закрыты.
2. **Архитектурные ограничения, требующие отдельного решения/миграции**: `UserSessionEntity` не хранит `familyId` (требует миграции БД), `ApplicationTokenService` выпускает stateless JWT без DB-отзыва, `UserSessionCleanupCronJob` ожидает утверждения политики хранения.
3. **Смежные этапы**: собственные права (`ROB-766`), просмотр и экспорт аудита (`ROB-767`), коннекторы/чаты (`ROB-768`), ИИ и workflow (`ROB-769`).

## Рекомендуемый следующий шаг
- Собрать новый изолированный серверный образ-кандидат (`LOG089`-`LOG213`) и выполнить сквозную HTTP/JWT приёмку `ROB-765` на Schrodinger (перед выкатом).
