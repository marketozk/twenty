import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { omniConnectorAcceptanceInputSchema } from 'src/modules/omnichannel/contracts/omni-connector-acceptance';
import { omniHumanTextCommandInputSchema } from 'src/modules/omnichannel/contracts/omni-human-text-command';
import {
  omniHumanCommandRecoveryPrincipalSchema,
  omniHumanCommandDeferInputSchema,
  omniHumanCommandDiscoveryInputSchema,
  omniHumanCommandDiscoveryCursorSchema,
  type OmniHumanCommandRecoveryPrincipal,
  type OmniHumanCommandDeferInput,
  type OmniHumanCommandDeferResult,
  type OmniHumanCommandDiscoveryInput,
  type OmniHumanCommandDiscoveryResult,
} from 'src/modules/omnichannel/contracts/omni-human-command-recovery';
import { type OmniHumanCommandLeaseScope } from 'src/modules/omnichannel/services/claim-omni-human-command';

const fields = omniConnectorAcceptanceInputSchema.unwrap().shape;
const uuid = fields.commandId;
const timestamp = z.iso.datetime({ precision: 6 });
const rowsSchema = z.array(z.record(z.string(), z.unknown()));
const fail = (code: string): never => {
  throw new Error(`OMNI_HUMAN_COMMAND_RECOVERY_${code}`);
};
const one = <Schema extends z.ZodType>(
  schema: Schema,
  rows: unknown[],
): z.infer<Schema> => {
  if (rows.length !== 1) return fail('ROW_INTEGRITY');
  return schema.parse(rows[0]);
};
const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
export type OmniHumanCommandRecoveryScope = OmniHumanCommandLeaseScope;
type BindingDescriptor = Readonly<{
  principal: OmniHumanCommandRecoveryPrincipal;
  bindingId: string;
  bindingStatus: string;
  bindingRevision: string;
  routeGeneration: string;
  policyEpoch: string;
  restoreIncarnation: string;
  capabilitiesVersion: string;
  capabilities: unknown;
}>;
export type OmniHumanCommandDeferDescriptor = Readonly<
  BindingDescriptor & {
    action: 'command.reconcile.defer';
    conversationId: string;
    providerChatId: string;
    queueId: string | null;
    command: Readonly<Record<string, unknown>>;
  }
>;
export type OmniHumanCommandDiscoveryDescriptor = Readonly<
  BindingDescriptor & {
    action: 'command.recovery.discover';
  }
>;
export type OmniHumanCommandDeferCallbacks = Readonly<{
  authorize: (
    scope: OmniHumanCommandRecoveryScope,
    descriptor: OmniHumanCommandDeferDescriptor,
  ) => Promise<void>;
  qualifyTransport: (
    scope: OmniHumanCommandRecoveryScope,
    descriptor: OmniHumanCommandDeferDescriptor,
  ) => Promise<void>;
}>;
export type OmniHumanCommandDiscoveryCallbacks = Readonly<{
  authorize: (
    scope: OmniHumanCommandRecoveryScope,
    descriptor: OmniHumanCommandDiscoveryDescriptor,
  ) => Promise<void>;
}>;
export const snapshotOmniHumanCommandDeferRequest = (
  principal: OmniHumanCommandRecoveryPrincipal,
  input: OmniHumanCommandDeferInput,
  callbacks: OmniHumanCommandDeferCallbacks,
) => {
  const authorize = callbacks?.authorize,
    qualifyTransport = callbacks?.qualifyTransport;
  if (typeof authorize !== 'function' || typeof qualifyTransport !== 'function')
    return fail('CALLBACKS_REQUIRED');
  return Object.freeze({
    principal: omniHumanCommandRecoveryPrincipalSchema.parse(principal),
    input: omniHumanCommandDeferInputSchema.parse(input),
    callbacks: Object.freeze({ authorize, qualifyTransport }),
  });
};
export const snapshotOmniHumanCommandDiscoveryRequest = (
  principal: OmniHumanCommandRecoveryPrincipal,
  input: OmniHumanCommandDiscoveryInput,
  callbacks: OmniHumanCommandDiscoveryCallbacks,
) => {
  const authorize = callbacks?.authorize;
  if (typeof authorize !== 'function') return fail('CALLBACKS_REQUIRED');
  return Object.freeze({
    principal: omniHumanCommandRecoveryPrincipalSchema.parse(principal),
    input: omniHumanCommandDiscoveryInputSchema.parse(input),
    callbacks: Object.freeze({ authorize }),
  });
};

const lockedBinding = async (
  inputScope: OmniHumanCommandRecoveryScope,
  principal: OmniHumanCommandRecoveryPrincipal,
) => {
  if (inputScope.workspaceId !== principal.workspaceId)
    return fail('WORKSPACE_MISMATCH');
  const execute = inputScope.executeRawQuery;
  const scope: OmniHumanCommandRecoveryScope = Object.freeze({
    workspaceId: principal.workspaceId,
    transactionLifecycle: inputScope.transactionLifecycle,
    executeRawQuery: (sql, parameters) =>
      execute.call(inputScope, sql, parameters),
  });
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = async (sql: string, parameters?: unknown[]) =>
    rowsSchema.parse(await executor.query(sql, parameters));
  const policy = one(
    z.object({ epoch: fields.generation, restoreIncarnation: uuid }),
    await query(
      'SELECT epoch,"restoreIncarnation" FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR SHARE',
      [principal.workspaceId],
    ),
  );
  const binding = one(
    z.object({
      id: uuid,
      status: z.string(),
      revision: fields.generation,
      routeGeneration: fields.generation,
      capabilitiesVersion: z.string(),
      capabilities: z.json(),
    }),
    await query(
      'SELECT id,status,revision,"routeGeneration","capabilitiesVersion",capabilities FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [principal.workspaceId, principal.bindingId],
    ),
  );
  const descriptor: BindingDescriptor = freeze({
    principal,
    bindingId: binding.id,
    bindingStatus: binding.status,
    bindingRevision: binding.revision,
    routeGeneration: binding.routeGeneration,
    policyEpoch: policy.epoch,
    restoreIncarnation: policy.restoreIncarnation,
    capabilitiesVersion: binding.capabilitiesVersion,
    capabilities: binding.capabilities,
  });
  return { scope, executor, query, descriptor };
};

const payloadSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: uuid,
  bindingId: uuid,
  conversationId: uuid,
  providerChatId: fields.providerChatId,
  text: omniHumanTextCommandInputSchema.unwrap().shape.text,
  readyFileIds: z.array(z.unknown()).length(0),
  replyToMessageLinkId: z.null(),
  resolvedReplyNativeRef: z.null(),
});
const commandSchema = z
  .object({
    id: uuid,
    workspaceId: uuid,
    conversationId: uuid,
    actorKind: z.literal('workspaceMember'),
    actorId: uuid,
    initiatingActorId: uuid,
    senderClass: z.literal('human'),
    contentProvenance: z.literal('human_direct'),
    policyVersion: z.literal('0'),
    generation: fields.generation,
    statusRevision: fields.generation,
    state: z.enum([
      'pending',
      'dispatching',
      'accepted',
      'outcome_unknown',
      'sent',
      'failed',
      'cancelled',
    ]),
    payload: z.json(),
    payloadHash: fields.payloadHash,
    expectedAutomationEpoch: z.null(),
    producerTurnId: z.null(),
    capturedTurnFence: z.null(),
    referenceId: z.null(),
    workflowCancellationRefs: z.array(z.json()).length(0),
    replacesCommandId: z.null(),
    replyToMessageLinkId: z.null(),
    resolvedReplyNativeRef: z.null(),
    leaseToken: uuid.nullable(),
    leaseUntil: timestamp.nullable(),
    nextAttemptAt: timestamp,
  })
  .passthrough();
const commandColumns = `command.*,
 to_char(command."leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
 to_char(command."nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt",
 to_char(command."cancelRequestedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cancelRequestedAt",
 COALESCE(command."leaseUntil">clock_timestamp(),false) AS "leaseLive"`;
const readSnapshot = (rows: unknown[]) => {
  const row = one(
    z
      .object({
        leaseUntil: timestamp.nullable(),
        nextAttemptAt: timestamp,
        leaseLive: z.boolean(),
      })
      .passthrough(),
    rows,
  );
  const {
    createdAt: _created,
    updatedAt: _updated,
    leaseLive,
    ...snapshot
  } = row;
  return { command: commandSchema.parse(snapshot), leaseLive };
};
const auditSnapshot = (command: Record<string, unknown>) => {
  const { payload: _payload, idempotencyKey: _key, ...snapshot } = command;
  return snapshot;
};

// Only records uncertainty and schedules another status check; never authorizes provider retry.
export const deferOmniHumanCommandReconciliation = async (
  inputScope: OmniHumanCommandRecoveryScope,
  inputPrincipal: OmniHumanCommandRecoveryPrincipal,
  input: OmniHumanCommandDeferInput,
  inputCallbacks: OmniHumanCommandDeferCallbacks,
): Promise<OmniHumanCommandDeferResult> => {
  const request = snapshotOmniHumanCommandDeferRequest(
    inputPrincipal,
    input,
    inputCallbacks,
  );
  const { principal, callbacks } = request;
  const { workspaceId, bindingId } = principal;
  const context = await lockedBinding(inputScope, principal);
  const { scope, executor, query } = context;
  const found = one(
    z.object({ conversationId: uuid }),
    await query(
      `SELECT command."conversationId" FROM core."omniOutgoingCommand" command JOIN core."omniConversation" conversation ON conversation.id=command."conversationId" AND conversation."workspaceId"=command."workspaceId" WHERE command."workspaceId"=$1 AND command.id=$2 AND conversation."bindingId"=$3`,
      [workspaceId, request.input.commandId, bindingId],
    ),
  );
  const conversation = one(
    z.object({
      id: uuid,
      bindingId: uuid,
      providerChatId: fields.providerChatId,
      queueId: uuid.nullable(),
    }),
    await query(
      'SELECT id,"bindingId","providerChatId","queueId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
      [workspaceId, found.conversationId],
    ),
  );
  if (conversation.bindingId !== bindingId) return fail('PARENT_CHANGED');
  const readCommand = () =>
    query(
      `SELECT ${commandColumns} FROM core."omniOutgoingCommand" command WHERE command."workspaceId"=$1 AND command.id=$2 FOR UPDATE`,
      [workspaceId, request.input.commandId],
    );
  const initial = readSnapshot(await readCommand());
  const before = initial.command;
  if (
    before.id !== request.input.commandId ||
    before.workspaceId !== workspaceId ||
    before.conversationId !== conversation.id ||
    before.initiatingActorId !== before.actorId ||
    auditPayloadHash(before.payload) !== before.payloadHash
  )
    return fail('COMMAND_INTEGRITY');
  const payload = payloadSchema.parse(before.payload);
  if (
    payload.workspaceId !== workspaceId ||
    payload.bindingId !== bindingId ||
    payload.conversationId !== conversation.id ||
    payload.providerChatId !== conversation.providerChatId
  )
    return fail('TARGET_INTEGRITY');
  const descriptor: OmniHumanCommandDeferDescriptor = freeze({
    ...context.descriptor,
    action: 'command.reconcile.defer',
    conversationId: conversation.id,
    providerChatId: conversation.providerChatId,
    queueId: conversation.queueId,
    command: auditSnapshot(before),
  });
  await callbacks.authorize(scope, descriptor);
  createCrmAuditWorkspaceExecutor(scope);
  await callbacks.qualifyTransport(scope, descriptor);
  createCrmAuditWorkspaceExecutor(scope);
  const checked = readSnapshot(await readCommand());
  if (canonicalAuditJson(checked.command) !== canonicalAuditJson(before))
    return fail('COMMAND_CHANGED');
  const noOp = (
    reason: Extract<OmniHumanCommandDeferResult, { deferred: false }>['reason'],
  ): OmniHumanCommandDeferResult => Object.freeze({ deferred: false, reason });
  if (
    context.descriptor.restoreIncarnation !==
    request.input.capturedRestoreIncarnation
  )
    return noOp('restore_changed');
  if (['sent', 'failed', 'cancelled'].includes(before.state))
    return noOp('terminal');
  if (before.state === 'pending') return noOp('pending');
  if (
    before.leaseToken !== request.input.leaseToken ||
    before.leaseUntil !== request.input.leaseUntil
  )
    return noOp('lease_superseded');
  if (!checked.leaseLive) return noOp('lease_expired');
  if (BigInt(before.statusRevision) >= 9223372036854775807n)
    return fail('REVISION_EXHAUSTED');
  const timing = one(
    z.object({ nextAttemptAt: timestamp }),
    await query(
      `SELECT to_char((clock_timestamp()+$1*interval '1 millisecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt"`,
      [request.input.retryAfterMilliseconds],
    ),
  );
  const after = {
    ...before,
    state: 'outcome_unknown',
    statusRevision: (BigInt(before.statusRevision) + 1n).toString(),
    leaseToken: null,
    leaseUntil: null,
    nextAttemptAt: timing.nextAttemptAt,
  };
  const audit = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId: randomUUID(),
    actor: principal.actor,
    initiator: { kind: 'workspaceMember', id: before.actorId },
  });
  audit.record({
    resourceKind: 'omniOutgoingCommand',
    resourceId: before.id,
    action: 'update',
    before: auditSnapshot(before),
    after: auditSnapshot(after),
    securityDescriptor: {
      resourceKind: 'omniOutgoingCommand',
      resourceId: before.id,
      bindingId,
      conversationId: conversation.id,
    },
  });
  await audit.flush();
  const result = readSnapshot(
    await query(
      `WITH changed AS (UPDATE core."omniOutgoingCommand" SET state='outcome_unknown',"statusRevision"=$4,"leaseToken"=NULL,"leaseUntil"=NULL,"nextAttemptAt"=$5::timestamptz,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND id=$2 AND "statusRevision"=$3 AND state=$6 AND "leaseToken"=$7::uuid AND "leaseUntil"=$8::timestamptz AND "leaseUntil">clock_timestamp() AND $5::timestamptz>clock_timestamp() RETURNING *) SELECT ${commandColumns} FROM changed command`,
      [
        workspaceId,
        before.id,
        before.statusRevision,
        after.statusRevision,
        after.nextAttemptAt,
        before.state,
        request.input.leaseToken,
        request.input.leaseUntil,
      ],
    ),
  );
  if (
    canonicalAuditJson(result.command) !== canonicalAuditJson(after) ||
    result.leaseLive
  )
    return fail('DEFER_POSTCONDITION');
  const persisted = readSnapshot(await readCommand());
  if (
    canonicalAuditJson(persisted.command) !== canonicalAuditJson(after) ||
    persisted.leaseLive
  )
    return fail('DEFER_READBACK');
  createCrmAuditWorkspaceExecutor(scope);
  return Object.freeze({
    deferred: true,
    commandId: before.id,
    state: 'outcome_unknown',
    statusRevision: after.statusRevision,
    nextAttemptAt: after.nextAttemptAt,
  });
};

export const discoverOmniHumanCommandRecovery = async (
  inputScope: OmniHumanCommandRecoveryScope,
  inputPrincipal: OmniHumanCommandRecoveryPrincipal,
  input: OmniHumanCommandDiscoveryInput,
  inputCallbacks: OmniHumanCommandDiscoveryCallbacks,
): Promise<OmniHumanCommandDiscoveryResult> => {
  const request = snapshotOmniHumanCommandDiscoveryRequest(
    inputPrincipal,
    input,
    inputCallbacks,
  );
  const { principal } = request;
  const { workspaceId, bindingId } = principal;
  const { scope, query, descriptor } = await lockedBinding(
    inputScope,
    principal,
  );
  await request.callbacks.authorize(
    scope,
    freeze({ ...descriptor, action: 'command.recovery.discover' }),
  );
  createCrmAuditWorkspaceExecutor(scope);
  const candidates = z.array(omniHumanCommandDiscoveryCursorSchema).parse(
    await query(
      `SELECT command.id AS "commandId",to_char(command."nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt"
  FROM core."omniOutgoingCommand" command JOIN core."omniConversation" conversation ON conversation.id=command."conversationId" AND conversation."workspaceId"=command."workspaceId"
  WHERE command."workspaceId"=$1 AND conversation."bindingId"=$2
    AND command.state IN ('pending','dispatching','accepted','outcome_unknown')
    AND command."senderClass"='human' AND command."contentProvenance"='human_direct' AND command."actorKind"='workspaceMember' AND command."policyVersion"=0
    AND command."producerTurnId" IS NULL AND command."referenceId" IS NULL AND command."replacesCommandId" IS NULL AND command."replyToMessageLinkId" IS NULL
    AND command."expectedAutomationEpoch" IS NULL AND command."capturedTurnFence" IS NULL AND command."workflowCancellationRefs"='[]'::jsonb AND command."resolvedReplyNativeRef" IS NULL
    AND command.payload->'readyFileIds'='[]'::jsonb AND command.payload->'version'='1'::jsonb
    AND command."nextAttemptAt"<=clock_timestamp() AND (command."leaseUntil" IS NULL OR command."leaseUntil"<=clock_timestamp())
    AND ($3::timestamptz IS NULL OR (command."nextAttemptAt",command.id)>($3::timestamptz,$4::uuid))
  ORDER BY command."nextAttemptAt",command.id LIMIT $5`,
      [
        workspaceId,
        bindingId,
        request.input.cursor?.nextAttemptAt ?? null,
        request.input.cursor?.commandId ?? null,
        request.input.limit + 1,
      ],
    ),
  );
  createCrmAuditWorkspaceExecutor(scope);
  const hasMore = candidates.length > request.input.limit;
  const page = candidates.slice(0, request.input.limit);
  return freeze({
    candidates: page,
    nextCursor: hasMore ? page[page.length - 1] : null,
  });
};
