# LOG195 - Транзакционный аудит управления ключами подписи JWT (`signingKey` в `core."signingKey"`)

## Сводка изменений
- В `crm-audit.types.ts` и `crm-audit-transaction-context.ts`:
  - добавлен вид ресурса `'signingKey'` с `ADMINISTRATIVE_ACTIONS.signingKey = ['create', 'update']`;
  - добавлен `CATALOG.signingKey` с `values: ['isCurrent', 'hasPrivateKey']` и `redacted: ['publicKey', 'privateKey', 'revokedAt']`.
- В `workspace-domain-audit.ts`:
  - добавлены `projectSigningKey`, `runAuditedSigningKeyRevoke`, `runAuditedSigningKeyRotate` и `runAuditedSigningKeyBootstrapCreate` с блокировками `core.workspace` (`FOR NO KEY UPDATE`) и `core."signingKey"` (`FOR UPDATE`), fail-closed проверкой актора/имперсонации при отзыве, единым `operationId` при ротации (деактивация прежнего ключа `update` + создание нового `create`), системной атрибуцией для фоновой ротации и первичной генерации, а также пост-flush сверкой состояния БД.
- В `JwtKeyManagerService`:
  - `revokeSigningKey` переведён на `runAuditedSigningKeyRevoke` (fail-closed без `auditIdentity`, идемпотентность при повторном отзыве, пост-коммитная инвалидация кэшей);
  - `rotateCurrent` переведён на `runAuditedSigningKeyRotate` (поддерживает явный `auditIdentity` и системную ротацию без `auditIdentity`);
  - `generateAndPersistCurrent` переведён на `runAuditedSigningKeyBootstrapCreate`.
- В `AdminPanelSigningKeyService.revokeSigningKey` и `AdminPanelResolver.revokeSigningKey`:
  - проброшен `auditIdentity` (включая `impersonationContext`) из запроса серверного администратора.
- В тестах `fork-migration`:
  - добавлен реальный PostgreSQL-спек [crm-audit-signing-key.postgres-spec.ts](../../../../packages/twenty-server/test/fork-migration/crm-audit-signing-key.postgres-spec.ts) (5 сценариев).

## Артефакты
- [Дизайн](design.md)
- [Ревью дизайна](design-review.md)
- [Исследование тестов](test-research.md)
- [Ревью кода](review.md)
- [Результаты проверок](results.json)
- [Дифференциальный typecheck](typecheck-differential.json)
- [Снимок исходников](source-snapshot.json)
- [Лог регрессии](regression.log)
- [Следующая граница](next-boundary.md)
