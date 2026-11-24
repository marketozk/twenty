# LOG-212 - Защищённый административный health-эндпоинт `crmAuditHealth` и внешний alert sink `CrmAuditAlertSinkService`

- Дата: `2026-11-25`
- Задача: Linear `ROB-765` (Phase 2a, остаётся `In Progress`)
- Ветка: `codex/omnichannel-requirements`

## Изменённые и добавленные файлы кода и тестов
1. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-health.ts` - расширен `CrmAuditDatabaseHealthStatus` (`recentWindowMs`, `countsByCode`, `recentFailures` из единого пост-пробного снимка) и добавлена single-flight дедупликация параллельных `bypassCache: true` DB-проб (`inFlightBypassProbes` с сохранением `{ startedSeq, promise }` и независимым `cacheTtlMs` каждого вызывающего).
2. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-alert-sink.service.ts` (новый) - подключает внешний sink алертинга через `CrmAuditHealthService.registerAlertSink`: Sentry-канал через `ExceptionHandlerService` (только при `EXCEPTION_HANDLER_DRIVER=SENTRY` и `CRM_AUDIT_ALERT_SENTRY_ENABLED=true`, с `CrmAuditUnavailableError(record.code)` без дублирования консоли) и HTTP/HTTPS webhook-канал (`axios.post` + SSRF-safe агенты `createSsrfSafeAgent`, `maxRedirects: 0`, `transformRequest: [(data) => data]`, опциональная подпись HMAC-SHA256 `X-Twenty-Audit-Alert-Timestamp` / `X-Twenty-Audit-Alert-Signature`, независимый per-code cooldown с защитой от обратного шага часов `elapsedMs >= 0`, лимит `MAX_IN_FLIGHT_WEBHOOKS = 4`, санитизация логов без утечки URL/токенов/секретов/IP/тела ответа, запрет рекурсии и корректный `onModuleDestroy()` с `AbortController` и `.destroy()` агентов).
3. `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-health.module.ts` (новый) - изолированный NestJS-модуль без Enterprise-зависимостей, предоставляющий и экспортирующий `CrmAuditHealthService` и `CrmAuditAlertSinkService`.
4. `packages/twenty-server/src/engine/core-modules/admin-panel/dtos/crm-audit-health.dto.ts` (новый) - GraphQL-типы `CrmAuditHealthStatus`, `CrmAuditHealthInput`, `CrmAuditHealthDTO`, `CrmAuditAlertSinkStatusDTO`, `CrmAuditUnavailableCodeCountDTO` и `CrmAuditRecentFailureDTO` (без секретов, URL и PII).
5. `packages/twenty-server/src/engine/core-modules/admin-panel/admin-panel.resolver.ts` - добавлен защищённый GraphQL query `crmAuditHealth(bypassCache, recentWindowMs)` с method-level `@UseGuards(AuthPrincipalGuard({ userSession: { standard: true, impersonated: false, playground: false, workspaceAgnostic: false }, apiKey: false, oauthClient: false, application: false }), AdminPanelGuard)` без изменения `GET /healthz` и `HealthIndicatorId`.
6. `packages/twenty-server/src/engine/core-modules/admin-panel/admin-panel.module.ts` и `packages/twenty-server/src/engine/core-modules/core-engine.module.ts` - подключён `CrmAuditHealthModule` (работает при старте сервера и в админ-резолвере; NestJS дедуплицирует статический модуль).
7. `packages/twenty-server/src/engine/core-modules/twenty-config/config-variables.ts` - добавлены 5 env-only переменных `CRM_AUDIT_ALERT_SENTRY_ENABLED`, `CRM_AUDIT_ALERT_WEBHOOK_URL` (`isSensitive`, `isHiddenInAdminPanel`), `CRM_AUDIT_ALERT_WEBHOOK_SECRET` (`isSensitive`, `isHiddenInAdminPanel`), `CRM_AUDIT_ALERT_WEBHOOK_TIMEOUT_MS` и `CRM_AUDIT_ALERT_WEBHOOK_MIN_INTERVAL_MS` с безопасным `@Transform` для пустых строк env и явной документацией env-only SSRF-границы.
8. `packages/twenty-server/src/engine/guards/admin-panel-guard.ts` - добавлен fail-closed null-check `Boolean(request?.user)` перед `userIsFullAdmin(request.user)`.
9. `packages/twenty-server/test/fork-migration/crm-audit-admin-health-and-alert-sink.postgres-spec.ts` (новый) - 5 комплексных PG 17 + loopback `node:http` сценариев: метаданные и fail-closed поведение `AdminPanelGuard`/`AuthPrincipalGuard`, реальная PG 17 проба привилегий `ok -> degraded -> unavailable` + single-flight `bypassCache`, webhook HMAC-SHA256 + per-code cooldown + защита от обратного шага часов + `maxRedirects: 0` + запрет утечки секретов в логах + `onModuleDestroy()`, Sentry-канал без дублирования на `CONSOLE` и изоляция сбоя Sentry, SSRF-блокировка приватных IP по умолчанию + валидация `ConfigVariables` на пустых env-строках.

## Артефакты
- [design.md](design.md)
- [test-research.md](test-research.md)
- [design-review.md](design-review.md)
- [review.md](review.md)
- [results.json](results.json)
- [source-snapshot.json](source-snapshot.json)
- [next-boundary.md](next-boundary.md)
