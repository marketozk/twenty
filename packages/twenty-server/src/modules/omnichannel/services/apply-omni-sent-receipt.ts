import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditResourceKind } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  omniConnectorAcceptanceInputSchema,
  omniConnectorAcceptanceProofSchema,
  isOmniConnectorAcceptanceProof,
} from 'src/modules/omnichannel/contracts/omni-connector-acceptance';
import {
  omniSentReceiptPrincipalSchema,
  parseOmniSentReceiptInput,
  type OmniSentReceiptPrincipal,
  type OmniSentReceiptInput,
} from 'src/modules/omnichannel/contracts/omni-sent-receipt';
import {
  type OmniSentReceiptScope,
  type OmniSentReceiptDescriptor,
} from 'src/modules/omnichannel/services/omni-sent-receipt';
import { buildOmniNativeMessageReferences } from 'src/modules/omnichannel/services/build-omni-native-message-references';

const fields = omniConnectorAcceptanceInputSchema.unwrap().shape;
const uuid = fields.commandId;
const timestamp = z.iso.datetime({ precision: 6 });
const queryRowsSchema = z.array(z.record(z.string(), z.unknown()));
const proofSchema = z
  .strictObject({
    receiptId: uuid,
    leaseOwner: uuid,
    leaseToken: fields.generation,
    routeGeneration: fields.generation,
    leaseUntil: timestamp,
  })
  .readonly();
export type OmniSentApplyPrincipal = OmniSentReceiptPrincipal;
export type OmniSentApplyScope = OmniSentReceiptScope;
export type OmniSentApplyProof = z.infer<typeof proofSchema>;
export type OmniSentApplyDescriptor = Readonly<
  Omit<OmniSentReceiptDescriptor, 'action'> & {
    action: 'sent_receipt.apply';
    receiptId: string;
  }
>;
export type OmniSentApplyCallbacks = Readonly<{
  authorize: (
    scope: OmniSentApplyScope,
    descriptor: OmniSentApplyDescriptor,
  ) => Promise<void>;
  verifyEvidence: (
    scope: OmniSentApplyScope,
    descriptor: OmniSentApplyDescriptor,
  ) => Promise<void>;
}>;
export type OmniSentApplyNativeInput = Readonly<{
  workspaceId: string;
  messageChannelId: string;
  messageThreadId: string;
  headerMessageId: string;
  messageExternalId: string;
  messageThreadExternalId: string;
  subject: null;
  text: string;
  receivedAt: string;
  workspaceMemberId: string | null;
}>;
export type OmniSentApplyNativePort = {
  createInitialMessage: (input: OmniSentApplyNativeInput) => Promise<{
    messageId: string;
    participantId: string;
    associationId: string;
    createdThread: boolean;
  }>;
};
export type OmniSentApplyResult = Readonly<{
  receiptId: string;
  messageLinkId: string;
  messageId: string;
  conversationId: string;
  created: boolean;
  state: 'applied';
}>;
export const snapshotOmniSentApplyRequest = (
  principal: OmniSentApplyPrincipal,
  proof: OmniSentApplyProof,
  callbacks: OmniSentApplyCallbacks,
) => {
  const authorize = callbacks?.authorize;
  const verifyEvidence = callbacks?.verifyEvidence;
  if (typeof authorize !== 'function' || typeof verifyEvidence !== 'function')
    throw new Error('OMNI_SENT_APPLY_CALLBACKS_REQUIRED');
  return Object.freeze({
    principal: omniSentReceiptPrincipalSchema.parse(principal),
    proof: proofSchema.parse(proof),
    callbacks: Object.freeze({ authorize, verifyEvidence }),
  });
};
const fail = (code: string): never => {
  throw new Error(`OMNI_SENT_APPLY_${code}`);
};
const one = <Schema extends z.ZodType>(
  schema: Schema,
  rows: unknown[],
): z.infer<Schema> => {
  if (rows.length !== 1) return fail('ROW_INTEGRITY');
  return schema.parse(rows[0]);
};
const same = (actual: unknown, expected: unknown, code: string) => {
  if (canonicalAuditJson(actual) !== canonicalAuditJson(expected))
    return fail(code);
};
const project = (
  row: Record<string, unknown>,
  expected: Record<string, unknown>,
) => Object.fromEntries(Object.keys(expected).map((key) => [key, row[key]]));
const exact = (
  rows: Record<string, unknown>[],
  expected: Record<string, unknown>,
  code: string,
) => {
  if (rows.length !== 1) return fail(code);
  same(project(rows[0], expected), expected, code);
  return rows[0];
};
const iso = (value: unknown) =>
  z
    .union([z.date(), z.iso.datetime({ offset: true })])
    .transform((item) => new Date(item).toISOString())
    .parse(value);
const receiptSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  bindingId: uuid,
  eventId: fields.providerChatId,
  kind: z.literal('command.sent'),
  schemaVersion: z.literal(1),
  routeGeneration: fields.generation,
  canonicalPayloadHash: fields.payloadHash,
  validatedEnvelope: z.json(),
  trustedCaptureContext: z.json(),
  trustedCaptureContextHash: fields.payloadHash,
  state: z.string(),
  leaseOwner: uuid.nullable(),
  leaseToken: fields.journalSequence,
  leaseUntil: timestamp.nullable(),
  resultId: uuid.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  errorCode: z.string().nullable(),
  leaseLive: z.boolean(),
});
type Receipt = z.infer<typeof receiptSchema>;
const receiptColumns = `receipt.*,
  to_char(receipt."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  to_char(receipt."updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
  to_char(receipt."leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
  COALESCE(receipt."leaseUntil">clock_timestamp(),false) AS "leaseLive"`;
const storedInput = (receipt: Receipt, principal: OmniSentApplyPrincipal) => {
  if (
    receipt.workspaceId !== principal.workspaceId ||
    receipt.bindingId !== principal.bindingId
  )
    return fail('RECEIPT_SCOPE');
  const parsed = parseOmniSentReceiptInput({
    envelope: receipt.validatedEnvelope,
    capture: receipt.trustedCaptureContext,
  });
  if (
    parsed.envelope.accountBindingId !== principal.bindingId ||
    parsed.envelope.eventId !== receipt.eventId ||
    parsed.envelope.routeGeneration !== receipt.routeGeneration ||
    auditPayloadHash(parsed.envelope) !== receipt.canonicalPayloadHash ||
    auditPayloadHash(parsed.capture) !== receipt.trustedCaptureContextHash
  )
    return fail('RECEIPT_INTEGRITY');
  same(parsed.envelope, receipt.validatedEnvelope, 'RECEIPT_INTEGRITY');
  same(parsed.capture, receipt.trustedCaptureContext, 'RECEIPT_INTEGRITY');
  return parsed;
};
const immutableReceipt = (receipt: Receipt) => ({
  id: receipt.id,
  workspaceId: receipt.workspaceId,
  bindingId: receipt.bindingId,
  eventId: receipt.eventId,
  kind: receipt.kind,
  schemaVersion: receipt.schemaVersion,
  routeGeneration: receipt.routeGeneration,
  canonicalPayloadHash: receipt.canonicalPayloadHash,
  validatedEnvelope: receipt.validatedEnvelope,
  trustedCaptureContext: receipt.trustedCaptureContext,
  trustedCaptureContextHash: receipt.trustedCaptureContextHash,
  createdAt: receipt.createdAt,
});
const stableReceipt = (receipt: Receipt) => {
  const { leaseLive: _live, ...rest } = receipt;
  return rest;
};
const commandSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  conversationId: uuid,
  actorKind: z.literal('workspaceMember'),
  actorId: uuid,
  initiatingActorId: uuid,
  idempotencyKey: z.string(),
  outboundSequence: fields.generation,
  expectedAutomationEpoch: z.null(),
  producerTurnId: z.null(),
  capturedTurnFence: z.null(),
  referenceId: z.null(),
  workflowCancellationRefs: z.array(z.json()).length(0),
  replacesCommandId: z.null(),
  replyToMessageLinkId: z.null(),
  resolvedReplyNativeRef: z.null(),
  payload: z.json(),
  payloadHash: fields.payloadHash,
  generation: fields.generation,
  policyId: uuid,
  policyVersion: z.literal('0'),
  senderClass: z.literal('human'),
  contentProvenance: z.literal('human_direct'),
  state: z.string(),
  statusRevision: fields.generation,
  connectorJobId: z.string().nullable(),
  journalSequence: fields.journalSequence.nullable(),
  connectorAcceptedEvidence: z.json().nullable(),
  leaseToken: uuid.nullable(),
  leaseUntil: timestamp.nullable(),
  nextAttemptAt: timestamp,
  cancelRequestedAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  cancelEvidence: z.json().nullable(),
});
const commandColumns = `command.*,
 to_char(command."leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
 to_char(command."nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt",
 to_char(command."cancelRequestedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cancelRequestedAt"`;

export const applyOmniSentReceipt = async (
  inputScope: OmniSentApplyScope,
  inputPrincipal: OmniSentApplyPrincipal,
  inputProof: OmniSentApplyProof,
  inputCallbacks: OmniSentApplyCallbacks,
  nativePort: OmniSentApplyNativePort,
): Promise<OmniSentApplyResult> => {
  const { principal, proof, callbacks } = snapshotOmniSentApplyRequest(
    inputPrincipal,
    inputProof,
    inputCallbacks,
  );
  const createInitialMessage = nativePort?.createInitialMessage;
  if (typeof createInitialMessage !== 'function')
    return fail('NATIVE_PORT_REQUIRED');
  const { workspaceId, bindingId } = principal;
  if (inputScope.workspaceId !== workspaceId) return fail('WORKSPACE_MISMATCH');
  const execute = inputScope.executeRawQuery;
  const scope: OmniSentApplyScope = Object.freeze({
    workspaceId,
    transactionLifecycle: inputScope.transactionLifecycle,
    executeRawQuery: (sql, parameters) =>
      execute.call(inputScope, sql, parameters),
  });
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = async (sql: string, parameters?: unknown[]) =>
    queryRowsSchema.parse(await executor.query(sql, parameters));
  // Avoid the upstream utilities barrel's commercial dependency graph.
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const readReceipt = (id: string, lock = '') =>
    query(
      `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" receipt WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 ${lock}`,
      [workspaceId, bindingId, id],
    );
  let receipt = one(receiptSchema, await readReceipt(proof.receiptId));
  const input = storedInput(receipt, principal);
  const { envelope, capture } = input;
  if (envelope.routeGeneration !== proof.routeGeneration)
    return fail('PROOF_GENERATION');
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
      messageChannelId: uuid,
      connectedAccountId: uuid,
      status: z.string(),
      routeGeneration: fields.generation,
    }),
    await query(
      'SELECT id,"messageChannelId","connectedAccountId",status,"routeGeneration" FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, bindingId],
    ),
  );
  one(
    z.object({ id: uuid }),
    await query(
      `SELECT channel.id FROM core."messageChannel" channel
    JOIN core."connectedAccount" account ON account.id=channel."connectedAccountId"
    WHERE channel.id=$1 AND channel."workspaceId"=$2 AND channel.type='APP' AND channel."connectedAccountId"=$3
      AND account."workspaceId"=$2 AND account."applicationId" IS NULL AND account."connectionProviderId" IS NULL
    FOR SHARE OF channel,account`,
      [binding.messageChannelId, workspaceId, binding.connectedAccountId],
    ),
  );
  const policy = one(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniAutomationPolicy" WHERE "workspaceId"=$1 AND "bindingId"=$2 FOR SHARE',
      [workspaceId, bindingId],
    ),
  );
  const version = one(
    z.object({ settings: z.json(), settingsHash: fields.payloadHash }),
    await query(
      'SELECT settings,"settingsHash" FROM core."omniAutomationPolicyVersion" WHERE "workspaceId"=$1 AND "policyId"=$2 AND version=0',
      [workspaceId, policy.id],
    ),
  );
  same(
    version.settings,
    { enabled: false, maxReplies: 0, maxCrmEffects: 0, maxHops: 0 },
    'POLICY_NOT_DISABLED_V0',
  );
  if (auditPayloadHash(version.settings) !== version.settingsHash)
    return fail('POLICY_HASH');
  const readCommand = (lock = '') =>
    query(
      `SELECT ${commandColumns} FROM core."omniOutgoingCommand" command WHERE "workspaceId"=$1 AND id=$2 ${lock}`,
      [workspaceId, envelope.commandId],
    );
  let command = one(commandSchema, await readCommand());
  const conversation = one(
    z.object({
      id: uuid,
      bindingId: uuid,
      providerChatId: fields.providerChatId,
      messageThreadId: uuid,
      queueId: uuid,
      conversationSequence: fields.journalSequence,
      replyRevision: fields.generation,
    }),
    await query(
      'SELECT id,"bindingId","providerChatId","messageThreadId","queueId","conversationSequence","replyRevision" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
      [workspaceId, command.conversationId],
    ),
  );
  if (
    conversation.bindingId !== bindingId ||
    conversation.providerChatId !== envelope.providerChatId
  )
    return fail('CONVERSATION_SCOPE');
  const refreshed = one(receiptSchema, await readReceipt(proof.receiptId));
  same(
    immutableReceipt(refreshed),
    immutableReceipt(receipt),
    'RECEIPT_CHANGED',
  );
  receipt = refreshed;
  command = one(commandSchema, await readCommand());
  const payload = z
    .strictObject({
      version: z.literal(1),
      workspaceId: uuid,
      bindingId: uuid,
      conversationId: uuid,
      providerChatId: fields.providerChatId,
      text: z.string(),
      readyFileIds: z.array(uuid).length(0),
      replyToMessageLinkId: z.null(),
      resolvedReplyNativeRef: z.null(),
    })
    .parse(command.payload);
  if (
    command.workspaceId !== workspaceId ||
    command.conversationId !== conversation.id ||
    command.actorId !== command.initiatingActorId ||
    command.policyId !== policy.id ||
    command.payloadHash !== auditPayloadHash(command.payload) ||
    command.payloadHash !== envelope.payloadHash ||
    command.generation !== envelope.routeGeneration ||
    payload.workspaceId !== workspaceId ||
    payload.bindingId !== bindingId ||
    payload.conversationId !== conversation.id ||
    payload.providerChatId !== conversation.providerChatId
  )
    return fail('COMMAND_INTEGRITY');
  const thread = one(
    z.object({ id: uuid, subject: z.string().nullable(), deletedAt: z.null() }),
    await query(
      `SELECT id,subject,"deletedAt" FROM "${schema}"."messageThread" WHERE id=$1 FOR UPDATE`,
      [conversation.messageThreadId],
    ),
  );
  if (
    (
      await query(
        'SELECT id FROM core."omniConversation" WHERE "workspaceId"=$1 AND "messageThreadId"=$2 AND id<>$3',
        [workspaceId, thread.id, conversation.id],
      )
    ).length
  )
    return fail('FOREIGN_THREAD_OWNER');
  const memberRows = z
    .array(z.object({ id: uuid, deletedAt: z.unknown().nullable() }))
    .parse(
      await query(
        `SELECT id,"deletedAt" FROM "${schema}"."workspaceMember" WHERE id=$1 FOR SHARE`,
        [command.actorId],
      ),
    );
  if (memberRows.length > 1) return fail('AUTHOR_IDENTITY');
  const memberId =
    memberRows.length === 1 && memberRows[0].deletedAt === null
      ? command.actorId
      : null;
  const descriptor: OmniSentApplyDescriptor = Object.freeze({
    principal,
    action: 'sent_receipt.apply',
    receiptId: receipt.id,
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
  await callbacks.verifyEvidence(scope, descriptor);
  createCrmAuditWorkspaceExecutor(scope);
  same(one(commandSchema, await readCommand()), command, 'COMMAND_CHANGED');
  if (
    !['dispatching', 'accepted', 'outcome_unknown', 'sent'].includes(
      command.state,
    ) ||
    BigInt(command.statusRevision) < 2n
  )
    return fail('COMMAND_STATE');
  if (
    (command.connectorJobId !== null &&
      command.connectorJobId !== envelope.connectorJobId) ||
    (command.journalSequence !== null &&
      command.journalSequence !== envelope.journalSequence)
  )
    return fail('ACCEPTANCE_CONFLICT');
  const proofContext = {
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
  };
  if (
    command.connectorAcceptedEvidence !== null &&
    !isOmniConnectorAcceptanceProof(
      command.connectorAcceptedEvidence,
      proofContext,
    )
  )
    return fail('ACCEPTANCE_CONFLICT');
  const acceptance =
    command.connectorAcceptedEvidence ??
    omniConnectorAcceptanceProofSchema.parse({
      schemaVersion: 1,
      evidenceKind: 'connector.durable_acceptance',
      workspaceId,
      bindingId,
      conversationId: conversation.id,
      commandId: command.id,
      providerChatId: conversation.providerChatId,
      payloadHash: command.payloadHash,
      generation: command.generation,
      connectorJobId: envelope.connectorJobId,
      journalSequence: envelope.journalSequence,
      qualification: capture.qualification,
    });
  const messageLinkId = uuidV5('omni:sent.message-link:v1', command.id);
  const revisionId = uuidV5('omni:sent.initial-revision:v1', command.id);
  const eventId = uuidV5('omni:sent.message.sent:v1', command.id);
  const rootId = uuidV5(`domain_event:${eventId}`, workspaceId);
  const rootRowId = uuidV5('omni:sent.root:v1', command.id);
  const dispatchId = uuidV5('omni:sent.dispatch:v1', command.id);
  const graphOperationId = uuidV5('omni:sent.apply:v1', command.id);
  const receiptOperationId = uuidV5('omni:sent.receipt.apply:v1', receipt.id);
  const scoped = { bindingId, conversationId: conversation.id };
  const references = buildOmniNativeMessageReferences({
    bindingId,
    providerChatId: envelope.providerChatId,
    nativeMessageKeyVersion: 1,
    nativeMessageKey: capture.nativeMessageKey,
  });
  const links = await query(
    `SELECT * FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND
    ("outgoingCommandId"=$2 OR id=$3 OR ("bindingId"=$4 AND "conversationId"=$5 AND "nativeMessageKey"=$6))`,
    [
      workspaceId,
      command.id,
      messageLinkId,
      bindingId,
      conversation.id,
      capture.nativeMessageKey,
    ],
  );
  if (links.length > 1) return fail('MULTIPLE_COMMAND_LINKS');
  const existing = links.length === 1;
  const currentRevisionId = existing
    ? uuid.nullable().parse(links[0].currentRevisionId)
    : revisionId;
  if (currentRevisionId !== null && currentRevisionId !== revisionId)
    return fail('REVISION_HEAD_INTEGRITY');
  if (command.state === 'sent' && !existing) return fail('SENT_GRAPH_MISSING');
  if (receipt.state === 'applied' && !existing)
    return fail('APPLIED_GRAPH_MISSING');
  if (
    receipt.state !== 'applied' &&
    (receipt.state !== 'processing' ||
      receipt.resultId !== null ||
      receipt.leaseOwner !== proof.leaseOwner ||
      receipt.leaseToken !== proof.leaseToken ||
      receipt.leaseUntil !== proof.leaseUntil ||
      !receipt.leaseLive)
  )
    return fail('LEASE_LOST');
  // Remaining graph work deliberately precedes the final Command and Receipt lock positions.
  let creatorReceipt = receipt;
  let creatorInput: OmniSentReceiptInput = input;
  if (existing) {
    const revision = one(
      z.object({ sourceEventId: fields.providerChatId }),
      await query(
        'SELECT "sourceEventId" FROM core."omniMessageRevision" WHERE "workspaceId"=$1 AND id=$2',
        [workspaceId, revisionId],
      ),
    );
    creatorReceipt = one(
      receiptSchema,
      await query(
        `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" receipt
      WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "eventId"=$3`,
        [workspaceId, bindingId, revision.sourceEventId],
      ),
    );
    creatorInput = storedInput(creatorReceipt, principal);
    if (
      creatorReceipt.state !== 'applied' ||
      creatorReceipt.resultId !== messageLinkId ||
      creatorReceipt.leaseOwner !== null ||
      creatorReceipt.leaseUntil !== null ||
      creatorReceipt.errorCode !== null
    )
      return fail('CREATOR_RECEIPT');
    const identity = (item: OmniSentReceiptInput) => ({
      commandId: item.envelope.commandId,
      routeGeneration: item.envelope.routeGeneration,
      providerChatId: item.envelope.providerChatId,
      payloadHash: item.envelope.payloadHash,
      connectorJobId: item.envelope.connectorJobId,
      journalSequence: item.envelope.journalSequence,
      providerMessageId: item.envelope.providerMessageId,
      nativeMessageKey: item.capture.nativeMessageKey,
      nativeMessageKeyVersion: item.capture.nativeMessageKeyVersion,
    });
    same(identity(creatorInput), identity(input), 'NATIVE_IDENTITY_CONFLICT');
  }
  const receivedAt = iso(
    creatorInput.envelope.occurredAt ?? creatorReceipt.createdAt,
  );
  const author = {
    actorKind: 'workspaceMember',
    actorId: command.actorId,
    initiatingActorId: command.initiatingActorId,
  };
  const expectedLink = {
    currentRevisionId,
    bindingId,
    conversationId: conversation.id,
    rawNativeMessageId: creatorInput.envelope.providerMessageId,
    nativeMessageKey: creatorInput.capture.nativeMessageKey,
    nativeMessageKeyVersion: 1,
    sourcePosition: creatorInput.capture.sourcePosition,
    displayOccurredAt: receivedAt,
    displayTimeSource:
      creatorInput.envelope.occurredAt === null ? 'capture' : 'source',
    immutableAuthorSnapshot: author,
    sourceAuthorId: null,
    sourceDisplayName: null,
    authorVerification: 'command_identity',
    senderProvenance: 'human_direct',
    correlationState: 'command_confirmed',
    outgoingCommandId: command.id,
    providerRevision: null,
  };
  const contentHash = auditPayloadHash({
    direction: 'outgoing',
    text: payload.text,
    receivedAt,
    nativeMessageKey: capture.nativeMessageKey,
    author,
  });
  const expectedRevision = {
    messageLinkId,
    sourceRevisionKey: `command.sent:${command.id}`,
    sourceEventId: creatorInput.envelope.eventId,
    contentHash,
    tombstone: false,
    origin: 'connector_outcome',
    protectedPayloadRef: null,
  };
  const graphAudit = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId: graphOperationId,
    actor: principal.actor,
    initiator: { kind: 'workspaceMember', id: command.actorId },
  });
  const record = (
    kind: CrmAuditResourceKind,
    id: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ) =>
    graphAudit.record({
      resourceKind: kind,
      resourceId: id,
      action: before === null ? 'create' : 'update',
      before,
      after,
      securityDescriptor: { resourceKind: kind, resourceId: id, ...scoped },
    });
  let nativeIds: {
    messageId: string;
    participantId: string;
    associationId: string;
  };
  if (existing) {
    const row = links[0];
    row.displayOccurredAt = iso(row.displayOccurredAt);
    exact([row], { id: messageLinkId, ...expectedLink }, 'REPLAY_LINK');
    nativeIds = {
      messageId: uuid.parse(row.messageId),
      participantId: one(
        z.object({ id: uuid }),
        await query(
          `SELECT id FROM "${schema}"."messageParticipant" WHERE "messageId"=$1`,
          [row.messageId],
        ),
      ).id,
      associationId: one(
        z.object({ id: uuid }),
        await query(
          `SELECT id FROM "${schema}"."messageChannelMessageAssociation" WHERE "messageId"=$1`,
          [row.messageId],
        ),
      ).id,
    };
  } else {
    if (
      (
        await query(
          `SELECT id FROM "${schema}"."message" WHERE "headerMessageId"=$1
      UNION ALL SELECT "messageId" AS id FROM "${schema}"."messageChannelMessageAssociation" WHERE "messageChannelId"=$2 AND "messageExternalId"=$3`,
          [
            references.headerMessageId,
            binding.messageChannelId,
            references.messageExternalId,
          ],
        )
      ).length
    )
      return fail('FOREIGN_NATIVE_IDENTITY');
    const created = z
      .object({
        messageId: uuid,
        participantId: uuid,
        associationId: uuid,
        createdThread: z.literal(false),
      })
      .parse(
        await createInitialMessage.call(
          nativePort,
          Object.freeze({
            workspaceId,
            messageChannelId: binding.messageChannelId,
            messageThreadId: thread.id,
            ...references,
            subject: null,
            text: payload.text,
            receivedAt,
            workspaceMemberId: memberId,
          }),
        ),
      );
    nativeIds = created;
  }
  const verifyNative = async (lock = 'FOR SHARE') => {
    const messageRows = await query(
      `SELECT * FROM "${schema}"."message" WHERE id=$1 OR "headerMessageId"=$2 ${lock}`,
      [nativeIds.messageId, references.headerMessageId],
    );
    for (const row of messageRows) row.receivedAt = iso(row.receivedAt);
    const message = exact(
      messageRows,
      {
        id: nativeIds.messageId,
        messageThreadId: thread.id,
        headerMessageId: references.headerMessageId,
        text: payload.text,
        subject: null,
        receivedAt,
        isDraft: false,
        deletedAt: null,
      },
      'NATIVE_MESSAGE',
    );
    const association = exact(
      await query(
        `SELECT * FROM "${schema}"."messageChannelMessageAssociation"
      WHERE "messageId"=$1 OR ("messageChannelId"=$2 AND "messageExternalId"=$3) ${lock}`,
        [
          nativeIds.messageId,
          binding.messageChannelId,
          references.messageExternalId,
        ],
      ),
      {
        id: nativeIds.associationId,
        messageId: nativeIds.messageId,
        messageChannelId: binding.messageChannelId,
        messageExternalId: references.messageExternalId,
        messageThreadExternalId: references.messageThreadExternalId,
        direction: 'OUTGOING',
        deletedAt: null,
      },
      'NATIVE_ASSOCIATION',
    );
    const participant = one(
      z.object({
        id: uuid,
        messageId: uuid,
        personId: z.null(),
        workspaceMemberId: uuid.nullable(),
        role: z.literal('FROM'),
        handle: z.null(),
        displayName: z.null(),
        deletedAt: z.null(),
      }),
      await query(
        `SELECT * FROM "${schema}"."messageParticipant" WHERE "messageId"=$1 ${lock}`,
        [nativeIds.messageId],
      ),
    );
    if (
      participant.id !== nativeIds.participantId ||
      participant.messageId !== nativeIds.messageId ||
      (participant.workspaceMemberId !== null &&
        participant.workspaceMemberId !== command.actorId) ||
      (!existing && participant.workspaceMemberId !== memberId)
    )
      return fail('NATIVE_AUTHOR');
    exact(
      await query(
        `SELECT subject,"deletedAt" FROM "${schema}"."messageThread" WHERE id=$1`,
        [thread.id],
      ),
      { subject: thread.subject, deletedAt: null },
      'NATIVE_THREAD',
    );
    return { message, association, participant };
  };
  const native = await verifyNative();
  const eventPayload = {
    commandId: command.id,
    messageLinkId,
    senderClass: 'human',
    dispatchSuppressed: true,
  };
  const root = {
    rootKind: 'domain_event',
    rootId,
    sourceKey: eventId,
    initialEventIds: [eventId],
    origin: 'connector_outcome',
    scope: { workspaceId, ...scoped },
    coveredRoots: [],
    policyId: command.policyId,
    policyVersion: '0',
    maxCrmEffects: '0',
    maxHops: '0',
    usedCrmEffects: '0',
    usedHops: '0',
    state: 'suppressed',
  };
  const eventFor = (sequence: string) => ({
    conversationId: conversation.id,
    conversationSequence: sequence,
    kind: 'message.sent',
    origin: 'connector_outcome',
    rootExecutionId: rootRowId,
    payloadVersion: 1,
    payload: eventPayload,
  });
  const dispatchFor = (event: ReturnType<typeof eventFor>) => ({
    eventId,
    rootKind: 'domain_event',
    rootId,
    policyId: command.policyId,
    policyVersion: '0',
    activationVersion: null,
    targets: [],
    payloadHash: auditPayloadHash(event),
    initialPlan: true,
    state: 'suppressed',
  });
  let sequence = conversation.conversationSequence;
  if (existing) {
    const revisions = await query(
      'SELECT id FROM core."omniMessageRevision" WHERE "workspaceId"=$1 AND "messageLinkId"=$2',
      [workspaceId, messageLinkId],
    );
    if (revisions.length !== 1 || revisions[0].id !== revisionId)
      return fail('REVISION_HEAD_INTEGRITY');
    exact(
      await query(
        'SELECT * FROM core."omniMessageRevision" WHERE "workspaceId"=$1 AND id=$2',
        [workspaceId, revisionId],
      ),
      expectedRevision,
      'REPLAY_REVISION',
    );
    const event = one(
      z.object({ conversationSequence: fields.generation }),
      await query(
        'SELECT "conversationSequence" FROM core."omniDomainEvent" WHERE "workspaceId"=$1 AND id=$2',
        [workspaceId, eventId],
      ),
    );
    sequence = event.conversationSequence;
    if (BigInt(sequence) > BigInt(conversation.conversationSequence))
      return fail('REPLAY_SEQUENCE');
  } else {
    if (BigInt(sequence) >= 9223372036854775807n)
      return fail('SEQUENCE_EXHAUSTED');
    sequence = (BigInt(sequence) + 1n).toString();
    await query(
      `INSERT INTO core."omniMessageLink" (id,"workspaceId","bindingId","conversationId","messageId","rawNativeMessageId","nativeMessageKey","nativeMessageKeyVersion",
      "sourcePosition","displayOccurredAt","displayTimeSource","immutableAuthorSnapshot","sourceAuthorId","sourceDisplayName","authorVerification","senderProvenance","correlationState","outgoingCommandId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8::jsonb,$9,$10,$11::jsonb,NULL,NULL,'command_identity','human_direct','command_confirmed',$12)`,
      [
        messageLinkId,
        workspaceId,
        bindingId,
        conversation.id,
        nativeIds.messageId,
        envelope.providerMessageId,
        capture.nativeMessageKey,
        canonicalAuditJson(capture.sourcePosition),
        receivedAt,
        expectedLink.displayTimeSource,
        canonicalAuditJson(author),
        command.id,
      ],
    );
    await query(
      `INSERT INTO core."omniMessageRevision" (id,"workspaceId","messageLinkId","sourceRevisionKey","sourceEventId","contentHash",tombstone,origin)
      VALUES ($1,$2,$3,$4,$5,$6,false,'connector_outcome')`,
      [
        revisionId,
        workspaceId,
        messageLinkId,
        expectedRevision.sourceRevisionKey,
        envelope.eventId,
        contentHash,
      ],
    );
    await query(
      'UPDATE core."omniMessageLink" SET "currentRevisionId"=$3 WHERE "workspaceId"=$1 AND id=$2 AND "currentRevisionId" IS NULL',
      [workspaceId, messageLinkId, revisionId],
    );
    exact(
      await query(
        `WITH changed AS (UPDATE core."omniConversation" SET "conversationSequence"=$3,"updatedAt"=clock_timestamp()
      WHERE "workspaceId"=$1 AND id=$2 AND "conversationSequence"=$4 RETURNING *) SELECT * FROM changed`,
        [
          workspaceId,
          conversation.id,
          sequence,
          conversation.conversationSequence,
        ],
      ),
      {
        conversationSequence: sequence,
        replyRevision: conversation.replyRevision,
      },
      'CONVERSATION_POSTCONDITION',
    );
    await query(
      `INSERT INTO core."omniRootExecution" (id,"workspaceId","rootKind","rootId","sourceKey","initialEventIds",origin,scope,"coveredRoots","policyId","policyVersion","maxCrmEffects","maxHops",state)
      VALUES ($1,$2,'domain_event',$3,$4,$5::uuid[],'connector_outcome',$6::jsonb,'[]'::jsonb,$7,0,0,0,'suppressed')`,
      [
        rootRowId,
        workspaceId,
        rootId,
        eventId,
        [eventId],
        canonicalAuditJson(root.scope),
        command.policyId,
      ],
    );
    await query(
      `INSERT INTO core."omniDomainEvent" (id,"workspaceId","conversationId","conversationSequence",kind,origin,"rootExecutionId","payloadVersion",payload)
      VALUES ($1,$2,$3,$4,'message.sent','connector_outcome',$5,1,$6::jsonb)`,
      [
        eventId,
        workspaceId,
        conversation.id,
        sequence,
        rootRowId,
        canonicalAuditJson(eventPayload),
      ],
    );
    await query(
      `INSERT INTO core."omniEventDispatchPlan" (id,"workspaceId","eventId","rootKind","rootId","policyId","policyVersion","activationVersion",targets,"payloadHash","initialPlan",state)
      VALUES ($1,$2,$3,'domain_event',$4,$5,0,NULL,'[]'::jsonb,$6,true,'suppressed')`,
      [
        dispatchId,
        workspaceId,
        eventId,
        rootId,
        command.policyId,
        dispatchFor(eventFor(sequence)).payloadHash,
      ],
    );
    record('omniMessage', nativeIds.messageId, null, {
      messageThreadId: thread.id,
      isDraft: false,
      text: payload.text,
      subject: null,
      headerMessageId: references.headerMessageId,
      receivedAt,
    });
    record('omniMessageParticipant', nativeIds.participantId, null, {
      messageId: nativeIds.messageId,
      personId: null,
      workspaceMemberId: memberId,
      role: 'FROM',
      handle: null,
      displayName: null,
    });
    record('omniMessageAssociation', nativeIds.associationId, null, {
      messageId: nativeIds.messageId,
      messageChannelId: binding.messageChannelId,
      direction: 'OUTGOING',
      messageExternalId: references.messageExternalId,
      messageThreadExternalId: references.messageThreadExternalId,
    });
    record('omniMessageLink', messageLinkId, null, {
      ...expectedLink,
      messageId: nativeIds.messageId,
    });
    record('omniMessageRevision', revisionId, null, expectedRevision);
    record(
      'omniConversation',
      conversation.id,
      { conversationSequence: conversation.conversationSequence },
      { conversationSequence: sequence },
    );
    record('omniRootExecution', rootRowId, null, root);
    record('omniDomainEvent', eventId, null, eventFor(sequence));
    record(
      'omniEventDispatchPlan',
      dispatchId,
      null,
      dispatchFor(eventFor(sequence)),
    );
  }
  const verifyCoreGraph = async (lock: string) => {
    const rows = await query(
      `SELECT * FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND
      ("outgoingCommandId"=$2 OR id=$3 OR ("bindingId"=$4 AND "conversationId"=$5 AND "nativeMessageKey"=$6))`,
      [
        workspaceId,
        command.id,
        messageLinkId,
        bindingId,
        conversation.id,
        capture.nativeMessageKey,
      ],
    );
    for (const row of rows) row.displayOccurredAt = iso(row.displayOccurredAt);
    exact(
      rows,
      { id: messageLinkId, messageId: nativeIds.messageId, ...expectedLink },
      'LINK_POSTCONDITION',
    );
    exact(
      await query(
        'SELECT * FROM core."omniMessageRevision" WHERE "workspaceId"=$1 AND id=$2',
        [workspaceId, revisionId],
      ),
      expectedRevision,
      'REVISION_POSTCONDITION',
    );
    exact(
      await query(
        `SELECT * FROM core."omniRootExecution" WHERE "workspaceId"=$1 AND id=$2 ${lock}`,
        [workspaceId, rootRowId],
      ),
      { ...root, causationId: null },
      'ROOT_POSTCONDITION',
    );
    exact(
      await query(
        'SELECT * FROM core."omniDomainEvent" WHERE "workspaceId"=$1 AND id=$2',
        [workspaceId, eventId],
      ),
      { ...eventFor(sequence), causationId: null },
      'EVENT_POSTCONDITION',
    );
    exact(
      await query(
        `SELECT * FROM core."omniEventDispatchPlan" WHERE "workspaceId"=$1 AND id=$2 ${lock}`,
        [workspaceId, dispatchId],
      ),
      dispatchFor(eventFor(sequence)),
      'DISPATCH_POSTCONDITION',
    );
    if (
      (
        await query(
          `SELECT id FROM core."omniAutomationAdmission" WHERE "workspaceId"=$1 AND "eventId"=$2
      UNION ALL SELECT id FROM core."omniConsumerReceipt" WHERE "workspaceId"=$1 AND "eventId"=$2
      UNION ALL SELECT id FROM core."omniReplyBudget" WHERE "workspaceId"=$1 AND "rootKind"='domain_event' AND "rootId"=$3`,
          [workspaceId, eventId, rootId],
        )
      ).length
    )
      return fail('UNEXPECTED_AUTOMATION');
  };
  await verifyCoreGraph('FOR SHARE');
  // Locks for root/dispatch precede Command, and Receipt is always last.
  same(
    one(commandSchema, await readCommand('FOR UPDATE')),
    command,
    'COMMAND_CHANGED',
  );
  const lockedReceipt = one(
    receiptSchema,
    await readReceipt(proof.receiptId, 'FOR UPDATE'),
  );
  same(stableReceipt(lockedReceipt), stableReceipt(receipt), 'RECEIPT_CHANGED');
  let finalCommand = command;
  if (existing) {
    if (
      command.state !== 'sent' ||
      command.connectorAcceptedEvidence === null ||
      !isOmniConnectorAcceptanceProof(
        command.connectorAcceptedEvidence,
        proofContext,
      )
    )
      return fail('REPLAY_COMMAND');
    const successes = await query(
      'SELECT "resourceKind","resourceId",action,"securityDescriptor","redactedDiff" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 AND outcome=\'success\'',
      [workspaceId, graphOperationId],
    );
    const expectedAudits = [
      ['omniMessage', nativeIds.messageId, 'create'],
      ['omniMessageParticipant', nativeIds.participantId, 'create'],
      ['omniMessageAssociation', nativeIds.associationId, 'create'],
      ['omniMessageLink', messageLinkId, 'create'],
      ['omniMessageRevision', revisionId, 'create'],
      ['omniConversation', conversation.id, 'update'],
      ['omniRootExecution', rootRowId, 'create'],
      ['omniDomainEvent', eventId, 'create'],
      ['omniEventDispatchPlan', dispatchId, 'create'],
      ['omniOutgoingCommand', command.id, 'update'],
      ['omniIncomingReceipt', creatorReceipt.id, 'update'],
    ];
    if (successes.length !== expectedAudits.length) return fail('REPLAY_AUDIT');
    for (const [resourceKind, resourceId, action] of expectedAudits)
      exact(
        successes.filter(
          (row) =>
            row.resourceKind === resourceKind &&
            row.resourceId === resourceId &&
            row.action === action,
        ),
        {
          resourceKind,
          resourceId,
          action,
          securityDescriptor: { resourceKind, resourceId, ...scoped },
        },
        'REPLAY_AUDIT',
      );
    const participantAudit = one(
      z.object({
        redactedDiff: z.object({
          values: z.object({
            workspaceMemberId: z.object({ after: uuid.nullable() }),
          }),
        }),
      }),
      successes.filter((row) => row.resourceKind === 'omniMessageParticipant'),
    );
    const birthMember =
      participantAudit.redactedDiff.values.workspaceMemberId.after;
    if (birthMember !== null && birthMember !== command.actorId)
      return fail('REPLAY_AUTHOR_AUDIT');
    const expectedMember =
      birthMember !== null && memberRows.length === 0 ? null : birthMember;
    if (native.participant.workspaceMemberId !== expectedMember)
      return fail('REPLAY_AUTHOR_RELATION');
    if (receipt.state === 'applied') {
      if (
        receipt.resultId !== messageLinkId ||
        receipt.leaseOwner !== null ||
        receipt.leaseUntil !== null ||
        receipt.errorCode !== null
      )
        return fail('REPLAY_RECEIPT');
      if (receipt.id !== creatorReceipt.id) {
        const attempts = await query(
          'SELECT "resourceKind","resourceId",action,"securityDescriptor" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 AND outcome=\'success\'',
          [workspaceId, receiptOperationId],
        );
        exact(
          attempts,
          {
            resourceKind: 'omniIncomingReceipt',
            resourceId: receipt.id,
            action: 'update',
            securityDescriptor: {
              resourceKind: 'omniIncomingReceipt',
              resourceId: receipt.id,
              ...scoped,
            },
          },
          'REPLAY_RECEIPT_AUDIT',
        );
      }
      return Object.freeze({
        receiptId: receipt.id,
        messageLinkId,
        messageId: nativeIds.messageId,
        conversationId: conversation.id,
        created: false,
        state: 'applied',
      });
    }
  } else {
    if (BigInt(command.statusRevision) >= 9223372036854775807n)
      return fail('COMMAND_REVISION_EXHAUSTED');
    const after = {
      ...command,
      state: 'sent',
      statusRevision: (BigInt(command.statusRevision) + 1n).toString(),
      connectorJobId: envelope.connectorJobId,
      journalSequence: envelope.journalSequence,
      connectorAcceptedEvidence: acceptance,
      leaseToken: null,
      leaseUntil: null,
    };
    const updated = one(
      commandSchema,
      await query(
        `WITH changed AS (UPDATE core."omniOutgoingCommand" SET state='sent',"statusRevision"=$4,
      "connectorJobId"=$5,"journalSequence"=$6,"connectorAcceptedEvidence"=$7::jsonb,"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=clock_timestamp()
      WHERE "workspaceId"=$1 AND id=$2 AND "statusRevision"=$3 RETURNING *) SELECT ${commandColumns} FROM changed command`,
        [
          workspaceId,
          command.id,
          command.statusRevision,
          after.statusRevision,
          envelope.connectorJobId,
          envelope.journalSequence,
          canonicalAuditJson(acceptance),
        ],
      ),
    );
    same(updated, after, 'COMMAND_POSTCONDITION');
    finalCommand = updated;
    record('omniOutgoingCommand', command.id, command, after);
  }
  const finalAudit = existing
    ? new CrmAuditTransactionContext(executor, {
        workspaceId,
        operationId: receiptOperationId,
        actor: principal.actor,
        initiator: { kind: 'workspaceMember', id: command.actorId },
      })
    : graphAudit;
  finalAudit.record({
    resourceKind: 'omniIncomingReceipt',
    resourceId: receipt.id,
    action: 'update',
    before: {
      state: receipt.state,
      resultId: receipt.resultId,
      leaseOwner: receipt.leaseOwner,
      leaseUntil: receipt.leaseUntil,
      errorCode: receipt.errorCode,
    },
    after: {
      state: 'applied',
      resultId: messageLinkId,
      leaseOwner: null,
      leaseUntil: null,
      errorCode: null,
    },
    securityDescriptor: {
      resourceKind: 'omniIncomingReceipt',
      resourceId: receipt.id,
      ...scoped,
    },
  });
  await finalAudit.flush();
  // These rows are already locked; this read adds no parent lock after Receipt.
  await verifyCoreGraph('');
  same(
    (await verifyNative('')).participant,
    native.participant,
    'NATIVE_AUTHOR_POSTCONDITION',
  );
  same(
    one(commandSchema, await readCommand()),
    finalCommand,
    'COMMAND_POSTCONDITION',
  );
  const applied = one(
    receiptSchema,
    await query(
      `WITH changed AS (UPDATE core."omniIncomingReceipt" SET state='applied',"resultId"=$7,"leaseOwner"=NULL,
    "leaseUntil"=NULL,"errorCode"=NULL,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state='processing'
    AND "leaseOwner"=$4 AND "leaseToken"=$5 AND "routeGeneration"=$6 AND "leaseUntil"=$8::timestamptz AND "leaseUntil">clock_timestamp()
    AND "resultId" IS NULL AND "updatedAt"=$9::timestamptz RETURNING *) SELECT ${receiptColumns} FROM changed receipt`,
      [
        workspaceId,
        bindingId,
        receipt.id,
        proof.leaseOwner,
        proof.leaseToken,
        proof.routeGeneration,
        messageLinkId,
        proof.leaseUntil,
        receipt.updatedAt,
      ],
    ),
  );
  if (
    applied.state !== 'applied' ||
    applied.resultId !== messageLinkId ||
    applied.leaseOwner !== null ||
    applied.leaseUntil !== null ||
    applied.errorCode !== null
  )
    return fail('RECEIPT_POSTCONDITION');
  same(
    immutableReceipt(applied),
    immutableReceipt(receipt),
    'RECEIPT_POSTCONDITION',
  );
  await verifyCoreGraph('');
  same(
    (await verifyNative('')).participant,
    native.participant,
    'NATIVE_AUTHOR_POSTCONDITION',
  );
  same(
    one(commandSchema, await readCommand()),
    finalCommand,
    'COMMAND_POSTCONDITION',
  );
  createCrmAuditWorkspaceExecutor(scope);
  return Object.freeze({
    receiptId: receipt.id,
    messageLinkId,
    messageId: nativeIds.messageId,
    conversationId: conversation.id,
    created: !existing,
    state: 'applied',
  });
};
