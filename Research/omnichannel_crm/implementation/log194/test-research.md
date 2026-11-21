# LOG194 - Исследование и план тестов

## Существующие тесты
- В `packages/twenty-server/src/engine/core-modules/usage-limit/` 48 юнит-тестов на утилиты и фильтры; прямых вызовов `new UsageLimitService` нет.
- Смежные PG-тесты: `crm-audit-workspace-domain.postgres-spec.ts`.

## Обязательные реальные PostgreSQL-сценарии (`crm-audit-usage-limit.postgres-spec.ts`)
1. **Полный жизненный цикл через `UsageLimitResolver` (`isOperator: false`)**:
   - `createUsageLimit`, `updateUsageLimit` и `deleteUsageLimit` с имперсонацией (`actor` + `initiator`), проверкой всех полей `values`, `securityDescriptor`, повторного `deleteUsageLimit` -> `false` без лишней записи, а также порядка пост-коммитной инвалидации кэша и `dropCounter`.
2. **Операторское управление через `AdminPanelUsageLimitResolver` (`isOperator: true`) для чужого `workspaceId`**:
   - `createWorkspaceUsageLimit`, `updateWorkspaceUsageLimit` (`isInstanceOverride: true`, включая `bigint`-значение) и `deleteWorkspaceUsageLimit` из сессии админа в другом рабочем пространстве; проверка корректного `actor`, `initiator` при имперсонации и `workspaceId` в `crm_audit."crmAuditEntry"`.
3. **Запрет редактирования/удаления `isInstanceOverride: true` обычным пользователем и валидация `scope`**:
   - Попытка изменить/удалить операторский лимит через `UsageLimitResolver` (`isOperator: false`) или создать дубликат scope отклоняется с `UsageLimitException` без записи в аудит и без изменения БД.
4. **Fail-closed без `auditIdentity` и кросс-workspace изоляция**:
   - `create`, `update`, `delete` без `auditIdentity` отклоняются без изменения `core."usageLimit"` и без вызова `invalidateAndRecompute`/`dropCounter`.
   - Попытка обновить или удалить `usageLimit` чужого `workspaceId` не трогает чужую строку и не пишет ложный аудит.
5. **Откат при сбое `crm_audit` flush и при пост-flush дрейфе строки `core."usageLimit"`**:
   - Триггер `BEFORE INSERT` на `crm_audit."crmAuditEntry"` откатывает `create`, `update` и `delete` без вызова пост-коммитных эффектов.
   - Триггер `AFTER INSERT` на `crm_audit."crmAuditEntry"`, меняющий `limitValue` после `flush()`, откатывает `create` и `update` (`Usage limit state changed during audit flush`).
