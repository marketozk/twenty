# Следующая граница после LOG-212

## Что закрыто в LOG-212
- **Защищённый административный health-эндпоинт `AdminPanelResolver.crmAuditHealth`**:
  - Защищён method-level `@UseGuards(AuthPrincipalGuard({ userSession: { standard: true, impersonated: false, playground: false, workspaceAgnostic: false }, apiKey: false, oauthClient: false, application: false }), AdminPanelGuard)`.
  - `AdminPanelGuard` получил fail-closed null-check `Boolean(request?.user)`.
  - Возвращает единый пост-пробный снимок (`status`, `databaseReachable`, `appendOnlyPrivilegesVerified`, `checkedAt`, `fromCache`, `totalUnavailableCount`, `recentUnavailableCount`, `hasRecentAuditLoss`, `recentWindowMs`, `lastFailureCode`, `lastFailureAt`, `countsByCode`, `recentFailures`, `alertSink`) без секретов, URL и PII.
  - `GET /healthz` остался zero-IO liveness, `HealthIndicatorId` и `twenty-front` не затрагивались.
- **Конфигурируемый внешний alert sink (`CrmAuditAlertSinkService` + `CrmAuditHealthModule`)**:
  - Подключён при старте сервера (`CoreEngineModule`) и в `AdminPanelModule` без единого нового Enterprise-ребра (`violations: 0`).
  - Sentry-канал работает через `ExceptionHandlerService` только при `EXCEPTION_HANDLER_DRIVER=SENTRY` и `CRM_AUDIT_ALERT_SENTRY_ENABLED=true` с `CrmAuditUnavailableError(record.code)`.
  - Webhook-канал использует SSRF-safe агенты `createSsrfSafeAgent`, `maxRedirects: 0`, `transformRequest: [(data) => data]`, опциональную подпись HMAC-SHA256, независимый per-code cooldown с защитой от обратного шага часов, `MAX_IN_FLIGHT_WEBHOOKS = 4`, санитизированное логирование и чистое освобождение ресурсов в `onModuleDestroy()`.
  - 5 env-only переменных `CRM_AUDIT_ALERT_*` добавлены в `ConfigVariables` с безопасной обработкой пустых строк и `isSensitive: true, isHiddenInAdminPanel: true` для URL и секрета.

## Оставшиеся открытые границы ROB-765
1. **Архитектурные ограничения Session lifecycle**: `UserSessionEntity` не хранит `familyId`, `signOut({ refreshToken })` отзывает только предъявленный токен, `ApplicationTokenService` выпускает stateless JWT без DB-отзыва, `UserSessionCleanupCronJob` ожидает утверждения политики хранения.
2. **Предсуществующая гонка в `omni-human-text-command.postgres-spec.ts:668`**: `PK` vs `ON CONFLICT` в `admit-omni-human-text-command.ts` под PG 17 (вне контура `LOG-211`/`LOG-212`).
3. **Build / deployment / full HTTP/JWT acceptance**: сборка нового изолированного серверного кандидата (текущий - `LOG088`), полная сквозная HTTP/JWT приёмка накопленного покрытия `LOG089`-`LOG212` и выкат.
4. **Просмотр и экспорт аудита (`ROB-767`)** - после собственных прав (`ROB-766`).
5. **Workflow (`workflow`/`workflowVersion`/`workflowRun`/`workflowAutomatedTrigger`) и коннекторы/ИИ** - относятся к контурам `ROB-768`/`ROB-769`.

## Рекомендуемый следующий шаг
- Сборка нового изолированного серверного кандидата (`LOG089`-`LOG212`) и сквозная HTTP/JWT приёмка `ROB-765`, либо закрытие оставшихся границ `Session lifecycle` / `omni-human-text-command` по приоритету владельца.
