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
  omniHumanCommandLeaseInputSchema,
  omniHumanCommandLeasePrincipalSchema,
  type OmniHumanCommandLeaseInput,
  type OmniHumanCommandLeasePrincipal,
  type OmniHumanCommandLeasePurpose,
  type OmniHumanCommandLeaseResult,
} from 'src/modules/omnichannel/contracts/omni-human-command-lease';

const uuid = z.uuid();
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const positive = counter.refine((value) => BigInt(value) > 0n);
const timestamp = z.iso.datetime({ precision: 6 });
const commandState = z.enum([
  'pending',
  'dispatching',
  'accepted',
  'outcome_unknown',
  'sent',
  'failed',
  'cancelled',
]);
const commandSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  conversationId: uuid,
  actorKind: z.string().min(1),
  actorId: z.string().min(1),
  initiatingActorId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.json(),
  generation: positive,
  policyId: uuid,
  policyVersion: counter,
  senderClass: z.string().min(1),
  contentProvenance: z.string().min(1),
  expectedAutomationEpoch: positive.nullable(),
  referenceId: uuid.nullable(),
  producerTurnId: uuid.nullable(),
  capturedTurnFence: positive.nullable(),
  workflowCancellationRefs: z.array(z.json()),
  replacesCommandId: uuid.nullable(),
  replyToMessageLinkId: uuid.nullable(),
  resolvedReplyNativeRef: z.json().nullable(),
  outboundSequence: positive,
  state: commandState,
  statusRevision: positive,
  leaseToken: uuid.nullable(),
  leaseUntil: timestamp.nullable(),
  nextAttemptAt: timestamp,
  connectorJobId: z.string().nullable(),
  connectorAcceptedEvidence: z.json().nullable(),
  journalSequence: counter.nullable(),
  cancelRequestedAt: timestamp.nullable(),
  cancelReason: z.string().nullable(),
  cancelEvidence: z.json().nullable(),
  leaseLive: z.boolean(),
  due: z.boolean(),
});
type Command = z.infer<typeof commandSchema>;
export type OmniHumanCommandLeaseScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
type CommandSnapshot = Readonly<
  Omit<Command, 'payload' | 'idempotencyKey' | 'leaseLive' | 'due'>
>;
export type OmniHumanCommandLeaseDescriptor = Readonly<{
  principal: OmniHumanCommandLeasePrincipal;
  action: 'command.send' | 'command.reconcile';
  purpose: OmniHumanCommandLeasePurpose;
  bindingId: string;
  conversationId: string;
  providerChatId: string;
  queueId: string | null;
  mode: 'human' | 'assist' | 'auto';
  status: 'open' | 'closed';
  bindingStatus: string;
  bindingRevision: string;
  routeGeneration: string;
  policyEpoch: string;
  capturedRestoreIncarnation: string;
  capabilitiesVersion: string;
  capabilities: unknown;
  capturedAuthor: Readonly<{
    workspaceMemberId: string;
    userId: string | null;
  }>;
  command: CommandSnapshot;
}>;
export type OmniHumanCommandLeaseCallbacks = Readonly<{
  authorize: (
    scope: OmniHumanCommandLeaseScope,
    descriptor: OmniHumanCommandLeaseDescriptor,
  ) => Promise<void>;
  qualifyTransport: (
    scope: OmniHumanCommandLeaseScope,
    descriptor: OmniHumanCommandLeaseDescriptor,
  ) => Promise<void>;
  verifyPredecessor?: (
    scope: OmniHumanCommandLeaseScope,
    descriptor: Readonly<
      OmniHumanCommandLeaseDescriptor & { predecessor: CommandSnapshot }
    >,
  ) => Promise<'durably_accepted' | 'terminal_before_enqueue'>;
}>;

const fail = (code: string): never => {
  throw new Error(`OMNI_HUMAN_COMMAND_LEASE_${code}`);
};
const authorizationErrors = new WeakSet<Error>();
export const isOmniHumanCommandLeaseAuthorizationError = (
  error: unknown,
): boolean => error instanceof Error && authorizationErrors.has(error);
const denyMembership = (): never => {
  const error = new Error('OMNI_HUMAN_COMMAND_LEASE_MEMBERSHIP_DENIED');
  authorizationErrors.add(error);
  throw error;
};
const one = <Schema extends z.ZodType>(
  schema: Schema,
  rows: unknown[],
): z.infer<Schema> => {
  if (rows.length !== 1) return fail('ROW_INTEGRITY');
  return schema.parse(rows[0]);
};
const freezeJson = <Value>(value: Value): Value => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
};
const commandSnapshot = (command: Command): CommandSnapshot => {
  const {
    payload: _payload,
    idempotencyKey: _key,
    leaseLive: _live,
    due: _due,
    ...snapshot
  } = command;
  return freezeJson(snapshot);
};
export const snapshotOmniHumanCommandLeaseRequest = (
  inputPrincipal: OmniHumanCommandLeasePrincipal,
  input: OmniHumanCommandLeaseInput,
  inputCallbacks: OmniHumanCommandLeaseCallbacks,
) => {
  const authorize = inputCallbacks?.authorize;
  const qualifyTransport = inputCallbacks?.qualifyTransport;
  const verifyPredecessor = inputCallbacks?.verifyPredecessor;
  if (
    typeof authorize !== 'function' ||
    typeof qualifyTransport !== 'function' ||
    (verifyPredecessor !== undefined && typeof verifyPredecessor !== 'function')
  )
    return fail('CALLBACKS_REQUIRED');
  return Object.freeze({
    principal: omniHumanCommandLeasePrincipalSchema.parse(inputPrincipal),
    input: omniHumanCommandLeaseInputSchema.parse(input),
    callbacks: Object.freeze({
      authorize,
      qualifyTransport,
      verifyPredecessor,
    }),
  });
};
const columns = `command.*,
  to_char(command."leaseUntil" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil",
  to_char(command."nextAttemptAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "nextAttemptAt",
  to_char(command."cancelRequestedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cancelRequestedAt",
  COALESCE(command."leaseUntil">clock_timestamp(),false) AS "leaseLive",
  command."nextAttemptAt"<=clock_timestamp() AS due`;
const noClaim = (
  reason: Extract<OmniHumanCommandLeaseResult, { claimed: false }>['reason'],
): OmniHumanCommandLeaseResult => Object.freeze({ claimed: false, reason });
const isEvidence = (value: unknown): boolean =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0;
const acceptanceCandidate = (command: Command): boolean =>
  command.state !== 'pending' &&
  command.journalSequence !== null &&
  command.connectorJobId !== null &&
  command.connectorJobId.trim().length > 0 &&
  isEvidence(command.connectorAcceptedEvidence);
const terminalCandidate = (command: Command): boolean =>
  ['failed', 'cancelled'].includes(command.state) &&
  isEvidence(command.cancelEvidence);

// The callbacks verify current grants and locally available transport evidence; no network runs under these locks.
export const claimOmniHumanCommandLease = async (
  inputScope: OmniHumanCommandLeaseScope,
  inputPrincipal: OmniHumanCommandLeasePrincipal,
  input: OmniHumanCommandLeaseInput,
  inputCallbacks: OmniHumanCommandLeaseCallbacks,
): Promise<OmniHumanCommandLeaseResult> => {
  const request = snapshotOmniHumanCommandLeaseRequest(
    inputPrincipal,
    input,
    inputCallbacks,
  );
  const { principal, callbacks } = request;
  const { workspaceId, bindingId } = principal;
  if (inputScope.workspaceId !== workspaceId) return fail('WORKSPACE_MISMATCH');
  const execute = inputScope.executeRawQuery;
  const scope: OmniHumanCommandLeaseScope = Object.freeze({
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
    z.object({
      id: uuid,
      status: z.string(),
      revision: positive,
      routeGeneration: positive,
      connectedAccountId: uuid,
      messageChannelId: uuid,
      capabilitiesVersion: z.string(),
      capabilities: z.json(),
    }),
    await query(
      'SELECT id,status,revision,"routeGeneration","connectedAccountId","messageChannelId","capabilitiesVersion",capabilities FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
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
    z.object({
      id: uuid,
      bindingId: uuid,
      providerChatId: z.string().min(1),
      queueId: uuid.nullable(),
      policyId: uuid,
      policyVersion: counter,
      mode: z.enum(['human', 'assist', 'auto']),
      status: z.enum(['open', 'closed']),
    }),
    await query(
      'SELECT id,"bindingId","providerChatId","queueId","policyId","policyVersion",mode,status FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
      [workspaceId, discovered.conversationId],
    ),
  );
  if (conversation.bindingId !== bindingId) return fail('PARENT_CHANGED');
  const readCommand = (lock = '') =>
    query(
      `SELECT ${columns} FROM core."omniOutgoingCommand" command WHERE command."workspaceId"=$1 AND command.id=$2 ${lock}`,
      [workspaceId, request.input.commandId],
    );
  const initial = one(commandSchema, await readCommand());
  if (
    initial.conversationId !== conversation.id ||
    initial.workspaceId !== workspaceId ||
    initial.id !== request.input.commandId ||
    initial.actorKind !== 'workspaceMember' ||
    !uuid.safeParse(initial.actorId).success ||
    initial.initiatingActorId !== initial.actorId ||
    initial.senderClass !== 'human' ||
    initial.contentProvenance !== 'human_direct' ||
    initial.expectedAutomationEpoch !== null ||
    initial.referenceId !== null ||
    initial.producerTurnId !== null ||
    initial.capturedTurnFence !== null ||
    initial.workflowCancellationRefs.length !== 0 ||
    initial.replacesCommandId !== null ||
    initial.replyToMessageLinkId !== null ||
    initial.resolvedReplyNativeRef !== null ||
    auditPayloadHash(initial.payload) !== initial.payloadHash
  )
    return fail('COMMAND_INTEGRITY');
  const payload = z
    .strictObject({
      version: z.literal(1),
      workspaceId: uuid,
      conversationId: uuid,
      bindingId: uuid,
      providerChatId: z.string().min(1),
      text: z.string().min(1),
      readyFileIds: z.array(z.unknown()).length(0),
      replyToMessageLinkId: z.null(),
      resolvedReplyNativeRef: z.null(),
    })
    .parse(initial.payload);
  if (
    payload.workspaceId !== workspaceId ||
    payload.conversationId !== conversation.id ||
    payload.bindingId !== bindingId ||
    payload.providerChatId !== conversation.providerChatId
  )
    return fail('TARGET_INTEGRITY');
  const purpose: OmniHumanCommandLeasePurpose =
    initial.state === 'pending' ? 'first_attempt' : 'reconcile_only';
  let userId: string | null = null;
  if (purpose === 'first_attempt') {
    // The shared utility barrel reaches Enterprise code; this is Twenty's validated UUID schema encoding.
    const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
    const members = await query(
      `SELECT member.id,member."userId" FROM "${schema}"."workspaceMember" member
      JOIN core."userWorkspace" membership ON membership."userId"=member."userId" AND membership."workspaceId"=$1
      JOIN core."user" active_user ON active_user.id=member."userId"
      WHERE member.id=$2 AND member."deletedAt" IS NULL AND membership."deletedAt" IS NULL AND active_user."deletedAt" IS NULL
      FOR SHARE OF member,membership,active_user`,
      [workspaceId, initial.actorId],
    );
    if (members.length !== 1) return denyMembership();
    const member = one(
      z.object({ id: z.literal(initial.actorId), userId: uuid }),
      members,
    );
    userId = member.userId;
  }
  const descriptor: OmniHumanCommandLeaseDescriptor = freezeJson({
    principal,
    action: purpose === 'first_attempt' ? 'command.send' : 'command.reconcile',
    purpose,
    bindingId,
    conversationId: conversation.id,
    providerChatId: payload.providerChatId,
    queueId: conversation.queueId,
    mode: conversation.mode,
    status: conversation.status,
    bindingStatus: binding.status,
    bindingRevision: binding.revision,
    routeGeneration: binding.routeGeneration,
    policyEpoch: policy.epoch,
    capturedRestoreIncarnation: policy.restoreIncarnation,
    capabilitiesVersion: binding.capabilitiesVersion,
    capabilities: binding.capabilities,
    capturedAuthor: { workspaceMemberId: initial.actorId, userId },
    command: commandSnapshot(initial),
  });
  await callbacks.authorize(scope, descriptor);
  assertActive();
  if (['sent', 'failed', 'cancelled'].includes(initial.state))
    return noClaim('terminal');
  if (initial.leaseLive) return noClaim('lease_live');
  if (!initial.due) return noClaim('not_due');
  if (purpose === 'first_attempt') {
    if (
      initial.statusRevision !== '1' ||
      initial.leaseToken !== null ||
      initial.leaseUntil !== null ||
      initial.connectorJobId !== null ||
      initial.connectorAcceptedEvidence !== null ||
      initial.journalSequence !== null ||
      initial.cancelRequestedAt !== null ||
      initial.cancelReason !== null ||
      initial.cancelEvidence !== null
    )
      return noClaim('non_virgin_pending');
    if (
      binding.status !== 'active' ||
      initial.generation !== binding.routeGeneration
    )
      return fail('CURRENT_ROUTE_REQUIRED');
    if (
      conversation.status !== 'open' ||
      conversation.mode === 'auto' ||
      conversation.queueId === null
    )
      return fail('CURRENT_HUMAN_MODE_REQUIRED');
    one(
      z.object({ id: uuid }),
      await query(
        'SELECT id FROM core."omniQueue" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND active=true FOR SHARE',
        [workspaceId, bindingId, conversation.queueId],
      ),
    );
    one(
      z.object({ id: uuid }),
      await query(
        `SELECT channel.id FROM core."messageChannel" channel JOIN core."connectedAccount" account ON account.id=channel."connectedAccountId"
      WHERE channel.id=$1 AND channel."workspaceId"=$2 AND channel.type='APP' AND channel."connectedAccountId"=$3 AND account."workspaceId"=$2
      AND account."archivedAt" IS NULL AND account."applicationId" IS NULL AND account."connectionProviderId" IS NULL FOR SHARE OF channel,account`,
        [binding.messageChannelId, workspaceId, binding.connectedAccountId],
      ),
    );
    const predecessors = z.array(commandSchema).parse(
      await query(
        `SELECT ${columns} FROM core."omniOutgoingCommand" command
      WHERE command."workspaceId"=$1 AND command."conversationId"=$2 AND command."outboundSequence"<$3
      ORDER BY command."outboundSequence" DESC LIMIT 101`,
        [workspaceId, conversation.id, initial.outboundSequence],
      ),
    );
    if (predecessors.length > 100) return noClaim('predecessor_scan_limit');
    for (const predecessor of predecessors) {
      if (
        predecessor.workspaceId !== workspaceId ||
        predecessor.conversationId !== conversation.id ||
        BigInt(predecessor.outboundSequence) >=
          BigInt(initial.outboundSequence) ||
        auditPayloadHash(predecessor.payload) !== predecessor.payloadHash
      )
        return fail('PREDECESSOR_INTEGRITY');
      const accepted = acceptanceCandidate(predecessor);
      const terminal = terminalCandidate(predecessor);
      if (!accepted && !terminal) return noClaim('waiting_predecessor');
      if (!callbacks.verifyPredecessor)
        return fail('PREDECESSOR_VERIFIER_REQUIRED');
      const proof = await callbacks.verifyPredecessor(
        scope,
        freezeJson({
          ...descriptor,
          predecessor: commandSnapshot(predecessor),
        }),
      );
      assertActive();
      if (
        !(
          (proof === 'durably_accepted' && accepted) ||
          (proof === 'terminal_before_enqueue' && terminal)
        )
      )
        return fail('PREDECESSOR_PROOF_REJECTED');
    }
  }
  await callbacks.qualifyTransport(scope, descriptor);
  assertActive();
  // No parent locks are acquired after the command; callbacks never perform network effects.
  const before = one(commandSchema, await readCommand('FOR UPDATE'));
  const stableSnapshot = (command: Command) => {
    const { leaseLive: _live, due: _due, ...stable } = command;
    return stable;
  };
  if (
    canonicalAuditJson(stableSnapshot(before)) !==
    canonicalAuditJson(stableSnapshot(initial))
  )
    return fail('COMMAND_CHANGED');
  if (before.leaseLive) return noClaim('lease_live');
  if (!before.due) return noClaim('not_due');
  if (BigInt(before.statusRevision) >= 9223372036854775807n)
    return fail('REVISION_EXHAUSTED');
  const timing = one(
    z.object({ leaseUntil: timestamp }),
    await query(
      `SELECT to_char((clock_timestamp()+$1*interval '1 millisecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "leaseUntil"`,
      [request.input.leaseMilliseconds],
    ),
  );
  const leaseToken = randomUUID();
  const nextState = purpose === 'first_attempt' ? 'dispatching' : before.state;
  const after = {
    ...stableSnapshot(before),
    state: nextState,
    statusRevision: (BigInt(before.statusRevision) + 1n).toString(),
    leaseToken,
    leaseUntil: timing.leaseUntil,
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
    before: stableSnapshot(before),
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
    UPDATE core."omniOutgoingCommand" SET state=$4,"statusRevision"=$5,"leaseToken"=$6,"leaseUntil"=$7::timestamptz,"updatedAt"=clock_timestamp()
    WHERE "workspaceId"=$1 AND id=$2 AND "statusRevision"=$3 AND state=$8
      AND "leaseToken" IS NOT DISTINCT FROM $9::uuid AND "leaseUntil" IS NOT DISTINCT FROM $10::timestamptz
      AND ("leaseUntil" IS NULL OR "leaseUntil"<=clock_timestamp()) AND "nextAttemptAt"<=clock_timestamp()
      AND $7::timestamptz>clock_timestamp() RETURNING *) SELECT ${columns} FROM changed command`,
      [
        workspaceId,
        before.id,
        before.statusRevision,
        nextState,
        after.statusRevision,
        leaseToken,
        timing.leaseUntil,
        before.state,
        before.leaseToken,
        before.leaseUntil,
      ],
    ),
  );
  if (
    !updated.leaseLive ||
    canonicalAuditJson(stableSnapshot(updated)) !== canonicalAuditJson(after)
  )
    return fail('CLAIM_POSTCONDITION');
  assertActive();
  return Object.freeze({
    claimed: true,
    proof: Object.freeze({
      commandId: before.id,
      leaseToken,
      leaseUntil: timing.leaseUntil,
      capturedRestoreIncarnation: policy.restoreIncarnation,
      purpose,
    }),
  });
};
