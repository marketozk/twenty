# LOG-212: Design (Revised after Design Review)

## 1. Goal and boundary

`LOG-212` closes the remaining operational observability boundary of `ROB-765` (`design/08-audit.md:39`, `implementation-spec.md:169`, `log211/next-boundary.md` item 1) without DB migrations, without modifying `HealthIndicatorId` / `twenty-front`, and with **zero** new Enterprise dependency edges (`check_enterprise_dependencies.py --verify-baseline`):

1. **Unified consistent snapshot + single-flight bypass in `crm-audit-health.ts`**:
   - Extend `CrmAuditDatabaseHealthStatus` with `recentWindowMs`, `countsByCode`, and `recentFailures` populated from the **same** single `getCrmAuditHealthSnapshot(...)` captured after the DB probe (preventing torn reads between `status` and `recentFailures`, `M3`).
   - Add dedicated `inFlightBypassProbes = new WeakMap<DataSource, Promise<DatabaseProbeResult>>()` so concurrent `bypassCache: true` admin requests coalesce into one fresh read-only probe instead of amplifying DB connections (`M3`).

2. **Hardened `AdminPanelGuard` + `crmAuditHealth` query on existing `AdminPanelResolver`**:
   - Harden `AdminPanelGuard.canActivate` (`admin-panel-guard.ts`) to null-check `Boolean(request?.user)` before calling `userIsFullAdmin(request.user)` (`M4`).
   - Add `@Query(() => CrmAuditHealthDTO)` `crmAuditHealth(@Args() input?: CrmAuditHealthInput)` directly on existing `AdminPanelResolver` (`admin-panel.resolver.ts`, which already owns baseline edges to `AdminPanelGuard`, `AuthPrincipalGuard`, `ResolverValidationPipe`, `AuthGraphqlApiExceptionFilter` - zero new Enterprise edges, `B1`).
   - Method-level `@UseGuards`:
     ```ts
     @UseGuards(
       AuthPrincipalGuard({
         userSession: {
           standard: true,
           impersonated: false,
           playground: false,
           workspaceAgnostic: false,
         },
         apiKey: false,
         oauthClient: false,
         application: false,
       }),
       AdminPanelGuard,
     )
     ```
     Rejects impersonated tokens, API keys, OAuth clients, applications, playground, and non-full-admins cleanly (`M4`).
   - GraphQL DTOs in `packages/twenty-server/src/engine/core-modules/admin-panel/dtos/crm-audit-health.dto.ts` (imports ONLY `@nestjs/graphql` and `class-validator`, zero local enterprise-reachable imports, `B1`):
     - `CrmAuditHealthStatus` enum (`OK`, `DEGRADED`, `UNAVAILABLE`) registered via `registerEnumType`.
     - `@ArgsType() CrmAuditHealthInput`: `@Field(() => Boolean, { nullable: true }) @IsOptional() @IsBoolean() bypassCache?: boolean | null` and `@Field(() => Int, { nullable: true }) @IsOptional() @IsInt() @Min(0) @Max(86_400_000) recentWindowMs?: number | null`. Defaults applied in resolver (`input?.bypassCache ?? false`, `input?.recentWindowMs ?? undefined`) to handle raw `ResolverValidationPipe` output and explicit GraphQL `null` (`m7`).
     - `CrmAuditHealthDTO`: `status`, `databaseReachable`, `appendOnlyPrivilegesVerified`, `checkedAt`, `fromCache`, `totalUnavailableCount` (`Int`), `recentUnavailableCount` (`Int`), `hasRecentAuditLoss`, `recentWindowMs` (`Int`), `lastFailureCode` (`nullable: true`), `lastFailureAt` (`nullable: true`), `countsByCode: CrmAuditFailureCountDTO[]` (sorted by `code`), `recentFailures: CrmAuditUnavailableRecordDTO[]`, `alertSink: CrmAuditAlertSinkStatusDTO`.
   - `HealthController` (`GET /healthz`) stays strictly zero-IO liveness.

3. **Env-only `CRM_AUDIT_ALERT_*` configuration variables in `config-variables.ts`**:
   - Added under `ConfigVariablesGroup.LOGGING` with `isEnvOnly: true` (DB config tampering cannot redirect or disable audit alerts, no new imports in `config-variables.ts`, `B1`):
     - `CRM_AUDIT_ALERT_SENTRY_ENABLED: boolean = true` (`@CastToBoolean()`, `@IsOptional()`, `isEnvOnly: true`).
     - `CRM_AUDIT_ALERT_WEBHOOK_URL: string` (`@IsOptionalOrEmptyString()`, `@IsString()`, `isEnvOnly: true`, `isSensitive: true`, `isHiddenInAdminPanel: true`, `B2`, `M5`).
     - `CRM_AUDIT_ALERT_WEBHOOK_SECRET: string` (`@IsOptionalOrEmptyString()`, `@IsString()`, `isEnvOnly: true`, `isSensitive: true`, `isHiddenInAdminPanel: true`, `B2`, `M5`).
     - `CRM_AUDIT_ALERT_WEBHOOK_TIMEOUT_MS: number = 3000` (`@CastToPositiveNumber()`, `@IsOptional()`, `isEnvOnly: true`; empty/non-positive/NaN falls back to `3000` and clamps to `[500, 15_000]` in service, `B2`).
     - `CRM_AUDIT_ALERT_WEBHOOK_MIN_INTERVAL_MS: number = 30_000` (`@CastToPositiveNumber()`, `@IsOptional()`, `isEnvOnly: true`; clamped to `[0, 3_600_000]` in service, `B2`).

4. **External alert sink (`CrmAuditAlertSinkService`) and `CrmAuditHealthModule`**:
   - Zero Enterprise edges (`B1`): `crm-audit-alert-sink.service.ts` and `crm-audit-health.module.ts` import ONLY non-enterprise-reachable modules (`@nestjs/common`, `@nestjs/config` `ConfigService`, `node:crypto`, `axios`, `crm-audit-health.ts`, `exception-handler.service.ts`, `exception-handler/interfaces`, `secure-http-client/utils/create-ssrf-safe-agent.util.ts`, `secure-http-client/utils/normalize-allowed-internal-host.util.ts`, `secure-http-client/constants/allow-all-internal-hosts.constant.ts`, `secure-http-client/constants/outbound-http-default-max-payload-size-bytes.constant.ts`).
   - `CrmAuditHealthModule` provides and exports `CrmAuditHealthService` and `CrmAuditAlertSinkService`; imported in `CoreEngineModule` (auto-registered on server startup) and `AdminPanelModule`.
   - Lifecycle (`M6`):
     - `onModuleInit()` is idempotent (`if (this.unsubscribe) return;`), validates `CRM_AUDIT_ALERT_WEBHOOK_URL` once (strict `new URL(trimmed)` with `http:`/`https:`, logs a single sanitized `Logger.warn('CRM_AUDIT_ALERT_WEBHOOK_URL is invalid; webhook alerts disabled')` without printing the URL on invalid input), builds SSRF-safe `httpAgent`/`httpsAgent` via `createSsrfSafeAgent` (using env-only `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS` / `OUTBOUND_HTTP_SAFE_MODE_ENABLED`), and registers the sink.
     - `onModuleDestroy()` sets `this.destroyed = true`, calls `unsubscribe()`, aborts all `AbortController` instances tracked in `inFlightControllers`, and calls `.destroy()` on `httpAgent`/`httpsAgent` so no sockets or open handles hang shutdown/tests.
   - Independent per-`code` throttle maps (`sentryThrottleByCode`, `webhookThrottleByCode`, `M6`):
     - **Sentry channel**: active only when `CRM_AUDIT_ALERT_SENTRY_ENABLED === true` AND `EXCEPTION_HANDLER_DRIVER === ExceptionHandlerDriver.SENTRY` AND `exceptionHandlerService` is injected. Throws/constructs `CrmAuditUnavailableError` with `error.name = 'CrmAuditUnavailableError'` and `error.message = record.code` (`m8`, clean per-code Sentry grouping), passing sanitized `additionalData` (`event`, `code`, `occurredAt`, `operationId`, `attemptId`, `resourceKind`, `action`, `suppressedCount`). Wrapped in `try/catch`; never throws or recurses.
     - **Webhook channel**:
       - Checks `inFlightControllers.size >= MAX_IN_FLIGHT_WEBHOOKS` (`4`) **before** mutating `webhookThrottleByCode` (`M6`). When full, increments `webhookDroppedCount` without resetting cooldown or erasing `suppressedCountByCode[code]`.
       - Per-`code` cooldown (`minIntervalMs`): events within the window increment `suppressedCountByCode[code]` and monotonic `webhookSuppressedCount`.
       - Sends exact UTF-8 `rawBody` JSON with `transformRequest: [(data) => data]` (`m9`), `maxRedirects: 0` (`M5`), `maxContentLength`/`maxBodyLength` bounded, `timeout: timeoutMs`, and `signal: abortController.signal`.
       - When `CRM_AUDIT_ALERT_WEBHOOK_SECRET` is non-empty, sets `X-Twenty-Audit-Alert-Timestamp: <unixSeconds>` and `X-Twenty-Audit-Alert-Signature: sha256=<HMAC-SHA256(secret, "${timestamp}.${rawBody}")>`.
       - On delivery failure (network/timeout/non-2xx/3xx): if `!this.destroyed`, re-adds unsent `suppressedCount` back to `suppressedCountByCode[code]` (`M6`), increments `webhookDeliveryFailureCount`, updates `lastWebhookFailureAt`, logs sanitized `Logger.warn` with safe error code only (`HTTP_<status>` / `ECONNABORTED` / `ERR_CANCELED` / `DELIVERY_FAILED`, never URL/secret/response body/IP, `M5`), and never calls `reportCrmAuditUnavailable`.
       - On 2xx delivery: sets `lastWebhookDeliveredAt` and increments `webhookDeliveredCount`.

### Out of scope
- Changing `HealthController` (`GET /healthz`) or `HealthIndicatorId` enum / `twenty-front` UI.
- Adding DB-backed alert queues or PostgreSQL migrations.
- Session lifecycle architectural limits (`UserSession.familyId`, stateless application JWT) and `workflow` (`ROB-769`).
- Full server Docker image rebuild / production deploy.

## 2. Files to create / modify

| File | Action | Purpose |
|---|---|---|
| `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-health.ts` | Modify | Include `recentWindowMs`/`countsByCode`/`recentFailures` in `CrmAuditDatabaseHealthStatus` from the single post-probe snapshot; add `inFlightBypassProbes` single-flight coalescing |
| `packages/twenty-server/src/engine/guards/admin-panel-guard.ts` | Modify | Null-check `request?.user` before `userIsFullAdmin(request.user)` |
| `packages/twenty-server/src/engine/core-modules/twenty-config/config-variables.ts` | Modify | Add 5 env-only `CRM_AUDIT_ALERT_*` variables (`isHiddenInAdminPanel: true` + `isSensitive: true` on URL & secret; `@IsOptionalOrEmptyString()`) |
| `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-alert-sink.service.ts` | Create | `CrmAuditAlertSinkService` (Sentry + SSRF-safe HMAC-signed webhook, zero Enterprise edges, `maxRedirects: 0`, `transformRequest` passthrough, independent throttle maps, bounded concurrency, `AbortController` teardown) |
| `packages/twenty-server/src/engine/core-modules/crm-audit/crm-audit-health.module.ts` | Create | `CrmAuditHealthModule` exporting `CrmAuditHealthService` and `CrmAuditAlertSinkService` |
| `packages/twenty-server/src/engine/core-modules/admin-panel/dtos/crm-audit-health.dto.ts` | Create | GraphQL DTOs and `@ArgsType() CrmAuditHealthInput` (zero local enterprise-reachable imports) |
| `packages/twenty-server/src/engine/core-modules/admin-panel/admin-panel.resolver.ts` | Modify | Inject `CrmAuditHealthService` and `CrmAuditAlertSinkService`; add guarded `@Query(() => CrmAuditHealthDTO) crmAuditHealth` |
| `packages/twenty-server/src/engine/core-modules/admin-panel/admin-panel.module.ts` | Modify | Import `CrmAuditHealthModule` |
| `packages/twenty-server/src/engine/core-modules/core-engine.module.ts` | Modify | Import `CrmAuditHealthModule` |
| `packages/twenty-server/test/fork-migration/crm-audit-admin-health-and-alert-sink.postgres-spec.ts` | Create | Real PG 17 + local loopback HTTP server integration suite covering all guard, probe, single-flight, Sentry, HMAC webhook, redirect, throttling, concurrency, and teardown invariants |
