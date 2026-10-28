import { verifyOmniConversationTargetHistory } from 'src/modules/omnichannel/services/verify-omni-conversation-target-history';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  CrmAuditTransactionContext,
  appendCrmAuditAttempt,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { omniBindingConfigurationPrincipalSchema } from 'src/modules/omnichannel/contracts/omni-binding-configuration';
import { type OmniHistoryApplyScope } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { loadOmniIdentityBindingHistory } from 'src/modules/omnichannel/services/load-omni-identity-binding-history';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const counter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$(?![\s\S])/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const positive = counter.refine((value) => value !== '0');
const commandSchema = z
  .strictObject({
    bindingId: uuid,
    conversationId: uuid,
    objectMetadataId: uuid,
    recordId: uuid,
    expectedTargetRevision: counter,
    active: z.boolean(),
  })
  .readonly();
const metadataSchema = z
  .strictObject({
    id: uuid,
    workspaceId: uuid,
    isActive: z.literal(true),
    isSystem: z.literal(false),
    tableName: z.string().min(1).max(63),
    projectionField: z
      .enum(['targetPersonId', 'targetCompanyId', 'targetOpportunityId'])
      .nullable(),
  })
  .readonly();
const edgeSchema = z.object({
  id: uuid,
  conversationId: uuid,
  objectMetadataId: uuid,
  recordId: uuid,
  active: z.boolean(),
  revision: positive,
  projectionId: uuid.nullable(),
});
const conversationSchema = z.object({
  id: uuid,
  messageThreadId: uuid,
  queueId: uuid.nullable(),
});
const projectionSchema = z.object({
  id: uuid,
  messageThreadId: uuid,
  targetPersonId: uuid.nullable(),
  targetCompanyId: uuid.nullable(),
  targetOpportunityId: uuid.nullable(),
  isManuallyAssigned: z.literal(true),
  isAutomaticallyAssigned: z.literal(false),
  deletedAt: z.null(),
});
const fail = (code: string): never => {
  throw new Error(`OMNI_CONVERSATION_TARGET_${code}`);
};
const one = <T extends z.ZodType>(schema: T, rows: unknown[]) => {
  if (rows.length !== 1) return fail('RESOURCE_SCOPE');
  return schema.parse(rows[0]);
};
const next = (value: string) => {
  if (BigInt(value) >= 9223372036854775807n) return fail('COUNTER_EXHAUSTED');
  return (BigInt(value) + 1n).toString();
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export type OmniConversationTargetPrincipal = z.infer<
  typeof omniBindingConfigurationPrincipalSchema
>;
export type OmniConversationTargetCommand = z.infer<typeof commandSchema>;
export type OmniConversationTargetMetadata = z.infer<typeof metadataSchema>;
export type OmniConversationTargetAuthorizer = (
  scope: OmniHistoryApplyScope,
  facts: Readonly<
    OmniConversationTargetPrincipal & {
      action: 'conversation.setTarget';
      command: OmniConversationTargetCommand;
      conversation: Readonly<z.infer<typeof conversationSchema>>;
      currentTarget: Readonly<z.infer<typeof edgeSchema>> | null;
      replay: boolean;
    }
  >,
) => Promise<void>;
export const snapshotOmniConversationTargetRequest = (
  principal: OmniConversationTargetPrincipal,
  command: OmniConversationTargetCommand,
  authorize: OmniConversationTargetAuthorizer,
) => {
  if (typeof authorize !== 'function') return fail('AUTHORIZER_REQUIRED');
  return Object.freeze({
    principal: omniBindingConfigurationPrincipalSchema.parse(principal),
    command: commandSchema.parse(command),
    authorize,
  });
};
const edgeFields =
  'id,"conversationId","objectMetadataId","recordId",active,revision,"projectionId"';
const projectionFields =
  'id,"messageThreadId","targetPersonId","targetCompanyId","targetOpportunityId","isManuallyAssigned","isAutomaticallyAssigned","deletedAt"';
export const setOmniConversationTarget = async (
  scope: OmniHistoryApplyScope,
  request: ReturnType<typeof snapshotOmniConversationTargetRequest>,
  rawMetadata: OmniConversationTargetMetadata,
  operationId: string,
  candidateTargetId: string,
  port: {
    insertProjection: (
      projection: Omit<z.infer<typeof projectionSchema>, 'deletedAt'>,
    ) => Promise<void>;
    deleteProjection: (id: string) => Promise<void>;
  },
) => {
  const { principal, command, authorize } = request;
  const { workspaceId } = principal;
  if (scope.workspaceId !== workspaceId) return fail('WORKSPACE_MISMATCH');
  const metadata = metadataSchema.parse(rawMetadata);
  if (
    metadata.workspaceId !== workspaceId ||
    metadata.id !== command.objectMetadataId
  )
    return fail('METADATA_SCOPE');
  operationId = uuid.parse(operationId);
  candidateTargetId = uuid.parse(candidateTargetId);
  const schema = quote(
    `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`,
  );
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = executor.query;
  const state = one(
    z.object({ id: uuid, epoch: positive }),
    await query(
      'SELECT id,epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE',
      [workspaceId],
    ),
  );
  one(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, command.bindingId],
    ),
  );
  const conversation = one(
    conversationSchema,
    await query(
      'SELECT id,"messageThreadId","queueId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE',
      [workspaceId, command.bindingId, command.conversationId],
    ),
  );
  const edges = z
    .array(edgeSchema)
    .parse(
      await query(
        `SELECT ${edgeFields} FROM core."omniConversationTarget" WHERE "workspaceId"=$1 AND "conversationId"=$2 AND "objectMetadataId"=$3 AND "recordId"=$4 FOR UPDATE`,
        [workspaceId, conversation.id, metadata.id, command.recordId],
      ),
    );
  if (edges.length > 1) return fail('AMBIGUOUS_EDGE');
  const edge = edges[0] ?? null;
  const replay = Boolean(
    edge &&
      BigInt(edge.revision) === BigInt(command.expectedTargetRevision) + 1n &&
      edge.active === command.active,
  );
  await authorize(
    scope,
    Object.freeze({
      ...principal,
      action: 'conversation.setTarget',
      command,
      conversation: Object.freeze(conversation),
      currentTarget: edge && Object.freeze(edge),
      replay,
    }),
  );
  if (!replay && (edge?.revision ?? '0') !== command.expectedTargetRevision)
    return fail('REVISION_CONFLICT');
  one(
    z.object({ id: uuid, deletedAt: z.null() }),
    await query(
      `SELECT id,"deletedAt" FROM ${schema}."messageThread" WHERE id=$1 FOR UPDATE`,
      [conversation.messageThreadId],
    ),
  );
  const targetRecord = one(
    z.object({ id: uuid, deletedAt: z.unknown() }),
    await query(
      `SELECT id,"deletedAt" FROM ${schema}.${quote(metadata.tableName)} WHERE id=$1 FOR SHARE`,
      [command.recordId],
    ),
  );
  if (command.active && targetRecord.deletedAt !== null)
    return fail('RECORD_NOT_LIVE');
  if (command.active && metadata.projectionField === 'targetPersonId') {
    const identities = z
      .array(
        z.object({
          id: uuid,
          bindingId: uuid,
          personId: uuid,
          revision: positive,
          providerPeerId: z.string(),
          verificationSource: z.string(),
        }),
      )
      .parse(
        await query(
          `SELECT i.id,i."bindingId",i."personId",i.revision,i."providerPeerId",i."verificationSource" FROM core."omniExternalIdentity" i WHERE i."workspaceId"=$1 AND i."bindingId"=$2 AND i."personId"=$3 AND EXISTS(SELECT 1 FROM core."omniMessageLink" l WHERE l."workspaceId"=i."workspaceId" AND l."bindingId"=i."bindingId" AND l."conversationId"=$4 AND l."immutableAuthorSnapshot"->>'externalIdentityId'=i.id::text) ORDER BY i.id FOR SHARE`,
          [workspaceId, command.bindingId, command.recordId, conversation.id],
        ),
      );
    if (!identities.length) return fail('PERSON_IDENTITY_REQUIRED');
    for (const identity of identities) {
      if (!identity.verificationSource) return fail('PERSON_IDENTITY_REQUIRED');
      const history = await loadOmniIdentityBindingHistory(
        scope,
        workspaceId,
        identity,
      );
      const authors = z
        .array(
          z.object({
            authorVerification: z.string(),
            immutableAuthorSnapshot: z.object({
              identityRevision: positive,
              personId: uuid.nullable(),
              providerPeerId: z.string(),
            }),
          }),
        )
        .parse(
          await query(
            `SELECT "authorVerification","immutableAuthorSnapshot" FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "conversationId"=$3 AND "immutableAuthorSnapshot"->>'externalIdentityId'=$4`,
            [workspaceId, command.bindingId, conversation.id, identity.id],
          ),
        );
      for (const author of authors) {
        if (
          author.authorVerification !== identity.verificationSource ||
          author.immutableAuthorSnapshot.providerPeerId !==
            identity.providerPeerId
        )
          return fail('PERSON_IDENTITY_INTEGRITY');
        history.assertBirth(author.immutableAuthorSnapshot);
      }
    }
  }
  const expectedProjection = (id: string) => ({
    id,
    messageThreadId: conversation.messageThreadId,
    targetPersonId: null as string | null,
    targetCompanyId: null as string | null,
    targetOpportunityId: null as string | null,
    isManuallyAssigned: true as const,
    isAutomaticallyAssigned: false as const,
    deletedAt: null,
    ...(metadata.projectionField
      ? { [metadata.projectionField]: command.recordId }
      : {}),
  });
  const readProjection = async (id: string) =>
    one(
      projectionSchema,
      await query(
        `SELECT ${projectionFields} FROM ${schema}."messageThreadTarget" WHERE id=$1 FOR UPDATE`,
        [id],
      ),
    );
  const checkProjection = async (current: z.infer<typeof edgeSchema>) => {
    const needs = current.active && metadata.projectionField !== null;
    if (Boolean(current.projectionId) !== needs)
      return fail('PROJECTION_STATE');
    if (
      !current.projectionId &&
      metadata.projectionField &&
      (
        await query(
          `SELECT id FROM ${schema}."messageThreadTarget" WHERE "messageThreadId"=$1 AND ${quote(metadata.projectionField)}=$2 AND "deletedAt" IS NULL FOR UPDATE`,
          [conversation.messageThreadId, command.recordId],
        )
      ).length
    )
      return fail('PROJECTION_UNEXPECTED');
    if (
      current.projectionId &&
      auditPayloadHash(await readProjection(current.projectionId)) !==
        auditPayloadHash(expectedProjection(current.projectionId))
    )
      return fail('PROJECTION_INTEGRITY');
  };
  if (edge) await checkProjection(edge);
  const proof = async (
    current: z.infer<typeof edgeSchema>,
    policyEpoch = state.epoch,
  ) =>
    verifyOmniConversationTargetHistory(scope, {
      workspaceId,
      bindingId: command.bindingId,
      messageThreadId: conversation.messageThreadId,
      policyState: { id: state.id, epoch: policyEpoch },
      edge: current,
      projectionField: metadata.projectionField,
    });
  const priorProof = edge ? await proof(edge) : null;
  if (replay && edge && priorProof)
    return { ...edge, ...priorProof, replayed: true };
  const revision = next(edge?.revision ?? '0'),
    epoch = next(state.epoch),
    targetId = edge?.id ?? candidateTargetId;
  let projectionId = edge?.projectionId ?? null;
  const audit = new CrmAuditTransactionContext(executor, {
    ...principal,
    operationId,
  });
  if (command.active && metadata.projectionField && !projectionId) {
    projectionId = randomUUID();
    const projected = expectedProjection(projectionId);
    const { deletedAt: _, ...insert } = projected;
    await port.insertProjection(insert);
    audit.record({
      resourceKind: 'omniMessageThreadTarget',
      resourceId: projectionId,
      action: 'create',
      before: null,
      after: projected,
      securityDescriptor: {
        resourceKind: 'omniMessageThreadTarget',
        resourceId: projectionId,
        bindingId: command.bindingId,
        conversationId: conversation.id,
      },
    });
  } else if (!command.active && projectionId) {
    const projected = await readProjection(projectionId);
    await port.deleteProjection(projectionId);
    if (
      (
        await query(
          `SELECT id FROM ${schema}."messageThreadTarget" WHERE id=$1`,
          [projectionId],
        )
      ).length
    )
      return fail('PROJECTION_DELETE');
    audit.record({
      resourceKind: 'omniMessageThreadTarget',
      resourceId: projectionId,
      action: 'delete',
      before: projected,
      after: null,
      securityDescriptor: {
        resourceKind: 'omniMessageThreadTarget',
        resourceId: projectionId,
        bindingId: command.bindingId,
        conversationId: conversation.id,
      },
    });
    projectionId = null;
  }
  const updated = one(
    edgeSchema,
    edge
      ? await query(
          `WITH updated AS (UPDATE core."omniConversationTarget" SET active=$1,revision=revision+1,"projectionId"=$2,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$3 AND id=$4 AND revision=$5 RETURNING ${edgeFields}) SELECT * FROM updated`,
          [command.active, projectionId, workspaceId, edge.id, edge.revision],
        )
      : await query(
          `INSERT INTO core."omniConversationTarget" (id,"workspaceId","conversationId","objectMetadataId","recordId",active,revision,"projectionId") VALUES ($1,$2,$3,$4,$5,$6,1,$7) RETURNING ${edgeFields}`,
          [
            targetId,
            workspaceId,
            conversation.id,
            metadata.id,
            command.recordId,
            command.active,
            projectionId,
          ],
        ),
  );
  const expected = {
    id: targetId,
    conversationId: conversation.id,
    objectMetadataId: metadata.id,
    recordId: command.recordId,
    active: command.active,
    revision,
    projectionId,
  };
  if (auditPayloadHash(updated) !== auditPayloadHash(expected))
    return fail('EDGE_WRITE');
  const updatedState = one(
    z.object({ epoch: positive }),
    await query(
      'WITH updated AS (UPDATE core."omniWorkspacePolicyState" SET epoch=epoch+1,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND epoch=$2 RETURNING epoch) SELECT epoch FROM updated',
      [workspaceId, state.epoch],
    ),
  );
  if (updatedState.epoch !== epoch) return fail('EPOCH_WRITE');
  audit.record({
    resourceKind: 'omniConversationTarget',
    resourceId: targetId,
    action: edge ? 'update' : 'create',
    before: edge,
    after: updated,
    securityDescriptor: {
      resourceKind: 'omniConversationTarget',
      resourceId: targetId,
      bindingId: command.bindingId,
      conversationId: conversation.id,
    },
  });
  audit.record({
    resourceKind: 'omniWorkspacePolicyState',
    resourceId: state.id,
    action: 'update',
    before: { epoch: state.epoch },
    after: { epoch },
    securityDescriptor: {
      resourceKind: 'omniWorkspacePolicyState',
      resourceId: state.id,
    },
  });
  await audit.flush();
  const final = one(
    edgeSchema,
    await query(
      `SELECT ${edgeFields} FROM core."omniConversationTarget" WHERE "workspaceId"=$1 AND id=$2`,
      [workspaceId, targetId],
    ),
  );
  if (auditPayloadHash(final) !== auditPayloadHash(expected))
    return fail('FINAL_EDGE');
  await checkProjection(final);
  const retained = await proof(final, epoch);
  const finalState = one(
    z.object({ epoch: positive }),
    await query(
      'SELECT epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1',
      [workspaceId],
    ),
  );
  if (
    retained.operationId !== operationId ||
    retained.policyEpoch !== epoch ||
    finalState.epoch !== epoch
  )
    return fail('FINAL_AUDIT');
  return { ...final, operationId, policyEpoch: epoch, replayed: false };
};
export const appendOmniConversationTargetFailure = async (
  scope: OmniHistoryApplyScope,
  request: ReturnType<typeof snapshotOmniConversationTargetRequest>,
  operationId: string,
  candidateTargetId: string,
  denied: boolean,
) => {
  const { principal, command } = request;
  if (scope.workspaceId !== principal.workspaceId)
    return fail('WORKSPACE_MISMATCH');
  const conversations = await scope.executeRawQuery(
    'SELECT id FROM core."omniConversation" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3',
    [principal.workspaceId, command.bindingId, command.conversationId],
  );
  if (conversations.length !== 1) return;
  const edges = z
    .array(z.object({ id: uuid }))
    .parse(
      await scope.executeRawQuery(
        'SELECT id FROM core."omniConversationTarget" WHERE "workspaceId"=$1 AND "conversationId"=$2 AND "objectMetadataId"=$3 AND "recordId"=$4',
        [
          principal.workspaceId,
          command.conversationId,
          command.objectMetadataId,
          command.recordId,
        ],
      ),
    );
  if (edges.length > 1) return fail('AMBIGUOUS_EDGE');
  const resourceId = edges[0]?.id ?? uuid.parse(candidateTargetId);
  await appendCrmAuditAttempt(
    createCrmAuditWorkspaceExecutor(scope),
    { ...principal, operationId },
    {
      resourceKind: 'omniConversationTarget',
      resourceId,
      attemptId: randomUUID(),
      action: edges.length ? 'update' : 'create',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: denied
        ? 'conversation.target.denied'
        : 'conversation.target.failed',
      securityDescriptor: {
        resourceKind: 'omniConversationTarget',
        resourceId,
        bindingId: command.bindingId,
        conversationId: command.conversationId,
      },
    },
  );
};
