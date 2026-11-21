# LOG194 - Транзакционный аудит жизненного цикла лимитов использования рабочего пространства (`usageLimit` в `core."usageLimit"`)

## Сводка изменений
- В `crm-audit.types.ts` и `crm-audit-transaction-context.ts`:
  - добавлен вид ресурса `'usageLimit'` с `ADMINISTRATIVE_ACTIONS.usageLimit = ['create', 'update', 'delete']`;
  - добавлен `CATALOG.usageLimit` с `values: ['resourceType', 'operationType', 'spenderType', 'spenderId', 'limitKind', 'periodCount', 'periodUnit', 'unit', 'limitValue', 'burstValue', 'isInstanceOverride']` и `redacted: []`.
- В `workspace-domain-audit.ts`:
  - добавлены `projectUsageLimit` (с канонической строковой проекцией `bigint`-колонок `limitValue` и `burstValue`), `runAuditedUsageLimitCreate`, `runAuditedUsageLimitUpdate` и `runAuditedUsageLimitDelete` с блокировками `core.workspace` (`FOR NO KEY UPDATE`) и `core."usageLimit"` (`FOR UPDATE`), fail-closed проверкой актора/имперсонации и пост-flush сверкой состояния БД.
- В `UsageLimitService`:
  - `create`, `update` и `delete` переведены на транзакционный аудит внутри `runAuditedUsageLimitCreate` / `Update` / `Delete` с проверкой свободности scope и `isInstanceOverride` под блокировками БД;
  - инвалидация кэша `workspaceCacheService.invalidateAndRecompute(..., ['usageLimits'])` и сброс счётчиков `dropCounter(...)` выполняются строго после успешного `COMMIT`.
- В `UsageLimitResolver` и `AdminPanelUsageLimitResolver`:
  - проброшен `auditIdentity` во все мутации (`createUsageLimit`, `updateUsageLimit`, `deleteUsageLimit`, `createWorkspaceUsageLimit`, `updateWorkspaceUsageLimit`, `deleteWorkspaceUsageLimit`), включая кросс-workspace управление серверного админа с сохранением `initiator` при имперсонации.
- В тестах `fork-migration`:
  - добавлен реальный PostgreSQL-спек [crm-audit-usage-limit.postgres-spec.ts](../../../../packages/twenty-server/test/fork-migration/crm-audit-usage-limit.postgres-spec.ts) (5 сценариев).

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
