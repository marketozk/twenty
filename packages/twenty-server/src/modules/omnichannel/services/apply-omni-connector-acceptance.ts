import { v5 as uuidV5 } from 'uuid';
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
  omniConnectorAcceptancePrincipalSchema,
  omniConnectorAcceptanceProofSchema,
  isOmniConnectorAcceptanceProof,
  type OmniConnectorAcceptanceInput,
  type OmniConnectorAcceptancePrincipal,
  type OmniConnectorAcceptanceProof,
  type OmniConnectorAcceptanceResult,
} from 'src/modules/omnichannel/contracts/omni-connector-acceptance';

const uuid = z.uuid();
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const positive = counter.refine((value) => BigInt(value) > 0n);
const timestamp = z.iso.datetime({ precision: 6 });
const commandSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  conversationId: uuid,
  actorKind: z.literal('workspaceMember'),
  actorId: uuid,
  initiatingActorId: uuid,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.json(),
  generation: positive,
  policyId: uuid,
  policyVersion: counter,
  senderClass: z.literal('human'),
  contentProvenance: z.literal('human_direct'),
  outboundSequence: positive,
  state: z.enum([
    'pending',
    'dispatching',
    'accepted',
    'outcome_unknown',
    'sent',
    'failed',
    'cancelled',
  ]),
  statusRevision: positive,
  connectorJobId: z.string().nullable(),
  journalSequence: counter.nullable(),
  connectorAcceptedEvidence: z.json().nullable(),
  leaseToken: uuid.nullable(),
  leaseUntil: timestamp.nullable(),
  nextAttemptAt: timestamp,
  cancelRequestedAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  cancelEvidence: z.json().nullable(),
  expectedAutomationEpoch: positive.nullable(),
  producerTurnId: uuid.nullable(),
  capturedTurnFence: positive.nullable(),
  referenceId: uuid.nullable(),
  workflowCancellationRefs: z.array(z.json()),
  replacesCommandId: uuid.nullable(),
  replyToMessageLinkId: uuid.nullable(),
  resolvedReplyNativeRef: z.json().nullable(),
});
type Command = z.infer<typeof commandSchema>;
export type OmniConnectorAcceptanceScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
export type OmniConnectorAcceptanceDescriptor = Readonly<{
  principal: OmniConnectorAcceptancePrincipal;
  action: 'command.acceptance';
  bindingId: string;
  conversationId: string;
  providerChatId: string;
  currentRouteGeneration: string;
  bindingStatus: string;
  policyEpoch: string;
  restoreIncarnation: string;
  command: Readonly<
    Pick<
      Command,
      | 'id'
      | 'actorKind'
      | 'actorId'
      | 'generation'
      | 'payloadHash'
      | 'state'
      | 'statusRevision'
      | 'outboundSequence'
      | 'connectorJobId'
      | 'journalSequence'
    >
  >;
  evidence: OmniConnectorAcceptanceProof;
}>;
export type OmniConnectorAcceptanceCallbacks = Readonly<{
  authorize: (
    scope: OmniConnectorAcceptanceScope,
    descriptor: OmniConnectorAcceptanceDescriptor,
  ) => Promise<void>;
  verifyEvidence: (
    scope: OmniConnectorAcceptanceScope,
    descriptor: OmniConnectorAcceptanceDescriptor,
  ) => Promise<void>;
}>;
const fail = (code: string): never => {
  throw new Error(`OMNI_CONNECTOR_ACCEPTANCE_${code}`);
};
const one = <Schema extends z.ZodType>(
  schema: Schema,
  rows: unknown[],
): z.infer<Schema> => {
  if (rows.length !== 1) return fail('ROW_INTEGRITY');
  return schema.parse(rows[0]);
};
export const snapshotOmniConnectorAcceptanceRequest = (
  inputPrincipal: OmniConnectorAcceptancePrincipal,
  input: OmniConnectorAcceptanceInput,
  inputCallbacks: OmniConnectorAcceptanceCallbacks,
) => {
  const authorize = inputCallbacks?.authorize;
  const verifyEvidence = inputCallbacks?.verifyEvidence;
  if (typeof authorize !== 'function' || typeof verifyEvidence !== 'function')
    return fail('CALLBACKS_REQUIRED');
  return Object.freeze({
    principal: omniConnectorAcceptancePrincipalSchema.parse(inputPrincipal),
    input: omniConnectorAcceptanceInputSchema.parse(input),
    callbacks: Object.freeze({ authorize, verifyEvidence }),
  });
};
const columns = `command.*,
  to_char(command."leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
  to_char(command."nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt",
  to_char(command."cancelRequestedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cancelRequestedAt"`;

// A qualified durable enqueue fact survives lease expiry and historical route revocation; it grants no new send.
export const applyOmniConnectorAcceptance = async (
  inputScope: OmniConnectorAcceptanceScope,
  inputPrincipal: OmniConnectorAcceptancePrincipal,
  input: OmniConnectorAcceptanceInput,
  inputCallbacks: OmniConnectorAcceptanceCallbacks,
): Promise<OmniConnectorAcceptanceResult> => {
  const request = snapshotOmniConnectorAcceptanceRequest(
    inputPrincipal,
    input,
    inputCallbacks,
  );
  const { principal, callbacks } = request;
  const { workspaceId, bindingId } = principal;
  if (inputScope.workspaceId !== workspaceId) return fail('WORKSPACE_MISMATCH');
  const execute = inputScope.executeRawQuery;
  const scope: OmniConnectorAcceptanceScope = Object.freeze({
    workspaceId,
    transactionLifecycle: inputScope.transactionLifecycle,
    executeRawQuery: (sql, parameters) =>
      execute.call(inputScope, sql, parameters),
  });
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = executor.query;
  const assertActive = () => {
    createCrmAuditWorkspaceExecutor(scope);
  };
  const policy = one(
    z.object({ id: uuid, epoch: positive, restoreIncarnation: uuid }),
    await query(
      'SELECT id,epoch,"restoreIncarnation" FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR SHARE',
      [workspaceId],
    ),
  );
  const binding = one(
    z.object({ id: uuid, routeGeneration: positive, status: z.string() }),
    await query(
      'SELECT id,"routeGeneration",status FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, bindingId],
    ),
  );
  const discovered = one(
    z.object({ conversationId: uuid }),
    await query(
      `SELECT command."conversationId" FROM core."omniOutgoingCommand" command
     JOIN core."omniConversation" conversation ON conversation."workspaceId"=command."workspaceId" AND conversation.id=command."conversationId"
     WHERE command."workspaceId"=$1 AND command.id=$2 AND conversation."bindingId"=$3`,
      [workspaceId, request.input.commandId, bindingId],
    ),
  );
  const conversation = one(
    z.object({ id: uuid, bindingId: uuid, providerChatId: z.string().min(1) }),
    await query(
      'SELECT id,"bindingId","providerChatId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
      [workspaceId, discovered.conversationId],
    ),
  );
  if (conversation.bindingId !== bindingId) return fail('PARENT_CHANGED');
  const readCommand = () =>
    query(
      `SELECT ${columns} FROM core."omniOutgoingCommand" command WHERE command."workspaceId"=$1 AND command.id=$2 FOR UPDATE`,
      [workspaceId, request.input.commandId],
    );
  const before = one(commandSchema, await readCommand());
  if (
    before.id !== request.input.commandId ||
    before.workspaceId !== workspaceId ||
    before.conversationId !== conversation.id ||
    before.initiatingActorId !== before.actorId ||
    auditPayloadHash(before.payload) !== before.payloadHash
  )
    return fail('COMMAND_INTEGRITY');
  const payload = z
    .object({
      workspaceId: uuid,
      bindingId: uuid,
      conversationId: uuid,
      providerChatId: z.string().min(1),
    })
    .parse(before.payload);
  if (
    payload.workspaceId !== workspaceId ||
    payload.bindingId !== bindingId ||
    payload.conversationId !== conversation.id ||
    payload.providerChatId !== conversation.providerChatId
  )
    return fail('TARGET_INTEGRITY');
  const evidence = omniConnectorAcceptanceProofSchema.parse({
    ...request.input,
    schemaVersion: 1,
    evidenceKind: 'connector.durable_acceptance',
    workspaceId,
    bindingId,
    conversationId: conversation.id,
  });
  const descriptor: OmniConnectorAcceptanceDescriptor = Object.freeze({
    principal,
    action: 'command.acceptance',
    bindingId,
    conversationId: conversation.id,
    providerChatId: conversation.providerChatId,
    currentRouteGeneration: binding.routeGeneration,
    bindingStatus: binding.status,
    policyEpoch: policy.epoch,
    restoreIncarnation: policy.restoreIncarnation,
    command: Object.freeze({
      id: before.id,
      actorKind: before.actorKind,
      actorId: before.actorId,
      generation: before.generation,
      payloadHash: before.payloadHash,
      state: before.state,
      statusRevision: before.statusRevision,
      outboundSequence: before.outboundSequence,
      connectorJobId: before.connectorJobId,
      journalSequence: before.journalSequence,
    }),
    evidence,
  });
  await callbacks.authorize(scope, descriptor);
  assertActive();
  if (
    request.input.payloadHash !== before.payloadHash ||
    request.input.generation !== before.generation ||
    request.input.providerChatId !== conversation.providerChatId
  )
    return fail('EVIDENCE_CONFLICT');
  await callbacks.verifyEvidence(scope, descriptor);
  assertActive();
  const unchanged = one(commandSchema, await readCommand());
  if (canonicalAuditJson(unchanged) !== canonicalAuditJson(before))
    return fail('COMMAND_CHANGED');
  if (
    !['dispatching', 'accepted', 'outcome_unknown', 'sent'].includes(
      before.state,
    )
  )
    return fail('STATE_CONFLICT');
  const resultState =
    before.state === 'dispatching'
      ? 'accepted'
      : z.enum(['accepted', 'outcome_unknown', 'sent']).parse(before.state);
  const context = {
    workspaceId,
    bindingId,
    conversationId: conversation.id,
    commandId: before.id,
    providerChatId: conversation.providerChatId,
    payloadHash: before.payloadHash,
    generation: before.generation,
    connectorJobId: before.connectorJobId,
    journalSequence: before.journalSequence,
    state: before.state,
    payload: before.payload,
  };
  const hasExistingFact =
    before.connectorAcceptedEvidence !== null ||
    before.connectorJobId !== null ||
    before.journalSequence !== null;
  if (hasExistingFact) {
    if (
      !isOmniConnectorAcceptanceProof(
        before.connectorAcceptedEvidence,
        context,
      ) ||
      canonicalAuditJson(before.connectorAcceptedEvidence) !==
        canonicalAuditJson(evidence)
    )
      return fail('EVIDENCE_CONFLICT');
    // A duplicate must not invalidate a newer status-reconciliation lease or change its state.
    return Object.freeze({
      commandId: before.id,
      state: z
        .enum(['accepted', 'outcome_unknown', 'sent'])
        .parse(before.state),
      statusRevision: before.statusRevision,
      applied: false,
    });
  }
  if (BigInt(before.statusRevision) >= 9223372036854775807n)
    return fail('REVISION_EXHAUSTED');
  const after = {
    ...before,
    connectorJobId: evidence.connectorJobId,
    connectorAcceptedEvidence: evidence,
    journalSequence: evidence.journalSequence,
    state: resultState,
    statusRevision: (BigInt(before.statusRevision) + 1n).toString(),
    leaseToken: null,
    leaseUntil: null,
  };
  const audit = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId: uuidV5('omni:connector.acceptance:v1', before.id),
    actor: principal.actor,
    initiator: { kind: 'workspaceMember', id: before.actorId },
  });
  audit.record({
    resourceKind: 'omniOutgoingCommand',
    resourceId: before.id,
    action: 'update',
    before,
    after,
    securityDescriptor: {
      resourceKind: 'omniOutgoingCommand',
      resourceId: before.id,
      bindingId,
      conversationId: conversation.id,
    },
  });
  await audit.flush();
  const updated = one(
    commandSchema,
    await query(
      `WITH changed AS (
    UPDATE core."omniOutgoingCommand" SET "connectorJobId"=$4,"connectorAcceptedEvidence"=$5::jsonb,"journalSequence"=$6,
      state=$7,"statusRevision"=$8,"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=clock_timestamp()
    WHERE "workspaceId"=$1 AND id=$2 AND "statusRevision"=$3 AND state=$9
      AND "connectorJobId" IS NULL AND "connectorAcceptedEvidence" IS NULL AND "journalSequence" IS NULL
    RETURNING *) SELECT ${columns} FROM changed command`,
      [
        workspaceId,
        before.id,
        before.statusRevision,
        evidence.connectorJobId,
        canonicalAuditJson(evidence),
        evidence.journalSequence,
        resultState,
        after.statusRevision,
        before.state,
      ],
    ),
  );
  if (
    canonicalAuditJson(updated) !== canonicalAuditJson(after) ||
    !isOmniConnectorAcceptanceProof(updated.connectorAcceptedEvidence, {
      ...context,
      state: updated.state,
      connectorJobId: updated.connectorJobId,
      journalSequence: updated.journalSequence,
    })
  )
    return fail('APPLY_POSTCONDITION');
  assertActive();
  return Object.freeze({
    commandId: before.id,
    state: resultState,
    statusRevision: updated.statusRevision,
    applied: true,
  });
};
