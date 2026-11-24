import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { type DataSource } from 'typeorm';

import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { verifyCrmAuditPrivileges } from 'src/engine/core-modules/crm-audit/verify-crm-audit-privileges';

export type CrmAuditUnavailableCode =
  | 'POST_ROLLBACK_AUDIT_UNAVAILABLE'
  | 'TRANSACTION_OUTCOME_UNKNOWN_AUDIT_SKIPPED'
  | 'SESSION_REVOCATION_AUDIT_UNAVAILABLE'
  | 'REFRESH_REVOCATION_AUDIT_UNAVAILABLE'
  | 'REFRESH_FAMILY_REVOCATION_AUDIT_UNAVAILABLE'
  | 'MEMBERSHIP_CLEANUP_AUDIT_UNAVAILABLE'
  | 'CORE_USER_DEACTIVATION_AUDIT_UNAVAILABLE'
  | 'NATIVE_MEMBER_DELETION_AUDIT_UNAVAILABLE'
  | 'RECORD_SHARE_TRANSFER_AUDIT_UNAVAILABLE'
  | 'CONNECTED_ACCOUNT_TRANSFER_AUDIT_UNAVAILABLE'
  | 'CONNECTED_ACCOUNT_DISCONNECT_AUDIT_UNAVAILABLE';

export type CrmAuditUnavailableInput = {
  code: CrmAuditUnavailableCode;
  loggerContext?: string;
  workspaceId?: string;
  operationId?: string;
  attemptId?: string;
  resourceKind?: string;
  action?: string;
  nowMs?: number;
};

export type CrmAuditUnavailableRecord = {
  readonly code: CrmAuditUnavailableCode;
  readonly occurredAt: string;
  readonly occurredAtMs: number;
  readonly workspaceId?: string;
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly resourceKind?: string;
  readonly action?: string;
};

export type CrmAuditAlertSink = (
  record: CrmAuditUnavailableRecord,
) => void | Promise<void>;

export type CrmAuditHealthSnapshot = {
  readonly status: 'ok' | 'degraded';
  readonly totalUnavailableCount: number;
  readonly recentUnavailableCount: number;
  readonly hasRecentAuditLoss: boolean;
  readonly recentWindowMs: number;
  readonly lastFailureCode: CrmAuditUnavailableCode | null;
  readonly lastFailureAt: string | null;
  readonly countsByCode: Readonly<Record<string, number>>;
  readonly recentFailures: readonly CrmAuditUnavailableRecord[];
};

export type CrmAuditDatabaseHealthStatus = {
  readonly status: 'ok' | 'degraded' | 'unavailable';
  readonly databaseReachable: boolean;
  readonly appendOnlyPrivilegesVerified: boolean;
  readonly checkedAt: string;
  readonly fromCache: boolean;
  readonly totalUnavailableCount: number;
  readonly recentUnavailableCount: number;
  readonly hasRecentAuditLoss: boolean;
  readonly lastFailureCode: CrmAuditUnavailableCode | null;
  readonly lastFailureAt: string | null;
};

type DatabaseProbeResult = {
  readonly checkedAt: string;
  readonly databaseReachable: boolean;
  readonly appendOnlyPrivilegesVerified: boolean;
};

type CachedDatabaseProbe = DatabaseProbeResult & {
  readonly startedSeq: number;
  readonly expiresAtMs: number;
};

const DEFAULT_RECENT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_PROBE_CACHE_TTL_MS = 5000;
const MAX_RECENT_FAILURES = 100;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

let totalUnavailableCount = 0;
let lastFailureCode: CrmAuditUnavailableCode | null = null;
let lastFailureAt: string | null = null;
let nextProbeSeq = 0;
const countsByCode = new Map<CrmAuditUnavailableCode, number>();
const recentFailures: CrmAuditUnavailableRecord[] = [];
const alertSinks = new Set<CrmAuditAlertSink>();
let probeCache = new WeakMap<DataSource, CachedDatabaseProbe>();
let inFlightProbes = new WeakMap<DataSource, Promise<DatabaseProbeResult>>();

const sanitizeToken = (value?: string): string | undefined =>
  typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;

const normalizeWindowMs = (value?: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_RECENT_WINDOW_MS;

const hasExplicitNow = (value?: number): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const registerCrmAuditAlertSink = (
  sink: CrmAuditAlertSink,
): (() => void) => {
  alertSinks.add(sink);

  return () => {
    alertSinks.delete(sink);
  };
};

export const reportCrmAuditUnavailable = (
  input: CrmAuditUnavailableInput,
): CrmAuditUnavailableRecord => {
  const occurredAtMs = hasExplicitNow(input.nowMs) ? input.nowMs : Date.now();
  const occurredAt = new Date(occurredAtMs).toISOString();
  const operationId = sanitizeToken(input.operationId);
  const workspaceId = sanitizeToken(input.workspaceId);
  const attemptId = sanitizeToken(input.attemptId);
  const resourceKind = sanitizeToken(input.resourceKind);
  const action = sanitizeToken(input.action);

  const record: CrmAuditUnavailableRecord = Object.freeze({
    code: input.code,
    occurredAt,
    occurredAtMs,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(operationId !== undefined ? { operationId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(resourceKind !== undefined ? { resourceKind } : {}),
    ...(action !== undefined ? { action } : {}),
  });

  totalUnavailableCount += 1;
  lastFailureCode = input.code;
  lastFailureAt = occurredAt;
  countsByCode.set(input.code, (countsByCode.get(input.code) ?? 0) + 1);
  recentFailures.push(record);

  if (recentFailures.length > MAX_RECENT_FAILURES) {
    recentFailures.splice(0, recentFailures.length - MAX_RECENT_FAILURES);
  }

  const logger = new Logger(input.loggerContext ?? 'CrmAuditHealth');
  const message =
    operationId !== undefined
      ? `${input.code} operationId=${operationId}`
      : input.code;

  logger.error(message);

  for (const sink of [...alertSinks]) {
    Promise.resolve()
      .then(() => sink(record))
      .catch(() => undefined);
  }

  return record;
};

export const getCrmAuditHealthSnapshot = (options?: {
  recentWindowMs?: number;
  nowMs?: number;
}): CrmAuditHealthSnapshot => {
  const recentWindowMs = normalizeWindowMs(options?.recentWindowMs);
  const explicitNowMs = hasExplicitNow(options?.nowMs)
    ? options.nowMs
    : undefined;
  const nowMs = explicitNowMs ?? Date.now();
  const cutoffMs = nowMs - recentWindowMs;
  const activeFailures = recentFailures.filter((entry) =>
    explicitNowMs !== undefined
      ? entry.occurredAtMs >= cutoffMs && entry.occurredAtMs <= nowMs
      : entry.occurredAtMs >= cutoffMs,
  );
  const counts: Record<string, number> = {};

  for (const [code, count] of countsByCode.entries()) {
    counts[code] = count;
  }

  const hasRecentAuditLoss = activeFailures.length > 0;

  return Object.freeze({
    status: hasRecentAuditLoss ? 'degraded' : 'ok',
    totalUnavailableCount,
    recentUnavailableCount: activeFailures.length,
    hasRecentAuditLoss,
    recentWindowMs,
    lastFailureCode,
    lastFailureAt,
    countsByCode: Object.freeze(counts),
    recentFailures: Object.freeze([...activeFailures]),
  });
};

const runDatabaseProbe = async (
  dataSource: DataSource,
  explicitNowMs?: number,
): Promise<DatabaseProbeResult> => {
  if (!dataSource.isInitialized) {
    return {
      checkedAt: new Date(explicitNowMs ?? Date.now()).toISOString(),
      databaseReachable: false,
      appendOnlyPrivilegesVerified: false,
    };
  }

  let databaseReachable = false;
  let appendOnlyPrivilegesVerified = false;

  try {
    await runInCoreAuditTransaction(dataSource, async (runner) => {
      await runner.query('SET LOCAL TRANSACTION READ ONLY');
      await runner.query("SET LOCAL lock_timeout = '1s'");
      await runner.query("SET LOCAL statement_timeout = '3s'");
      await runner.query('SELECT 1');
      databaseReachable = true;
      await verifyCrmAuditPrivileges(runner);
      await runner.query('SELECT 1 FROM crm_audit."crmAuditEntry" LIMIT 1');
      appendOnlyPrivilegesVerified = true;
    });
  } catch {
    appendOnlyPrivilegesVerified = false;
  }

  return {
    checkedAt: new Date(explicitNowMs ?? Date.now()).toISOString(),
    databaseReachable,
    appendOnlyPrivilegesVerified,
  };
};

export const checkCrmAuditDatabaseHealth = async (
  dataSource: DataSource | undefined,
  options?: {
    bypassCache?: boolean;
    cacheTtlMs?: number;
    recentWindowMs?: number;
    nowMs?: number;
  },
): Promise<CrmAuditDatabaseHealthStatus> => {
  const explicitNowMs = hasExplicitNow(options?.nowMs)
    ? options.nowMs
    : undefined;
  const initialNowMs = explicitNowMs ?? Date.now();
  const cacheTtlMs =
    typeof options?.cacheTtlMs === 'number' &&
    Number.isFinite(options.cacheTtlMs) &&
    options.cacheTtlMs >= 0
      ? options.cacheTtlMs
      : DEFAULT_PROBE_CACHE_TTL_MS;

  if (!dataSource) {
    const snapshot = getCrmAuditHealthSnapshot({
      recentWindowMs: options?.recentWindowMs,
      ...(explicitNowMs !== undefined ? { nowMs: explicitNowMs } : {}),
    });

    return Object.freeze({
      status: 'unavailable',
      databaseReachable: false,
      appendOnlyPrivilegesVerified: false,
      checkedAt: new Date(initialNowMs).toISOString(),
      fromCache: false,
      totalUnavailableCount: snapshot.totalUnavailableCount,
      recentUnavailableCount: snapshot.recentUnavailableCount,
      hasRecentAuditLoss: snapshot.hasRecentAuditLoss,
      lastFailureCode: snapshot.lastFailureCode,
      lastFailureAt: snapshot.lastFailureAt,
    });
  }

  const cached = probeCache.get(dataSource);
  let probe: DatabaseProbeResult;
  let fromCache = false;

  if (!options?.bypassCache && cached && initialNowMs < cached.expiresAtMs) {
    probe = cached;
    fromCache = true;
  } else {
    let pending = options?.bypassCache
      ? undefined
      : inFlightProbes.get(dataSource);

    if (!pending) {
      const startedSeq = ++nextProbeSeq;
      const created = runDatabaseProbe(dataSource, explicitNowMs)
        .then((result) => {
          if (cacheTtlMs > 0) {
            const currentCached = probeCache.get(dataSource);
            if (!currentCached || startedSeq >= currentCached.startedSeq) {
              const completedAtMs = explicitNowMs ?? Date.now();
              probeCache.set(dataSource, {
                ...result,
                startedSeq,
                expiresAtMs: completedAtMs + cacheTtlMs,
              });
            }
          }
          return result;
        })
        .finally(() => {
          if (inFlightProbes.get(dataSource) === created) {
            inFlightProbes.delete(dataSource);
          }
        });

      pending = created;

      if (!options?.bypassCache) {
        inFlightProbes.set(dataSource, created);
      }
    }

    probe = await pending;
  }

  // Re-read current time after awaited DB probe so concurrent failures are not hidden.
  const snapshot = getCrmAuditHealthSnapshot({
    recentWindowMs: options?.recentWindowMs,
    ...(explicitNowMs !== undefined ? { nowMs: explicitNowMs } : {}),
  });
  const status: 'ok' | 'degraded' | 'unavailable' =
    !probe.databaseReachable || !probe.appendOnlyPrivilegesVerified
      ? 'unavailable'
      : snapshot.hasRecentAuditLoss
        ? 'degraded'
        : 'ok';

  return Object.freeze({
    status,
    databaseReachable: probe.databaseReachable,
    appendOnlyPrivilegesVerified: probe.appendOnlyPrivilegesVerified,
    checkedAt: probe.checkedAt,
    fromCache,
    totalUnavailableCount: snapshot.totalUnavailableCount,
    recentUnavailableCount: snapshot.recentUnavailableCount,
    hasRecentAuditLoss: snapshot.hasRecentAuditLoss,
    lastFailureCode: snapshot.lastFailureCode,
    lastFailureAt: snapshot.lastFailureAt,
  });
};

export const resetCrmAuditHealthStateForTesting = (): void => {
  totalUnavailableCount = 0;
  lastFailureCode = null;
  lastFailureAt = null;
  nextProbeSeq = 0;
  countsByCode.clear();
  recentFailures.length = 0;
  alertSinks.clear();
  probeCache = new WeakMap<DataSource, CachedDatabaseProbe>();
  inFlightProbes = new WeakMap();
};

@Injectable()
export class CrmAuditHealthService {
  constructor(
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  getSnapshot(options?: {
    recentWindowMs?: number;
    nowMs?: number;
  }): CrmAuditHealthSnapshot {
    return getCrmAuditHealthSnapshot(options);
  }

  checkHealth(options?: {
    bypassCache?: boolean;
    cacheTtlMs?: number;
    recentWindowMs?: number;
    nowMs?: number;
  }): Promise<CrmAuditDatabaseHealthStatus> {
    return checkCrmAuditDatabaseHealth(this.coreDataSource, options);
  }

  registerAlertSink(sink: CrmAuditAlertSink): () => void {
    return registerCrmAuditAlertSink(sink);
  }
}
