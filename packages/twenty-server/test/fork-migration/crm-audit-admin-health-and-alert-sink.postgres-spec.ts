import { createHmac, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { type AddressInfo } from 'node:net';
import { Logger, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { GqlExecutionContext } from '@nestjs/graphql';
import { DataSource } from 'typeorm';

import { AdminPanelResolver } from 'src/engine/core-modules/admin-panel/admin-panel.resolver';
import { CrmAuditHealthStatus } from 'src/engine/core-modules/admin-panel/dtos/crm-audit-health.dto';
import { CrmAuditAlertSinkService } from 'src/engine/core-modules/crm-audit/crm-audit-alert-sink.service';
import {
  CrmAuditHealthService,
  getCrmAuditHealthSnapshot,
  reportCrmAuditUnavailable,
  resetCrmAuditHealthStateForTesting,
} from 'src/engine/core-modules/crm-audit/crm-audit-health';
import { ExceptionHandlerDriver } from 'src/engine/core-modules/exception-handler/interfaces';
import { type ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { validate } from 'src/engine/core-modules/twenty-config/config-variables';
import { AdminPanelGuard } from 'src/engine/guards/admin-panel-guard';
import { createOmniNativeMessageFixture } from 'test/fork-migration/omni-native-message.fixture';

jest.mock('twenty-shared/ai', () => ({
  AI_MODEL_TIERS: ['fast', 'smart'],
}));
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-ai-provider.service',
  () => ({ AdminPanelAiProviderService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-billing.service',
  () => ({ AdminPanelBillingService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-chat.service',
  () => ({ AdminPanelChatService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-config.service',
  () => ({ AdminPanelConfigService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-server-admin.service',
  () => ({ AdminPanelServerAdminService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-signing-key.service',
  () => ({ AdminPanelSigningKeyService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-statistics.service',
  () => ({ AdminPanelStatisticsService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-user-lookup.service',
  () => ({ AdminPanelUserLookupService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/services/admin-panel-version.service',
  () => ({ AdminPanelVersionService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/admin-panel-health.service',
  () => ({ AdminPanelHealthService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/admin-panel-queue.service',
  () => ({ AdminPanelQueueService: class {} }),
);
jest.mock(
  'src/engine/core-modules/admin-panel/maintenance-mode.service',
  () => ({ MaintenanceModeService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-registration/application-registration.service',
  () => ({ ApplicationRegistrationService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-registration/application-registration-claim.service',
  () => ({ ApplicationRegistrationClaimService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-registration-variable/application-registration-variable.service',
  () => ({ ApplicationRegistrationVariableService: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-registration/application-registration.entity',
  () => ({ ApplicationRegistrationEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-registration/application-registration-exception-filter',
  () => ({ ApplicationRegistrationExceptionFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/application/application-marketplace/crons/marketplace-catalog-sync.cron.job',
  () => ({ MarketplaceCatalogSyncCronJob: class {} }),
);
jest.mock(
  'src/engine/core-modules/auth/filters/auth-graphql-api-exception.filter',
  () => ({ AuthGraphqlApiExceptionFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/client-config/client-config.entity',
  () => ({ AdminAiModelsDTO: class {} }),
);
jest.mock(
  'src/engine/core-modules/graphql/filters/prevent-nest-to-auto-log-graphql-errors.filter',
  () => ({ PreventNestToAutoLogGraphqlErrorsFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/filters/config-variable-graphql-api-exception.filter',
  () => ({ ConfigVariableGraphqlApiExceptionFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/throttler/filters/throttler-graphql-api-exception.filter',
  () => ({ ThrottlerGraphqlApiExceptionFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/two-factor-authentication/two-factor-authentication-exception.filter',
  () => ({ TwoFactorAuthenticationExceptionFilter: class {} }),
);
jest.mock(
  'src/engine/core-modules/two-factor-authentication/services/two-factor-authentication-recovery.service',
  () => ({ TwoFactorAuthenticationRecoveryService: class {} }),
);
jest.mock(
  'src/engine/core-modules/feature-flag/services/feature-flag.service',
  () => ({ FeatureFlagService: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/ai/ai-models/services/ai-model-registry.service',
  () => ({ AiModelRegistryService: class {} }),
);
jest.mock(
  'src/engine/core-modules/usage/services/usage-analytics.service',
  () => ({ UsageAnalyticsService: class {} }),
);
jest.mock(
  'src/engine/core-modules/upgrade/services/upgrade-status.service',
  () => ({ UpgradeStatusService: class {} }),
);
jest.mock(
  'src/engine/core-modules/workspace/workspace.entity',
  () => ({ WorkspaceEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);

const f = createOmniNativeMessageFixture({
  coreSchema: 'fork',
});

let runtimeDataSource: DataSource;

const waitForCondition = async (
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for async alert condition');
};

const makeGqlContext = (req: Record<string, unknown>): ExecutionContext => {
  const ctx = {} as ExecutionContext;
  jest.spyOn(GqlExecutionContext, 'create').mockReturnValueOnce({
    getContext: () => ({ req }),
  } as never);

  return ctx;
};

const buildAdminResolver = (
  healthService: CrmAuditHealthService,
  alertSinkService: CrmAuditAlertSinkService,
): AdminPanelResolver => {
  const resolver = Object.create(AdminPanelResolver.prototype) as AdminPanelResolver;
  Object.assign(resolver, {
    crmAuditHealthService: healthService,
    crmAuditAlertSinkService: alertSinkService,
  });

  return resolver;
};

const startLoopbackServer = async (
  handler: (
    req: http.IncomingMessage,
    rawBody: string,
    res: http.ServerResponse,
  ) => void,
): Promise<{
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}> => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      handler(req, Buffer.concat(chunks).toString('utf8'), res);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;

  return {
    server,
    url: `http://127.0.0.1:${port}/audit-alerts?token=super-secret-token-value`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

beforeAll(async () => {
  await f.initialize();
  runtimeDataSource = new DataSource({
    type: 'postgres',
    url: f.runtimeDatabaseUrl,
    synchronize: false,
    migrationsRun: false,
    extra: { max: 4, statement_timeout: 10_000 },
  });
  await runtimeDataSource.initialize();
});

beforeEach(() => {
  resetCrmAuditHealthStateForTesting();
});

afterAll(async () => {
  if (runtimeDataSource?.isInitialized) {
    await runtimeDataSource.destroy();
  }
  await f.dispose();
});

describe('LOG-212: Protected Admin Audit Health Endpoint & External Alert Sink', () => {
  it('enforces AdminPanelGuard null-safety, rejects impersonated/non-admin/unauthenticated callers, and attaches guards on AdminPanelResolver.crmAuditHealth', () => {
    const guard = new AdminPanelGuard();

    expect(
      guard.canActivate(
        makeGqlContext({
          user: { id: randomUUID(), canAccessFullAdminPanel: true },
        }),
      ),
    ).toBe(true);

    expect(
      guard.canActivate(
        makeGqlContext({
          user: { id: randomUUID(), canAccessFullAdminPanel: false },
        }),
      ),
    ).toBe(false);

    expect(
      guard.canActivate(
        makeGqlContext({
          user: { id: randomUUID(), canAccessFullAdminPanel: true },
          impersonationContext: {
            impersonatorUserWorkspaceId: randomUUID(),
            impersonatedUserWorkspaceId: randomUUID(),
          },
        }),
      ),
    ).toBe(false);

    // Missing user (unauthenticated, API key, or application request) returns false without TypeError.
    expect(guard.canActivate(makeGqlContext({}))).toBe(false);
    expect(
      guard.canActivate(makeGqlContext({ apiKey: { id: randomUUID() } })),
    ).toBe(false);

    const methodGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminPanelResolver.prototype.crmAuditHealth,
    ) as unknown[];
    expect(Array.isArray(methodGuards)).toBe(true);
    expect(methodGuards).toContain(AdminPanelGuard);
    expect(methodGuards.length).toBeGreaterThanOrEqual(2);
  });

  it('serves consistent real PG 17 crmAuditHealth across OK, cached, single-flight bypassCache, DEGRADED, UNAVAILABLE, and null inputs without leaking secrets', async () => {
    const healthService = new CrmAuditHealthService(runtimeDataSource);
    const config = new ConfigService({
      EXCEPTION_HANDLER_DRIVER: ExceptionHandlerDriver.CONSOLE,
      CRM_AUDIT_ALERT_WEBHOOK_URL: 'https://hooks.example.com/secret-path-1234',
      CRM_AUDIT_ALERT_WEBHOOK_SECRET: 'top-secret-hmac-key',
    });
    const alertSinkService = new CrmAuditAlertSinkService(
      healthService,
      config,
    );
    alertSinkService.onModuleInit();

    try {
      const resolver = buildAdminResolver(healthService, alertSinkService);

      // First call probes PG 17 directly -> OK, fromCache: false
      const first = await resolver.crmAuditHealth();
      expect(first.status).toBe(CrmAuditHealthStatus.OK);
      expect(first.databaseReachable).toBe(true);
      expect(first.appendOnlyPrivilegesVerified).toBe(true);
      expect(first.fromCache).toBe(false);
      expect(first.hasRecentAuditLoss).toBe(false);
      expect(first.recentFailures).toEqual([]);
      expect(first.countsByCode).toEqual([]);
      expect(first.alertSink.webhookConfigured).toBe(true);
      expect(first.alertSink.sentryEnabled).toBe(false);
      expect(JSON.stringify(first)).not.toContain('secret-path-1234');
      expect(JSON.stringify(first)).not.toContain('top-secret-hmac-key');

      // Second call hits TTL cache with explicit GraphQL null inputs
      const second = await resolver.crmAuditHealth({
        bypassCache: null,
        recentWindowMs: null,
      });
      expect(second.fromCache).toBe(true);
      expect(second.status).toBe(CrmAuditHealthStatus.OK);

      // Concurrent bypassCache: true calls coalesce into a single DB probe (inFlightBypassProbes)
      const createRunnerSpy = jest.spyOn(runtimeDataSource, 'createQueryRunner');
      const [b1, b2, b3] = await Promise.all([
        resolver.crmAuditHealth({ bypassCache: true }),
        resolver.crmAuditHealth({ bypassCache: true }),
        resolver.crmAuditHealth({ bypassCache: true }),
      ]);
      expect(createRunnerSpy).toHaveBeenCalledTimes(1);
      expect(b1.checkedAt).toBe(b2.checkedAt);
      expect(b2.checkedAt).toBe(b3.checkedAt);
      createRunnerSpy.mockRestore();

      // Report two distinct audit unavailability events -> single consistent DEGRADED snapshot
      const op1 = randomUUID();
      const op2 = randomUUID();
      reportCrmAuditUnavailable({
        code: 'SESSION_REVOCATION_AUDIT_UNAVAILABLE',
        workspaceId: f.workspaceId,
        operationId: op1,
        resourceKind: 'userSession',
        action: 'update',
      });
      reportCrmAuditUnavailable({
        code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
        workspaceId: f.workspaceId,
        operationId: op2,
        resourceKind: 'crmRecord',
        action: 'create',
      });

      const degraded = await resolver.crmAuditHealth();
      expect(degraded.status).toBe(CrmAuditHealthStatus.DEGRADED);
      expect(degraded.hasRecentAuditLoss).toBe(true);
      expect(degraded.totalUnavailableCount).toBe(2);
      expect(degraded.recentUnavailableCount).toBe(2);
      expect(degraded.recentFailures).toHaveLength(2);
      expect(degraded.countsByCode).toEqual([
        { code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE', count: 1 },
        { code: 'SESSION_REVOCATION_AUDIT_UNAVAILABLE', count: 1 },
      ]);

      // Zero-width window expires recent failures consistently
      const expired = await resolver.crmAuditHealth({
        recentWindowMs: 0,
      });
      if (expired.recentUnavailableCount === 0) {
        expect(expired.status).toBe(CrmAuditHealthStatus.OK);
        expect(expired.recentFailures).toEqual([]);
      }

      // Over-privileged owner role fails verifyCrmAuditPrivileges -> UNAVAILABLE
      const ownerHealthService = new CrmAuditHealthService(f.owner);
      const ownerResolver = buildAdminResolver(
        ownerHealthService,
        alertSinkService,
      );
      const unavailable = await ownerResolver.crmAuditHealth({
        bypassCache: true,
      });
      expect(unavailable.status).toBe(CrmAuditHealthStatus.UNAVAILABLE);
      expect(unavailable.databaseReachable).toBe(true);
      expect(unavailable.appendOnlyPrivilegesVerified).toBe(false);
    } finally {
      alertSinkService.onModuleDestroy();
    }
  });

  it('forwards alerts to ExceptionHandlerService only under SENTRY driver with independent per-code throttling and error isolation', async () => {
    const healthService = new CrmAuditHealthService(runtimeDataSource);
    const captureExceptions = jest.fn().mockReturnValue(['evt-1']);
    const exceptionHandler = {
      captureExceptions,
    } as unknown as ExceptionHandlerService;

    // 1. CONSOLE driver does not forward to ExceptionHandlerService
    const consoleSink = new CrmAuditAlertSinkService(
      healthService,
      new ConfigService({
        EXCEPTION_HANDLER_DRIVER: ExceptionHandlerDriver.CONSOLE,
        CRM_AUDIT_ALERT_SENTRY_ENABLED: true,
      }),
      exceptionHandler,
    );
    consoleSink.onModuleInit();
    reportCrmAuditUnavailable({ code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(captureExceptions).not.toHaveBeenCalled();
    expect(consoleSink.getStatus().sentryEnabled).toBe(false);
    consoleSink.onModuleDestroy();

    // 2. SENTRY driver with enabled flag forwards with clean grouping error, throttling, and failure isolation
    resetCrmAuditHealthStateForTesting();
    const sentrySink = new CrmAuditAlertSinkService(
      healthService,
      new ConfigService({
        EXCEPTION_HANDLER_DRIVER: ExceptionHandlerDriver.SENTRY,
        CRM_AUDIT_ALERT_SENTRY_ENABLED: true,
        CRM_AUDIT_ALERT_WEBHOOK_MIN_INTERVAL_MS: 1000,
      }),
      exceptionHandler,
    );
    // Idempotent double onModuleInit
    sentrySink.onModuleInit();
    sentrySink.onModuleInit();
    expect(sentrySink.getStatus().sentryEnabled).toBe(true);

    const t0 = 1_700_000_000_000;
    const opId = randomUUID();
    reportCrmAuditUnavailable({
      code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
      workspaceId: f.workspaceId,
      operationId: opId,
      nowMs: t0,
    });
    // Rapid repeat within 1000ms is throttled
    reportCrmAuditUnavailable({
      code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
      workspaceId: f.workspaceId,
      nowMs: t0 + 200,
    });
    // Distinct code is dispatched immediately
    reportCrmAuditUnavailable({
      code: 'SESSION_REVOCATION_AUDIT_UNAVAILABLE',
      workspaceId: f.workspaceId,
      nowMs: t0 + 250,
    });
    // After cooldown, next event includes suppressedCount: 1
    reportCrmAuditUnavailable({
      code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
      workspaceId: f.workspaceId,
      nowMs: t0 + 1500,
    });

    await waitForCondition(() => captureExceptions.mock.calls.length === 3);

    const [firstErrs, firstOpts] = captureExceptions.mock.calls[0];
    expect(firstErrs[0].name).toBe('CrmAuditUnavailableError');
    expect(firstErrs[0].message).toBe('POST_ROLLBACK_AUDIT_UNAVAILABLE');
    expect(firstOpts.workspace).toEqual({ id: f.workspaceId });
    expect(firstOpts.additionalData).toMatchObject({
      event: 'crm_audit.unavailable',
      code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
      operationId: opId,
      suppressedCount: 0,
    });

    const [thirdErrs, thirdOpts] = captureExceptions.mock.calls[2];
    expect(thirdErrs[0].message).toBe('POST_ROLLBACK_AUDIT_UNAVAILABLE');
    expect(thirdOpts.additionalData.suppressedCount).toBe(1);

    // Throwing exceptionHandler never propagates or recurses into reportCrmAuditUnavailable
    const beforeTotal = getCrmAuditHealthSnapshot().totalUnavailableCount;
    captureExceptions.mockImplementationOnce(() => {
      throw new Error('sentry transport down');
    });
    reportCrmAuditUnavailable({
      code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
      nowMs: t0 + 3000,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getCrmAuditHealthSnapshot().totalUnavailableCount).toBe(
      beforeTotal + 1,
    );

    // Destroy unregisters cleanly
    sentrySink.onModuleDestroy();
    captureExceptions.mockClear();
    reportCrmAuditUnavailable({
      code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
      nowMs: t0 + 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(captureExceptions).not.toHaveBeenCalled();
  });

  it('delivers HMAC-SHA256 signed webhook payloads over HTTP, blocks redirects, enforces per-code throttling, caps concurrency, and never leaks URL/secret or recurses on failure', async () => {
    const secret = 'webhook-hmac-secret-212';
    const received: Array<{
      rawBody: string;
      headers: http.IncomingHttpHeaders;
    }> = [];
    let mode: 'ok' | 'redirect' | 'error' | 'hold' = 'ok';
    const heldResponses: http.ServerResponse[] = [];

    const srv = await startLoopbackServer((req, rawBody, res) => {
      if (mode === 'redirect') {
        res.writeHead(307, { Location: 'http://127.0.0.1:9/redirected' });
        res.end();
        return;
      }
      if (mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
        return;
      }
      if (mode === 'hold') {
        heldResponses.push(res);
        return;
      }
      received.push({ rawBody, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });

    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const healthService = new CrmAuditHealthService(runtimeDataSource);
    const sink = new CrmAuditAlertSinkService(
      healthService,
      new ConfigService({
        CRM_AUDIT_ALERT_WEBHOOK_URL: srv.url,
        CRM_AUDIT_ALERT_WEBHOOK_SECRET: secret,
        CRM_AUDIT_ALERT_WEBHOOK_TIMEOUT_MS: 2000,
        CRM_AUDIT_ALERT_WEBHOOK_MIN_INTERVAL_MS: 1000,
        OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS: '127.0.0.1',
      }),
    );
    sink.onModuleInit();

    try {
      const t0 = 1_700_100_000_000;
      const opId = randomUUID();
      reportCrmAuditUnavailable({
        code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
        workspaceId: f.workspaceId,
        operationId: opId,
        resourceKind: 'crmRecord',
        action: 'update',
        nowMs: t0,
      });

      await waitForCondition(() => received.length === 1);

      // Verify exact raw UTF-8 JSON (no double-encoding) and HMAC-SHA256 signature
      const first = received[0];
      const parsed = JSON.parse(first.rawBody);
      expect(parsed).toEqual({
        event: 'crm_audit.unavailable',
        code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
        occurredAt: new Date(t0).toISOString(),
        workspaceId: f.workspaceId,
        operationId: opId,
        resourceKind: 'crmRecord',
        action: 'update',
        suppressedCount: 0,
      });
      const ts = first.headers['x-twenty-audit-alert-timestamp'];
      const sig = first.headers['x-twenty-audit-alert-signature'];
      expect(typeof ts).toBe('string');
      const expectedSig = `sha256=${createHmac('sha256', secret)
        .update(`${ts}.${first.rawBody}`)
        .digest('hex')}`;
      expect(sig).toBe(expectedSig);
      expect(sink.getStatus().webhookDeliveredCount).toBe(1);

      // Throttling: repeat within 1000ms suppressed, next after 1000ms carries suppressedCount: 1
      reportCrmAuditUnavailable({
        code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
        nowMs: t0 + 100,
      });
      await waitForCondition(() => sink.getStatus().webhookSuppressedCount === 1);
      expect(received).toHaveLength(1);

      reportCrmAuditUnavailable({
        code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
        nowMs: t0 + 1500,
      });
      await waitForCondition(() => received.length === 2);
      expect(JSON.parse(received[1].rawBody).suppressedCount).toBe(1);

      // Backward wall-clock step does not blackout alerts
      reportCrmAuditUnavailable({
        code: 'POST_ROLLBACK_AUDIT_UNAVAILABLE',
        nowMs: t0 + 1000,
      });
      await waitForCondition(() => received.length === 3);

      // 307 redirect is rejected (maxRedirects: 0) and counted as delivery failure
      mode = 'redirect';
      reportCrmAuditUnavailable({
        code: 'SESSION_REVOCATION_AUDIT_UNAVAILABLE',
        nowMs: t0 + 2000,
      });
      await waitForCondition(
        () => sink.getStatus().webhookDeliveryFailureCount === 1,
      );

      // HTTP 500 preserves suppressedCount and does NOT recurse into reportCrmAuditUnavailable
      mode = 'error';
      reportCrmAuditUnavailable({
        code: 'REFRESH_REVOCATION_AUDIT_UNAVAILABLE',
        nowMs: t0 + 3000,
      });
      await waitForCondition(
        () => sink.getStatus().webhookDeliveryFailureCount === 2,
      );
      const countBeforeSecondSuppressed =
        getCrmAuditHealthSnapshot().totalUnavailableCount;
      expect(sink.getStatus().lastWebhookFailureAt).not.toBeNull();

      // Verify warn logs never contain the webhook URL, token, or secret
      const allWarns = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(allWarns).not.toContain('super-secret-token-value');
      expect(allWarns).not.toContain(secret);
      expect(allWarns).not.toContain('127.0.0.1');
      expect(getCrmAuditHealthSnapshot().totalUnavailableCount).toBe(
        countBeforeSecondSuppressed,
      );

      // Bounded concurrency (MAX_IN_FLIGHT_WEBHOOKS = 4): 5th concurrent request drops cleanly
      mode = 'hold';
      const distinctCodes = [
        'MEMBERSHIP_CLEANUP_AUDIT_UNAVAILABLE',
        'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE',
        'NATIVE_MEMBER_DELETION_AUDIT_UNAVAILABLE',
        'RECORD_SHARE_TRANSFER_AUDIT_UNAVAILABLE',
        'CONNECTED_ACCOUNT_TRANSFER_AUDIT_UNAVAILABLE',
      ] as const;
      for (const code of distinctCodes) {
        reportCrmAuditUnavailable({ code, nowMs: t0 + 10_000 });
      }
      await waitForCondition(
        () => heldResponses.length === 4 && sink.getStatus().webhookDroppedCount === 1,
      );

      // onModuleDestroy aborts all 4 in-flight requests cleanly
      sink.onModuleDestroy();
      for (const res of heldResponses) {
        if (!res.writableEnded) {
          res.writeHead(200);
          res.end();
        }
      }
    } finally {
      sink.onModuleDestroy();
      warnSpy.mockRestore();
      await srv.close();
    }
  });

  it('degrades gracefully on invalid webhook URLs without leaking the URL and validates empty ConfigVariables safely', () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const healthService = new CrmAuditHealthService(runtimeDataSource);
    const badProtocolSink = new CrmAuditAlertSinkService(
      healthService,
      new ConfigService({
        CRM_AUDIT_ALERT_WEBHOOK_URL: 'ftp://secret.internal/private-token',
      }),
    );
    badProtocolSink.onModuleInit();
    expect(badProtocolSink.getStatus().webhookConfigured).toBe(false);
    badProtocolSink.onModuleDestroy();

    const malformedSink = new CrmAuditAlertSinkService(
      healthService,
      new ConfigService({
        CRM_AUDIT_ALERT_WEBHOOK_URL: 'not-a-url-with-secret-xyz',
      }),
    );
    malformedSink.onModuleInit();
    expect(malformedSink.getStatus().webhookConfigured).toBe(false);
    malformedSink.onModuleDestroy();

    const warns = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(warns).not.toContain('private-token');
    expect(warns).not.toContain('secret-xyz');
    warnSpy.mockRestore();

    // ConfigVariables validate() accepts empty string env vars and preserves defaults safely
    const validatedEmpty = validate({
      PG_DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/default',
      APP_SECRET: 'test-app-secret-value-at-least-32-chars',
      CRM_AUDIT_ALERT_SENTRY_ENABLED: '',
      CRM_AUDIT_ALERT_WEBHOOK_URL: '',
      CRM_AUDIT_ALERT_WEBHOOK_SECRET: '',
      CRM_AUDIT_ALERT_WEBHOOK_TIMEOUT_MS: '',
      CRM_AUDIT_ALERT_WEBHOOK_MIN_INTERVAL_MS: '',
    });
    expect(validatedEmpty.CRM_AUDIT_ALERT_SENTRY_ENABLED).toBe(true);
    expect(validatedEmpty.CRM_AUDIT_ALERT_WEBHOOK_URL).toBe('');
    expect(validatedEmpty.CRM_AUDIT_ALERT_WEBHOOK_TIMEOUT_MS).toBe(3000);
    expect(validatedEmpty.CRM_AUDIT_ALERT_WEBHOOK_MIN_INTERVAL_MS).toBe(30_000);

    const validatedFalse = validate({
      PG_DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/default',
      APP_SECRET: 'test-app-secret-value-at-least-32-chars',
      CRM_AUDIT_ALERT_SENTRY_ENABLED: 'false',
    });
    expect(validatedFalse.CRM_AUDIT_ALERT_SENTRY_ENABLED).toBe(false);
  });
});
