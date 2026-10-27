import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import { snapshotOmniIncomingCaptureContext } from 'src/modules/omnichannel/contracts/omni-incoming-capture-context';
import { parseOmniIncomingEnvelope } from 'src/modules/omnichannel/contracts/omni-incoming-envelope';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const positiveCounter = counter.refine((value) => BigInt(value) > 0n);
// PostgreSQL timestamps retain six fractional digits; JS Date would lose three.
const databaseTimestamp = z.iso.datetime({ precision: 6 });
const cursorSchema = z
  .strictObject({ nextAttemptAt: databaseTimestamp, id: uuid })
  .readonly();
const inputSchema = z
  .strictObject({
    routeGeneration: positiveCounter,
    limit: z.number().int().min(1).max(100),
    after: cursorSchema.optional(),
  })
  .readonly();
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
          .regex(/^[^\u0000-\u001f\u007f]+$/)
          .refine((value) => value.trim() === value),
      })
      .readonly(),
  })
  .readonly();

export type OmniBlockedHistoryResumeCursor = z.infer<typeof cursorSchema>;
export type OmniBlockedHistoryResumeInput = z.infer<typeof inputSchema>;
export type OmniBlockedHistoryResumePrincipal = z.infer<typeof principalSchema>;
export type OmniBlockedHistoryResumeScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
export type OmniBlockedHistoryResumeAuthorizer = (
  scope: OmniBlockedHistoryResumeScope,
  authorization: Readonly<
    OmniBlockedHistoryResumePrincipal & {
      action: 'history.resume';
      routeGeneration: string;
      bindingRevision: string;
      policyId: string;
      policyVersion: '0';
    }
  >,
) => Promise<void>;
export type OmniBlockedHistoryResumeResult = Readonly<{
  scannedCount: number;
  resumedReceiptIds: readonly string[];
  nextCursor: OmniBlockedHistoryResumeCursor | null;
}>;

export const snapshotOmniBlockedHistoryResumeRequest = (
  principal: OmniBlockedHistoryResumePrincipal,
  input: OmniBlockedHistoryResumeInput,
  authorize: OmniBlockedHistoryResumeAuthorizer,
) => {
  if (typeof authorize !== 'function')
    throw new Error('OMNI_HISTORY_RESUME_AUTHORIZER_REQUIRED');
  return Object.freeze({
    principal: principalSchema.parse(principal),
    input: inputSchema.parse(input),
    authorize,
  });
};

const fail = (reason: string): never => {
  throw new Error(`OMNI_HISTORY_RESUME_${reason}`);
};
const requireOne = <T extends z.ZodType>(
  schema: T,
  rows: unknown[],
): z.infer<T> => {
  if (rows.length !== 1) return fail('MISSING_OR_AMBIGUOUS_RECORD');
  return schema.parse(rows[0]);
};
const receiptSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  bindingId: uuid,
  routeGeneration: positiveCounter,
  eventId: z.string(),
  kind: z.string(),
  schemaVersion: z.number().int().positive(),
  canonicalPayloadHash: z.string(),
  validatedEnvelope: z.unknown(),
  trustedCaptureContext: z.unknown(),
  trustedCaptureContextHash: z.string().nullable(),
  state: z.string(),
  errorCode: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  leaseToken: counter,
  leaseOwner: z.string().nullable(),
  leaseUntilText: databaseTimestamp.nullable(),
  resultId: uuid.nullable(),
  createdAtText: databaseTimestamp,
  nextAttemptAtText: databaseTimestamp,
  updatedAtText: databaseTimestamp,
});
type Receipt = z.infer<typeof receiptSchema>;
const receiptColumns = `id,"workspaceId","bindingId","routeGeneration","eventId",kind,"schemaVersion",
  "canonicalPayloadHash","validatedEnvelope","trustedCaptureContext","trustedCaptureContextHash",
  state,"errorCode",attempts,"leaseToken","leaseOwner","resultId",
  to_char("leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntilText",
  to_char("createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtText",
  to_char("nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAtText",
  to_char("updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtText"`;

const qualifiedChat = (receipt: Receipt): string | null => {
  if (
    receipt.trustedCaptureContext === null ||
    receipt.trustedCaptureContextHash === null
  )
    return null;
  try {
    const envelope = parseOmniIncomingEnvelope(receipt.validatedEnvelope);
    const capture = snapshotOmniIncomingCaptureContext(
      receipt.trustedCaptureContext,
      envelope,
    );
    if (
      receipt.canonicalPayloadHash !== auditPayloadHash(envelope) ||
      receipt.trustedCaptureContextHash !== capture.hash ||
      receipt.bindingId !== envelope.accountBindingId ||
      receipt.routeGeneration !== envelope.routeGeneration ||
      receipt.eventId !== envelope.eventId ||
      receipt.kind !== envelope.kind ||
      receipt.schemaVersion !== envelope.schemaVersion ||
      capture.context.origin !== 'history_import' ||
      envelope.kind !== 'message.received' ||
      envelope.direction !== 'incoming' ||
      envelope.sourceVariant !== 'complete' ||
      envelope.payload.text === null
    )
      return null;
    return envelope.providerChatId;
  } catch {
    // A malformed or unqualified persisted receipt stays blocked for its owner to reconcile.
    return null;
  }
};

const receiptAuditSnapshot = (receipt: Receipt) => ({
  bindingId: receipt.bindingId,
  routeGeneration: receipt.routeGeneration,
  state: receipt.state,
  errorCode: receipt.errorCode,
  attempts: receipt.attempts,
  leaseToken: receipt.leaseToken,
  leaseOwner: receipt.leaseOwner,
  leaseUntil: receipt.leaseUntilText,
  resultId: receipt.resultId,
  nextAttemptAt: receipt.nextAttemptAtText,
});

// Internal primitive: the caller owns a strict transaction, including unknown commit handling.
// A completed scan is a point-in-time pass; later housekeeping starts again without a cursor.
export const resumeOmniBlockedHistoryReceipts = async (
  inputScope: OmniBlockedHistoryResumeScope,
  inputPrincipal: OmniBlockedHistoryResumePrincipal,
  input: OmniBlockedHistoryResumeInput,
  inputAuthorize: OmniBlockedHistoryResumeAuthorizer,
): Promise<OmniBlockedHistoryResumeResult> => {
  const request = snapshotOmniBlockedHistoryResumeRequest(
    inputPrincipal,
    input,
    inputAuthorize,
  );
  const { principal, input: options, authorize } = request;
  const workspaceId = uuid.parse(inputScope.workspaceId);
  if (workspaceId !== principal.workspaceId) return fail('WORKSPACE_MISMATCH');
  const executeRawQuery = inputScope.executeRawQuery;
  const scope: OmniBlockedHistoryResumeScope = Object.freeze({
    workspaceId,
    transactionLifecycle: inputScope.transactionLifecycle,
    executeRawQuery: (sql: string, parameters?: unknown[]) =>
      executeRawQuery.call(inputScope, sql, parameters),
  });
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = executor.query;
  requireOne(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR SHARE',
      [workspaceId],
    ),
  );
  const binding = requireOne(
    z.object({
      id: uuid,
      status: z.literal('active'),
      routeGeneration: positiveCounter,
      revision: positiveCounter,
      connectedAccountId: uuid,
      messageChannelId: uuid,
      defaultQueueId: uuid.nullable(),
      defaultConversationMode: z.string(),
    }),
    await query(
      'SELECT id,status,"routeGeneration",revision,"connectedAccountId","messageChannelId","defaultQueueId","defaultConversationMode" FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, principal.bindingId],
    ),
  );
  if (binding.routeGeneration !== options.routeGeneration)
    return fail('STALE_GENERATION');
  requireOne(
    z.object({ id: uuid }),
    await query(
      `SELECT channel.id FROM core."messageChannel" channel JOIN core."connectedAccount" account ON account.id=channel."connectedAccountId"
     WHERE channel.id=$1 AND channel."workspaceId"=$2 AND channel.type='APP' AND channel."connectedAccountId"=$3
       AND account."workspaceId"=$2 AND account."archivedAt" IS NULL AND account."applicationId" IS NULL AND account."connectionProviderId" IS NULL
     FOR SHARE OF channel,account`,
      [binding.messageChannelId, workspaceId, binding.connectedAccountId],
    ),
  );
  const policy = requireOne(
    z.object({ id: uuid, currentVersion: z.literal('0') }),
    await query(
      'SELECT id,"currentVersion" FROM core."omniAutomationPolicy" WHERE "workspaceId"=$1 AND "bindingId"=$2 FOR SHARE',
      [workspaceId, binding.id],
    ),
  );
  const version = requireOne(
    z.object({ settings: z.unknown(), settingsHash: z.string() }),
    await query(
      'SELECT settings,"settingsHash" FROM core."omniAutomationPolicyVersion" WHERE "workspaceId"=$1 AND "policyId"=$2 AND version=0',
      [workspaceId, policy.id],
    ),
  );
  if (
    auditPayloadHash(version.settings) !== version.settingsHash ||
    canonicalAuditJson(version.settings) !==
      canonicalAuditJson({
        enabled: false,
        maxReplies: 0,
        maxCrmEffects: 0,
        maxHops: 0,
      })
  )
    return fail('POLICY_NOT_DISABLED_V0');
  await authorize(
    scope,
    Object.freeze({
      ...principal,
      action: 'history.resume' as const,
      routeGeneration: binding.routeGeneration,
      bindingRevision: binding.revision,
      policyId: policy.id,
      policyVersion: '0' as const,
    }),
  );

  const page = z.array(receiptSchema).parse(
    await query(
      `SELECT ${receiptColumns} FROM core."omniIncomingReceipt"
     WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "routeGeneration"=$3
       AND state='blocked_config' AND "errorCode"='configuration_missing'
       AND "leaseOwner" IS NULL AND "leaseUntil" IS NULL AND "resultId" IS NULL
       AND ($4::timestamptz IS NULL OR ("nextAttemptAt",id)>($4::timestamptz,$5::uuid))
     ORDER BY "nextAttemptAt",id LIMIT $6`,
      [
        workspaceId,
        binding.id,
        binding.routeGeneration,
        options.after?.nextAttemptAt ?? null,
        options.after?.id ?? null,
        options.limit,
      ],
    ),
  );
  if (
    page.length > options.limit ||
    new Set(page.map((row) => row.id)).size !== page.length ||
    page.some(
      (row) =>
        row.workspaceId !== workspaceId ||
        row.bindingId !== binding.id ||
        row.routeGeneration !== binding.routeGeneration,
    )
  )
    return fail('INVALID_SCAN_RESULT');
  const last = page.at(-1);
  const nextCursor =
    page.length === options.limit && last
      ? Object.freeze({ nextAttemptAt: last.nextAttemptAtText, id: last.id })
      : null;
  const qualified = new Map(
    page.flatMap((row) => {
      const chat = qualifiedChat(row);
      return chat === null ? [] : [[row.id, chat] as const];
    }),
  );
  const chatIds = [...new Set(qualified.values())];
  const conversations =
    chatIds.length === 0
      ? []
      : z
          .array(
            z.object({
              id: uuid,
              workspaceId: uuid,
              bindingId: uuid,
              providerChatId: z.string(),
              queueId: uuid.nullable(),
              policyId: uuid,
              policyVersion: counter,
            }),
          )
          .parse(
            await query(
              `SELECT id,"workspaceId","bindingId","providerChatId","queueId","policyId","policyVersion" FROM core."omniConversation"
     WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "providerChatId"=ANY($3::text[]) ORDER BY id FOR SHARE`,
              [workspaceId, binding.id, chatIds],
            ),
          );
  if (
    new Set(conversations.map((row) => row.providerChatId)).size !==
      conversations.length ||
    conversations.some(
      (row) =>
        row.workspaceId !== workspaceId ||
        row.bindingId !== binding.id ||
        !chatIds.includes(row.providerChatId),
    )
  )
    return fail('INVALID_CONVERSATION_RESULT');
  const byChat = new Map(conversations.map((row) => [row.providerChatId, row]));
  const queueIds = [
    ...new Set([
      ...conversations.flatMap((row) =>
        row.queueId === null ? [] : [row.queueId],
      ),
      ...(binding.defaultQueueId === null ? [] : [binding.defaultQueueId]),
    ]),
  ];
  const queues =
    queueIds.length === 0 || qualified.size === 0
      ? []
      : z
          .array(z.object({ id: uuid }))
          .parse(
            await query(
              'SELECT id FROM core."omniQueue" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=ANY($3::uuid[]) AND active=true ORDER BY id FOR SHARE',
              [workspaceId, binding.id, queueIds],
            ),
          );
  if (
    new Set(queues.map((row) => row.id)).size !== queues.length ||
    queues.some((row) => !queueIds.includes(row.id))
  )
    return fail('INVALID_QUEUE_RESULT');
  const activeQueues = new Set(queues.map((row) => row.id));
  const eligible = page.filter((row) => {
    const chat = qualified.get(row.id);
    if (chat === undefined) return false;
    const conversation = byChat.get(chat);
    return conversation
      ? conversation.policyId === policy.id &&
          conversation.policyVersion === '0' &&
          conversation.queueId !== null &&
          activeQueues.has(conversation.queueId)
      : binding.defaultConversationMode === 'human' &&
          binding.defaultQueueId !== null &&
          activeQueues.has(binding.defaultQueueId);
  });
  const eligibleById = new Map(eligible.map((row) => [row.id, row]));
  // No parent locks are taken after this point. The next sweep revisits skipped locks from its start.
  const locked =
    eligible.length === 0
      ? []
      : z.array(receiptSchema).parse(
          await query(
            `SELECT ${receiptColumns} FROM core."omniIncomingReceipt"
     WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE SKIP LOCKED`,
            [workspaceId, binding.id, [...eligibleById.keys()].sort()],
          ),
        );
  if (
    new Set(locked.map((row) => row.id)).size !== locked.length ||
    locked.some(
      (row) =>
        !eligibleById.has(row.id) ||
        row.workspaceId !== workspaceId ||
        row.bindingId !== binding.id,
    )
  )
    return fail('INVALID_LOCK_RESULT');
  const resumedReceiptIds: string[] = [];
  for (const before of locked) {
    const scanned = eligibleById.get(before.id);
    // Another resume/claim/defer may have won while this transaction waited.
    if (!scanned || canonicalAuditJson(before) !== canonicalAuditJson(scanned))
      continue;
    const after = requireOne(
      receiptSchema,
      await query(
        `UPDATE core."omniIncomingReceipt" SET state='retryable_error',"errorCode"=NULL,"nextAttemptAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
       WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND "routeGeneration"=$4
         AND state='blocked_config' AND "errorCode"='configuration_missing' AND "leaseToken"=$5 AND attempts=$6
         AND "leaseOwner" IS NULL AND "leaseUntil" IS NULL AND "resultId" IS NULL
       RETURNING ${receiptColumns}`,
        [
          workspaceId,
          binding.id,
          before.id,
          binding.routeGeneration,
          before.leaseToken,
          before.attempts,
        ],
      ),
    );
    const preserved = (row: Receipt) => {
      const {
        state: _state,
        errorCode: _error,
        nextAttemptAtText: _next,
        updatedAtText: _updated,
        ...immutable
      } = row;
      return immutable;
    };
    if (
      after.state !== 'retryable_error' ||
      after.errorCode !== null ||
      canonicalAuditJson(preserved(after)) !==
        canonicalAuditJson(preserved(before))
    )
      return fail('TRANSITION_POSTCONDITION');
    const audit = new CrmAuditTransactionContext(executor, {
      workspaceId,
      operationId: uuidV5(
        `omni:history.resume:v1:${before.leaseToken}`,
        before.id,
      ),
      actor: principal.actor,
    });
    audit.record({
      resourceKind: 'omniIncomingReceipt',
      resourceId: before.id,
      action: 'update',
      before: receiptAuditSnapshot(before),
      after: receiptAuditSnapshot(after),
      securityDescriptor: {
        resourceKind: 'omniIncomingReceipt',
        resourceId: before.id,
        bindingId: binding.id,
      },
    });
    await audit.flush();
    resumedReceiptIds.push(before.id);
  }
  return Object.freeze({
    scannedCount: page.length,
    resumedReceiptIds: Object.freeze(resumedReceiptIds),
    nextCursor,
  });
};
