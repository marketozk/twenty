# LOG194 - Независимое ревью дизайна

## Вердикт
`pass` (блокеров не выявлено)

## Проверенные риски и граничные случаи
1. **Граница Enterprise (`enterprise-dependency-baseline.json`)**:
   - `usage-limit.service.ts` уже присутствует в baseline (из-за `usage-period.service.ts`). Импорт `workspace-domain-audit.ts` в `usage-limit.service.ts`, `usage-limit.resolver.ts` и `admin-panel-usage-limit.resolver.ts` не добавляет новых рёбер в Enterprise-достижимые модули, так как `workspace-domain-audit.ts` не импортирует ничего из `usage-limit/`.
2. **Точность `bigint` (`limitValue`, `burstValue`)**:
   - В PostgreSQL `limitValue` и `burstValue` имеют тип `bigint`. В `to_jsonb(ul)` Postgres сериализует их в JSON-числа/строки; в `projectUsageLimit` приводим их к канонической десятичной строке (или `null` для `burstValue`), чтобы не зависеть от потери точности > `2^53 - 1` и гарантировать стабильный `canonicalAuditJson`.
3. **TOCTOU-гонка и авторизация `isInstanceOverride` в `update` / `delete`**:
   - Блокировка целевой строки `FOR UPDATE` внутри транзакции перед проверкой `assertUsageLimitInstanceOverrideIsAllowed` и `assertUsageLimitDefaultOverrideIsAllowed` закрывает гонку, сохраняя прежние коды исключений (`LIMIT_INVALID`, `LIMIT_CONFLICT`).
4. **Серверный админ (`AdminPanelUsageLimitResolver`) в чужом `workspaceId`**:
   - При `context.req.workspace?.id === workspaceId` используется `roleAuditIdentityFromRequest(context.req)`, а при кросс-workspace администрировании - `{ workspaceId, actor: { kind: 'coreUser', id: actorUserId }, ...(impersonatorUserWorkspaceId ? { impersonatorUserWorkspaceId } : {}) }`, что проходит `resolveWorkspaceDomainOperation`.
5. **Кэш и Redis-счётчики после `COMMIT`**:
   - `workspaceCacheService.invalidateAndRecompute` и `dropCounter` выполняются только после успешного `COMMIT`; сбой аудита откатывает БД и не сбрасывает счётчики/кэш.
