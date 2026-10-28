import { randomUUID } from 'node:crypto';

import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditResourceKind } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { type WorkspaceTransactionLifecycle } from 'src/engine/twenty-orm/types/workspace-transaction-lifecycle.type';
import {
  type OmniIncomingCaptureContext,
  snapshotOmniIncomingCaptureContext,
} from 'src/modules/omnichannel/contracts/omni-incoming-capture-context';
import {
  type OmniIncomingEnvelope,
  parseOmniIncomingEnvelope,
} from 'src/modules/omnichannel/contracts/omni-incoming-envelope';
import { buildOmniNativeMessageReferences } from 'src/modules/omnichannel/services/build-omni-native-message-references';
import { createOmniHistoryMissingConfigurationError } from 'src/modules/omnichannel/services/omni-history-missing-configuration.error';

import {
  snapshotOmniIncomingApplicationResult,
  type OmniIncomingApplicationResult,
} from 'src/modules/omnichannel/contracts/omni-incoming-application-result';
import {
  snapshotOmniIncomingRevisionAdapter,
  qualifyOmniIncomingRevisionKey,
  omniIncomingTextRevisionContent,
  type OmniIncomingRevisionAdapter,
} from 'src/modules/omnichannel/contracts/omni-incoming-text-revision';
import {
  loadOmniIncomingRevisionChain,
  omniIncomingTextApplyOperationId,
  omniIncomingTextRevisionId,
  type OmniIncomingRevisionChain,
} from 'src/modules/omnichannel/services/load-omni-incoming-revision-chain';
import { createOmniIncomingRevisionConflict } from 'src/modules/omnichannel/services/omni-incoming-revision-conflict.error';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const positiveBigint = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
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
const proofSchema = z
  .strictObject({
    receiptId: uuid,
    leaseOwner: uuid,
    leaseToken: positiveBigint,
    routeGeneration: positiveBigint,
    externalIdentityId: uuid,
  })
  .readonly();

export type OmniHistoryApplyPrincipal = z.infer<typeof principalSchema>;
export type OmniHistoryApplyProof = z.infer<typeof proofSchema>;
export type OmniHistoryApplyScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
export type OmniHistoryApplyAuthorizer = (
  scope: OmniHistoryApplyScope,
  authorization: Readonly<
    OmniHistoryApplyPrincipal & {
      action: 'history.apply' | 'incoming.text.apply';
      creatingConversation: boolean;
      bindingDefaultQueueId: string | null;
      bindingDefaultConversationMode: string;
      receiptId: string;
      conversationId: string;
      queueId: string;
      externalIdentityId: string;
      identityRevision: string;
      providerPeerId: string;
      verificationSource: string;
      personId: string;
      envelope: Readonly<OmniIncomingEnvelope>;
      captureContext: OmniIncomingCaptureContext;
    }
  >,
) => Promise<void>;
export type OmniHistoryNativeMessageInput = Readonly<{
  workspaceId: string;
  messageChannelId: string;
  messageThreadId: string;
  headerMessageId: string;
  messageExternalId: string;
  messageThreadExternalId: string;
  subject: null;
  text: string | null;
  receivedAt: string;
  personId: string;
  participantHandle: string;
  participantDisplayName: string;
}>;
export type OmniHistoryNativePort = {
  updateMessageText?: (messageId: string, text: string | null) => Promise<void>;
  createInitialMessage: (input: OmniHistoryNativeMessageInput) => Promise<{
    messageId: string;
    participantId: string;
    associationId: string;
    createdThread: boolean;
  }>;
};
export type OmniHistoryApplyResult = Readonly<{
  receiptId: string;
  messageLinkId: string;
  messageId: string;
  conversationId: string;
  created: boolean;
  state: 'applied';
}>;

export const snapshotOmniHistoryReceiptRequest = (
  principal: OmniHistoryApplyPrincipal,
  proof: OmniHistoryApplyProof,
  authorize: OmniHistoryApplyAuthorizer,
) => {
  if (typeof authorize !== 'function')
    throw new Error('OMNI_HISTORY_AUTHORIZER_REQUIRED');
  return Object.freeze({
    principal: principalSchema.parse(principal),
    proof: proofSchema.parse(proof),
    authorize,
  });
};

const frozen = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
};
const fail = (reason: string): never => {
  throw new Error(`OMNI_HISTORY_${reason}`);
};
const requireOne = <T extends z.ZodType>(
  schema: T,
  rows: unknown[],
): z.infer<T> => {
  if (rows.length !== 1) return fail('MISSING_OR_AMBIGUOUS_RECORD');
  return schema.parse(rows[0]);
};
const timestamp = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => new Date(value).toISOString());
const receiptSchema = z.object({
  id: uuid,
  bindingId: uuid,
  eventId: z.string(),
  kind: z.string(),
  schemaVersion: z.number().int().positive(),
  routeGeneration: positiveBigint,
  canonicalPayloadHash: z.string(),
  validatedEnvelope: z.unknown(),
  trustedCaptureContext: z.unknown(),
  trustedCaptureContextHash: z.string().nullable(),
  state: z.string(),
  leaseOwner: z.string().nullable(),
  leaseToken: z.string(),
  leaseUntil: timestamp.nullable(),
  resultId: uuid.nullable(),
  applicationResult: z.unknown(),
  errorCode: z.string().nullable(),
  createdAt: timestamp,
});
const receiptColumns = `id, "bindingId", "eventId", kind, "schemaVersion", "routeGeneration", "canonicalPayloadHash", "validatedEnvelope",
  "trustedCaptureContext", "trustedCaptureContextHash", state, "leaseOwner", "leaseToken", "leaseUntil", "resultId", "applicationResult", "errorCode", "createdAt"`;
const disabledSettings = {
  enabled: false,
  maxReplies: 0,
  maxCrmEffects: 0,
  maxHops: 0,
};

export const omniHistoryApplyOperationId = (receiptId: string): string =>
  uuidV5('omni:history.apply:v1', uuid.parse(receiptId));

export type OmniIncomingTextApplyResult = OmniHistoryApplyResult &
  Readonly<{
    applicationResult: OmniIncomingApplicationResult;
    replayed: boolean;
  }>;
export const applyOmniHistoryReceipt = (
  scope: OmniHistoryApplyScope,
  principal: OmniHistoryApplyPrincipal,
  proof: OmniHistoryApplyProof,
  authorize: OmniHistoryApplyAuthorizer,
  nativePort: OmniHistoryNativePort,
): Promise<OmniHistoryApplyResult> =>
  applyIncomingReceipt(scope, principal, proof, authorize, nativePort, null);
export const applyOmniIncomingTextReceipt = async (
  scope: OmniHistoryApplyScope,
  principal: OmniHistoryApplyPrincipal,
  proof: OmniHistoryApplyProof,
  authorize: OmniHistoryApplyAuthorizer,
  nativePort: OmniHistoryNativePort,
  adapter: OmniIncomingRevisionAdapter,
): Promise<OmniIncomingTextApplyResult> => {
  const result = await applyIncomingReceipt(
    scope,
    principal,
    proof,
    authorize,
    nativePort,
    snapshotOmniIncomingRevisionAdapter(adapter),
  );
  if (!result.applicationResult || result.replayed === undefined)
    throw new Error('OMNI_INCOMING_RESULT_POSTCONDITION');
  return Object.freeze({
    ...result,
    applicationResult: result.applicationResult,
    replayed: result.replayed,
  });
};
// The caller owns commit/rollback; SQL and the native adapter share this strict scope.
const applyIncomingReceipt = async (
  inputScope: OmniHistoryApplyScope,
  inputPrincipal: OmniHistoryApplyPrincipal,
  inputProof: OmniHistoryApplyProof,
  inputAuthorize: OmniHistoryApplyAuthorizer,
  nativePort: OmniHistoryNativePort,
  adapter: OmniIncomingRevisionAdapter | null,
): Promise<
  OmniHistoryApplyResult & {
    applicationResult?: OmniIncomingApplicationResult;
    replayed?: boolean;
  }
> => {
  const { principal, proof, authorize } = snapshotOmniHistoryReceiptRequest(
    inputPrincipal,
    inputProof,
    inputAuthorize,
  );
  const createInitialMessage = nativePort?.createInitialMessage;
  const updateMessageText = nativePort?.updateMessageText;
  if (adapter && typeof updateMessageText !== 'function')
    return fail('NATIVE_REVISION_PORT_REQUIRED');
  if (typeof createInitialMessage !== 'function')
    return fail('NATIVE_PORT_REQUIRED');
  const workspaceId = uuid.parse(inputScope.workspaceId);
  if (workspaceId !== principal.workspaceId) return fail('WORKSPACE_MISMATCH');
  const executeRawQuery = inputScope.executeRawQuery;
  const scope: OmniHistoryApplyScope = Object.freeze({
    workspaceId,
    transactionLifecycle: inputScope.transactionLifecycle,
    executeRawQuery: (sql: string, parameters?: unknown[]) =>
      executeRawQuery.call(inputScope, sql, parameters),
  });
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = executor.query;
  // Twenty's physical workspace schema is the unsigned UUID integer encoded in base 36.
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const operationId = adapter
    ? omniIncomingTextApplyOperationId(proof.receiptId)
    : omniHistoryApplyOperationId(proof.receiptId);
  const eventId = uuidV5(
    adapter
      ? 'omni:incoming.text.event:v1'
      : 'omni:history.message.received:v1',
    proof.receiptId,
  );
  const rootId = uuidV5(`domain_event:${eventId}`, workspaceId);
  const rootRowId = uuidV5(
    adapter ? 'omni:incoming.text.root:v1' : 'omni:history.root:v1',
    proof.receiptId,
  );
  const dispatchId = uuidV5(
    adapter ? 'omni:incoming.text.dispatch:v1' : 'omni:history.dispatch:v1',
    proof.receiptId,
  );
  const revisionId = adapter
    ? omniIncomingTextRevisionId(proof.receiptId)
    : uuidV5('omni:history.initial.revision:v1', proof.receiptId);
  const creatorConversationId = uuidV5(
    adapter
      ? 'omni:incoming.text.conversation:v1'
      : 'omni:history.conversation:v1',
    proof.receiptId,
  );
  const creatorThreadId = uuidV5(
    adapter ? 'omni:incoming.text.thread:v1' : 'omni:history.thread:v1',
    proof.receiptId,
  );
  const creationEventId = uuidV5(
    adapter
      ? 'omni:incoming.text.conversation.created:v1'
      : 'omni:history.conversation.created:v1',
    proof.receiptId,
  );
  const creationRootId = uuidV5(`domain_event:${creationEventId}`, workspaceId);
  const creationRootRowId = uuidV5(
    adapter
      ? 'omni:incoming.text.conversation.root:v1'
      : 'omni:history.conversation.root:v1',
    proof.receiptId,
  );
  const creationDispatchId = uuidV5(
    adapter
      ? 'omni:incoming.text.conversation.dispatch:v1'
      : 'omni:history.conversation.dispatch:v1',
    proof.receiptId,
  );
  const audit = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId,
    actor: principal.actor,
  });

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
      messageChannelId: uuid,
      connectedAccountId: uuid,
      status: z.literal('active'),
      routeGeneration: positiveBigint,
      defaultQueueId: uuid.nullable(),
      defaultConversationMode: z.string(),
    }),
    await query(
      'SELECT id,"messageChannelId","connectedAccountId",status,"routeGeneration","defaultQueueId","defaultConversationMode" FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, principal.bindingId],
    ),
  );
  if (binding.routeGeneration !== proof.routeGeneration)
    return fail('STALE_GENERATION');
  requireOne(
    z.object({ id: uuid }),
    await query(
      `SELECT channel.id FROM core."messageChannel" channel
    JOIN core."connectedAccount" account ON account.id=channel."connectedAccountId"
    WHERE channel.id=$1 AND channel."workspaceId"=$2 AND channel.type='APP'
      AND channel."connectedAccountId"=$3 AND account."workspaceId"=$2
      AND account."archivedAt" IS NULL AND account."applicationId" IS NULL AND account."connectionProviderId" IS NULL
    FOR SHARE OF channel,account`,
      [binding.messageChannelId, workspaceId, binding.connectedAccountId],
    ),
  );
  let initialReceipt = requireOne(
    receiptSchema,
    await query(
      `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3`,
      [workspaceId, binding.id, proof.receiptId],
    ),
  );
  const envelope = frozen(
    parseOmniIncomingEnvelope(initialReceipt.validatedEnvelope),
  );
  if (
    initialReceipt.trustedCaptureContext === null ||
    initialReceipt.trustedCaptureContextHash === null
  )
    return fail('UNQUALIFIED_RECEIPT');
  const capture = snapshotOmniIncomingCaptureContext(
    initialReceipt.trustedCaptureContext,
    envelope,
  );
  if (
    initialReceipt.canonicalPayloadHash !== auditPayloadHash(envelope) ||
    initialReceipt.trustedCaptureContextHash !== capture.hash ||
    initialReceipt.eventId !== envelope.eventId ||
    initialReceipt.kind !== envelope.kind ||
    initialReceipt.schemaVersion !== envelope.schemaVersion ||
    envelope.accountBindingId !== binding.id ||
    initialReceipt.routeGeneration !== proof.routeGeneration ||
    envelope.routeGeneration !== proof.routeGeneration
  )
    return fail('RECEIPT_INTEGRITY');
  if (
    !adapter &&
    (capture.context.origin !== 'history_import' ||
      envelope.kind !== 'message.received' ||
      envelope.direction !== 'incoming' ||
      envelope.sourceVariant !== 'complete' ||
      envelope.payload.text === null)
  )
    return fail('UNSUPPORTED_VARIANT');
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
      canonicalAuditJson(disabledSettings)
  )
    return fail('POLICY_NOT_DISABLED_V0');
  const conversationSchema = z.object({
    id: uuid,
    messageThreadId: uuid,
    queueId: uuid,
    policyId: uuid,
    policyVersion: z.literal('0'),
    conversationSequence: z.string().regex(/^(0|[1-9][0-9]*)$/),
    replyRevision: positiveBigint,
    mode: z.enum(['human', 'assist', 'auto']),
    status: z.enum(['open', 'closed']),
    assigneeMemberId: uuid.nullable(),
    controlEpoch: positiveBigint,
    automationEpoch: positiveBigint,
    nextOutboundSequence: positiveBigint,
  });
  const conversationSql =
    'SELECT id,"messageThreadId","queueId","policyId","policyVersion","conversationSequence","replyRevision",mode,status,"assigneeMemberId","controlEpoch","automationEpoch","nextOutboundSequence" FROM core."omniConversation" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "providerChatId"=$3 FOR UPDATE';
  let conversationRows = await query(conversationSql, [
    workspaceId,
    binding.id,
    envelope.providerChatId,
  ]);
  let creatingConversation = false;

  if (conversationRows.length === 0) {
    if (
      initialReceipt.state !== 'processing' ||
      initialReceipt.resultId !== null
    )
      return fail('MISSING_CONVERSATION');
    if (
      initialReceipt.leaseOwner !== proof.leaseOwner ||
      initialReceipt.leaseToken !== proof.leaseToken
    )
      return fail('LEASE_LOST');
    if (
      binding.defaultQueueId === null ||
      binding.defaultConversationMode !== 'human'
    )
      throw createOmniHistoryMissingConfigurationError();
    const defaultQueue = await query(
      'SELECT id FROM core."omniQueue" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND active=true',
      [workspaceId, binding.id, binding.defaultQueueId],
    );
    if (defaultQueue.length === 0)
      throw createOmniHistoryMissingConfigurationError();
    requireOne(z.object({ id: uuid }), defaultQueue);
    const inserted = await query(
      `INSERT INTO core."omniConversation" (id,"workspaceId","bindingId","providerChatId","messageThreadId","queueId",mode,status,"policyId","policyVersion")
       VALUES ($1,$2,$3,$4,$5,$6,'human','open',$7,0)
       ON CONFLICT ("workspaceId","bindingId","providerChatId") DO NOTHING RETURNING id`,
      [
        creatorConversationId,
        workspaceId,
        binding.id,
        envelope.providerChatId,
        creatorThreadId,
        binding.defaultQueueId,
        policy.id,
      ],
    );
    if (
      inserted.length !== 0 &&
      requireOne(z.object({ id: uuid }), inserted).id !== creatorConversationId
    )
      return fail('CONVERSATION_RESERVATION');
    creatingConversation = inserted.length === 1;
    // A separate statement sees the concurrent winner after ON CONFLICT waited.
    conversationRows = await query(conversationSql, [
      workspaceId,
      binding.id,
      envelope.providerChatId,
    ]);
  }
  const conversation = requireOne(conversationSchema, conversationRows);
  let currentConversationSequence = conversation.conversationSequence;
  const receiptCreatedConversation = conversation.id === creatorConversationId;
  if (
    receiptCreatedConversation !==
    (conversation.messageThreadId === creatorThreadId)
  )
    return fail('CONVERSATION_CREATOR_INTEGRITY');
  if (
    creatingConversation &&
    (!receiptCreatedConversation ||
      conversation.queueId !== binding.defaultQueueId ||
      conversation.mode !== 'human' ||
      conversation.status !== 'open' ||
      conversation.assigneeMemberId !== null ||
      conversation.conversationSequence !== '0' ||
      conversation.replyRevision !== '1' ||
      conversation.controlEpoch !== '1' ||
      conversation.automationEpoch !== '1' ||
      conversation.nextOutboundSequence !== '1')
  )
    return fail('CONVERSATION_RESERVATION');
  // Another apply may have committed while this transaction waited for the conversation.
  const refreshedReceipt = requireOne(
    receiptSchema,
    await query(
      `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3`,
      [workspaceId, binding.id, proof.receiptId],
    ),
  );
  const immutableReceipt = (receipt: z.infer<typeof receiptSchema>) => ({
    id: receipt.id,
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
  if (
    canonicalAuditJson(immutableReceipt(refreshedReceipt)) !==
    canonicalAuditJson(immutableReceipt(initialReceipt))
  )
    return fail('RECEIPT_CHANGED');
  initialReceipt = refreshedReceipt;
  if (
    receiptCreatedConversation &&
    !creatingConversation &&
    initialReceipt.state !== 'applied'
  )
    return fail('CONVERSATION_CREATOR_INTEGRITY');
  if (conversation.policyId !== policy.id)
    return fail('CONVERSATION_POLICY_MISMATCH');
  requireOne(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniQueue" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND active=true',
      [workspaceId, binding.id, conversation.queueId],
    ),
  );
  const identity = requireOne(
    z.object({
      id: uuid,
      providerPeerId: z.string().min(1),
      personId: uuid,
      verificationSource: z.string().min(1),
      revision: positiveBigint,
    }),
    await query(
      'SELECT id,"providerPeerId","personId","verificationSource",revision FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR SHARE',
      [workspaceId, binding.id, proof.externalIdentityId],
    ),
  );
  requireOne(
    z.object({ id: uuid }),
    await query(
      `SELECT id FROM "${schema}"."person" WHERE id=$1 AND "deletedAt" IS NULL FOR SHARE`,
      [identity.personId],
    ),
  );
  const threadRows = await query(
    `SELECT id,subject,"deletedAt" FROM "${schema}"."messageThread" WHERE id=$1 FOR UPDATE`,
    [conversation.messageThreadId],
  );
  if (creatingConversation && threadRows.length !== 0)
    return fail('FOREIGN_THREAD_OWNER');
  const thread = creatingConversation
    ? { id: creatorThreadId, subject: null }
    : requireOne(
        z.object({
          id: uuid,
          subject: z.string().nullable(),
          deletedAt: z.null(),
        }),
        threadRows,
      );
  const otherOwners = await query(
    'SELECT id FROM core."omniConversation" WHERE "workspaceId"=$1 AND "messageThreadId"=$2 AND id<>$3',
    [workspaceId, thread.id, conversation.id],
  );
  if (otherOwners.length !== 0) return fail('FOREIGN_THREAD_OWNER');
  await authorize(
    scope,
    frozen({
      ...principal,
      action: adapter
        ? ('incoming.text.apply' as const)
        : ('history.apply' as const),
      creatingConversation,
      bindingDefaultQueueId: binding.defaultQueueId,
      bindingDefaultConversationMode: binding.defaultConversationMode,
      receiptId: proof.receiptId,
      conversationId: conversation.id,
      queueId: conversation.queueId,
      externalIdentityId: identity.id,
      identityRevision: identity.revision,
      providerPeerId: identity.providerPeerId,
      verificationSource: identity.verificationSource,
      personId: identity.personId,
      envelope,
      captureContext: capture.context,
    }),
  );

  const candidateFacts = frozen({ envelope, captureContext: capture.context });
  const candidateContent = adapter
    ? omniIncomingTextRevisionContent(candidateFacts)
    : null;
  const candidateRevisionKey = adapter
    ? qualifyOmniIncomingRevisionKey(adapter, candidateFacts)
    : null;

  const references = buildOmniNativeMessageReferences({
    bindingId: binding.id,
    providerChatId: envelope.providerChatId,
    nativeMessageKeyVersion: capture.context.nativeMessageKeyVersion,
    nativeMessageKey: capture.context.nativeMessageKey,
  });
  const receivedAt =
    envelope.occurredAt === null
      ? initialReceipt.createdAt
      : new Date(envelope.occurredAt).toISOString();
  const nativeInput: OmniHistoryNativeMessageInput = Object.freeze({
    workspaceId,
    messageChannelId: binding.messageChannelId,
    messageThreadId: thread.id,
    ...references,
    subject: null,
    text: candidateContent ? candidateContent.text : envelope.payload.text,
    receivedAt,
    personId: identity.personId,
    participantHandle: identity.providerPeerId,
    participantDisplayName: envelope.payload.sourceDisplayName ?? '',
  });
  const contentHash =
    candidateContent?.contentHash ??
    auditPayloadHash({
      direction: envelope.direction,
      text: nativeInput.text,
      receivedAt,
      sourceAuthorId: envelope.payload.sourceAuthorId,
      sourceDisplayName: envelope.payload.sourceDisplayName,
      nativeMessageKey: capture.context.nativeMessageKey,
      sourceVariant: envelope.sourceVariant,
    });
  const sourceRevisionKey =
    candidateRevisionKey ??
    `initial:${auditPayloadHash({ eventId: envelope.eventId, captureHash: capture.hash })}`;
  const authorSnapshot = {
    externalIdentityId: identity.id,
    identityRevision: identity.revision,
    providerPeerId: identity.providerPeerId,
    personId: identity.personId,
    sourceAuthorId: envelope.payload.sourceAuthorId,
    sourceDisplayName: envelope.payload.sourceDisplayName,
  };
  const scoped = {
    bindingId: binding.id,
    conversationId: conversation.id,
    queueId: conversation.queueId,
  };
  const createdConversationSnapshot = {
    bindingId: binding.id,
    providerChatId: envelope.providerChatId,
    messageThreadId: thread.id,
    queueId: conversation.queueId,
    mode: 'human',
    status: 'open',
    assigneeMemberId: null,
    policyId: policy.id,
    policyVersion: '0',
    controlEpoch: '1',
    automationEpoch: '1',
    nextOutboundSequence: '1',
    conversationSequence: '2',
    replyRevision: '2',
  };
  const record = (
    resourceKind: CrmAuditResourceKind,
    resourceId: string,
    action: 'create' | 'update',
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ) =>
    audit.record({
      resourceKind,
      resourceId,
      action,
      before,
      after,
      securityDescriptor: { resourceKind, resourceId, ...scoped },
    });

  const buildStorageEvent = (input: {
    eventId: string;
    rootId: string;
    rootRowId: string;
    dispatchId: string;
    kind:
      | 'message.received'
      | 'message.edited'
      | 'message.deleted'
      | 'conversation.created';
    sequence: string;
    payload: Record<string, unknown>;
    origin?: OmniIncomingCaptureContext['origin'];
  }) => {
    const root = {
      rootKind: 'domain_event',
      rootId: input.rootId,
      sourceKey: input.eventId,
      initialEventIds: [input.eventId],
      origin: input.origin ?? capture.context.origin,
      scope: { ...scoped, workspaceId },
      coveredRoots: [],
      policyId: policy.id,
      policyVersion: '0',
      maxCrmEffects: '0',
      maxHops: '0',
      usedCrmEffects: '0',
      usedHops: '0',
      state: 'suppressed',
    };
    const event = {
      conversationId: conversation.id,
      conversationSequence: input.sequence,
      kind: input.kind,
      origin: input.origin ?? capture.context.origin,
      rootExecutionId: input.rootRowId,
      payloadVersion: 1,
      payload: input.payload,
    };
    const dispatch = {
      eventId: input.eventId,
      rootKind: 'domain_event',
      rootId: input.rootId,
      policyId: policy.id,
      policyVersion: '0',
      activationVersion: null,
      targets: [],
      payloadHash: auditPayloadHash(event),
      initialPlan: true,
      state: 'suppressed',
    };
    return { ...input, root, event, dispatch };
  };
  type StorageEvent = ReturnType<typeof buildStorageEvent>;
  const creationEvent = buildStorageEvent({
    eventId: creationEventId,
    rootId: creationRootId,
    rootRowId: creationRootRowId,
    dispatchId: creationDispatchId,
    kind: 'conversation.created',
    sequence: '1',
    payload: {
      messageThreadId: creatorThreadId,
      receiptId: proof.receiptId,
      dispatchSuppressed: true,
    },
  });
  const persistStorageEvent = async (item: StorageEvent) => {
    await query(
      `INSERT INTO core."omniRootExecution" (id,"workspaceId","rootKind","rootId","sourceKey","initialEventIds",origin,scope,"coveredRoots","policyId","policyVersion","maxCrmEffects","maxHops",state)
       VALUES ($1,$2,'domain_event',$3,$4,$5::uuid[],$8,$6::jsonb,'[]'::jsonb,$7,0,0,0,'suppressed')`,
      [
        item.rootRowId,
        workspaceId,
        item.rootId,
        item.eventId,
        [item.eventId],
        canonicalAuditJson(item.root.scope),
        policy.id,
        item.root.origin,
      ],
    );
    await query(
      `INSERT INTO core."omniDomainEvent" (id,"workspaceId","conversationId","conversationSequence",kind,origin,"rootExecutionId","payloadVersion",payload)
       VALUES ($1,$2,$3,$4,$5,$8,$6,1,$7::jsonb)`,
      [
        item.eventId,
        workspaceId,
        conversation.id,
        item.sequence,
        item.kind,
        item.rootRowId,
        canonicalAuditJson(item.payload),
        item.root.origin,
      ],
    );
    await query(
      `INSERT INTO core."omniEventDispatchPlan" (id,"workspaceId","eventId","rootKind","rootId","policyId","policyVersion","activationVersion",targets,"payloadHash","initialPlan",state)
       VALUES ($1,$2,$3,'domain_event',$4,$5,0,NULL,'[]'::jsonb,$6,true,'suppressed')`,
      [
        item.dispatchId,
        workspaceId,
        item.eventId,
        item.rootId,
        policy.id,
        item.dispatch.payloadHash,
      ],
    );
  };
  const recordStorageEvent = (item: StorageEvent) => {
    record('omniRootExecution', item.rootRowId, 'create', null, item.root);
    record('omniDomainEvent', item.eventId, 'create', null, item.event);
    record(
      'omniEventDispatchPlan',
      item.dispatchId,
      'create',
      null,
      item.dispatch,
    );
  };
  const verifyStorageEvent = async (
    input: Omit<Parameters<typeof buildStorageEvent>[0], 'sequence'> & {
      sequence?: string;
    },
  ) => {
    const event = requireOne(
      z.object({
        conversationId: uuid,
        conversationSequence: positiveBigint,
        kind: z.enum([
          'message.received',
          'message.edited',
          'message.deleted',
          'conversation.created',
        ]),
        origin: z.enum(['live', 'history_import', 'restore_replay']),
        rootExecutionId: uuid,
        payloadVersion: z.literal(1),
        payload: z.unknown(),
      }),
      await query(
        'SELECT "conversationId","conversationSequence",kind,origin,"rootExecutionId","payloadVersion",payload FROM core."omniDomainEvent" WHERE "workspaceId"=$1 AND id=$2 AND "causationId" IS NULL',
        [workspaceId, input.eventId],
      ),
    );
    if (
      BigInt(event.conversationSequence) >
        BigInt(currentConversationSequence) ||
      (input.sequence !== undefined &&
        event.conversationSequence !== input.sequence)
    )
      return fail('REPLAY_EVENT_INTEGRITY');
    const expected = buildStorageEvent({
      ...input,
      sequence: event.conversationSequence,
    });
    if (canonicalAuditJson(event) !== canonicalAuditJson(expected.event))
      return fail('REPLAY_EVENT_INTEGRITY');
    const root = requireOne(
      z.object({
        rootKind: z.literal('domain_event'),
        rootId: uuid,
        sourceKey: z.string(),
        initialEventIds: z.array(uuid),
        origin: z.enum(['live', 'history_import', 'restore_replay']),
        scope: z.unknown(),
        coveredRoots: z.array(z.unknown()),
        policyId: uuid,
        policyVersion: z.literal('0'),
        state: z.literal('suppressed'),
        maxCrmEffects: z.literal('0'),
        maxHops: z.literal('0'),
        usedCrmEffects: z.literal('0'),
        usedHops: z.literal('0'),
      }),
      await query(
        'SELECT * FROM core."omniRootExecution" WHERE "workspaceId"=$1 AND id=$2 AND "causationId" IS NULL FOR SHARE',
        [workspaceId, input.rootRowId],
      ),
    );
    if (canonicalAuditJson(root) !== canonicalAuditJson(expected.root))
      return fail('REPLAY_ROOT_INTEGRITY');
    const dispatch = requireOne(
      z.object({
        eventId: uuid,
        rootKind: z.literal('domain_event'),
        rootId: uuid,
        policyId: uuid,
        policyVersion: z.literal('0'),
        activationVersion: z.null(),
        targets: z.array(z.unknown()),
        payloadHash: z.string(),
        initialPlan: z.literal(true),
        state: z.literal('suppressed'),
      }),
      await query(
        'SELECT * FROM core."omniEventDispatchPlan" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
        [workspaceId, input.dispatchId],
      ),
    );
    if (canonicalAuditJson(dispatch) !== canonicalAuditJson(expected.dispatch))
      return fail('REPLAY_DISPATCH_INTEGRITY');
  };

  const verifyNative = async (
    ids: {
      messageId: string;
      participantId: string;
      associationId: string;
    },
    expected = {
      text: nativeInput.text,
      receivedAt,
      personId: identity.personId,
      handle: nativeInput.participantHandle,
      displayName: nativeInput.participantDisplayName,
    },
  ) => {
    const messages = await query(
      `SELECT id,"messageThreadId","headerMessageId",subject,text,"receivedAt","isDraft","deletedAt" FROM "${schema}"."message" WHERE "headerMessageId"=$1 OR id=$2`,
      [references.headerMessageId, ids.messageId],
    );
    const message = requireOne(
      z.object({
        id: uuid,
        messageThreadId: uuid,
        headerMessageId: z.string(),
        subject: z.null(),
        text: z.string().nullable(),
        receivedAt: timestamp,
        isDraft: z.literal(false),
        deletedAt: z.null(),
      }),
      messages,
    );
    if (
      message.id !== ids.messageId ||
      message.messageThreadId !== thread.id ||
      message.headerMessageId !== references.headerMessageId ||
      message.text !== expected.text ||
      message.receivedAt !== expected.receivedAt
    )
      return fail('NATIVE_MESSAGE_POSTCONDITION');
    const association = requireOne(
      z.object({
        id: uuid,
        messageId: uuid,
        messageChannelId: uuid,
        messageExternalId: z.string(),
        messageThreadExternalId: z.string(),
        direction: z.literal('INCOMING'),
        deletedAt: z.null(),
      }),
      await query(
        `SELECT id,"messageId","messageChannelId","messageExternalId","messageThreadExternalId",direction,"deletedAt" FROM "${schema}"."messageChannelMessageAssociation" WHERE "messageId"=$1 OR ("messageChannelId"=$2 AND "messageExternalId"=$3)`,
        [message.id, binding.messageChannelId, references.messageExternalId],
      ),
    );
    if (
      association.id !== ids.associationId ||
      association.messageId !== message.id ||
      association.messageChannelId !== binding.messageChannelId ||
      association.messageExternalId !== references.messageExternalId ||
      association.messageThreadExternalId !== envelope.providerChatId
    )
      return fail('NATIVE_ASSOCIATION_POSTCONDITION');
    const participant = requireOne(
      z.object({
        id: uuid,
        messageId: uuid,
        personId: uuid,
        workspaceMemberId: z.null(),
        role: z.literal('FROM'),
        handle: z.string(),
        displayName: z.string(),
        deletedAt: z.null(),
      }),
      await query(
        `SELECT id,"messageId","personId","workspaceMemberId",role,handle,"displayName","deletedAt" FROM "${schema}"."messageParticipant" WHERE "messageId"=$1`,
        [message.id],
      ),
    );
    if (
      participant.id !== ids.participantId ||
      participant.messageId !== message.id ||
      participant.personId !== expected.personId ||
      participant.handle !== expected.handle ||
      participant.displayName !== expected.displayName
    )
      return fail('NATIVE_PARTICIPANT_POSTCONDITION');
    const currentThread = requireOne(
      z.object({ subject: z.string().nullable(), deletedAt: z.null() }),
      await query(
        `SELECT subject,"deletedAt" FROM "${schema}"."messageThread" WHERE id=$1`,
        [thread.id],
      ),
    );
    if (currentThread.subject !== thread.subject)
      return fail('NATIVE_THREAD_POSTCONDITION');
    return { message, association, participant };
  };

  const links = await query(
    'SELECT * FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "conversationId"=$3 AND "nativeMessageKey"=$4',
    [
      workspaceId,
      binding.id,
      conversation.id,
      capture.context.nativeMessageKey,
    ],
  );
  const loadChain = async (link: unknown) =>
    loadOmniIncomingRevisionChain({
      query,
      workspaceId,
      bindingId: binding.id,
      conversationId: conversation.id,
      providerChatId: envelope.providerChatId,
      nativeMessageKey: capture.context.nativeMessageKey,
      link,
    });
  const verifyRetainedRevisionEvent = async (
    item: OmniIncomingRevisionChain['head'],
    messageId: string,
  ) => {
    const legacy = item.outcome === null;
    const receiptId = item.receipt.id;
    const prefix = legacy ? 'omni:history' : 'omni:incoming.text';
    const retainedEventId = uuidV5(
      legacy
        ? 'omni:history.message.received:v1'
        : 'omni:incoming.text.event:v1',
      receiptId,
    );
    const createdConversation =
      conversation.id === uuidV5(`${prefix}.conversation:v1`, receiptId);
    const events = [
      {
        eventId: retainedEventId,
        rootId: uuidV5(`domain_event:${retainedEventId}`, workspaceId),
        rootRowId: uuidV5(`${prefix}.root:v1`, receiptId),
        dispatchId: uuidV5(`${prefix}.dispatch:v1`, receiptId),
        kind: item.facts.envelope.kind,
        origin: item.facts.captureContext.origin,
        ...(createdConversation ? { sequence: '2' } : {}),
        payload: {
          messageLinkId: item.revision.messageLinkId,
          messageId,
          receiptId,
          dispatchSuppressed: true,
        },
      },
    ];
    for (const item of events) await verifyStorageEvent(item);
    if (createdConversation) {
      const createdEventId = uuidV5(
        `${prefix}.conversation.created:v1`,
        receiptId,
      );
      await verifyStorageEvent({
        eventId: createdEventId,
        rootId: uuidV5(`domain_event:${createdEventId}`, workspaceId),
        rootRowId: uuidV5(`${prefix}.conversation.root:v1`, receiptId),
        dispatchId: uuidV5(`${prefix}.conversation.dispatch:v1`, receiptId),
        kind: 'conversation.created',
        origin: item.facts.captureContext.origin,
        sequence: '1',
        payload: {
          messageThreadId: uuidV5(`${prefix}.thread:v1`, receiptId),
          receiptId,
          dispatchSuppressed: true,
        },
      });
    }
  };
  const verifyChainNative = async (chain: OmniIncomingRevisionChain) => {
    await verifyRetainedRevisionEvent(chain.head, chain.link.messageId);
    if (chain.initial.revision.id !== chain.head.revision.id)
      await verifyRetainedRevisionEvent(chain.initial, chain.link.messageId);
    if (
      chain.author.externalIdentityId !== identity.id ||
      chain.author.personId !== identity.personId ||
      chain.author.providerPeerId !== identity.providerPeerId ||
      chain.link.authorVerification !== identity.verificationSource
    )
      return fail('REPLAY_AUTHOR_INTEGRITY');
    const participant = requireOne(
      z.object({ id: uuid }),
      await query(
        `SELECT id FROM "${schema}"."messageParticipant" WHERE "messageId"=$1`,
        [chain.link.messageId],
      ),
    );
    const association = requireOne(
      z.object({ id: uuid }),
      await query(
        `SELECT id FROM "${schema}"."messageChannelMessageAssociation" WHERE "messageId"=$1`,
        [chain.link.messageId],
      ),
    );
    return verifyNative(
      {
        messageId: chain.link.messageId,
        participantId: participant.id,
        associationId: association.id,
      },
      {
        text: chain.head.content.text,
        receivedAt: chain.link.displayOccurredAt,
        personId: chain.author.personId,
        handle: chain.author.providerPeerId,
        displayName: chain.author.sourceDisplayName ?? '',
      },
    );
  };
  if (adapter && (links.length !== 0 || initialReceipt.state === 'applied')) {
    if (links.length !== 1 || creatingConversation)
      return fail('REPLAY_LINK_INTEGRITY');
    const chain = await loadChain(links[0]);
    const native = await verifyChainNative(chain);
    const { link } = chain;
    if (initialReceipt.state === 'applied') {
      const outcome = snapshotOmniIncomingApplicationResult(
        initialReceipt.applicationResult,
      );
      if (
        initialReceipt.resultId !== link.id ||
        outcome.candidateSourceRevisionKey !== sourceRevisionKey ||
        outcome.candidateContentHash !== contentHash
      )
        return fail('REPLAY_RESULT_INTEGRITY');
      const selected = chain.revisions.find(
        (item) => item.revision.id === outcome.selectedRevisionId,
      );
      const observed = chain.revisions.find(
        (item) => item.revision.id === outcome.observedHeadRevisionId,
      );
      if (!selected || (outcome.observedHeadRevisionId !== null && !observed))
        return fail('REPLAY_RESULT_SCOPE');
      if (
        ['created', 'advanced'].includes(outcome.disposition) &&
        (selected.receipt.id !== proof.receiptId ||
          canonicalAuditJson(selected.outcome) !== canonicalAuditJson(outcome))
      )
        return fail('REPLAY_RESULT_INTEGRITY');
      if (
        outcome.disposition === 'duplicate' &&
        (qualifyOmniIncomingRevisionKey(adapter, selected.facts) !==
          sourceRevisionKey ||
          selected.content.contentHash !== contentHash)
      )
        return fail('REPLAY_RESULT_INTEGRITY');
      await verifyRetainedRevisionEvent(selected, link.messageId);
      const successRows = z
        .array(
          z.object({
            resourceKind: z.string(),
            resourceId: uuid,
            action: z.string(),
          }),
        )
        .parse(
          await query(
            'SELECT "resourceKind","resourceId",action FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 AND outcome=\'success\'',
            [workspaceId, operationId],
          ),
        );
      if (
        !successRows.some(
          (row) =>
            row.resourceKind === 'omniIncomingReceipt' &&
            row.resourceId === proof.receiptId &&
            row.action === 'update',
        ) ||
        (['duplicate', 'stale'].includes(outcome.disposition) &&
          successRows.length !== 1)
      )
        return fail('REPLAY_AUDIT_INTEGRITY');
      const reread = requireOne(
        receiptSchema,
        await query(
          `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE`,
          [workspaceId, binding.id, proof.receiptId],
        ),
      );
      if (canonicalAuditJson(reread) !== canonicalAuditJson(initialReceipt))
        return fail('RECEIPT_CHANGED');
      return Object.freeze({
        receiptId: proof.receiptId,
        messageLinkId: link.id,
        messageId: link.messageId,
        conversationId: conversation.id,
        created: false,
        state: 'applied',
        applicationResult: outcome,
        replayed: true,
      });
    }
    if (
      initialReceipt.state !== 'processing' ||
      initialReceipt.resultId !== null ||
      initialReceipt.applicationResult !== null
    )
      return fail('RECEIPT_NOT_PROCESSING');
    if (
      initialReceipt.leaseOwner !== proof.leaseOwner ||
      initialReceipt.leaseToken !== proof.leaseToken
    )
      return fail('LEASE_LOST');
    const matching = chain.revisions.filter(
      (item) =>
        qualifyOmniIncomingRevisionKey(adapter, item.facts) ===
        sourceRevisionKey,
    );
    if (matching.length > 1) throw createOmniIncomingRevisionConflict();
    let disposition: 'advanced' | 'duplicate' | 'stale';
    let selectedRevisionId: string;
    if (matching.length === 1) {
      if (matching[0].content.contentHash !== contentHash)
        throw createOmniIncomingRevisionConflict();
      disposition = 'duplicate';
      selectedRevisionId = matching[0].revision.id;
    } else {
      const order = adapter.compare(candidateFacts, chain.head.facts);
      if (order === 'older') {
        disposition = 'stale';
        selectedRevisionId = chain.head.revision.id;
      } else if (
        order === 'newer' &&
        !chain.head.content.tombstone &&
        !(
          envelope.sourceVariant === 'placeholder' &&
          chain.head.facts.envelope.sourceVariant === 'complete'
        )
      ) {
        disposition = 'advanced';
        selectedRevisionId = revisionId;
      } else throw createOmniIncomingRevisionConflict();
    }
    const outcome = snapshotOmniIncomingApplicationResult({
      schemaVersion: 1,
      kind: 'incoming_text_revision',
      disposition,
      selectedRevisionId,
      observedHeadRevisionId: chain.head.revision.id,
      candidateSourceRevisionKey: sourceRevisionKey,
      candidateContentHash: contentHash,
    });
    if (disposition === 'advanced') {
      if (!candidateContent || !updateMessageText)
        return fail('NATIVE_REVISION_PORT_REQUIRED');
      await updateMessageText.call(
        nativePort,
        link.messageId,
        candidateContent.text,
      );
      await verifyNative(
        {
          messageId: link.messageId,
          participantId: native.participant.id,
          associationId: native.association.id,
        },
        {
          text: candidateContent.text,
          receivedAt: link.displayOccurredAt,
          personId: chain.author.personId,
          handle: chain.author.providerPeerId,
          displayName: chain.author.sourceDisplayName ?? '',
        },
      );
      const revision = {
        messageLinkId: link.id,
        sourceRevisionKey,
        sourceEventId: envelope.eventId,
        contentHash,
        tombstone: candidateContent.tombstone,
        origin: capture.context.origin,
      };
      await query(
        'INSERT INTO core."omniMessageRevision" (id,"workspaceId","messageLinkId","sourceRevisionKey","sourceEventId","contentHash",tombstone,origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          revisionId,
          workspaceId,
          link.id,
          sourceRevisionKey,
          envelope.eventId,
          contentHash,
          revision.tombstone,
          revision.origin,
        ],
      );
      const updated = await query(
        'UPDATE core."omniMessageLink" SET "currentRevisionId"=$3,"sourcePosition"=$4::jsonb WHERE "workspaceId"=$1 AND id=$2 AND "currentRevisionId" IS NOT DISTINCT FROM $5::uuid RETURNING id',
        [
          workspaceId,
          link.id,
          revisionId,
          canonicalAuditJson(capture.context.sourcePosition),
          link.currentRevisionId,
        ],
      );
      if (updated.length !== 1) return fail('REVISION_HEAD_POSTCONDITION');
      const advanced = requireOne(
        z.object({
          conversationSequence: positiveBigint,
          replyRevision: positiveBigint,
        }),
        await query(
          'UPDATE core."omniConversation" SET "conversationSequence"="conversationSequence"+1,"replyRevision"="replyRevision"+1,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND id=$2 RETURNING "conversationSequence","replyRevision"',
          [workspaceId, conversation.id],
        ),
      );
      currentConversationSequence = advanced.conversationSequence;
      const messageEvent = buildStorageEvent({
        eventId,
        rootId,
        rootRowId,
        dispatchId,
        kind: envelope.kind,
        sequence: advanced.conversationSequence,
        payload: {
          messageLinkId: link.id,
          messageId: link.messageId,
          receiptId: proof.receiptId,
          dispatchSuppressed: true,
        },
      });
      await persistStorageEvent(messageEvent);
      record(
        'omniMessage',
        link.messageId,
        'update',
        { text: native.message.text },
        { text: candidateContent.text },
      );
      record('omniMessageRevision', revisionId, 'create', null, revision);
      record(
        'omniMessageLink',
        link.id,
        'update',
        {
          currentRevisionId: link.currentRevisionId,
          sourcePosition: link.sourcePosition,
        },
        {
          currentRevisionId: revisionId,
          sourcePosition: capture.context.sourcePosition,
        },
      );
      record(
        'omniConversation',
        conversation.id,
        'update',
        {
          bindingId: binding.id,
          conversationSequence: conversation.conversationSequence,
          replyRevision: conversation.replyRevision,
        },
        { bindingId: binding.id, ...advanced },
      );
      recordStorageEvent(messageEvent);
    }
    const lockedReceipt = requireOne(
      receiptSchema,
      await query(
        `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE`,
        [workspaceId, binding.id, proof.receiptId],
      ),
    );
    if (
      canonicalAuditJson(lockedReceipt) !== canonicalAuditJson(initialReceipt)
    )
      return fail('RECEIPT_CHANGED');
    record(
      'omniIncomingReceipt',
      proof.receiptId,
      'update',
      {
        bindingId: binding.id,
        state: 'processing',
        resultId: null,
        applicationResult: null,
        leaseOwner: initialReceipt.leaseOwner,
        leaseUntil: initialReceipt.leaseUntil,
        leaseToken: initialReceipt.leaseToken,
      },
      {
        bindingId: binding.id,
        state: 'applied',
        resultId: link.id,
        applicationResult: outcome,
        leaseOwner: null,
        leaseUntil: null,
        leaseToken: initialReceipt.leaseToken,
      },
    );
    await audit.flush();
    const applied = await query(
      `UPDATE core."omniIncomingReceipt" SET state='applied',"resultId"=$7,"applicationResult"=$8::jsonb,"leaseOwner"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state='processing' AND "leaseOwner"=$4 AND "leaseToken"=$5 AND "routeGeneration"=$6 AND "leaseUntil">clock_timestamp() RETURNING id`,
      [
        workspaceId,
        binding.id,
        proof.receiptId,
        proof.leaseOwner,
        proof.leaseToken,
        proof.routeGeneration,
        link.id,
        canonicalAuditJson(outcome),
      ],
    );
    if (applied.length !== 1) return fail('LEASE_LOST');
    const finalReceipt = requireOne(
      receiptSchema,
      await query(
        `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" WHERE "workspaceId"=$1 AND id=$2`,
        [workspaceId, proof.receiptId],
      ),
    );
    if (
      finalReceipt.state !== 'applied' ||
      finalReceipt.resultId !== link.id ||
      finalReceipt.leaseOwner !== null ||
      finalReceipt.leaseUntil !== null ||
      finalReceipt.errorCode !== null ||
      finalReceipt.leaseToken !== proof.leaseToken ||
      canonicalAuditJson(immutableReceipt(finalReceipt)) !==
        canonicalAuditJson(immutableReceipt(initialReceipt)) ||
      canonicalAuditJson(finalReceipt.applicationResult) !==
        canonicalAuditJson(outcome)
    )
      return fail('RECEIPT_POSTCONDITION');
    const finalLinks = await query(
      'SELECT * FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND id=$2',
      [workspaceId, link.id],
    );
    if (finalLinks.length !== 1) return fail('REVISION_HEAD_POSTCONDITION');
    const finalChain = await loadChain(finalLinks[0]);
    if (
      finalChain.head.revision.id !==
      (disposition === 'advanced' ? revisionId : chain.head.revision.id)
    )
      return fail('REVISION_HEAD_POSTCONDITION');
    await verifyChainNative(finalChain);
    return Object.freeze({
      receiptId: proof.receiptId,
      messageLinkId: link.id,
      messageId: link.messageId,
      conversationId: conversation.id,
      created: false,
      state: 'applied',
      applicationResult: outcome,
      replayed: false,
    });
  }
  if (initialReceipt.state === 'applied') {
    if (initialReceipt.applicationResult !== null)
      return fail('REPLAY_RESULT_INTEGRITY');
    const link = requireOne(
      z.object({
        id: uuid,
        messageId: uuid,
        currentRevisionId: uuid.nullable(),
        rawNativeMessageId: z.string(),
        nativeMessageKeyVersion: z.literal(1),
        sourcePosition: z.unknown(),
        displayOccurredAt: timestamp,
        displayTimeSource: z.enum(['source', 'capture']),
        immutableAuthorSnapshot: z.unknown(),
        sourceAuthorId: z.string().nullable(),
        sourceDisplayName: z.string().nullable(),
        authorVerification: z.string().nullable(),
        senderProvenance: z.literal('unresolved_external'),
        correlationState: z.literal('not_applicable'),
        providerRevision: z.null(),
        outgoingCommandId: z.null(),
      }),
      links,
    );
    if (
      initialReceipt.resultId !== link.id ||
      link.rawNativeMessageId !== envelope.providerMessageId ||
      link.displayOccurredAt !== receivedAt ||
      link.displayTimeSource !==
        (envelope.occurredAt === null ? 'capture' : 'source') ||
      canonicalAuditJson(link.immutableAuthorSnapshot) !==
        canonicalAuditJson(authorSnapshot) ||
      link.sourceAuthorId !== envelope.payload.sourceAuthorId ||
      link.sourceDisplayName !== envelope.payload.sourceDisplayName ||
      link.authorVerification !== identity.verificationSource
    )
      return fail('REPLAY_LINK_INTEGRITY');
    const participant = requireOne(
      z.object({ id: uuid }),
      await query(
        `SELECT id FROM "${schema}"."messageParticipant" WHERE "messageId"=$1`,
        [link.messageId],
      ),
    );
    const association = requireOne(
      z.object({ id: uuid }),
      await query(
        `SELECT id FROM "${schema}"."messageChannelMessageAssociation" WHERE "messageId"=$1`,
        [link.messageId],
      ),
    );
    const retainedChain = await loadChain(links[0]);
    await verifyChainNative(retainedChain);
    const revision = requireOne(
      z.object({
        messageLinkId: uuid,
        sourceRevisionKey: z.string(),
        sourceEventId: z.string(),
        contentHash: z.string(),
        tombstone: z.literal(false),
        origin: z.enum(['live', 'history_import', 'restore_replay']),
        protectedPayloadRef: z.null(),
      }),
      await query(
        'SELECT "messageLinkId","sourceRevisionKey","sourceEventId","contentHash",tombstone,origin,"protectedPayloadRef" FROM core."omniMessageRevision" WHERE "workspaceId"=$1 AND id=$2',
        [workspaceId, revisionId],
      ),
    );
    if (
      revision.messageLinkId !== link.id ||
      revision.sourceRevisionKey !== sourceRevisionKey ||
      revision.sourceEventId !== envelope.eventId ||
      revision.contentHash !== contentHash
    )
      return fail('REPLAY_REVISION_INTEGRITY');
    const revisions = z
      .array(z.object({ id: uuid }))
      .parse(
        await query(
          'SELECT id FROM core."omniMessageRevision" WHERE "workspaceId"=$1 AND "messageLinkId"=$2',
          [workspaceId, link.id],
        ),
      );
    if (
      link.currentRevisionId === null &&
      (revisions.length !== 1 || revisions[0].id !== revisionId)
    )
      return fail('REPLAY_REVISION_HEAD_INTEGRITY');
    const replayEvents = [
      {
        eventId,
        rootId,
        rootRowId,
        dispatchId,
        kind: 'message.received' as const,
        ...(receiptCreatedConversation ? { sequence: '2' } : {}),
        payload: {
          messageLinkId: link.id,
          messageId: link.messageId,
          receiptId: proof.receiptId,
          dispatchSuppressed: true,
        },
      },
      ...(receiptCreatedConversation ? [creationEvent] : []),
    ];
    for (const item of replayEvents.sort((left, right) =>
      left.rootId.localeCompare(right.rootId),
    )) {
      await verifyStorageEvent(item);
    }
    const successes = z
      .array(
        z.object({
          resourceKind: z.string(),
          resourceId: uuid,
          action: z.enum(['create', 'update', 'delete']),
          redactedDiff: z.unknown(),
          securityDescriptor: z.unknown(),
        }),
      )
      .parse(
        await query(
          'SELECT "resourceKind","resourceId",action,"redactedDiff","securityDescriptor" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 AND outcome=\'success\'',
          [workspaceId, operationId],
        ),
      );
    const expectedAudit = [
      ['omniMessage', link.messageId, 'create'],
      ['omniMessageParticipant', participant.id, 'create'],
      ['omniMessageAssociation', association.id, 'create'],
      ['omniMessageLink', link.id, 'create'],
      ['omniMessageRevision', revisionId, 'create'],
      [
        'omniConversation',
        conversation.id,
        receiptCreatedConversation ? 'create' : 'update',
      ],
      ['omniRootExecution', rootRowId, 'create'],
      ['omniDomainEvent', eventId, 'create'],
      ['omniEventDispatchPlan', dispatchId, 'create'],
      ['omniIncomingReceipt', proof.receiptId, 'update'],
      ...(receiptCreatedConversation
        ? [
            ['omniMessageThread', thread.id, 'create'],
            ['omniRootExecution', creationRootRowId, 'create'],
            ['omniDomainEvent', creationEventId, 'create'],
            ['omniEventDispatchPlan', creationDispatchId, 'create'],
          ]
        : []),
    ];
    if (
      successes.length !== expectedAudit.length ||
      expectedAudit.some(
        ([resourceKind, resourceId, action]) =>
          !successes.some(
            (row) =>
              typeof row === 'object' &&
              row !== null &&
              'resourceKind' in row &&
              'resourceId' in row &&
              'action' in row &&
              row.resourceKind === resourceKind &&
              row.resourceId === resourceId &&
              row.action === action,
          ),
      )
    )
      return fail('REPLAY_AUDIT_INTEGRITY');
    if (receiptCreatedConversation) {
      const creationValues = Object.fromEntries(
        Object.entries(createdConversationSnapshot)
          .filter(([field]) => field !== 'providerChatId')
          .map(([field, value]) => [field, { before: null, after: value }]),
      );
      const expectedCreationDiff = {
        changedFields: Object.keys(createdConversationSnapshot).sort(),
        values: creationValues,
      };
      for (const [resourceKind, resourceId, expectedDiff] of [
        ['omniConversation', conversation.id, expectedCreationDiff],
        [
          'omniMessageThread',
          thread.id,
          { changedFields: ['subject'], values: {} },
        ],
      ] as const) {
        const entry = requireOne(
          z.object({
            redactedDiff: z.unknown(),
            securityDescriptor: z.unknown(),
          }),
          successes.filter(
            (row) =>
              row.resourceKind === resourceKind &&
              row.resourceId === resourceId &&
              row.action === 'create',
          ),
        );
        if (
          canonicalAuditJson(entry.redactedDiff) !==
            canonicalAuditJson(expectedDiff) ||
          canonicalAuditJson(entry.securityDescriptor) !==
            canonicalAuditJson({ resourceKind, resourceId, ...scoped })
        )
          return fail('REPLAY_CREATION_AUDIT_INTEGRITY');
      }
    }
    const reread = requireOne(
      receiptSchema,
      await query(
        `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE`,
        [workspaceId, binding.id, proof.receiptId],
      ),
    );
    if (canonicalAuditJson(reread) !== canonicalAuditJson(initialReceipt))
      return fail('RECEIPT_CHANGED');
    return Object.freeze({
      receiptId: proof.receiptId,
      messageLinkId: link.id,
      messageId: link.messageId,
      conversationId: conversation.id,
      created: false,
      state: 'applied',
    });
  }
  if (
    initialReceipt.applicationResult !== null ||
    initialReceipt.state !== 'processing' ||
    initialReceipt.resultId !== null
  )
    return fail('RECEIPT_NOT_PROCESSING');
  if (
    initialReceipt.leaseOwner !== proof.leaseOwner ||
    initialReceipt.leaseToken !== proof.leaseToken
  )
    return fail('LEASE_LOST');
  if (links.length !== 0)
    return fail('EXISTING_MESSAGE_REQUIRES_RECONCILIATION');
  const conflicts = await query(
    `SELECT id FROM "${schema}"."message" WHERE "headerMessageId"=$1
    UNION ALL SELECT "messageId" AS id FROM "${schema}"."messageChannelMessageAssociation" WHERE "messageChannelId"=$2 AND "messageExternalId"=$3`,
    [
      references.headerMessageId,
      binding.messageChannelId,
      references.messageExternalId,
    ],
  );
  if (conflicts.length !== 0) return fail('FOREIGN_NATIVE_IDENTITY');
  const nativeIds = z
    .object({
      messageId: uuid,
      participantId: uuid,
      associationId: uuid,
      createdThread: z.boolean(),
    })
    .parse(await createInitialMessage.call(nativePort, nativeInput));
  if (nativeIds.createdThread !== creatingConversation)
    return fail('NATIVE_THREAD_CREATION_POSTCONDITION');
  const native = await verifyNative(nativeIds);
  const messageLinkId = randomUUID();
  const link = {
    bindingId: binding.id,
    conversationId: conversation.id,
    messageId: nativeIds.messageId,
    currentRevisionId: revisionId,
    rawNativeMessageId: envelope.providerMessageId,
    nativeMessageKey: capture.context.nativeMessageKey,
    nativeMessageKeyVersion: capture.context.nativeMessageKeyVersion,
    sourcePosition: capture.context.sourcePosition,
    displayOccurredAt: receivedAt,
    displayTimeSource: envelope.occurredAt === null ? 'capture' : 'source',
    immutableAuthorSnapshot: authorSnapshot,
    sourceAuthorId: envelope.payload.sourceAuthorId,
    sourceDisplayName: envelope.payload.sourceDisplayName,
    authorVerification: identity.verificationSource,
    senderProvenance: 'unresolved_external',
    correlationState: 'not_applicable',
  };
  await query(
    `INSERT INTO core."omniMessageLink" (id,"workspaceId","bindingId","conversationId","messageId","rawNativeMessageId","nativeMessageKey","nativeMessageKeyVersion","sourcePosition","displayOccurredAt","displayTimeSource","immutableAuthorSnapshot","sourceAuthorId","sourceDisplayName","authorVerification","senderProvenance","correlationState")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)`,
    [
      messageLinkId,
      workspaceId,
      link.bindingId,
      link.conversationId,
      link.messageId,
      link.rawNativeMessageId,
      link.nativeMessageKey,
      link.nativeMessageKeyVersion,
      canonicalAuditJson(link.sourcePosition),
      receivedAt,
      link.displayTimeSource,
      canonicalAuditJson(authorSnapshot),
      link.sourceAuthorId,
      link.sourceDisplayName,
      link.authorVerification,
      link.senderProvenance,
      link.correlationState,
    ],
  );
  const revision = {
    messageLinkId,
    sourceRevisionKey,
    sourceEventId: envelope.eventId,
    contentHash,
    tombstone: candidateContent?.tombstone ?? false,
    origin: capture.context.origin,
  };
  await query(
    `INSERT INTO core."omniMessageRevision" (id,"workspaceId","messageLinkId","sourceRevisionKey","sourceEventId","contentHash",tombstone,origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      revisionId,
      workspaceId,
      messageLinkId,
      sourceRevisionKey,
      envelope.eventId,
      contentHash,
      revision.tombstone,
      revision.origin,
    ],
  );
  await query(
    'UPDATE core."omniMessageLink" SET "currentRevisionId"=$3 WHERE "workspaceId"=$1 AND id=$2 AND "currentRevisionId" IS NULL',
    [workspaceId, messageLinkId, revisionId],
  );
  const verifyHead = async () => {
    const head = requireOne(
      z.object({ currentRevisionId: uuid }),
      await query(
        'SELECT "currentRevisionId" FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND id=$2',
        [workspaceId, messageLinkId],
      ),
    );
    if (head.currentRevisionId !== revisionId)
      return fail('REVISION_HEAD_POSTCONDITION');
  };
  await verifyHead();
  const advanced = requireOne(
    z.object({
      conversationSequence: positiveBigint,
      replyRevision: positiveBigint,
    }),
    await query(
      'UPDATE core."omniConversation" SET "conversationSequence"="conversationSequence"+$3,"replyRevision"="replyRevision"+1,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND id=$2 RETURNING "conversationSequence","replyRevision"',
      [workspaceId, conversation.id, creatingConversation ? 2 : 1],
    ),
  );
  const sequence = advanced.conversationSequence;
  currentConversationSequence = sequence;
  if (
    creatingConversation &&
    (sequence !== '2' || advanced.replyRevision !== '2')
  )
    return fail('CONVERSATION_RESERVATION');
  const messageEvent = buildStorageEvent({
    eventId,
    rootId,
    rootRowId,
    dispatchId,
    kind: adapter ? envelope.kind : 'message.received',
    sequence,
    payload: {
      messageLinkId,
      messageId: nativeIds.messageId,
      receiptId: proof.receiptId,
      dispatchSuppressed: true,
    },
  });
  const newEvents = [
    messageEvent,
    ...(creatingConversation ? [creationEvent] : []),
  ];
  for (const item of newEvents.sort((left, right) =>
    left.rootId.localeCompare(right.rootId),
  )) {
    await persistStorageEvent(item);
  }

  const lockedReceipt = requireOne(
    receiptSchema,
    await query(
      `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE`,
      [workspaceId, binding.id, proof.receiptId],
    ),
  );
  if (canonicalAuditJson(lockedReceipt) !== canonicalAuditJson(initialReceipt))
    return fail('RECEIPT_CHANGED');
  record('omniMessage', nativeIds.messageId, 'create', null, {
    messageThreadId: thread.id,
    isDraft: false,
    text: native.message.text,
    subject: null,
    headerMessageId: references.headerMessageId,
    receivedAt,
  });
  record('omniMessageParticipant', nativeIds.participantId, 'create', null, {
    messageId: nativeIds.messageId,
    personId: identity.personId,
    workspaceMemberId: null,
    role: 'FROM',
    handle: nativeInput.participantHandle,
    displayName: nativeInput.participantDisplayName,
  });
  record('omniMessageAssociation', nativeIds.associationId, 'create', null, {
    messageId: nativeIds.messageId,
    messageChannelId: binding.messageChannelId,
    direction: 'INCOMING',
    messageExternalId: references.messageExternalId,
    messageThreadExternalId: references.messageThreadExternalId,
  });
  record('omniMessageLink', messageLinkId, 'create', null, link);
  record('omniMessageRevision', revisionId, 'create', null, revision);
  if (creatingConversation) {
    record('omniMessageThread', thread.id, 'create', null, { subject: null });
    record(
      'omniConversation',
      conversation.id,
      'create',
      null,
      createdConversationSnapshot,
    );
  } else
    record(
      'omniConversation',
      conversation.id,
      'update',
      {
        bindingId: binding.id,
        conversationSequence: conversation.conversationSequence,
        replyRevision: conversation.replyRevision,
      },
      {
        bindingId: binding.id,
        conversationSequence: sequence,
        replyRevision: advanced.replyRevision,
      },
    );
  for (const item of newEvents) recordStorageEvent(item);
  const applicationResult = adapter
    ? snapshotOmniIncomingApplicationResult({
        schemaVersion: 1,
        kind: 'incoming_text_revision',
        disposition: 'created',
        selectedRevisionId: revisionId,
        observedHeadRevisionId: null,
        candidateSourceRevisionKey: sourceRevisionKey,
        candidateContentHash: contentHash,
      })
    : null;
  record(
    'omniIncomingReceipt',
    proof.receiptId,
    'update',
    {
      bindingId: binding.id,
      state: initialReceipt.state,
      ...(adapter ? { applicationResult: null } : {}),
      resultId: null,
      leaseToken: initialReceipt.leaseToken,
      leaseOwner: initialReceipt.leaseOwner,
      leaseUntil: initialReceipt.leaseUntil,
    },
    {
      bindingId: binding.id,
      state: 'applied',
      ...(adapter ? { applicationResult } : {}),
      resultId: messageLinkId,
      leaseToken: initialReceipt.leaseToken,
      leaseOwner: null,
      leaseUntil: null,
    },
  );
  await audit.flush();
  const applied = await query(
    `UPDATE core."omniIncomingReceipt" SET state='applied',"resultId"=$7,"applicationResult"=$8::jsonb,"leaseOwner"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"updatedAt"=clock_timestamp()
    WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state='processing' AND "leaseOwner"=$4 AND "leaseToken"=$5 AND "routeGeneration"=$6 AND "leaseUntil">clock_timestamp() RETURNING id`,
    [
      workspaceId,
      binding.id,
      proof.receiptId,
      proof.leaseOwner,
      proof.leaseToken,
      proof.routeGeneration,
      messageLinkId,
      applicationResult === null ? null : canonicalAuditJson(applicationResult),
    ],
  );
  if (applied.length !== 1) return fail('LEASE_LOST');
  await verifyHead();
  await verifyNative(nativeIds);
  const finalReceipt = requireOne(
    receiptSchema,
    await query(
      `SELECT ${receiptColumns} FROM core."omniIncomingReceipt" WHERE "workspaceId"=$1 AND id=$2`,
      [workspaceId, proof.receiptId],
    ),
  );
  if (
    finalReceipt.state !== 'applied' ||
    finalReceipt.resultId !== messageLinkId ||
    finalReceipt.leaseOwner !== null ||
    finalReceipt.leaseUntil !== null ||
    finalReceipt.errorCode !== null ||
    finalReceipt.leaseToken !== proof.leaseToken ||
    canonicalAuditJson(immutableReceipt(finalReceipt)) !==
      canonicalAuditJson(immutableReceipt(initialReceipt)) ||
    canonicalAuditJson(finalReceipt.applicationResult) !==
      canonicalAuditJson(applicationResult)
  )
    return fail('RECEIPT_POSTCONDITION');
  if (adapter) {
    const finalLinks = await query(
      'SELECT * FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND id=$2',
      [workspaceId, messageLinkId],
    );
    if (finalLinks.length !== 1) return fail('REVISION_HEAD_POSTCONDITION');
    await verifyChainNative(await loadChain(finalLinks[0]));
  }
  return Object.freeze({
    receiptId: proof.receiptId,
    messageLinkId,
    messageId: nativeIds.messageId,
    conversationId: conversation.id,
    created: true,
    ...(applicationResult ? { applicationResult, replayed: false } : {}),
    state: 'applied',
  });
};
