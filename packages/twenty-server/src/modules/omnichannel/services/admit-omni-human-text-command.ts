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
  omniHumanTextCommandInputSchema,
  omniHumanTextCommandPrincipalSchema,
  type OmniHumanTextCommandInput,
  type OmniHumanTextCommandPrincipal,
  type OmniHumanTextCommandResult,
} from 'src/modules/omnichannel/contracts/omni-human-text-command';

export type OmniHumanTextCommandScope = {
  workspaceId: string;
  transactionLifecycle?: WorkspaceTransactionLifecycle;
  executeRawQuery: (
    sql: string,
    parameters?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};
export type OmniHumanTextCommandAuthorizer = (
  scope: OmniHumanTextCommandScope,
  descriptor: Readonly<
    OmniHumanTextCommandPrincipal & {
      action: 'command.admit';
      bindingId: string;
      conversationId: string;
      queueId: string;
      routeGeneration: string;
      policyId: string;
      policyVersion: '0';
      mode: 'human' | 'assist' | 'auto';
      status: 'open' | 'closed';
      command: OmniHumanTextCommandInput;
      replay: boolean;
    }
  >,
) => Promise<void>;

export const snapshotOmniHumanTextCommandRequest = (
  principal: OmniHumanTextCommandPrincipal,
  input: OmniHumanTextCommandInput,
  authorize: OmniHumanTextCommandAuthorizer,
) => {
  const capturedAuthorize = authorize;
  if (typeof capturedAuthorize !== 'function')
    throw new Error('OMNI_HUMAN_TEXT_COMMAND_AUTHORIZER_REQUIRED');
  return Object.freeze({
    principal: omniHumanTextCommandPrincipalSchema.parse(principal),
    input: omniHumanTextCommandInputSchema.parse(input),
    authorize: capturedAuthorize,
  });
};

export const omniHumanTextCommandOperationId = (
  principal: OmniHumanTextCommandPrincipal,
  input: OmniHumanTextCommandInput,
): string =>
  uuidV5(
    canonicalAuditJson([
      'omni:human.command:v1',
      principal.workspaceMemberId,
      input.idempotencyKey,
    ]),
    principal.workspaceId,
  );

const uuid = z.uuid();
const positive = z.string().regex(/^[1-9][0-9]*$/);
const counter = z.string().regex(/^(0|[1-9][0-9]*)$/);
const fail = (code: string): never => {
  throw new Error(`OMNI_HUMAN_TEXT_COMMAND_${code}`);
};
const authorizationErrors = new WeakSet<Error>();
export const isOmniHumanTextCommandAuthorizationError = (
  error: unknown,
): boolean => error instanceof Error && authorizationErrors.has(error);
export class OmniHumanTextCommandConflictError extends Error {
  constructor(
    readonly code: 'STALE_VIEW' | 'STALE_CONTROL',
    readonly projection: Readonly<{
      conversationId: string;
      replyRevision: string;
      controlEpoch: string;
      mode: 'human' | 'assist' | 'auto';
    }>,
  ) {
    super(`OMNI_HUMAN_TEXT_COMMAND_${code}`);
    this.name = 'OmniHumanTextCommandConflictError';
    Object.freeze(projection);
  }
}
const denyMembership = (): never => {
  const error = new Error('OMNI_HUMAN_TEXT_COMMAND_MEMBERSHIP_DENIED');
  authorizationErrors.add(error);
  throw error;
};
const one = <T extends z.ZodType>(schema: T, rows: unknown[]): z.infer<T> => {
  if (rows.length !== 1) return fail('ROW_INTEGRITY');
  return schema.parse(rows[0]);
};
const state = z.enum([
  'pending',
  'dispatching',
  'accepted',
  'outcome_unknown',
  'sent',
  'failed',
  'cancelled',
]);
const storedCommandSchema = z.object({
  id: uuid,
  conversationId: uuid,
  actorKind: z.literal('workspaceMember'),
  actorId: uuid,
  initiatingActorId: uuid,
  idempotencyKey: z.string(),
  payloadHash: z.string(),
  payload: z.unknown(),
  expectedAutomationEpoch: z.null(),
  policyId: uuid,
  policyVersion: z.literal('0'),
  generation: positive,
  createdRestoreIncarnation: uuid.nullable(),
  workflowCancellationRefs: z.array(z.unknown()).length(0),
  senderClass: z.literal('human'),
  contentProvenance: z.literal('human_direct'),
  producerTurnId: z.null(),
  capturedTurnFence: z.null(),
  referenceId: z.null(),
  replacesCommandId: z.null(),
  outboundSequence: positive,
  replyToMessageLinkId: z.null(),
  resolvedReplyNativeRef: z.null(),
  state,
  statusRevision: positive,
  nextAttemptAt: z.iso.datetime({ precision: 6 }),
});
const disabledSettings = {
  enabled: false,
  maxReplies: 0,
  maxCrmEffects: 0,
  maxHops: 0,
};

// This accepts an intent only. The strict transaction owner handles COMMIT ambiguity and failure audit.
export const admitOmniHumanTextCommand = async (
  inputScope: OmniHumanTextCommandScope,
  inputPrincipal: OmniHumanTextCommandPrincipal,
  inputCommand: OmniHumanTextCommandInput,
  inputAuthorize: OmniHumanTextCommandAuthorizer,
): Promise<OmniHumanTextCommandResult> => {
  const { principal, input, authorize } = snapshotOmniHumanTextCommandRequest(
    inputPrincipal,
    inputCommand,
    inputAuthorize,
  );
  const { workspaceId } = principal;
  if (inputScope.workspaceId !== workspaceId) return fail('WORKSPACE_MISMATCH');
  const execute = inputScope.executeRawQuery;
  const scope = Object.freeze({
    workspaceId,
    transactionLifecycle: inputScope.transactionLifecycle,
    executeRawQuery: (sql: string, parameters?: unknown[]) =>
      execute.call(inputScope, sql, parameters),
  });
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = executor.query;
  const assertActive = () => {
    if (!executor.isTransactionActive || executor.isReleased)
      return fail('TRANSACTION_INACTIVE');
  };
  // Same validated UUID/base36 mapping as Twenty; its utility barrel reaches Enterprise code.
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const workspacePolicy = one(
    z.object({ id: uuid, restoreIncarnation: uuid }),
    await query(
      'SELECT id,"restoreIncarnation" FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR SHARE',
      [workspaceId],
    ),
  );
  const discovered = one(
    z.object({ bindingId: uuid }),
    await query(
      'SELECT "bindingId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=$2',
      [workspaceId, input.conversationId],
    ),
  );
  const binding = one(
    z.object({
      id: uuid,
      status: z.string(),
      routeGeneration: positive,
      connectedAccountId: uuid,
      messageChannelId: uuid,
    }),
    await query(
      'SELECT id,status,"routeGeneration","connectedAccountId","messageChannelId" FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, discovered.bindingId],
    ),
  );
  const policy = one(
    z.object({ id: uuid, currentVersion: z.literal('0') }),
    await query(
      'SELECT id,"currentVersion" FROM core."omniAutomationPolicy" WHERE "workspaceId"=$1 AND "bindingId"=$2 FOR SHARE',
      [workspaceId, binding.id],
    ),
  );
  const version = one(
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
  const conversation = one(
    z.object({
      id: uuid,
      bindingId: uuid,
      providerChatId: z.string().min(1),
      queueId: uuid,
      policyId: uuid,
      policyVersion: z.literal('0'),
      mode: z.enum(['human', 'assist', 'auto']),
      status: z.enum(['open', 'closed']),
      controlEpoch: positive,
      replyRevision: positive,
      nextOutboundSequence: positive,
      conversationSequence: counter,
    }),
    await query(
      'SELECT id,"bindingId","providerChatId","queueId","policyId","policyVersion",mode,status,"controlEpoch","replyRevision","nextOutboundSequence","conversationSequence" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
      [workspaceId, input.conversationId],
    ),
  );
  if (
    conversation.bindingId !== binding.id ||
    conversation.policyId !== policy.id
  )
    return fail('PARENT_CHANGED');
  const memberships = await query(
    `SELECT member.id FROM "${schema}"."workspaceMember" member JOIN core."userWorkspace" membership ON membership."userId"=member."userId" AND membership."workspaceId"=$1
    JOIN core."user" active_user ON active_user.id=member."userId"
    WHERE member.id=$2 AND member."userId"=$3 AND member."deletedAt" IS NULL AND membership."deletedAt" IS NULL AND active_user."deletedAt" IS NULL FOR SHARE OF member,membership,active_user`,
    [workspaceId, principal.workspaceMemberId, principal.userId],
  );
  if (memberships.length !== 1) return denyMembership();
  one(z.object({ id: uuid }), memberships);
  const findCommand = () =>
    query(
      'SELECT *,to_char("nextAttemptAt" AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS "nextAttemptAt" FROM core."omniOutgoingCommand" WHERE "workspaceId"=$1 AND "actorKind"=\'workspaceMember\' AND "actorId"=$2 AND "idempotencyKey"=$3',
      [workspaceId, principal.workspaceMemberId, input.idempotencyKey],
    );
  const existing = await findCommand();
  await authorize(
    scope,
    Object.freeze({
      ...principal,
      action: 'command.admit',
      bindingId: binding.id,
      conversationId: conversation.id,
      queueId: conversation.queueId,
      routeGeneration: binding.routeGeneration,
      policyId: policy.id,
      policyVersion: '0',
      mode: conversation.mode,
      status: conversation.status,
      command: input,
      replay: existing.length > 0,
    }),
  );
  assertActive();
  const operationId = omniHumanTextCommandOperationId(principal, input);
  const commandId = uuidV5('omni:human.command.row:v1', operationId);
  const eventId = uuidV5('omni:human.command.created:v1', operationId);
  const rootId = uuidV5(`domain_event:${eventId}`, workspaceId);
  const rootRowId = uuidV5('omni:human.command.root:v1', operationId);
  const dispatchId = uuidV5('omni:human.command.dispatch:v1', operationId);
  const payload = {
    version: 1,
    workspaceId,
    conversationId: conversation.id,
    bindingId: binding.id,
    providerChatId: conversation.providerChatId,
    text: input.text,
    readyFileIds: [],
    replyToMessageLinkId: null,
    resolvedReplyNativeRef: null,
  };
  const payloadHash = auditPayloadHash(payload);
  const root = {
    rootKind: 'domain_event',
    rootId,
    sourceKey: eventId,
    initialEventIds: [eventId],
    origin: 'human_composer',
    scope: {
      workspaceId,
      bindingId: binding.id,
      conversationId: conversation.id,
    },
    coveredRoots: [],
    policyId: policy.id,
    policyVersion: '0',
    maxCrmEffects: '0',
    maxHops: '0',
    usedCrmEffects: '0',
    usedHops: '0',
    state: 'suppressed',
  };
  const eventFor = (sequence: string, outboundSequence: string) => ({
    conversationId: conversation.id,
    conversationSequence: sequence,
    kind: 'command.created',
    origin: 'human_composer',
    rootExecutionId: rootRowId,
    payloadVersion: 1,
    payload: {
      commandId,
      outboundSequence,
      senderClass: 'human',
      dispatchSuppressed: true,
    },
  });
  const dispatchFor = (event: ReturnType<typeof eventFor>) => ({
    eventId,
    rootKind: 'domain_event',
    rootId,
    policyId: policy.id,
    policyVersion: '0',
    activationVersion: null,
    targets: [],
    payloadHash: auditPayloadHash(event),
    initialPlan: true,
    state: 'suppressed',
  });
  const replay = async (
    rows: unknown[],
    current = conversation,
  ): Promise<OmniHumanTextCommandResult> => {
    const saved = one(storedCommandSchema, rows);
    if (
      saved.conversationId !== conversation.id ||
      saved.payloadHash !== payloadHash
    )
      return fail('IDEMPOTENCY_CONFLICT');
    if (
      saved.id !== commandId ||
      saved.actorId !== principal.workspaceMemberId ||
      saved.initiatingActorId !== principal.workspaceMemberId ||
      saved.policyId !== policy.id ||
      saved.idempotencyKey !== input.idempotencyKey ||
      auditPayloadHash(saved.payload) !== saved.payloadHash ||
      canonicalAuditJson(saved.payload) !== canonicalAuditJson(payload) ||
      BigInt(saved.outboundSequence) >= BigInt(current.nextOutboundSequence)
    )
      return fail('REPLAY_INTEGRITY');
    const event = one(
      z.object({
        conversationId: uuid,
        conversationSequence: positive,
        kind: z.string(),
        origin: z.string(),
        rootExecutionId: uuid,
        payloadVersion: z.number(),
        payload: z.unknown(),
      }),
      await query(
        'SELECT "conversationId","conversationSequence",kind,origin,"rootExecutionId","payloadVersion",payload FROM core."omniDomainEvent" WHERE "workspaceId"=$1 AND id=$2 AND "causationId" IS NULL',
        [workspaceId, eventId],
      ),
    );
    if (
      BigInt(event.conversationSequence) >
        BigInt(current.conversationSequence) ||
      canonicalAuditJson(event) !==
        canonicalAuditJson(
          eventFor(event.conversationSequence, saved.outboundSequence),
        )
    )
      return fail('REPLAY_EVENT_INTEGRITY');
    const rootRows = await query(
      'SELECT "rootKind","rootId","sourceKey","initialEventIds",origin,scope,"coveredRoots","policyId","policyVersion","maxCrmEffects","maxHops","usedCrmEffects","usedHops",state FROM core."omniRootExecution" WHERE "workspaceId"=$1 AND id=$2 AND "causationId" IS NULL',
      [workspaceId, rootRowId],
    );
    if (
      rootRows.length !== 1 ||
      canonicalAuditJson(rootRows[0]) !== canonicalAuditJson(root)
    )
      return fail('REPLAY_ROOT_INTEGRITY');
    const plans = await query(
      'SELECT "eventId","rootKind","rootId","policyId","policyVersion","activationVersion",targets,"payloadHash","initialPlan",state FROM core."omniEventDispatchPlan" WHERE "workspaceId"=$1 AND id=$2',
      [workspaceId, dispatchId],
    );
    if (
      plans.length !== 1 ||
      canonicalAuditJson(plans[0]) !==
        canonicalAuditJson(
          dispatchFor(
            eventFor(event.conversationSequence, saved.outboundSequence),
          ),
        )
    )
      return fail('REPLAY_DISPATCH_INTEGRITY');
    assertActive();
    return Object.freeze({
      commandId: saved.id,
      state: saved.state,
      replyRevision: current.replyRevision,
      controlEpoch: current.controlEpoch,
      mode: current.mode,
      created: false,
    });
  };
  if (existing.length > 0) return replay(existing);
  if (binding.status !== 'active') return fail('BINDING_INACTIVE');
  if (conversation.status !== 'open') return fail('CONVERSATION_CLOSED');
  if (conversation.mode === 'auto') return fail('TAKEOVER_REQUIRED');
  const projection = Object.freeze({
    conversationId: conversation.id,
    replyRevision: conversation.replyRevision,
    controlEpoch: conversation.controlEpoch,
    mode: conversation.mode,
  });
  if (conversation.controlEpoch !== input.expectedControlEpoch)
    throw new OmniHumanTextCommandConflictError('STALE_CONTROL', projection);
  if (conversation.replyRevision !== input.observedReplyRevision)
    throw new OmniHumanTextCommandConflictError('STALE_VIEW', projection);
  one(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniQueue" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND active=true FOR SHARE',
      [workspaceId, binding.id, conversation.queueId],
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
  const inserted = await query(
    `INSERT INTO core."omniOutgoingCommand" (id,"workspaceId","conversationId","actorKind","actorId","initiatingActorId","idempotencyKey","payloadHash",payload,"policyId","policyVersion",generation,"senderClass","contentProvenance","outboundSequence","createdRestoreIncarnation")
    VALUES ($1,$2,$3,'workspaceMember',$4,$4,$5,$6,$7::jsonb,$8,0,$9,'human','human_direct',$10,$11)
    ON CONFLICT ("workspaceId","actorKind","actorId","idempotencyKey") DO NOTHING RETURNING id`,
    [
      commandId,
      workspaceId,
      conversation.id,
      principal.workspaceMemberId,
      input.idempotencyKey,
      payloadHash,
      canonicalAuditJson(payload),
      policy.id,
      binding.routeGeneration,
      conversation.nextOutboundSequence,
      workspacePolicy.restoreIncarnation,
    ],
  );
  if (inserted.length === 0) return replay(await findCommand());
  one(z.object({ id: z.literal(commandId) }), inserted);
  const advanced = one(
    z.object({
      conversationSequence: positive,
      replyRevision: positive,
      nextOutboundSequence: positive,
    }),
    await query(
      'WITH updated AS (UPDATE core."omniConversation" SET "conversationSequence"="conversationSequence"+1,"replyRevision"="replyRevision"+1,"nextOutboundSequence"="nextOutboundSequence"+1,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND id=$2 RETURNING "conversationSequence","replyRevision","nextOutboundSequence") SELECT * FROM updated',
      [workspaceId, conversation.id],
    ),
  );
  if (
    advanced.conversationSequence !==
      (BigInt(conversation.conversationSequence) + 1n).toString() ||
    advanced.replyRevision !==
      (BigInt(conversation.replyRevision) + 1n).toString() ||
    advanced.nextOutboundSequence !==
      (BigInt(conversation.nextOutboundSequence) + 1n).toString()
  )
    return fail('COUNTER_POSTCONDITION');
  const event = eventFor(
    advanced.conversationSequence,
    conversation.nextOutboundSequence,
  );
  const dispatch = dispatchFor(event);
  await query(
    `INSERT INTO core."omniRootExecution" (id,"workspaceId","rootKind","rootId","sourceKey","initialEventIds",origin,scope,"coveredRoots","policyId","policyVersion","maxCrmEffects","maxHops",state)
    VALUES ($1,$2,'domain_event',$3,$4,$5::uuid[],'human_composer',$6::jsonb,'[]'::jsonb,$7,0,0,0,'suppressed')`,
    [
      rootRowId,
      workspaceId,
      rootId,
      eventId,
      [eventId],
      canonicalAuditJson(root.scope),
      policy.id,
    ],
  );
  await query(
    `INSERT INTO core."omniDomainEvent" (id,"workspaceId","conversationId","conversationSequence",kind,origin,"rootExecutionId","payloadVersion",payload)
    VALUES ($1,$2,$3,$4,'command.created','human_composer',$5,1,$6::jsonb)`,
    [
      eventId,
      workspaceId,
      conversation.id,
      advanced.conversationSequence,
      rootRowId,
      canonicalAuditJson(event.payload),
    ],
  );
  await query(
    `INSERT INTO core."omniEventDispatchPlan" (id,"workspaceId","eventId","rootKind","rootId","policyId","policyVersion","activationVersion",targets,"payloadHash","initialPlan",state)
    VALUES ($1,$2,$3,'domain_event',$4,$5,0,NULL,'[]'::jsonb,$6,true,'suppressed')`,
    [dispatchId, workspaceId, eventId, rootId, policy.id, dispatch.payloadHash],
  );
  const saved = one(storedCommandSchema, await findCommand());
  if (
    saved.id !== commandId ||
    saved.createdRestoreIncarnation !== workspacePolicy.restoreIncarnation ||
    saved.state !== 'pending' ||
    saved.statusRevision !== '1' ||
    saved.generation !== binding.routeGeneration ||
    saved.outboundSequence !== conversation.nextOutboundSequence ||
    canonicalAuditJson(saved.payload) !== canonicalAuditJson(payload) ||
    saved.payloadHash !== payloadHash
  )
    return fail('COMMAND_POSTCONDITION');
  await replay([saved], { ...conversation, ...advanced });
  const audit = new CrmAuditTransactionContext(executor, {
    workspaceId,
    operationId,
    actor: { kind: 'workspaceMember', id: principal.workspaceMemberId },
  });
  const record = (
    resourceKind: CrmAuditResourceKind,
    resourceId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ) =>
    audit.record({
      resourceKind,
      resourceId,
      action: before === null ? 'create' : 'update',
      before,
      after,
      securityDescriptor: {
        resourceKind,
        resourceId,
        bindingId: binding.id,
        conversationId: conversation.id,
      },
    });
  record('omniOutgoingCommand', commandId, null, saved);
  record(
    'omniConversation',
    conversation.id,
    {
      bindingId: binding.id,
      conversationSequence: conversation.conversationSequence,
      replyRevision: conversation.replyRevision,
      nextOutboundSequence: conversation.nextOutboundSequence,
    },
    { bindingId: binding.id, ...advanced },
  );
  record('omniRootExecution', rootRowId, null, root);
  record('omniDomainEvent', eventId, null, event);
  record('omniEventDispatchPlan', dispatchId, null, dispatch);
  await audit.flush();
  const committedCommand = one(storedCommandSchema, await findCommand());
  const currentPolicy = one(
    z.object({ restoreIncarnation: uuid }),
    await query(
      'SELECT "restoreIncarnation" FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1',
      [workspaceId],
    ),
  );
  if (
    canonicalAuditJson(committedCommand) !== canonicalAuditJson(saved) ||
    currentPolicy.restoreIncarnation !== workspacePolicy.restoreIncarnation
  )
    return fail('COMMAND_POSTCONDITION');
  assertActive();
  return Object.freeze({
    commandId,
    state: 'pending',
    replyRevision: advanced.replyRevision,
    controlEpoch: conversation.controlEpoch,
    mode: conversation.mode,
    created: true,
  });
};
