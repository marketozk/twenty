import { createHmac } from 'node:crypto';
import type * as http from 'node:http';
import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import axios from 'axios';

import {
  type CrmAuditUnavailableCode,
  type CrmAuditUnavailableRecord,
  CrmAuditHealthService,
} from 'src/engine/core-modules/crm-audit/crm-audit-health';
import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { ExceptionHandlerDriver } from 'src/engine/core-modules/exception-handler/interfaces';
import { ALLOW_ALL_INTERNAL_HOSTS } from 'src/engine/core-modules/secure-http-client/constants/allow-all-internal-hosts.constant';
import { OUTBOUND_HTTP_DEFAULT_MAX_PAYLOAD_SIZE_BYTES } from 'src/engine/core-modules/secure-http-client/constants/outbound-http-default-max-payload-size-bytes.constant';
import { createSsrfSafeAgent } from 'src/engine/core-modules/secure-http-client/utils/create-ssrf-safe-agent.util';
import { normalizeAllowedInternalHost } from 'src/engine/core-modules/secure-http-client/utils/normalize-allowed-internal-host.util';

const DEFAULT_WEBHOOK_TIMEOUT_MS = 3000;
const MIN_WEBHOOK_TIMEOUT_MS = 500;
const MAX_WEBHOOK_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_INTERVAL_MS = 30_000;
const MAX_MIN_INTERVAL_MS = 3_600_000;
const MAX_IN_FLIGHT_WEBHOOKS = 4;

type PerCodeThrottleState = {
  lastAcceptedAtMs: number;
  suppressedCount: number;
};

export type CrmAuditAlertSinkStatus = Readonly<{
  sentryEnabled: boolean;
  webhookConfigured: boolean;
  webhookDeliveredCount: number;
  webhookDeliveryFailureCount: number;
  webhookDroppedCount: number;
  webhookSuppressedCount: number;
  lastWebhookDeliveredAt: string | null;
  lastWebhookFailureAt: string | null;
}>;

class CrmAuditUnavailableError extends Error {
  constructor(code: CrmAuditUnavailableCode) {
    super(code);
    this.name = 'CrmAuditUnavailableError';
  }
}

const parseBooleanConfig = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }

  return fallback;
};

const parseBoundedNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  treatZeroAsFallback: boolean,
): number => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || (treatZeroAsFallback && numeric <= 0)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(numeric), min), max);
};

const parseAllowedInternalHosts = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
        }
      } catch {
        // Fall through to comma-separated parsing.
      }
    }

    return trimmed
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
};

const classifySafeDeliveryErrorCode = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (typeof status === 'number' && Number.isInteger(status)) {
      return `HTTP_${status}`;
    }
    if (
      error.code === 'ECONNABORTED' ||
      error.code === 'ERR_CANCELED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ENOTFOUND'
    ) {
      return error.code;
    }
  }

  return 'DELIVERY_FAILED';
};

@Injectable()
export class CrmAuditAlertSinkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CrmAuditAlertSinkService.name);
  private unsubscribe?: () => void;
  private destroyed = false;

  private sentryEnabled = false;
  private webhookUrl?: string;
  private webhookSecret?: string;
  private webhookTimeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS;
  private minIntervalMs = DEFAULT_MIN_INTERVAL_MS;

  private httpAgent?: http.Agent;
  private httpsAgent?: http.Agent;
  private readonly inFlightControllers = new Set<AbortController>();
  private readonly sentryThrottleByCode = new Map<
    CrmAuditUnavailableCode,
    PerCodeThrottleState
  >();
  private readonly webhookThrottleByCode = new Map<
    CrmAuditUnavailableCode,
    PerCodeThrottleState
  >();

  private webhookDeliveredCount = 0;
  private webhookDeliveryFailureCount = 0;
  private webhookDroppedCount = 0;
  private webhookSuppressedCount = 0;
  private lastWebhookDeliveredAt: string | null = null;
  private lastWebhookFailureAt: string | null = null;

  constructor(
    private readonly crmAuditHealthService: CrmAuditHealthService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly exceptionHandlerService?: ExceptionHandlerService,
  ) {}

  onModuleInit(): void {
    if (this.unsubscribe) {
      return;
    }

    this.destroyed = false;
    this.configureFromEnv();
    this.unsubscribe = this.crmAuditHealthService.registerAlertSink((record) =>
      this.handleAlert(record),
    );
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    for (const controller of [...this.inFlightControllers]) {
      controller.abort();
    }
    this.inFlightControllers.clear();

    this.httpAgent?.destroy();
    this.httpsAgent?.destroy();
    this.httpAgent = undefined;
    this.httpsAgent = undefined;
  }

  getStatus(): CrmAuditAlertSinkStatus {
    return Object.freeze({
      sentryEnabled: this.sentryEnabled,
      webhookConfigured: this.webhookUrl !== undefined,
      webhookDeliveredCount: this.webhookDeliveredCount,
      webhookDeliveryFailureCount: this.webhookDeliveryFailureCount,
      webhookDroppedCount: this.webhookDroppedCount,
      webhookSuppressedCount: this.webhookSuppressedCount,
      lastWebhookDeliveredAt: this.lastWebhookDeliveredAt,
      lastWebhookFailureAt: this.lastWebhookFailureAt,
    });
  }

  private configureFromEnv(): void {
    const rawSentryEnabled = this.configService?.get<unknown>(
      'CRM_AUDIT_ALERT_SENTRY_ENABLED',
    );
    const rawDriver = this.configService?.get<unknown>(
      'EXCEPTION_HANDLER_DRIVER',
    );
    const isSentryDriver =
      typeof rawDriver === 'string' &&
      rawDriver.trim().toUpperCase() === ExceptionHandlerDriver.SENTRY;
    this.sentryEnabled =
      Boolean(this.exceptionHandlerService) &&
      isSentryDriver &&
      parseBooleanConfig(rawSentryEnabled, true);

    this.webhookTimeoutMs = parseBoundedNumber(
      this.configService?.get<unknown>('CRM_AUDIT_ALERT_WEBHOOK_TIMEOUT_MS'),
      DEFAULT_WEBHOOK_TIMEOUT_MS,
      MIN_WEBHOOK_TIMEOUT_MS,
      MAX_WEBHOOK_TIMEOUT_MS,
      true,
    );
    this.minIntervalMs = parseBoundedNumber(
      this.configService?.get<unknown>(
        'CRM_AUDIT_ALERT_WEBHOOK_MIN_INTERVAL_MS',
      ),
      DEFAULT_MIN_INTERVAL_MS,
      0,
      MAX_MIN_INTERVAL_MS,
      false,
    );

    const rawSecret = this.configService?.get<unknown>(
      'CRM_AUDIT_ALERT_WEBHOOK_SECRET',
    );
    this.webhookSecret =
      typeof rawSecret === 'string' && rawSecret.trim().length > 0
        ? rawSecret.trim()
        : undefined;

    const rawUrl = this.configService?.get<unknown>(
      'CRM_AUDIT_ALERT_WEBHOOK_URL',
    );
    this.webhookUrl = undefined;

    if (typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
      const trimmedUrl = rawUrl.trim();
      try {
        const parsed = new URL(trimmedUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          this.webhookUrl = parsed.toString();
        } else {
          this.logger.warn(
            'CRM_AUDIT_ALERT_WEBHOOK_URL uses an unsupported protocol; webhook alerts disabled',
          );
        }
      } catch {
        this.logger.warn(
          'CRM_AUDIT_ALERT_WEBHOOK_URL is invalid; webhook alerts disabled',
        );
      }
    }

    if (this.webhookUrl !== undefined) {
      const rawAllowedHosts = parseAllowedInternalHosts(
        this.configService?.get<unknown>(
          'OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS',
        ),
      );
      const allowAll = rawAllowedHosts.includes(ALLOW_ALL_INTERNAL_HOSTS);
      const safeModeFlag = parseBooleanConfig(
        this.configService?.get<unknown>('OUTBOUND_HTTP_SAFE_MODE_ENABLED'),
        true,
      );
      if (!allowAll && safeModeFlag) {
        const normalizedAllowedHosts = rawAllowedHosts
          .map(normalizeAllowedInternalHost)
          .filter((host) => host.length > 0);
        this.httpAgent = createSsrfSafeAgent('http', normalizedAllowedHosts);
        this.httpsAgent = createSsrfSafeAgent('https', normalizedAllowedHosts);
      }
    }
  }

  private async handleAlert(record: CrmAuditUnavailableRecord): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.dispatchToSentry(record);
    await this.dispatchToWebhook(record);
  }

  private dispatchToSentry(record: CrmAuditUnavailableRecord): void {
    if (!this.sentryEnabled || !this.exceptionHandlerService) {
      return;
    }

    const nowMs = record.occurredAtMs;
    const state = this.sentryThrottleByCode.get(record.code);
    const elapsedMs = state ? nowMs - state.lastAcceptedAtMs : Number.POSITIVE_INFINITY;
    if (
      this.minIntervalMs > 0 &&
      state &&
      elapsedMs >= 0 &&
      elapsedMs < this.minIntervalMs
    ) {
      state.suppressedCount += 1;

      return;
    }

    const suppressedCount = state?.suppressedCount ?? 0;
    this.sentryThrottleByCode.set(record.code, {
      lastAcceptedAtMs: nowMs,
      suppressedCount: 0,
    });

    try {
      this.exceptionHandlerService.captureExceptions(
        [new CrmAuditUnavailableError(record.code)],
        {
          ...(record.workspaceId !== undefined
            ? { workspace: { id: record.workspaceId } }
            : {}),
          additionalData: {
            event: 'crm_audit.unavailable',
            code: record.code,
            occurredAt: record.occurredAt,
            ...(record.operationId !== undefined
              ? { operationId: record.operationId }
              : {}),
            ...(record.attemptId !== undefined
              ? { attemptId: record.attemptId }
              : {}),
            ...(record.resourceKind !== undefined
              ? { resourceKind: record.resourceKind }
              : {}),
            ...(record.action !== undefined ? { action: record.action } : {}),
            suppressedCount,
          },
        },
      );
    } catch {
      if (!this.destroyed) {
        const current = this.sentryThrottleByCode.get(record.code);
        if (current) {
          current.suppressedCount += suppressedCount;
        }
      }
      this.logger.warn(
        `CRM audit alert Sentry dispatch failed code=${record.code}`,
      );
    }
  }

  private async dispatchToWebhook(
    record: CrmAuditUnavailableRecord,
  ): Promise<void> {
    if (this.webhookUrl === undefined || this.destroyed) {
      return;
    }

    const nowMs = record.occurredAtMs;
    const state = this.webhookThrottleByCode.get(record.code);
    const elapsedMs = state ? nowMs - state.lastAcceptedAtMs : Number.POSITIVE_INFINITY;
    if (
      this.minIntervalMs > 0 &&
      state &&
      elapsedMs >= 0 &&
      elapsedMs < this.minIntervalMs
    ) {
      state.suppressedCount += 1;
      this.webhookSuppressedCount += 1;

      return;
    }

    if (this.inFlightControllers.size >= MAX_IN_FLIGHT_WEBHOOKS) {
      this.webhookDroppedCount += 1;

      return;
    }

    const suppressedCount = state?.suppressedCount ?? 0;
    this.webhookThrottleByCode.set(record.code, {
      lastAcceptedAtMs: nowMs,
      suppressedCount: 0,
    });

    const payload = {
      event: 'crm_audit.unavailable',
      code: record.code,
      occurredAt: record.occurredAt,
      ...(record.workspaceId !== undefined
        ? { workspaceId: record.workspaceId }
        : {}),
      ...(record.operationId !== undefined
        ? { operationId: record.operationId }
        : {}),
      ...(record.attemptId !== undefined
        ? { attemptId: record.attemptId }
        : {}),
      ...(record.resourceKind !== undefined
        ? { resourceKind: record.resourceKind }
        : {}),
      ...(record.action !== undefined ? { action: record.action } : {}),
      suppressedCount,
    };
    const rawBody = JSON.stringify(payload);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.webhookSecret !== undefined) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', this.webhookSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      headers['X-Twenty-Audit-Alert-Timestamp'] = timestamp;
      headers['X-Twenty-Audit-Alert-Signature'] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    this.inFlightControllers.add(controller);
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.webhookTimeoutMs);
    timeoutHandle.unref?.();

    try {
      await axios.post(this.webhookUrl, rawBody, {
        headers,
        timeout: this.webhookTimeoutMs,
        maxRedirects: 0,
        maxContentLength: OUTBOUND_HTTP_DEFAULT_MAX_PAYLOAD_SIZE_BYTES,
        maxBodyLength: OUTBOUND_HTTP_DEFAULT_MAX_PAYLOAD_SIZE_BYTES,
        transformRequest: [(data: unknown) => data],
        validateStatus: (status) => status >= 200 && status < 300,
        ...(this.httpAgent ? { httpAgent: this.httpAgent } : {}),
        ...(this.httpsAgent ? { httpsAgent: this.httpsAgent } : {}),
        signal: controller.signal,
      });

      if (!this.destroyed) {
        this.webhookDeliveredCount += 1;
        this.lastWebhookDeliveredAt = new Date().toISOString();
      }
    } catch (error) {
      if (!this.destroyed) {
        const current = this.webhookThrottleByCode.get(record.code);
        if (current) {
          current.suppressedCount += suppressedCount;
        }
        this.webhookDeliveryFailureCount += 1;
        this.lastWebhookFailureAt = new Date().toISOString();
        this.logger.warn(
          `CRM audit alert webhook delivery failed code=${record.code} reason=${classifySafeDeliveryErrorCode(error)}`,
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
      this.inFlightControllers.delete(controller);
    }
  }
}
