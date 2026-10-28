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
      action: 'history.apply';
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
  text: string;
  receivedAt: string;
  personId: string;
  participantHandle: string;
  participantDisplayName: string;
}>;
export type OmniHistoryNativePort = {
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
  createdAt: timestamp,
});
const receiptColumns = `id, "bindingId", "eventId", kind, "schemaVersion", "routeGeneration", "canonicalPayloadHash", "validatedEnvelope",
  "trustedCaptureContext", "trustedCaptureContextHash", state, "leaseOwner", "leaseToken", "leaseUntil", "resultId", "createdAt"`;
const disabledSettings = {
  enabled: false,
  maxReplies: 0,
  maxCrmEffects: 0,
  maxHops: 0,
};

export const omniHistoryApplyOperationId = (receiptId: string): string =>
  uuidV5('omni:history.apply:v1', uuid.parse(receiptId));

// The caller owns commit/rollback; every SQL statement and the native adapter share this strict scope.
export const applyOmniHistoryReceipt = async (
  inputScope: OmniHistoryApplyScope,
  inputPrincipal: OmniHistoryApplyPrincipal,
  inputProof: OmniHistoryApplyProof,
  inputAuthorize: OmniHistoryApplyAuthorizer,
  nativePort: OmniHistoryNativePort,
): Promise<OmniHistoryApplyResult> => {
  const { principal, proof, authorize } = snapshotOmniHistoryReceiptRequest(
    inputPrincipal,
    inputProof,
    inputAuthorize,
  );
  const createInitialMessage = nativePort?.createInitialMessage;
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
  const operationId = omniHistoryApplyOperationId(proof.receiptId);
  const eventId = uuidV5('omni:history.message.received:v1', proof.receiptId);
  const rootId = uuidV5(`domain_event:${eventId}`, workspaceId);
  const rootRowId = uuidV5('omni:history.root:v1', proof.receiptId);
  const dispatchId = uuidV5('omni:history.dispatch:v1', proof.receiptId);
  const revisionId = uuidV5(
    'omni:history.initial.revision:v1',
    proof.receiptId,
  );
  const creatorConversationId = uuidV5(
    'omni:history.conversation:v1',
    proof.receiptId,
  );
  const creatorThreadId = uuidV5('omni:history.thread:v1', proof.receiptId);
  const creationEventId = uuidV5(
    'omni:history.conversation.created:v1',
    proof.receiptId,
  );
  const creationRootId = uuidV5(`domain_event:${creationEventId}`, workspaceId);
  const creationRootRowId = uuidV5(
    'omni:history.conversation.root:v1',
    proof.receiptId,
  );
  const creationDispatchId = uuidV5(
    'omni:history.conversation.dispatch:v1',
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
    capture.context.origin !== 'history_import' ||
    envelope.kind !== 'message.received' ||
    envelope.direction !== 'incoming' ||
    envelope.sourceVariant !== 'complete' ||
    envelope.payload.text === null
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
      action: 'history.apply' as const,
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
    text: envelope.payload.text,
    receivedAt,
    personId: identity.personId,
    participantHandle: identity.providerPeerId,
    participantDisplayName: envelope.payload.sourceDisplayName ?? '',
  });
  const contentHash = auditPayloadHash({
    direction: envelope.direction,
    text: nativeInput.text,
    receivedAt,
    sourceAuthorId: envelope.payload.sourceAuthorId,
    sourceDisplayName: envelope.payload.sourceDisplayName,
    nativeMessageKey: capture.context.nativeMessageKey,
    sourceVariant: envelope.sourceVariant,
  });
  const sourceRevisionKey = `initial:${auditPayloadHash({ eventId: envelope.eventId, captureHash: capture.hash })}`;
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
    kind: 'message.received' | 'conversation.created';
    sequence: string;
    payload: Record<string, unknown>;
  }) => {
    const root = {
      rootKind: 'domain_event',
      rootId: input.rootId,
      sourceKey: input.eventId,
      initialEventIds: [input.eventId],
      origin: 'history_import',
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
      origin: 'history_import',
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
       VALUES ($1,$2,'domain_event',$3,$4,$5::uuid[],'history_import',$6::jsonb,'[]'::jsonb,$7,0,0,0,'suppressed')`,
      [
        item.rootRowId,
        workspaceId,
        item.rootId,
        item.eventId,
        [item.eventId],
        canonicalAuditJson(item.root.scope),
        policy.id,
      ],
    );
    await query(
      `INSERT INTO core."omniDomainEvent" (id,"workspaceId","conversationId","conversationSequence",kind,origin,"rootExecutionId","payloadVersion",payload)
       VALUES ($1,$2,$3,$4,$5,'history_import',$6,1,$7::jsonb)`,
      [
        item.eventId,
        workspaceId,
        conversation.id,
        item.sequence,
        item.kind,
        item.rootRowId,
        canonicalAuditJson(item.payload),
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
        kind: z.enum(['message.received', 'conversation.created']),
        origin: z.literal('history_import'),
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
        BigInt(conversation.conversationSequence) ||
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
        origin: z.literal('history_import'),
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

  const verifyNative = async (ids: {
    messageId: string;
    participantId: string;
    associationId: string;
  }) => {
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
        text: z.string(),
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
      message.text !== nativeInput.text ||
      message.receivedAt !== receivedAt
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
      participant.personId !== identity.personId ||
      participant.handle !== nativeInput.participantHandle ||
      participant.displayName !== nativeInput.participantDisplayName
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
  if (initialReceipt.state === 'applied') {
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
      (link.currentRevisionId !== null &&
        link.currentRevisionId !== revisionId) ||
      link.rawNativeMessageId !== envelope.providerMessageId ||
      canonicalAuditJson(link.sourcePosition) !==
        canonicalAuditJson(capture.context.sourcePosition) ||
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
    await verifyNative({
      messageId: link.messageId,
      participantId: participant.id,
      associationId: association.id,
    });
    const revision = requireOne(
      z.object({
        messageLinkId: uuid,
        sourceRevisionKey: z.string(),
        sourceEventId: z.string(),
        contentHash: z.string(),
        tombstone: z.literal(false),
        origin: z.literal('history_import'),
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
    if (revisions.length !== 1 || revisions[0].id !== revisionId)
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
  if (initialReceipt.state !== 'processing' || initialReceipt.resultId !== null)
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
    tombstone: false,
    origin: 'history_import',
  };
  await query(
    `INSERT INTO core."omniMessageRevision" (id,"workspaceId","messageLinkId","sourceRevisionKey","sourceEventId","contentHash",tombstone,origin) VALUES ($1,$2,$3,$4,$5,$6,false,'history_import')`,
    [
      revisionId,
      workspaceId,
      messageLinkId,
      sourceRevisionKey,
      envelope.eventId,
      contentHash,
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
    kind: 'message.received',
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
  record(
    'omniIncomingReceipt',
    proof.receiptId,
    'update',
    {
      bindingId: binding.id,
      state: initialReceipt.state,
      resultId: null,
      leaseToken: initialReceipt.leaseToken,
      leaseOwner: initialReceipt.leaseOwner,
      leaseUntil: initialReceipt.leaseUntil,
    },
    {
      bindingId: binding.id,
      state: 'applied',
      resultId: messageLinkId,
      leaseToken: initialReceipt.leaseToken,
      leaseOwner: null,
      leaseUntil: null,
    },
  );
  await audit.flush();
  const applied = await query(
    `UPDATE core."omniIncomingReceipt" SET state='applied',"resultId"=$7,"leaseOwner"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"updatedAt"=clock_timestamp()
    WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND state='processing' AND "leaseOwner"=$4 AND "leaseToken"=$5 AND "routeGeneration"=$6 AND "leaseUntil">clock_timestamp() RETURNING id`,
    [
      workspaceId,
      binding.id,
      proof.receiptId,
      proof.leaseOwner,
      proof.leaseToken,
      proof.routeGeneration,
      messageLinkId,
    ],
  );
  if (applied.length !== 1) return fail('LEASE_LOST');
  await verifyHead();
  return Object.freeze({
    receiptId: proof.receiptId,
    messageLinkId,
    messageId: nativeIds.messageId,
    conversationId: conversation.id,
    created: true,
    state: 'applied',
  });
};
