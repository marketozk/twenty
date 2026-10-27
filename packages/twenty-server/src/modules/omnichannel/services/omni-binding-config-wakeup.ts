import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { omniBindingConfigChangedEventSchema } from 'src/engine/core-modules/omnichannel-storage/contracts/omni-binding-config-changed';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { omniBindingConfigWakeupId } from 'src/modules/omnichannel/contracts/omni-binding-config-wakeup';
import {
  resumeOmniBlockedHistoryReceipts,
  type OmniBlockedHistoryResumeScope,
  type OmniBlockedHistoryResumeAuthorizer,
} from 'src/modules/omnichannel/services/resume-omni-blocked-history-receipts';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const positiveCounter = counter.refine((value) => BigInt(value) > 0n);
const timestamp = z.iso.datetime({ precision: 6 });
const principalSchema = z
  .strictObject({
    workspaceId: uuid,
    bindingId: uuid,
    actor: z
      .strictObject({
        kind: z.literal('system'),
        id: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^\u0000-\u001f\u007f\uD800-\uDFFF]+$/u)
          .refine((value) => value.trim() === value),
      })
      .readonly(),
  })
  .readonly();
const limitSchema = z.number().int().min(1).max(100);
const pageSchema = z.strictObject({ limit: limitSchema }).readonly();
const scanSchema = z
  .strictObject({
    limit: limitSchema,
    after: z
      .strictObject({ createdAt: timestamp, id: uuid })
      .readonly()
      .optional(),
  })
  .readonly();
const claimSchema = z
  .strictObject({
    leaseOwner: uuid,
    limit: limitSchema,
    leaseMilliseconds: z.number().int().min(1000).max(300000),
  })
  .readonly();
const proofSchema = z
  .strictObject({
    wakeupId: uuid,
    leaseOwner: uuid,
    leaseToken: positiveCounter,
  })
  .readonly();
const rowSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  bindingId: uuid,
  eventId: uuid,
  handlerVersion: z.number().int().positive(),
  state: z.enum(['pending', 'running', 'retryable', 'completed', 'blocked']),
  attempts: z.number().int().nonnegative(),
  leaseToken: counter,
  leaseOwner: z.string().nullable(),
  leaseUntil: timestamp.nullable(),
  nextAttemptAt: timestamp,
  cursorNextAttemptAt: timestamp.nullable(),
  cursorReceiptId: uuid.nullable(),
  needsRescan: z.boolean(),
  observedRouteGeneration: positiveCounter.nullable(),
  errorCode: z
    .enum([
      'binding_inactive',
      'unsupported_handler',
      'rescan_required',
      'transient_failure',
    ])
    .nullable(),
  leaseLive: z.boolean(),
});
type WakeupRow = z.infer<typeof rowSchema>;
export type OmniBindingConfigWakeupPrincipal = z.infer<typeof principalSchema>;
export type OmniBindingConfigWakeupScope = OmniBlockedHistoryResumeScope;
export type OmniBindingConfigWakeupProof = z.infer<typeof proofSchema>;
export type OmniBindingConfigWakeupAuthorizer = (
  scope: OmniBindingConfigWakeupScope,
  descriptor: Readonly<
    OmniBindingConfigWakeupPrincipal & {
      action:
        | 'config_wakeup.claim'
        | 'config_wakeup.process'
        | 'config_wakeup.reconcile'
        | 'config_wakeup.rearm';
      routeGeneration: string;
      bindingRevision: string;
      wakeupId?: string;
      eventId?: string;
    }
  >,
) => Promise<void>;
export type OmniBindingConfigWakeupClaim = Readonly<{
  wakeupId: string;
  eventId: string;
  bindingId: string;
  leaseOwner: string;
  leaseToken: string;
  leaseUntil: string;
  routeGeneration: string;
}>;

export { omniBindingConfigWakeupId } from 'src/modules/omnichannel/contracts/omni-binding-config-wakeup';
const fail = (reason: string): never => {
  throw new Error(`OMNI_BINDING_CONFIG_WAKEUP_${reason}`);
};
const one = <T extends z.ZodType>(schema: T, rows: unknown[]): z.infer<T> => {
  if (rows.length !== 1) return fail('MISSING_OR_AMBIGUOUS_ROW');
  return schema.parse(rows[0]);
};
const rowColumns = `id,"workspaceId","bindingId","eventId","handlerVersion",state,attempts,"leaseToken","leaseOwner",
  to_char("leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
  to_char("nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt",
  to_char("cursorNextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorNextAttemptAt",
  "cursorReceiptId","needsRescan","observedRouteGeneration","errorCode",
  COALESCE("leaseUntil">clock_timestamp(),false) AS "leaseLive"`;
const snapshot = (row: WakeupRow) => {
  const { id: _id, workspaceId: _workspace, leaseLive: _live, ...value } = row;
  return value;
};
const callbacks = (authorize: OmniBindingConfigWakeupAuthorizer) => {
  if (typeof authorize !== 'function') return fail('AUTHORIZER_REQUIRED');
  return authorize;
};
const open = async (
  inputScope: OmniBindingConfigWakeupScope,
  principal: OmniBindingConfigWakeupPrincipal,
) => {
  const execute = inputScope.executeRawQuery;
  const scope: OmniBindingConfigWakeupScope = Object.freeze({
    workspaceId: uuid.parse(inputScope.workspaceId),
    transactionLifecycle: inputScope.transactionLifecycle,
    executeRawQuery: (sql: string, parameters?: unknown[]) =>
      execute.call(inputScope, sql, parameters),
  });
  if (scope.workspaceId !== principal.workspaceId)
    return fail('WORKSPACE_MISMATCH');
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = executor.query;
  one(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR SHARE',
      [principal.workspaceId],
    ),
  );
  const binding = one(
    z.object({
      id: uuid,
      revision: positiveCounter,
      routeGeneration: positiveCounter,
      status: z.string(),
    }),
    await query(
      'SELECT id,revision,"routeGeneration",status FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [principal.workspaceId, principal.bindingId],
    ),
  );
  const audit = new CrmAuditTransactionContext(executor, {
    workspaceId: principal.workspaceId,
    actor: principal.actor,
    operationId: randomUUID(),
  });
  return { scope, executor, query, binding, audit };
};
type Transaction = Awaited<ReturnType<typeof open>>;
const authorizeCurrent = async (
  transaction: Transaction,
  principal: OmniBindingConfigWakeupPrincipal,
  authorize: OmniBindingConfigWakeupAuthorizer,
  action: Parameters<OmniBindingConfigWakeupAuthorizer>[1]['action'],
  row?: WakeupRow,
) => {
  await authorize(
    transaction.scope,
    Object.freeze({
      ...principal,
      action,
      routeGeneration: transaction.binding.routeGeneration,
      bindingRevision: transaction.binding.revision,
      ...(row ? { wakeupId: row.id, eventId: row.eventId } : {}),
    }),
  );
  // A trusted authorizer must not end the caller's transaction.
  createCrmAuditWorkspaceExecutor(transaction.scope);
};
const eventColumns =
  'id,"workspaceId",kind,origin,"payloadVersion",payload,"conversationId","conversationSequence","rootExecutionId","causationId"';
const eventSnapshot = (value: Record<string, unknown>) =>
  omniBindingConfigChangedEventSchema.parse({
    kind: value.kind,
    origin: value.origin,
    payloadVersion: value.payloadVersion,
    payload: value.payload,
    conversationId: value.conversationId,
    conversationSequence: value.conversationSequence,
    rootExecutionId: value.rootExecutionId,
    causationId: value.causationId,
  });
const verifyEvent = async (
  transaction: Transaction,
  principal: OmniBindingConfigWakeupPrincipal,
  row: WakeupRow,
) => {
  const records = await transaction.query(
    `SELECT ${eventColumns} FROM core."omniDomainEvent" WHERE "workspaceId"=$1 AND id=$2`,
    [principal.workspaceId, row.eventId],
  );
  const record = one(z.record(z.string(), z.unknown()), records);
  const event = eventSnapshot(record);
  if (
    record.id !== row.eventId ||
    record.workspaceId !== principal.workspaceId ||
    event.payload.bindingId !== principal.bindingId ||
    row.workspaceId !== principal.workspaceId ||
    row.bindingId !== principal.bindingId ||
    row.id !== omniBindingConfigWakeupId(row.eventId)
  )
    return fail('EVENT_INTEGRITY');
};
const recordChange = (
  transaction: Transaction,
  before: WakeupRow | null,
  after: WakeupRow,
) => {
  transaction.audit.record({
    resourceKind: 'omniBindingConfigWakeup',
    resourceId: after.id,
    action: before ? 'update' : 'create',
    before: before ? snapshot(before) : null,
    after: snapshot(after),
    securityDescriptor: {
      resourceKind: 'omniBindingConfigWakeup',
      resourceId: after.id,
      bindingId: after.bindingId,
    },
  });
};

// These leaves require a strict transaction owner. It handles commit/unknown ACK and
// failed/denied attempt audit after confirmed rollback; there is no default worker grant.
export const reconcileOmniBindingConfigWakeups = async (
  scope: OmniBindingConfigWakeupScope,
  inputPrincipal: OmniBindingConfigWakeupPrincipal,
  input: z.infer<typeof scanSchema>,
  inputAuthorize: OmniBindingConfigWakeupAuthorizer,
) => {
  const principal = principalSchema.parse(inputPrincipal);
  const options = scanSchema.parse(input);
  const authorize = callbacks(inputAuthorize);
  const transaction = await open(scope, principal);
  await authorizeCurrent(
    transaction,
    principal,
    authorize,
    'config_wakeup.reconcile',
  );
  const records = z.array(z.record(z.string(), z.unknown())).parse(
    await transaction.query(
      `SELECT ${eventColumns
        .split(',')
        .map((column) => `event.${column}`)
        .join(',')},
     to_char(event."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtText"
     FROM core."omniDomainEvent" event
     WHERE event."workspaceId"=$1 AND event.kind='binding.config_changed' AND event.payload->>'bindingId'=$2
       AND NOT EXISTS (SELECT 1 FROM core."omniBindingConfigWakeup" wakeup WHERE wakeup."workspaceId"=event."workspaceId" AND wakeup."eventId"=event.id)
       AND ($3::timestamptz IS NULL OR (event."createdAt",event.id)>($3::timestamptz,$4::uuid))
     ORDER BY event."createdAt",event.id LIMIT $5`,
      [
        principal.workspaceId,
        principal.bindingId,
        options.after?.createdAt ?? null,
        options.after?.id ?? null,
        options.limit,
      ],
    ),
  );
  const enqueuedIds: string[] = [];
  const invalidEventIds: string[] = [];
  for (const record of records) {
    const eventId = uuid.parse(record.id);
    try {
      const event = eventSnapshot(record);
      if (
        record.workspaceId !== principal.workspaceId ||
        event.payload.bindingId !== principal.bindingId
      )
        return fail('EVENT_INTEGRITY');
    } catch {
      invalidEventIds.push(eventId);
      continue;
    }
    const inserted = z.array(rowSchema).parse(
      await transaction.query(
        `INSERT INTO core."omniBindingConfigWakeup" (id,"workspaceId","eventId","bindingId") VALUES ($1,$2,$3,$4)
       ON CONFLICT ("workspaceId","eventId") DO NOTHING RETURNING ${rowColumns}`,
        [
          omniBindingConfigWakeupId(eventId),
          principal.workspaceId,
          eventId,
          principal.bindingId,
        ],
      ),
    );
    if (inserted.length > 1) return fail('AMBIGUOUS_ENQUEUE');
    if (inserted.length === 1) {
      const row = inserted[0];
      if (
        row.id !== omniBindingConfigWakeupId(eventId) ||
        row.bindingId !== principal.bindingId ||
        row.workspaceId !== principal.workspaceId ||
        row.eventId !== eventId
      )
        return fail('ENQUEUE_POSTCONDITION');
      recordChange(transaction, null, row);
      enqueuedIds.push(row.id);
    }
  }
  await transaction.audit.flush();
  createCrmAuditWorkspaceExecutor(transaction.scope);
  const last = records.at(-1);
  return Object.freeze({
    scannedCount: records.length,
    enqueuedIds: Object.freeze(enqueuedIds),
    invalidEventIds: Object.freeze(invalidEventIds),
    nextCursor:
      last && records.length === options.limit
        ? Object.freeze({
            createdAt: timestamp.parse(last.createdAtText),
            id: uuid.parse(last.id),
          })
        : null,
  });
};

export const claimOmniBindingConfigWakeups = async (
  scope: OmniBindingConfigWakeupScope,
  inputPrincipal: OmniBindingConfigWakeupPrincipal,
  input: z.infer<typeof claimSchema>,
  inputAuthorize: OmniBindingConfigWakeupAuthorizer,
): Promise<readonly OmniBindingConfigWakeupClaim[]> => {
  const principal = principalSchema.parse(inputPrincipal);
  const options = claimSchema.parse(input);
  const authorize = callbacks(inputAuthorize);
  const transaction = await open(scope, principal);
  await authorizeCurrent(
    transaction,
    principal,
    authorize,
    'config_wakeup.claim',
  );
  const rows = z.array(rowSchema).parse(
    await transaction.query(
      `SELECT ${rowColumns} FROM core."omniBindingConfigWakeup" WHERE "workspaceId"=$1 AND "bindingId"=$2
     AND ((state IN ('pending','retryable','blocked') AND "nextAttemptAt"<=clock_timestamp()) OR (state='running' AND "leaseUntil"<=clock_timestamp()))
     ORDER BY "nextAttemptAt",id LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [principal.workspaceId, principal.bindingId, options.limit],
    ),
  );
  const claims: OmniBindingConfigWakeupClaim[] = [];
  for (const before of rows) {
    await verifyEvent(transaction, principal, before);
    if (
      before.attempts >= 2147483647 ||
      BigInt(before.leaseToken) >= 9223372036854775807n
    )
      return fail('COUNTER_EXHAUSTED');
    const reason =
      before.handlerVersion !== 1
        ? 'unsupported_handler'
        : transaction.binding.status !== 'active'
          ? 'binding_inactive'
          : null;
    const after = one(
      rowSchema,
      await transaction.query(
        `WITH changed AS (UPDATE core."omniBindingConfigWakeup" SET state=CASE WHEN $4::text IS NULL THEN 'running' ELSE 'blocked' END,
       attempts=attempts+1,"leaseToken"="leaseToken"+CASE WHEN $4::text IS NULL THEN 1 ELSE 0 END,
       "leaseOwner"=CASE WHEN $4::text IS NULL THEN $5::text ELSE NULL END,
       "leaseUntil"=CASE WHEN $4::text IS NULL THEN clock_timestamp()+$6*interval '1 millisecond' ELSE NULL END,
       "nextAttemptAt"=CASE WHEN $4::text IS NULL THEN "nextAttemptAt" ELSE clock_timestamp()+interval '60 seconds' END,
       "errorCode"=$4,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 RETURNING *) SELECT ${rowColumns} FROM changed`,
        [
          principal.workspaceId,
          principal.bindingId,
          before.id,
          reason,
          options.leaseOwner,
          options.leaseMilliseconds,
        ],
      ),
    );
    recordChange(transaction, before, after);
    if (reason === null) {
      if (
        after.state !== 'running' ||
        after.leaseOwner !== options.leaseOwner ||
        after.leaseUntil === null ||
        BigInt(after.leaseToken) !== BigInt(before.leaseToken) + 1n
      )
        return fail('CLAIM_POSTCONDITION');
      claims.push(
        Object.freeze({
          wakeupId: after.id,
          eventId: after.eventId,
          bindingId: after.bindingId,
          leaseOwner: after.leaseOwner,
          leaseToken: after.leaseToken,
          leaseUntil: after.leaseUntil,
          routeGeneration: transaction.binding.routeGeneration,
        }),
      );
    }
  }
  await transaction.audit.flush();
  if (claims.length > 0) {
    const live = z.array(z.object({ id: uuid })).parse(
      await transaction.query(
        `SELECT id FROM core."omniBindingConfigWakeup" WHERE "workspaceId"=$1 AND "bindingId"=$2
       AND id=ANY($3::uuid[]) AND state='running' AND "leaseOwner"=$4 AND "leaseUntil">clock_timestamp()`,
        [
          principal.workspaceId,
          principal.bindingId,
          claims.map((claim) => claim.wakeupId),
          options.leaseOwner,
        ],
      ),
    );
    if (
      live.length !== claims.length ||
      new Set(live.map((row) => row.id)).size !== claims.length
    )
      return fail('CLAIM_EXPIRED');
  }
  createCrmAuditWorkspaceExecutor(transaction.scope);
  return Object.freeze(claims);
};

export const processOmniBindingConfigWakeupPage = async (
  scope: OmniBindingConfigWakeupScope,
  inputPrincipal: OmniBindingConfigWakeupPrincipal,
  inputProof: OmniBindingConfigWakeupProof,
  input: z.infer<typeof pageSchema>,
  inputAuthorize: OmniBindingConfigWakeupAuthorizer,
  inputAuthorizeResume: OmniBlockedHistoryResumeAuthorizer,
) => {
  const principal = principalSchema.parse(inputPrincipal);
  const proof = proofSchema.parse(inputProof);
  const options = pageSchema.parse(input);
  const authorize = callbacks(inputAuthorize);
  const authorizeResume = inputAuthorizeResume;
  if (typeof authorizeResume !== 'function')
    return fail('RESUME_AUTHORIZER_REQUIRED');
  const transaction = await open(scope, principal);
  const read = () =>
    transaction.query(
      `SELECT ${rowColumns} FROM core."omniBindingConfigWakeup" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3`,
      [principal.workspaceId, principal.bindingId, proof.wakeupId],
    );
  const before = one(rowSchema, await read());
  await authorizeCurrent(
    transaction,
    principal,
    authorize,
    'config_wakeup.process',
    before,
  );
  await verifyEvent(transaction, principal, before);
  if (
    before.state !== 'running' ||
    before.leaseOwner !== proof.leaseOwner ||
    before.leaseToken !== proof.leaseToken ||
    !before.leaseLive
  )
    return fail('LEASE_LOST');
  const sameGeneration =
    before.observedRouteGeneration === transaction.binding.routeGeneration;
  const reason =
    before.handlerVersion !== 1
      ? 'unsupported_handler'
      : transaction.binding.status !== 'active'
        ? 'binding_inactive'
        : null;
  const resumed =
    reason === null
      ? await resumeOmniBlockedHistoryReceipts(
          transaction.scope,
          principal,
          {
            routeGeneration: transaction.binding.routeGeneration,
            limit: options.limit,
            ...(sameGeneration &&
            before.cursorNextAttemptAt !== null &&
            before.cursorReceiptId !== null
              ? {
                  after: {
                    nextAttemptAt: before.cursorNextAttemptAt,
                    id: before.cursorReceiptId,
                  },
                }
              : {}),
          },
          authorizeResume,
        )
      : {
          scannedCount: 0,
          resumedReceiptIds: [] as readonly string[],
          nextCursor: null,
          needsRescan: false,
        };
  const needsRescan =
    (sameGeneration && before.needsRescan) || resumed.needsRescan;
  const nextCursor = reason
    ? sameGeneration && before.cursorNextAttemptAt && before.cursorReceiptId
      ? {
          nextAttemptAt: before.cursorNextAttemptAt,
          id: before.cursorReceiptId,
        }
      : null
    : resumed.nextCursor;
  const nextState = reason
    ? 'blocked'
    : nextCursor
      ? 'pending'
      : needsRescan
        ? 'retryable'
        : 'completed';
  const nextError =
    reason ?? (nextState === 'retryable' ? 'rescan_required' : null);
  const nextNeedsRescan = reason
    ? sameGeneration && before.needsRescan
    : nextCursor !== null && needsRescan;
  const delay = reason ? 60000 : nextState === 'retryable' ? 1000 : 0;
  // Receipt mutations already hold their parent locks. The delivery row is fenced last.
  const locked = one(
    rowSchema,
    await transaction.query(
      `SELECT ${rowColumns} FROM core."omniBindingConfigWakeup" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE`,
      [principal.workspaceId, principal.bindingId, proof.wakeupId],
    ),
  );
  if (
    canonicalAuditJson(snapshot(locked)) !==
      canonicalAuditJson(snapshot(before)) ||
    !locked.leaseLive
  )
    return fail('LEASE_LOST');
  const planned = one(
    z.object({ nextAttemptAt: timestamp }),
    await transaction.query(
      `SELECT to_char((clock_timestamp()+$1*interval '1 millisecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt"`,
      [delay],
    ),
  );
  const expectedAfter = {
    ...snapshot(before),
    state: nextState,
    errorCode: nextError,
    nextAttemptAt: planned.nextAttemptAt,
    leaseOwner: null,
    leaseUntil: null,
    cursorNextAttemptAt: nextCursor?.nextAttemptAt ?? null,
    cursorReceiptId: nextCursor?.id ?? null,
    needsRescan: nextNeedsRescan,
    observedRouteGeneration: transaction.binding.routeGeneration,
  };
  transaction.audit.record({
    resourceKind: 'omniBindingConfigWakeup',
    resourceId: before.id,
    action: 'update',
    before: snapshot(before),
    after: expectedAfter,
    securityDescriptor: {
      resourceKind: 'omniBindingConfigWakeup',
      resourceId: before.id,
      bindingId: principal.bindingId,
    },
  });
  await transaction.audit.flush();
  const after = one(
    rowSchema,
    await transaction.query(
      `WITH changed AS (UPDATE core."omniBindingConfigWakeup" SET state=$6,"errorCode"=$7,"leaseOwner"=NULL,"leaseUntil"=NULL,
     "nextAttemptAt"=$8::timestamptz,"cursorNextAttemptAt"=$9::timestamptz,"cursorReceiptId"=$10,
     "needsRescan"=$11,"observedRouteGeneration"=$12,"updatedAt"=clock_timestamp()
     WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state='running' AND "leaseOwner"=$4 AND "leaseToken"=$5
       AND "leaseUntil">clock_timestamp() RETURNING *) SELECT ${rowColumns} FROM changed`,
      [
        principal.workspaceId,
        principal.bindingId,
        before.id,
        proof.leaseOwner,
        proof.leaseToken,
        nextState,
        nextError,
        planned.nextAttemptAt,
        nextCursor?.nextAttemptAt ?? null,
        nextCursor?.id ?? null,
        nextNeedsRescan,
        transaction.binding.routeGeneration,
      ],
    ),
  );
  if (
    after.id !== before.id ||
    after.workspaceId !== before.workspaceId ||
    canonicalAuditJson(snapshot(after)) !== canonicalAuditJson(expectedAfter)
  )
    return fail('CHECKPOINT_POSTCONDITION');
  createCrmAuditWorkspaceExecutor(transaction.scope);
  return Object.freeze({
    wakeupId: after.id,
    state: after.state,
    resumedReceiptIds: resumed.resumedReceiptIds,
    nextCursor: nextCursor ? Object.freeze(nextCursor) : null,
    needsRescan: after.needsRescan,
  });
};

export const rearmOmniBindingConfigWakeup = async (
  scope: OmniBindingConfigWakeupScope,
  inputPrincipal: OmniBindingConfigWakeupPrincipal,
  inputId: string,
  inputAuthorize: OmniBindingConfigWakeupAuthorizer,
): Promise<boolean> => {
  const principal = principalSchema.parse(inputPrincipal);
  const id = uuid.parse(inputId);
  const authorize = callbacks(inputAuthorize);
  const transaction = await open(scope, principal);
  await authorizeCurrent(
    transaction,
    principal,
    authorize,
    'config_wakeup.rearm',
  );
  const before = one(
    rowSchema,
    await transaction.query(
      `SELECT ${rowColumns} FROM core."omniBindingConfigWakeup" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE`,
      [principal.workspaceId, principal.bindingId, id],
    ),
  );
  await verifyEvent(transaction, principal, before);
  if (before.state !== 'completed') return false;
  const after = one(
    rowSchema,
    await transaction.query(
      `WITH changed AS (UPDATE core."omniBindingConfigWakeup" SET state='pending',"errorCode"=NULL,"nextAttemptAt"=clock_timestamp(),
     "cursorNextAttemptAt"=NULL,"cursorReceiptId"=NULL,"needsRescan"=false,"observedRouteGeneration"=NULL,"updatedAt"=clock_timestamp()
     WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state='completed' RETURNING *) SELECT ${rowColumns} FROM changed`,
      [principal.workspaceId, principal.bindingId, id],
    ),
  );
  recordChange(transaction, before, after);
  await transaction.audit.flush();
  createCrmAuditWorkspaceExecutor(transaction.scope);
  return true;
};
