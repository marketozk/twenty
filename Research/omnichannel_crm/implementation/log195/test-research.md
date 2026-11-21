# LOG195 - Исследование и план тестов

## Существующие тесты
- В `packages/twenty-server/src/engine/core-modules/jwt/` отсутствуют юнит-тесты на `JwtKeyManagerService`.
- Смежные PG-тесты: `crm-audit-workspace-domain.postgres-spec.ts`.

## Обязательные реальные PostgreSQL-сценарии (`crm-audit-signing-key.postgres-spec.ts`)
1. **Отзыв ключа через `AdminPanelResolver.revokeSigningKey` -> `AdminPanelSigningKeyService` -> `JwtKeyManagerService`**:
   - Отзыв активного ключа с имперсонацией (`actor` + `initiator`): проверка `signingKey:update`, `values: { isCurrent: { before: true, after: false }, hasPrivateKey: { before: true, after: false } }`, `changedFields` содержит `revokedAt`, отсутствие PEM `publicKey` и `enc:v2:` `privateKey` в сериализованной записи аудита, пост-коммитная инвалидация `coreEntityCacheService`.
   - Повторный отзыв того же ключа возвращает сущность без создания новой записи аудита.
   - Отзыв несуществующего UUID бросает `SIGNING_KEY_NOT_FOUND` без записи аудита.
2. **Ротация ключа (`rotateCurrent`) с явным `auditIdentity` и системная ротация без `auditIdentity`**:
   - Явный вызов `rotateCurrent(auditIdentity)` в одной транзакции (единый `operationId`) деактивирует предыдущий ключ (`signingKey:update`, `isCurrent: true -> false`, `hasPrivateKey: true -> false`) и создаёт новый (`signingKey:create`, `isCurrent: false/null -> true`, `hasPrivateKey: true`), без утечки PEM/`enc:v2:`.
   - Системный вызов `rotateCurrent()` без `auditIdentity` выбирает активный `core.workspace` и фиксирует обе записи с `actor: { kind: 'system', id: 'jwt-key-manager:rotate-current' }`.
3. **Первичная ленивая генерация (`getCurrentSigningKey` -> `generateAndPersistCurrent`)**:
   - При пустой таблице `core."signingKey"` и наличии активного workspace фиксирует `signingKey:create` с `actor: { kind: 'system', id: 'jwt-key-manager:bootstrap-current' }`.
4. **Fail-closed без `auditIdentity` на `revokeSigningKey`**:
   - Вызов `revokeSigningKey(id)` без `auditIdentity` отклоняется до изменения `core."signingKey"` и без вызова `coreEntityCacheService.invalidate`.
5. **Откат транзакций при сбое `crm_audit` flush и при пост-flush дрейфе строки `core."signingKey"`**:
   - Триггер `BEFORE INSERT` на `crm_audit."crmAuditEntry"` откатывает и `revokeSigningKey`, и `rotateCurrent` (прежний ключ остаётся `isCurrent = true`, новый не вставляется, кэш не инвалидируется).
   - Триггер `AFTER INSERT` на `crm_audit."crmAuditEntry"`, меняющий `isCurrent` после `flush()`, откатывает транзакцию (`Signing key state changed during audit flush`).
