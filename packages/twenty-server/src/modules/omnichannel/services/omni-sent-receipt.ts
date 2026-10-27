import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import {
  omniConnectorAcceptanceInputSchema,
  isOmniConnectorAcceptanceProof,
} from 'src/modules/omnichannel/contracts/omni-connector-acceptance';
import {
  omniSentReceiptPrincipalSchema,
  omniSentReceiptClaimInputSchema,
  parseOmniSentReceiptInput,
  type OmniSentReceiptPrincipal,
  type OmniSentReceiptInput,
  type OmniSentReceiptClaimInput,
  type OmniSentReceiptEnvelope,
  type OmniSentReceiptCaptureContext,
  type OmniSentReceiptAcceptance,
  type OmniSentReceiptClaimResult,
} from 'src/modules/omnichannel/contracts/omni-sent-receipt';

const fields = omniConnectorAcceptanceInputSchema.unwrap().shape;
const uuid = fields.commandId;
const timestamp = z.iso.datetime({ precision: 6 });
const state = z.enum([
  'accepted',
  'processing',
  'applied',
  'retryable_error',
  'blocked_config',
  'quarantined',
]);
const receiptSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  bindingId: uuid,
  eventId: fields.providerChatId,
  kind: z.string(),
  schemaVersion: z.number().int(),
  routeGeneration: fields.generation,
  canonicalPayloadHash: fields.payloadHash,
  validatedEnvelope: z.json(),
  trustedCaptureContext: z.json().nullable(),
  trustedCaptureContextHash: fields.payloadHash.nullable(),
  state,
  attempts: z.number().int().nonnegative(),
  leaseOwner: uuid.nullable(),
  leaseToken: fields.journalSequence,
  leaseUntil: timestamp.nullable(),
  nextAttemptAt: timestamp,
  resultId: uuid.nullable(),
  errorCode: z.string().nullable(),
  updatedAt: timestamp,
  leaseLive: z.boolean(),
  due: z.boolean(),
});
type Receipt = z.infer<typeof receiptSchema>;
const commandSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  conversationId: uuid,
  actorKind: z.literal('workspaceMember'),
  actorId: uuid,
  initiatingActorId: uuid,
  generation: fields.generation,
  payloadHash: fields.payloadHash,
  payload: z.json(),
  senderClass: z.literal('human'),
  contentProvenance: z.literal('human_direct'),
  state: z.enum([
    'pending',
    'dispatching',
    'accepted',
    'outcome_unknown',
    'sent',
    'failed',
    'cancelled',
  ]),
  statusRevision: fields.generation,
  connectorJobId: z.string().nullable(),
  journalSequence: fields.journalSequence.nullable(),
  connectorAcceptedEvidence: z.json().nullable(),
});
export type OmniSentReceiptScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
export type OmniSentReceiptDescriptor = Readonly<{
  principal: OmniSentReceiptPrincipal;
  action: 'sent_receipt.accept' | 'sent_receipt.claim';
  bindingId: string;
  conversationId: string;
  currentRouteGeneration: string;
  bindingStatus: string;
  command: Readonly<{
    id: string;
    generation: string;
    payloadHash: string;
    state: string;
  }>;
  envelope: OmniSentReceiptEnvelope;
  capture: OmniSentReceiptCaptureContext;
}>;
export type OmniSentReceiptCallbacks = Readonly<{
  authorize: (
    scope: OmniSentReceiptScope,
    descriptor: OmniSentReceiptDescriptor,
  ) => Promise<void>;
  verifyEvidence: (
    scope: OmniSentReceiptScope,
    descriptor: OmniSentReceiptDescriptor,
  ) => Promise<void>;
}>;
const fail = (code: string): never => {
  throw new Error(`OMNI_SENT_RECEIPT_${code}`);
};
const one = <Schema extends z.ZodType>(
  schema: Schema,
  rows: unknown[],
): z.infer<Schema> => {
  if (rows.length !== 1) return fail('ROW_INTEGRITY');
  return schema.parse(rows[0]);
};
const snapshotCallbacks = (input: OmniSentReceiptCallbacks) => {
  const authorize = input?.authorize;
  const verifyEvidence = input?.verifyEvidence;
  if (typeof authorize !== 'function' || typeof verifyEvidence !== 'function')
    return fail('CALLBACKS_REQUIRED');
  return Object.freeze({ authorize, verifyEvidence });
};
export const snapshotOmniSentReceiptRequest = (
  principal: OmniSentReceiptPrincipal,
  input: OmniSentReceiptInput,
  callbacks: OmniSentReceiptCallbacks,
) => {
  const captured = snapshotCallbacks(callbacks);
  return Object.freeze({
    principal: omniSentReceiptPrincipalSchema.parse(principal),
    input: parseOmniSentReceiptInput(input),
    callbacks: captured,
  });
};
export const snapshotOmniSentReceiptClaimRequest = (
  principal: OmniSentReceiptPrincipal,
  input: OmniSentReceiptClaimInput,
  callbacks: OmniSentReceiptCallbacks,
) => {
  const captured = snapshotCallbacks(callbacks);
  return Object.freeze({
    principal: omniSentReceiptPrincipalSchema.parse(principal),
    input: omniSentReceiptClaimInputSchema.parse(input),
    callbacks: captured,
  });
};
const receiptColumns = `receipt.*,
  to_char(receipt."leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
  to_char(receipt."nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt",
  to_char(receipt."updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
  COALESCE(receipt."leaseUntil">clock_timestamp(),false) AS "leaseLive",
  receipt."nextAttemptAt"<=clock_timestamp() AS due`;
const stable = (receipt: Receipt) => {
  const {
    leaseLive: _leaseLive,
    due: _due,
    updatedAt: _updatedAt,
    ...snapshot
  } = receipt;
  return snapshot;
};
const scopeSnapshot = (
  input: OmniSentReceiptScope,
  workspaceId: string,
): OmniSentReceiptScope => {
  if (input.workspaceId !== workspaceId) return fail('WORKSPACE_MISMATCH');
  const execute = input.executeRawQuery;
  const scope = Object.freeze({
    workspaceId,
    transactionLifecycle: input.transactionLifecycle,
    executeRawQuery: (sql: string, parameters?: unknown[]) =>
      execute.call(input, sql, parameters),
  });
  createCrmAuditWorkspaceExecutor(scope);
  return scope;
};
const receiptInput = (
  receipt: Receipt,
  principal: OmniSentReceiptPrincipal,
): OmniSentReceiptInput => {
  if (
    receipt.workspaceId !== principal.workspaceId ||
    receipt.bindingId !== principal.bindingId ||
    receipt.kind !== 'command.sent' ||
    receipt.schemaVersion !== 1
  )
    return fail('RECEIPT_SCOPE_CONFLICT');
  const input = parseOmniSentReceiptInput({
    envelope: receipt.validatedEnvelope,
    capture: receipt.trustedCaptureContext,
  });
  if (
    input.envelope.accountBindingId !== principal.bindingId ||
    input.envelope.eventId !== receipt.eventId ||
    input.envelope.routeGeneration !== receipt.routeGeneration ||
    auditPayloadHash(input.envelope) !== receipt.canonicalPayloadHash ||
    auditPayloadHash(input.capture) !== receipt.trustedCaptureContextHash ||
    canonicalAuditJson(input.envelope) !==
      canonicalAuditJson(receipt.validatedEnvelope) ||
    canonicalAuditJson(input.capture) !==
      canonicalAuditJson(receipt.trustedCaptureContext)
  )
    return fail('RECEIPT_INTEGRITY');
  return input;
};
const prepare = async (
  scope: OmniSentReceiptScope,
  principal: OmniSentReceiptPrincipal,
  input: OmniSentReceiptInput,
  callbacks: OmniSentReceiptCallbacks,
  action: OmniSentReceiptDescriptor['action'],
) => {
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = executor.query;
  const { workspaceId, bindingId } = principal;
  const { envelope, capture } = input;
  if (envelope.accountBindingId !== bindingId) return fail('BINDING_MISMATCH');
  one(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR SHARE',
      [workspaceId],
    ),
  );
  const binding = one(
    z.object({
      id: uuid,
      status: z.string(),
      routeGeneration: fields.generation,
    }),
    await query(
      'SELECT id,status,"routeGeneration" FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, bindingId],
    ),
  );
  const discovered = one(
    z.object({ conversationId: uuid }),
    await query(
      `SELECT command."conversationId" FROM core."omniOutgoingCommand" command
    JOIN core."omniConversation" conversation ON conversation."workspaceId"=command."workspaceId" AND conversation.id=command."conversationId"
    WHERE command."workspaceId"=$1 AND command.id=$2 AND conversation."bindingId"=$3`,
      [workspaceId, envelope.commandId, bindingId],
    ),
  );
  const conversation = one(
    z.object({
      id: uuid,
      bindingId: uuid,
      providerChatId: fields.providerChatId,
    }),
    await query(
      'SELECT id,"bindingId","providerChatId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
      [workspaceId, discovered.conversationId],
    ),
  );
  const readCommand = () =>
    query(
      'SELECT * FROM core."omniOutgoingCommand" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
      [workspaceId, envelope.commandId],
    );
  const command = one(commandSchema, await readCommand());
  const payload = z
    .object({
      workspaceId: uuid,
      bindingId: uuid,
      conversationId: uuid,
      providerChatId: fields.providerChatId,
    })
    .parse(command.payload);
  if (
    command.workspaceId !== workspaceId ||
    command.conversationId !== conversation.id ||
    conversation.bindingId !== bindingId ||
    command.actorId !== command.initiatingActorId ||
    command.payloadHash !== auditPayloadHash(command.payload) ||
    payload.workspaceId !== workspaceId ||
    payload.bindingId !== bindingId ||
    payload.conversationId !== conversation.id ||
    payload.providerChatId !== conversation.providerChatId
  )
    return fail('COMMAND_INTEGRITY');
  const descriptor: OmniSentReceiptDescriptor = Object.freeze({
    principal,
    action,
    bindingId,
    conversationId: conversation.id,
    currentRouteGeneration: binding.routeGeneration,
    bindingStatus: binding.status,
    command: Object.freeze({
      id: command.id,
      generation: command.generation,
      payloadHash: command.payloadHash,
      state: command.state,
    }),
    envelope,
    capture,
  });
  await callbacks.authorize(scope, descriptor);
  createCrmAuditWorkspaceExecutor(scope);
  if (
    envelope.routeGeneration !== command.generation ||
    envelope.payloadHash !== command.payloadHash ||
    envelope.providerChatId !== conversation.providerChatId
  )
    return fail('COMMAND_EVIDENCE_CONFLICT');
  if (
    (command.connectorJobId !== null &&
      command.connectorJobId !== envelope.connectorJobId) ||
    (command.journalSequence !== null &&
      command.journalSequence !== envelope.journalSequence)
  )
    return fail('ACCEPTANCE_CONFLICT');
  if (
    command.connectorAcceptedEvidence !== null &&
    !isOmniConnectorAcceptanceProof(command.connectorAcceptedEvidence, {
      workspaceId,
      bindingId,
      conversationId: conversation.id,
      commandId: command.id,
      providerChatId: conversation.providerChatId,
      payloadHash: command.payloadHash,
      generation: command.generation,
      connectorJobId: command.connectorJobId,
      journalSequence: command.journalSequence,
      state: command.state,
      payload: command.payload,
    })
  )
    return fail('ACCEPTANCE_CONFLICT');
  await callbacks.verifyEvidence(scope, descriptor);
  createCrmAuditWorkspaceExecutor(scope);
  if (
    canonicalAuditJson(one(commandSchema, await readCommand())) !==
    canonicalAuditJson(command)
  )
    return fail('COMMAND_CHANGED');
  if (
    !['dispatching', 'accepted', 'outcome_unknown', 'sent'].includes(
      command.state,
    ) ||
    BigInt(command.statusRevision) < 2n
  )
    return fail('COMMAND_STATE_CONFLICT');
  return { executor, query, conversationId: conversation.id };
};

export const acceptOmniSentReceipt = async (
  inputScope: OmniSentReceiptScope,
  inputPrincipal: OmniSentReceiptPrincipal,
  input: OmniSentReceiptInput,
  inputCallbacks: OmniSentReceiptCallbacks,
): Promise<OmniSentReceiptAcceptance> => {
  const request = snapshotOmniSentReceiptRequest(
    inputPrincipal,
    input,
    inputCallbacks,
  );
  const { principal, callbacks } = request;
  const scope = scopeSnapshot(inputScope, principal.workspaceId);
  const { executor, query } = await prepare(
    scope,
    principal,
    request.input,
    callbacks,
    'sent_receipt.accept',
  );
  const { workspaceId, bindingId } = principal;
  const { envelope, capture } = request.input;
  const inserted = await query(
    `INSERT INTO core."omniIncomingReceipt" (id,"workspaceId","bindingId","eventId",kind,"schemaVersion","routeGeneration",
    "canonicalPayloadHash","validatedEnvelope","trustedCaptureContext","trustedCaptureContextHash") VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8::jsonb,$9::jsonb,$10)
    ON CONFLICT ("workspaceId","bindingId","eventId") DO NOTHING RETURNING id`,
    [
      randomUUID(),
      workspaceId,
      bindingId,
      envelope.eventId,
      envelope.kind,
      envelope.routeGeneration,
      auditPayloadHash(envelope),
      canonicalAuditJson(envelope),
      canonicalAuditJson(capture),
      auditPayloadHash(capture),
    ],
  );
  const readReceipt = () =>
    query(
      `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" receipt
    WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "eventId"=$3 FOR UPDATE`,
      [workspaceId, bindingId, envelope.eventId],
    );
  const receipt = one(receiptSchema, await readReceipt());
  if (
    canonicalAuditJson(receiptInput(receipt, principal)) !==
    canonicalAuditJson(request.input)
  )
    return fail('EVENT_CONFLICT');
  const created = inserted.length === 1;
  if (created) {
    if (
      one(z.object({ id: uuid }), inserted).id !== receipt.id ||
      receipt.state !== 'accepted' ||
      receipt.attempts !== 0 ||
      receipt.leaseToken !== '0' ||
      receipt.leaseOwner !== null ||
      receipt.leaseUntil !== null ||
      receipt.resultId !== null ||
      receipt.errorCode !== null
    )
      return fail('ACCEPT_POSTCONDITION');
    const audit = new CrmAuditTransactionContext(executor, {
      workspaceId,
      operationId: receipt.id,
      actor: principal.actor,
    });
    audit.record({
      resourceKind: 'omniIncomingReceipt',
      resourceId: receipt.id,
      action: 'create',
      before: null,
      after: stable(receipt),
      securityDescriptor: {
        resourceKind: 'omniIncomingReceipt',
        resourceId: receipt.id,
        bindingId,
      },
    });
    await audit.flush();
    if (
      canonicalAuditJson(stable(one(receiptSchema, await readReceipt()))) !==
      canonicalAuditJson(stable(receipt))
    )
      return fail('ACCEPT_POSTCONDITION');
  }
  createCrmAuditWorkspaceExecutor(scope);
  return Object.freeze({
    receiptId: receipt.id,
    state: receipt.state,
    created,
  });
};

export const claimOmniSentReceipt = async (
  inputScope: OmniSentReceiptScope,
  inputPrincipal: OmniSentReceiptPrincipal,
  input: OmniSentReceiptClaimInput,
  inputCallbacks: OmniSentReceiptCallbacks,
): Promise<OmniSentReceiptClaimResult> => {
  const request = snapshotOmniSentReceiptClaimRequest(
    inputPrincipal,
    input,
    inputCallbacks,
  );
  const { principal, callbacks } = request;
  const { workspaceId, bindingId } = principal;
  const scope = scopeSnapshot(inputScope, workspaceId);
  const initialExecutor = createCrmAuditWorkspaceExecutor(scope);
  const readReceipt = (lock: string) =>
    initialExecutor.query(
      `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" receipt
    WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 ${lock}`,
      [workspaceId, bindingId, request.input.receiptId],
    );
  // Discover immutable parent IDs without a receipt lock; receipt locks are last.
  const discovered = one(receiptSchema, await readReceipt(''));
  const saved = receiptInput(discovered, principal);
  const { executor, query } = await prepare(
    scope,
    principal,
    saved,
    callbacks,
    'sent_receipt.claim',
  );
  const before = one(receiptSchema, await readReceipt('FOR UPDATE'));
  if (
    canonicalAuditJson(receiptInput(before, principal)) !==
    canonicalAuditJson(saved)
  )
    return fail('RECEIPT_CHANGED');
  const noClaim = (
    reason: 'lease_live' | 'not_due' | 'applied' | 'not_claimable',
  ): OmniSentReceiptClaimResult => Object.freeze({ claimed: false, reason });
  if (before.state === 'applied') return noClaim('applied');
  if (!['accepted', 'processing', 'retryable_error'].includes(before.state))
    return noClaim('not_claimable');
  if (before.resultId !== null) return fail('RESULT_CONFLICT');
  if (before.leaseLive) return noClaim('lease_live');
  if (before.state !== 'processing' && !before.due) return noClaim('not_due');
  if (
    BigInt(before.leaseToken) >= 9223372036854775807n ||
    before.attempts >= 2147483647
  )
    return fail('COUNTER_EXHAUSTED');
  const timing = one(
    z.object({ leaseUntil: timestamp }),
    await query(
      `SELECT to_char((clock_timestamp()+$1*interval '1 millisecond') AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil"`,
      [request.input.leaseMilliseconds],
    ),
  );
  const after = {
    ...stable(before),
    state: 'processing',
    attempts: before.attempts + 1,
    leaseOwner: request.input.leaseOwner,
    leaseToken: (BigInt(before.leaseToken) + 1n).toString(),
    leaseUntil: timing.leaseUntil,
    errorCode: null,
  };
  const audit = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId: randomUUID(),
    actor: principal.actor,
  });
  audit.record({
    resourceKind: 'omniIncomingReceipt',
    resourceId: before.id,
    action: 'update',
    before: stable(before),
    after,
    securityDescriptor: {
      resourceKind: 'omniIncomingReceipt',
      resourceId: before.id,
      bindingId,
    },
  });
  await audit.flush();
  const updated = one(
    receiptSchema,
    await query(
      `WITH changed AS (UPDATE core."omniIncomingReceipt" SET state='processing',attempts=$4,
    "leaseOwner"=$5,"leaseToken"=$6,"leaseUntil"=$7::timestamptz,"errorCode"=NULL,"updatedAt"=clock_timestamp()
    WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state=$8 AND "leaseToken"=$9
      AND "leaseOwner" IS NOT DISTINCT FROM $10::text AND "leaseUntil" IS NOT DISTINCT FROM $11::timestamptz
      AND "updatedAt"=$12::timestamptz AND "resultId" IS NULL
      AND ((state IN ('accepted','retryable_error') AND "nextAttemptAt"<=clock_timestamp() AND ("leaseUntil" IS NULL OR "leaseUntil"<=clock_timestamp()))
        OR (state='processing' AND "leaseUntil"<=clock_timestamp())) AND $7::timestamptz>clock_timestamp()
    RETURNING *) SELECT ${receiptColumns} FROM changed receipt`,
      [
        workspaceId,
        bindingId,
        before.id,
        after.attempts,
        after.leaseOwner,
        after.leaseToken,
        after.leaseUntil,
        before.state,
        before.leaseToken,
        before.leaseOwner,
        before.leaseUntil,
        before.updatedAt,
      ],
    ),
  );
  if (
    !updated.leaseLive ||
    canonicalAuditJson(stable(updated)) !== canonicalAuditJson(after)
  )
    return fail('CLAIM_POSTCONDITION');
  createCrmAuditWorkspaceExecutor(scope);
  return Object.freeze({
    claimed: true,
    proof: Object.freeze({
      receiptId: before.id,
      leaseOwner: after.leaseOwner,
      leaseToken: after.leaseToken,
      leaseUntil: after.leaseUntil,
      routeGeneration: before.routeGeneration,
    }),
    envelope: saved.envelope,
    capture: saved.capture,
  });
};
