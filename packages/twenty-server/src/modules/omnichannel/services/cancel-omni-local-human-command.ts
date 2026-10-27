import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { omniConnectorAcceptanceInputSchema } from 'src/modules/omnichannel/contracts/omni-connector-acceptance';
import {
  isOmniLocalCommandCancellationProof,
  omniLocalCommandCancellationInputSchema,
  omniLocalCommandCancellationPrincipalSchema,
  omniLocalCommandCancellationProofSchema,
  type OmniLocalCommandCancellationInput,
  type OmniLocalCommandCancellationPrincipal,
  type OmniLocalCommandCancellationResult,
} from 'src/modules/omnichannel/contracts/omni-local-command-cancellation';
import { type OmniHumanCommandLeaseScope } from 'src/modules/omnichannel/services/claim-omni-human-command';

const fields = omniConnectorAcceptanceInputSchema.unwrap().shape;
const uuid = fields.commandId;
const timestamp = z.iso.datetime({ precision: 6 });
const authorizationErrors = new WeakSet<Error>();
const fail = (code: string): never => {
  throw new Error(`OMNI_LOCAL_COMMAND_CANCEL_${code}`);
};
const deny = (): never => {
  const error = new Error('OMNI_LOCAL_COMMAND_CANCEL_AUTHORIZATION_DENIED');
  authorizationErrors.add(error);
  throw error;
};
export const isOmniLocalCommandCancellationAuthorizationError = (
  error: unknown,
): boolean => error instanceof Error && authorizationErrors.has(error);
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
export type OmniLocalCommandCancellationScope = OmniHumanCommandLeaseScope;
export type OmniLocalCommandCancellationDescriptor = Readonly<{
  principal: OmniLocalCommandCancellationPrincipal;
  action: 'command.cancel.local';
  bindingId: string;
  conversationId: string;
  queueId: string | null;
  commandId: string;
  authorMemberId: string;
  state: string;
  restoreIncarnation: string;
  createdRestoreIncarnation: string | null;
}>;
export type OmniLocalCommandCancellationCallbacks = Readonly<{
  authorizeRead: (
    scope: OmniLocalCommandCancellationScope,
    descriptor: OmniLocalCommandCancellationDescriptor,
  ) => Promise<void>;
  authorizeDelegatedCancel?: (
    scope: OmniLocalCommandCancellationScope,
    descriptor: OmniLocalCommandCancellationDescriptor,
  ) => Promise<void>;
}>;
export const snapshotOmniLocalCommandCancellationRequest = (
  principal: OmniLocalCommandCancellationPrincipal,
  input: OmniLocalCommandCancellationInput,
  callbacks: OmniLocalCommandCancellationCallbacks,
) => {
  const authorizeRead = callbacks?.authorizeRead,
    authorizeDelegatedCancel = callbacks?.authorizeDelegatedCancel;
  if (
    typeof authorizeRead !== 'function' ||
    (authorizeDelegatedCancel !== undefined &&
      typeof authorizeDelegatedCancel !== 'function')
  )
    return fail('CALLBACKS_REQUIRED');
  return Object.freeze({
    principal: omniLocalCommandCancellationPrincipalSchema.parse(principal),
    input: omniLocalCommandCancellationInputSchema.parse(input),
    callbacks: Object.freeze({ authorizeRead, authorizeDelegatedCancel }),
  });
};
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
    payloadHash: fields.payloadHash,
    payload: z.json(),
    generation: fields.generation,
    policyVersion: z.literal('0'),
    createdRestoreIncarnation: uuid.nullable(),
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
    leaseToken: uuid.nullable(),
    leaseUntil: timestamp.nullable(),
    nextAttemptAt: timestamp,
    connectorJobId: z.string().nullable(),
    connectorAcceptedEvidence: z.json().nullable(),
    journalSequence: fields.journalSequence.nullable(),
    cancelRequestedAt: timestamp.nullable(),
    cancelReason: z.string().nullable(),
    cancelEvidence: z.json().nullable(),
    expectedAutomationEpoch: z.null(),
    referenceId: z.null(),
    producerTurnId: z.null(),
    capturedTurnFence: z.null(),
    workflowCancellationRefs: z.array(z.unknown()).length(0),
    replacesCommandId: z.null(),
    replyToMessageLinkId: z.null(),
    resolvedReplyNativeRef: z.null(),
  })
  .passthrough();
const payloadSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: uuid,
  bindingId: uuid,
  conversationId: uuid,
  providerChatId: fields.providerChatId,
  text: z.string().min(1),
  readyFileIds: z.array(z.unknown()).length(0),
  replyToMessageLinkId: z.null(),
  resolvedReplyNativeRef: z.null(),
});
const columns = `command.*,
  to_char(command."leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
  to_char(command."nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt",
  to_char(command."cancelRequestedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cancelRequestedAt"`;
const stable = (row: z.infer<typeof commandSchema>) => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...snapshot } = row;
  return snapshot;
};

export const cancelOmniLocalHumanCommand = async (
  inputScope: OmniLocalCommandCancellationScope,
  principalInput: OmniLocalCommandCancellationPrincipal,
  input: OmniLocalCommandCancellationInput,
  callbacksInput: OmniLocalCommandCancellationCallbacks,
): Promise<OmniLocalCommandCancellationResult> => {
  const request = snapshotOmniLocalCommandCancellationRequest(
    principalInput,
    input,
    callbacksInput,
  );
  const { principal, callbacks } = request;
  const { workspaceId } = principal;
  if (inputScope.workspaceId !== workspaceId) return fail('WORKSPACE_MISMATCH');
  const execute = inputScope.executeRawQuery;
  const scope: OmniLocalCommandCancellationScope = Object.freeze({
    workspaceId,
    transactionLifecycle: inputScope.transactionLifecycle,
    executeRawQuery: (sql, parameters) =>
      execute.call(inputScope, sql, parameters),
  });
  const executor = createCrmAuditWorkspaceExecutor(scope),
    query = executor.query;
  const assertActive = () => {
    createCrmAuditWorkspaceExecutor(scope);
  };
  const policy = one(
    z.object({ restoreIncarnation: uuid }),
    await query(
      'SELECT "restoreIncarnation" FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR SHARE',
      [workspaceId],
    ),
  );
  const discovered = one(
    z.object({ conversationId: uuid, bindingId: uuid }),
    await query(
      `SELECT command."conversationId",conversation."bindingId" FROM core."omniOutgoingCommand" command JOIN core."omniConversation" conversation ON conversation.id=command."conversationId" AND conversation."workspaceId"=command."workspaceId" WHERE command."workspaceId"=$1 AND command.id=$2`,
      [workspaceId, request.input.commandId],
    ),
  );
  one(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, discovered.bindingId],
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
      [workspaceId, discovered.conversationId],
    ),
  );
  if (conversation.bindingId !== discovered.bindingId)
    return fail('PARENT_CHANGED');
  // The shared schema utility barrel reaches Enterprise code; retain Twenty's validated UUID encoding.
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const memberships = await query(
    `SELECT member.id FROM "${schema}"."workspaceMember" member JOIN core."userWorkspace" membership ON membership."userId"=member."userId" AND membership."workspaceId"=$1 JOIN core."user" active_user ON active_user.id=member."userId" WHERE member.id=$2 AND member."userId"=$3 AND member."deletedAt" IS NULL AND membership."deletedAt" IS NULL AND active_user."deletedAt" IS NULL FOR SHARE OF member,membership,active_user`,
    [workspaceId, principal.workspaceMemberId, principal.userId],
  );
  if (memberships.length !== 1) return deny();
  one(z.object({ id: z.literal(principal.workspaceMemberId) }), memberships);
  const readCommand = () =>
    query(
      `SELECT ${columns} FROM core."omniOutgoingCommand" command WHERE command."workspaceId"=$1 AND command.id=$2 FOR UPDATE`,
      [workspaceId, request.input.commandId],
    );
  const before = one(commandSchema, await readCommand());
  const payload = payloadSchema.parse(before.payload);
  if (
    before.conversationId !== conversation.id ||
    before.initiatingActorId !== before.actorId ||
    auditPayloadHash(before.payload) !== before.payloadHash ||
    payload.workspaceId !== workspaceId ||
    payload.bindingId !== conversation.bindingId ||
    payload.conversationId !== conversation.id ||
    payload.providerChatId !== conversation.providerChatId
  )
    return fail('COMMAND_INTEGRITY');
  const descriptor = freeze({
    principal,
    action: 'command.cancel.local' as const,
    bindingId: conversation.bindingId,
    conversationId: conversation.id,
    queueId: conversation.queueId,
    commandId: before.id,
    authorMemberId: before.actorId,
    state: before.state,
    restoreIncarnation: policy.restoreIncarnation,
    createdRestoreIncarnation: before.createdRestoreIncarnation,
  });
  await callbacks.authorizeRead(scope, descriptor);
  assertActive();
  if (before.actorId !== principal.workspaceMemberId) {
    if (!callbacks.authorizeDelegatedCancel) return deny();
    await callbacks.authorizeDelegatedCancel(scope, descriptor);
    assertActive();
  }
  const proofContext = {
    ...before,
    commandId: before.id,
    bindingId: conversation.bindingId,
    providerChatId: conversation.providerChatId,
  };
  const operationId = uuidV5('omni:human.command.local_cancel:v1', before.id);
  if (
    isOmniLocalCommandCancellationProof(before.cancelEvidence, proofContext)
  ) {
    const proof = omniLocalCommandCancellationProofSchema.parse(
      before.cancelEvidence,
    );
    const entries = await query(
      `SELECT id FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 AND "resourceKind"='omniOutgoingCommand' AND "resourceId"=$3 AND action='update' AND outcome='success' AND actor=$4::jsonb`,
      [
        workspaceId,
        operationId,
        before.id,
        canonicalAuditJson({
          kind: 'workspaceMember',
          id: proof.cancelledByMemberId,
        }),
      ],
    );
    one(z.object({ id: uuid }), entries);
    if (
      canonicalAuditJson(stable(one(commandSchema, await readCommand()))) !==
      canonicalAuditJson(stable(before))
    )
      return fail('REPLAY_POSTCONDITION');
    assertActive();
    return Object.freeze({
      cancelled: true,
      commandId: before.id,
      applied: false,
      state: 'cancelled',
      statusRevision: '2',
    });
  }
  const noCancel = (
    reason: Extract<
      OmniLocalCommandCancellationResult,
      { cancelled: false }
    >['reason'],
  ): OmniLocalCommandCancellationResult =>
    Object.freeze({ cancelled: false, commandId: before.id, reason });
  if (['sent', 'failed', 'cancelled'].includes(before.state))
    return noCancel('terminal');
  if (
    before.state !== 'pending' ||
    before.statusRevision !== '1' ||
    before.leaseToken !== null ||
    before.leaseUntil !== null ||
    before.connectorJobId !== null ||
    before.connectorAcceptedEvidence !== null ||
    before.journalSequence !== null ||
    before.cancelRequestedAt !== null ||
    before.cancelReason !== null ||
    before.cancelEvidence !== null
  )
    return noCancel('requires_reconciliation');
  if (before.createdRestoreIncarnation !== policy.restoreIncarnation)
    return noCancel('restore_reconciliation_required');
  const timing = one(
    z.object({ cancelledAt: timestamp }),
    await query(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cancelledAt"`,
    ),
  );
  const proof = omniLocalCommandCancellationProofSchema.parse({
    schemaVersion: 1,
    evidenceKind: 'command.local_cancel_before_enqueue',
    workspaceId,
    bindingId: conversation.bindingId,
    conversationId: conversation.id,
    commandId: before.id,
    providerChatId: conversation.providerChatId,
    payloadHash: before.payloadHash,
    generation: before.generation,
    createdRestoreIncarnation: before.createdRestoreIncarnation,
    authorMemberId: before.actorId,
    cancelledByMemberId: principal.workspaceMemberId,
    cancelledByUserId: principal.userId,
    cancelledAt: timing.cancelledAt,
  });
  const after = {
    ...stable(before),
    state: 'cancelled' as const,
    statusRevision: '2',
    cancelRequestedAt: timing.cancelledAt,
    cancelReason: 'human_cancel_before_enqueue',
    cancelEvidence: proof,
  };
  const audit = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId,
    actor: { kind: 'workspaceMember', id: principal.workspaceMemberId },
  });
  audit.record({
    resourceKind: 'omniOutgoingCommand',
    resourceId: before.id,
    action: 'update',
    before: stable(before),
    after,
    securityDescriptor: {
      resourceKind: 'omniOutgoingCommand',
      resourceId: before.id,
      bindingId: conversation.bindingId,
      conversationId: conversation.id,
    },
  });
  await audit.flush();
  one(
    commandSchema,
    await query(
      `WITH changed AS (UPDATE core."omniOutgoingCommand" SET state='cancelled',"statusRevision"=2,"cancelRequestedAt"=$3::timestamptz,"cancelReason"='human_cancel_before_enqueue',"cancelEvidence"=$4::jsonb,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND id=$2 AND state='pending' AND "statusRevision"=1 AND "createdRestoreIncarnation"=$5 AND "leaseToken" IS NULL AND "leaseUntil" IS NULL AND "connectorJobId" IS NULL AND "connectorAcceptedEvidence" IS NULL AND "journalSequence" IS NULL AND "cancelRequestedAt" IS NULL AND "cancelReason" IS NULL AND "cancelEvidence" IS NULL RETURNING *) SELECT ${columns} FROM changed command`,
      [
        workspaceId,
        before.id,
        timing.cancelledAt,
        canonicalAuditJson(proof),
        policy.restoreIncarnation,
      ],
    ),
  );
  const persisted = one(commandSchema, await readCommand());
  const currentPolicy = one(
    z.object({ restoreIncarnation: uuid }),
    await query(
      'SELECT "restoreIncarnation" FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1',
      [workspaceId],
    ),
  );
  if (
    canonicalAuditJson(stable(persisted)) !== canonicalAuditJson(after) ||
    currentPolicy.restoreIncarnation !== policy.restoreIncarnation ||
    !isOmniLocalCommandCancellationProof(persisted.cancelEvidence, {
      ...proofContext,
      ...persisted,
    })
  )
    return fail('POSTCONDITION');
  assertActive();
  return Object.freeze({
    cancelled: true,
    commandId: before.id,
    applied: true,
    state: 'cancelled',
    statusRevision: '2',
  });
};
