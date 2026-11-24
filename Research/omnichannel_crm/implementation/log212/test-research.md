# LOG-212: Test Research (Revised after Design Review)

## 1. Real paths to verify

1. **Protected `AdminPanelResolver.crmAuditHealth` + `AuthPrincipalGuard` + `AdminPanelGuard` + real PG 17 DB probe**:
   - Guard metadata on `AdminPanelResolver.crmAuditHealth` includes method-level `AuthPrincipalGuard` (`impersonated: false`, `playground: false`, `apiKey: false`, `oauthClient: false`, `application: false`) and `AdminPanelGuard`.
   - `AdminPanelGuard.canActivate`:
     - Allows non-impersonated `canAccessFullAdminPanel: true` user.
     - Denies ordinary user (`canAccessFullAdminPanel: false`).
     - Denies impersonated admin (`impersonationContext` set).
     - Returns `false` (no `TypeError`) on missing `request.user` / API key / application request.
   - Real PG 17 `CrmAuditHealthService.checkHealth` + `AdminPanelResolver.crmAuditHealth`:
     - Healthy append-only runtime role -> `status: OK`, `databaseReachable: true`, `appendOnlyPrivilegesVerified: true`, `fromCache: false` then `fromCache: true`.
     - Concurrent `bypassCache: true` calls coalesce via `inFlightBypassProbes` into a single DB probe.
     - Explicit GraphQL `null` inputs (`{ bypassCache: null, recentWindowMs: null }`) and omitted input default cleanly.
     - After `reportCrmAuditUnavailable(...)` -> consistent single-snapshot `status: DEGRADED`, `hasRecentAuditLoss: true`, `recentUnavailableCount === recentFailures.length`, sorted `countsByCode`, sanitized fields only; expired `recentWindowMs` returns `OK` with `recentFailures: []`.
     - Revoked/super-privileged role failing `verifyCrmAuditPrivileges` -> `status: UNAVAILABLE`, `databaseReachable: true`, `appendOnlyPrivilegesVerified: false`.
     - `alertSink` status never leaks `CRM_AUDIT_ALERT_WEBHOOK_URL` or `CRM_AUDIT_ALERT_WEBHOOK_SECRET`.
2. **External alert sink (`CrmAuditAlertSinkService`)**:
   - Lifecycle: `onModuleInit()` registers sink idempotently (double call registers only once); `onModuleDestroy()` unregisters sink, aborts in-flight webhooks, and destroys HTTP agents.
   - Sentry channel (`ExceptionHandlerService`):
     - Under `EXCEPTION_HANDLER_DRIVER === SENTRY` and `CRM_AUDIT_ALERT_SENTRY_ENABLED === true`, captures `CrmAuditUnavailableError` with `error.message === record.code` (clean per-code grouping) and sanitized `additionalData` + `workspace: { id }`.
     - Under `CONSOLE` driver or `CRM_AUDIT_ALERT_SENTRY_ENABLED === false`, does NOT call `ExceptionHandlerService.captureExceptions`.
     - Independent per-`code` throttling limits Sentry bursts and reports `suppressedCount` without coupling to webhook state.
     - Throw inside `ExceptionHandlerService` is swallowed without propagating or calling `reportCrmAuditUnavailable`.
   - Real HTTP webhook delivery (via `node:http` loopback server with `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS=127.0.0.1`):
     - Wire bytes match exact UTF-8 JSON (no Axios double-encoding), `Content-Type: application/json`, allowlisted fields only.
     - With `CRM_AUDIT_ALERT_WEBHOOK_SECRET`, verifies `X-Twenty-Audit-Alert-Timestamp` and `X-Twenty-Audit-Alert-Signature: sha256=<hmac>` byte-for-byte against raw request bytes.
     - `307`/`302` redirect is NOT followed (`maxRedirects: 0`) and counted as a delivery failure.
     - Per-`code` throttling suppresses rapid repeat events for same `code` (incrementing `webhookSuppressedCount`), allows distinct `code` concurrently, and reports `suppressedCount` once the interval elapses.
     - Bounded concurrency (`MAX_IN_FLIGHT_WEBHOOKS = 4`): 5th simultaneous in-flight request increments `webhookDroppedCount` without mutating cooldown or erasing `suppressedCount`.
     - HTTP 500 / network error increments `webhookDeliveryFailureCount`, preserves unsent `suppressedCount` for next attempt, sets `lastWebhookFailureAt`, logs no URL/secret, and NEVER calls `reportCrmAuditUnavailable`.
     - Invalid URL (`ftp://...` or malformed string) logs a single sanitized warning (no URL in log), sets `webhookConfigured: false`, and disables webhook delivery cleanly.
     - Empty string env vars (`CRM_AUDIT_ALERT_WEBHOOK_URL=""`, `CRM_AUDIT_ALERT_WEBHOOK_TIMEOUT_MS=""`) pass `ConfigVariables` validation without crashing boot.
3. **`HealthController` (`GET /healthz`)**:
   - Existing `health.controller.spec.ts` confirms zero-IO `health.check([])`.

## 2. Verification gates

- Targeted PG 17 suites on Schrodinger (`--cpus=3 --memory=10g --memory-swap=10g -e RAYON_NUM_THREADS=2`):
  - `test/fork-migration/crm-audit-admin-health-and-alert-sink.postgres-spec.ts`
  - `test/fork-migration/crm-audit-post-rollback-and-health.postgres-spec.ts`
- Targeted unit tests:
  - `src/engine/core-modules/health/controllers/__tests__/health.controller.spec.ts`
- Differential TypeScript typecheck on all modified/created files (`TYPECHECK_DIAGS=0`).
- Local guards:
  - `python -I -X utf8 scripts/omnichannel/check_enterprise_dependencies.py --verify-baseline`
  - `python -I -X utf8 scripts/omnichannel/check_fork_migration_sources.py`
  - `python -I -X utf8 -m unittest discover -s scripts/omnichannel -v`
- Independent code review + targeted & full CRM-audit PG 17 verification + `STAND_CLEAN` cleanup.
