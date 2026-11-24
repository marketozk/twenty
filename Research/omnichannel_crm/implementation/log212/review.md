# LOG-212: Independent Code Review

## Verdict
`pass` (0 blockers; all actionable major and minor findings resolved and covered by tests; SSRF env-only boundary documented explicitly)

## Findings and resolutions

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | major | Empty `CRM_AUDIT_ALERT_WEBHOOK_MIN_INTERVAL_MS=""` and `CRM_AUDIT_ALERT_WEBHOOK_TIMEOUT_MS=""` coerced to `0` via `@CastToPositiveNumber()`, silently disabling alert throttling | Replaced `@CastToPositiveNumber()` on both fields with `@Transform` that preserves defaults (`3000` / `30_000`) on empty/whitespace/invalid input; asserted explicit default values in PG spec. |
| 2 | major | Empty `CRM_AUDIT_ALERT_SENTRY_ENABLED=""` failed `@IsBoolean()` validation during `validate()` and crashed server boot | Added `@Transform` before boolean coercion to convert empty/whitespace string to default `true`; added `CRM_AUDIT_ALERT_SENTRY_ENABLED: ''` regression test. |
| 3 | major | SSRF allowlist / safe mode read env-only `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS` via `ConfigService` instead of DB-overridable `TwentyConfigService` | Intentional security & Enterprise-boundary decision: audit alert SSRF rules remain env-only so DB-level tampering cannot weaken SSRF protection and `CrmAuditAlertSinkService` stays outside `runtime_enterprise_reachable` (`0` Enterprise edges). Documented explicitly in `config-variables.ts` description. |
| 4 | major | Backward wall-clock step (`nowMs < state.lastAcceptedAtMs`) produced negative `elapsedMs < minIntervalMs`, blacking out alerts until clock caught up | Added `elapsedMs >= 0` guard in both `dispatchToSentry` and `dispatchToWebhook` and added backward-clock regression test. |
| 5 | minor | Concurrency check ran before per-code throttle check, counting cooldown duplicates as `webhookDroppedCount` instead of `webhookSuppressedCount` | Reordered `dispatchToWebhook` to check cooldown first (without mutating `lastAcceptedAtMs` until concurrency passes), then check `inFlightControllers.size >= MAX_IN_FLIGHT_WEBHOOKS`. |
| 6 | minor | `parseBooleanConfig` and `parseAllowedInternalHosts` missed `'1'`/`'0'`/`'yes'`/`'no'`/`'on'`/`'off'`, JSON array strings, and post-normalization empty filter | Aligned both parsers with `configTransformers.boolean` and `SecureHttpClientService` normalization. |
| 7 | minor | Concurrent `bypassCache: true` coalescing inherited the first caller's `cacheTtlMs` (`0` prevented second caller with `5000` from caching) | Stored `{ startedSeq, promise }` in `inFlightProbes` / `inFlightBypassProbes` and let each caller apply its own `cacheTtlMs > 0` monotonic cache write after `await pending.promise`. |
