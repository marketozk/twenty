import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  CrmAuditTransactionContext,
  appendCrmAuditAttempt,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type OmniHistoryApplyScope } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { omniBindingConfigurationPrincipalSchema } from 'src/modules/omnichannel/contracts/omni-binding-configuration';
import { loadOmniIdentityBindingHistory } from 'src/modules/omnichannel/services/load-omni-identity-binding-history';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const counter = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$(?![\s\S])/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim() === value &&
      !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value),
  );
const commandSchema = z
  .strictObject({
    bindingId: uuid,
    externalIdentityId: uuid,
    personId: uuid.nullable(),
    expectedRevision: counter,
    idempotencyKey: idempotencyKeySchema,
  })
  .readonly();
const personNameText = z
  .string()
  .max(256)
  .refine(
    (value) =>
      value.trim() === value &&
      !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value),
  );
const createPersonFieldsSchema = z
  .strictObject({
    name: z
      .strictObject({ firstName: personNameText, lastName: personNameText })
      .refine((name) => Boolean(name.firstName || name.lastName))
      .readonly(),
  })
  .readonly();
const createCommandSchema = z
  .strictObject({
    bindingId: uuid,
    externalIdentityId: uuid,
    expectedRevision: counter,
    idempotencyKey: idempotencyKeySchema,
    person: createPersonFieldsSchema,
  })
  .readonly();
const identitySchema = z.object({
  id: uuid,
  bindingId: uuid,
  personId: uuid.nullable(),
  revision: counter,
  providerPeerId: z.string(),
  verificationSource: z.string(),
});
const descriptorSchema = z.strictObject({
  resourceKind: z.literal('omniExternalIdentity'),
  resourceId: uuid,
  bindingId: uuid,
});
const resultSchema = z.strictObject({
  externalIdentityId: uuid,
  personId: uuid.nullable(),
  revision: counter,
  policyEpoch: counter,
});
const receiptSchema = z.object({
  operationId: uuid,
  action: z.string(),
  payloadHash: z.string(),
  resourceDescriptor: z.unknown(),
  resultPublic: z.unknown(),
});
const conversationSchema = z.object({
  id: uuid,
  messageThreadId: uuid,
  queueId: uuid.nullable(),
});
const authorSchema = z.object({
  externalIdentityId: uuid,
  identityRevision: counter,
  providerPeerId: z.string(),
  personId: uuid.nullable(),
  sourceAuthorId: z.string().nullable(),
  sourceDisplayName: z.string().nullable(),
});
const linkSchema = z.object({
  id: uuid,
  messageId: uuid,
  conversationId: uuid,
  immutableAuthorSnapshot: authorSchema,
  authorVerification: z.string(),
});
const participantSchema = z.object({
  id: uuid,
  messageId: uuid,
  personId: uuid.nullable(),
  workspaceMemberId: z.null(),
  role: z.literal('FROM'),
  handle: z.string(),
  displayName: z.string(),
  deletedAt: z.null(),
});
const targetSchema = z.object({
  id: uuid,
  conversationId: uuid,
  objectMetadataId: uuid,
  recordId: uuid,
  active: z.boolean(),
  revision: counter,
  projectionId: uuid.nullable(),
});
const projectionSchema = z.object({
  id: uuid,
  messageThreadId: uuid,
  targetPersonId: uuid,
  targetCompanyId: z.null(),
  targetOpportunityId: z.null(),
  isManuallyAssigned: z.literal(true),
  isAutomaticallyAssigned: z.literal(false),
  deletedAt: z.null(),
});
export type OmniIdentityPersonPrincipal = z.infer<
  typeof omniBindingConfigurationPrincipalSchema
>;
export type OmniIdentityPersonCommand = z.infer<typeof commandSchema>;
export type OmniIdentityPersonAuthorizer = (
  scope: OmniHistoryApplyScope,
  facts: Readonly<
    OmniIdentityPersonPrincipal & {
      action: 'identity.setPerson';
      command: OmniIdentityPersonCommand;
      currentIdentity: Readonly<z.infer<typeof identitySchema>>;
      conversations: readonly Readonly<z.infer<typeof conversationSchema>>[];
      personObjectMetadataId: string;
      replay: boolean;
    }
  >,
) => Promise<void>;
export const snapshotOmniIdentityPersonRequest = (
  principal: OmniIdentityPersonPrincipal,
  command: OmniIdentityPersonCommand,
  authorize: OmniIdentityPersonAuthorizer,
) => {
  if (typeof authorize !== 'function')
    throw new Error('OMNI_IDENTITY_PERSON_AUTHORIZER_REQUIRED');
  return Object.freeze({
    mode: 'set' as const,
    principal: omniBindingConfigurationPrincipalSchema.parse(principal),
    command: commandSchema.parse(command),
    authorize,
  });
};
export type OmniIdentityCreatePersonFields = z.infer<
  typeof createPersonFieldsSchema
>;
export type OmniIdentityCreatePersonCommand = z.infer<
  typeof createCommandSchema
>;
export type OmniIdentityCreatePersonAuthorizer = (
  scope: OmniHistoryApplyScope,
  facts: Readonly<
    OmniIdentityPersonPrincipal & {
      action: 'identity.createPerson';
      command: OmniIdentityCreatePersonCommand;
      currentIdentity: Readonly<z.infer<typeof identitySchema>>;
      conversations: readonly Readonly<z.infer<typeof conversationSchema>>[];
      personObjectMetadataId: string;
      replay: boolean;
    }
  >,
) => Promise<void>;
export const snapshotOmniIdentityCreatePersonRequest = (
  principal: OmniIdentityPersonPrincipal,
  command: OmniIdentityCreatePersonCommand,
  authorize: OmniIdentityCreatePersonAuthorizer,
) => {
  if (typeof authorize !== 'function')
    throw new Error('OMNI_IDENTITY_PERSON_AUTHORIZER_REQUIRED');
  return Object.freeze({
    mode: 'create' as const,
    principal: omniBindingConfigurationPrincipalSchema.parse(principal),
    command: createCommandSchema.parse(command),
    authorize,
  });
};
export type OmniIdentityPersonRequest =
  | ReturnType<typeof snapshotOmniIdentityPersonRequest>
  | ReturnType<typeof snapshotOmniIdentityCreatePersonRequest>;
const fail = (code: string): never => {
  throw new Error(`OMNI_IDENTITY_PERSON_${code}`);
};
const one = <TSchema extends z.ZodType>(schema: TSchema, rows: unknown[]) => {
  if (rows.length !== 1) return fail('MISSING_OR_AMBIGUOUS_RESOURCE');
  return schema.parse(rows[0]);
};
const next = (value: string) => {
  if (BigInt(value) >= 9223372036854775807n) return fail('COUNTER_EXHAUSTED');
  return (BigInt(value) + 1n).toString();
};

export const setOmniIdentityPerson = async (
  originalScope: OmniHistoryApplyScope,
  request: OmniIdentityPersonRequest,
  personObjectMetadataId: string,
  attemptOperationId: string,
  nativePort: {
    updateParticipantPerson: (
      id: string,
      personId: string | null,
    ) => Promise<void>;
    deleteProjection: (id: string) => Promise<void>;
    createPerson?: (
      id: string,
      fields: OmniIdentityCreatePersonFields,
    ) => Promise<void>;
  },
) => {
  const { principal, command } = request;
  let personId: string | null =
    request.mode === 'set' ? request.command.personId : null;
  const { workspaceId } = principal;
  if (originalScope.workspaceId !== workspaceId)
    return fail('WORKSPACE_MISMATCH');
  const scope = originalScope;
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const query = executor.query;
  personObjectMetadataId = uuid.parse(personObjectMetadataId);
  let operationId = uuid.parse(attemptOperationId);
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const { idempotencyKey, ...payload } = command;
  const action =
    request.mode === 'create' ? 'identity.createPerson' : 'identity.setPerson';
  const payloadHash = auditPayloadHash({ workspaceId, action, ...payload });
  const state = one(
    z.object({ id: uuid, epoch: counter }),
    await query(
      'SELECT id,epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE',
      [workspaceId],
    ),
  );
  const receipts = z
    .array(receiptSchema)
    .parse(
      await query(
        `SELECT "operationId",action,"payloadHash","resourceDescriptor","resultPublic" FROM core."omniPolicyMutationReceipt" WHERE "workspaceId"=$1 AND "actorKind"=$2 AND "actorId"=$3 AND "idempotencyKey"=$4 FOR UPDATE`,
        [workspaceId, principal.actor.kind, principal.actor.id, idempotencyKey],
      ),
    );
  if (receipts.length > 1) return fail('AMBIGUOUS_RECEIPT');
  const receipt = receipts[0];
  one(
    z.object({ id: uuid }),
    await query(
      'SELECT id FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
      [workspaceId, command.bindingId],
    ),
  );
  const links = z
    .array(linkSchema)
    .parse(
      await query(
        `SELECT id,"messageId","conversationId","immutableAuthorSnapshot","authorVerification" FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "immutableAuthorSnapshot"->>'externalIdentityId'=$3 ORDER BY id`,
        [workspaceId, command.bindingId, command.externalIdentityId],
      ),
    );
  const conversationIds = [
    ...new Set(links.map((link) => link.conversationId)),
  ].sort();
  const conversations = z
    .array(conversationSchema)
    .parse(
      await query(
        `SELECT id,"messageThreadId","queueId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,
        [workspaceId, command.bindingId, conversationIds],
      ),
    );
  if (conversations.length !== conversationIds.length)
    return fail('CONVERSATION_SCOPE');
  const identity = one(
    identitySchema,
    await query(
      'SELECT id,"bindingId","personId",revision,"providerPeerId","verificationSource" FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE',
      [workspaceId, command.bindingId, command.externalIdentityId],
    ),
  );
  const facts = Object.freeze({
    ...principal,
    currentIdentity: Object.freeze(identity),
    conversations: Object.freeze(
      conversations.map((row) => Object.freeze(row)),
    ),
    personObjectMetadataId,
    replay: Boolean(receipt),
  });
  if (request.mode === 'create')
    await request.authorize(
      scope,
      Object.freeze({
        ...facts,
        action: 'identity.createPerson',
        command: request.command,
      }),
    );
  else
    await request.authorize(
      scope,
      Object.freeze({
        ...facts,
        action: 'identity.setPerson',
        command: request.command,
      }),
    );
  const history = await loadOmniIdentityBindingHistory(
    scope,
    workspaceId,
    identity,
  );
  const descriptor = {
    resourceKind: 'omniExternalIdentity' as const,
    resourceId: identity.id,
    bindingId: identity.bindingId,
  };
  const verifyCreationAudit = async (
    createdOperationId: string,
    createdPersonId: string,
  ) => {
    const entries = await query(
      `SELECT "securityDescriptor","redactedDiff" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 AND "resourceKind"='omniPerson' AND "resourceId"=$3 AND action='create' AND outcome='success'`,
      [workspaceId, createdOperationId, createdPersonId],
    );
    const proof = one(
      z.object({ securityDescriptor: z.unknown(), redactedDiff: z.unknown() }),
      entries,
    );
    if (
      auditPayloadHash(proof.securityDescriptor) !==
        auditPayloadHash({
          resourceKind: 'omniPerson',
          resourceId: createdPersonId,
          bindingId: identity.bindingId,
        }) ||
      auditPayloadHash(proof.redactedDiff) !==
        auditPayloadHash({ changedFields: ['name'], values: {} })
    )
      return fail('CREATED_PERSON_AUDIT');
  };
  if (receipt) {
    if (receipt.action !== action || receipt.payloadHash !== payloadHash)
      return fail('IDEMPOTENCY_CONFLICT');
    if (
      auditPayloadHash(descriptorSchema.parse(receipt.resourceDescriptor)) !==
      auditPayloadHash(descriptor)
    )
      return fail('RECEIPT_SCOPE');
    if (receipt.resultPublic === null) return fail('RESULT_EXPIRED');
    const result = resultSchema.parse(receipt.resultPublic);
    if (
      result.externalIdentityId !== identity.id ||
      (request.mode === 'set'
        ? result.personId !== personId
        : result.personId === null) ||
      BigInt(result.policyEpoch) > BigInt(state.epoch)
    )
      return fail('RECEIPT_INTEGRITY');
    history.assertTransition(
      receipt.operationId,
      command.expectedRevision,
      result.revision,
      result.personId,
      result.policyEpoch,
    );
    if (request.mode === 'create')
      await verifyCreationAudit(receipt.operationId, result.personId!);
    return { ...result, operationId: receipt.operationId, replayed: true };
  }
  if (identity.revision !== command.expectedRevision)
    return fail('REVISION_CONFLICT');
  const revision = next(identity.revision),
    epoch = next(state.epoch);
  let createdPerson: OmniIdentityCreatePersonFields | null = null;
  const verifyCreatedPerson = async () => {
    if (!createdPerson || !personId) return;
    const row = one(
      z.object({
        id: uuid,
        nameFirstName: z.string(),
        nameLastName: z.string(),
        deletedAt: z.null(),
      }),
      await query(
        `SELECT id,"nameFirstName","nameLastName","deletedAt" FROM "${schema}".person WHERE id=$1 FOR UPDATE`,
        [personId],
      ),
    );
    if (
      auditPayloadHash(row) !==
      auditPayloadHash({
        id: personId,
        nameFirstName: createdPerson.name.firstName,
        nameLastName: createdPerson.name.lastName,
        deletedAt: null,
      })
    )
      return fail('CREATED_PERSON_INTEGRITY');
  };
  if (request.mode === 'create') {
    if (identity.personId !== null) return fail('ALREADY_BOUND');
    if (!nativePort.createPerson) return fail('CREATE_PERSON_PORT_REQUIRED');
    personId = randomUUID();
    createdPerson = request.command.person;
    await nativePort.createPerson(personId, createdPerson);
    await verifyCreatedPerson();
  }
  const people = [
    ...new Set(
      [identity.personId, personId].filter((id): id is string => id !== null),
    ),
  ].sort();
  const personRows = z
    .array(z.object({ id: uuid, deletedAt: z.unknown() }))
    .parse(
      await query(
        `SELECT id,"deletedAt" FROM "${schema}"."person" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [people],
      ),
    );
  if (
    personRows.length !== people.length ||
    (personId !== null &&
      !personRows.some((row) => row.id === personId && row.deletedAt === null))
  )
    return fail('PERSON_NOT_LIVE');
  const messages = z
    .array(z.object({ id: uuid, messageThreadId: uuid, deletedAt: z.null() }))
    .parse(
      await query(
        `SELECT id,"messageThreadId","deletedAt" FROM "${schema}"."message" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [links.map((link) => link.messageId)],
      ),
    );
  if (messages.length !== links.length) return fail('MESSAGE_SCOPE');
  const participants = z
    .array(participantSchema)
    .parse(
      await query(
        `SELECT id,"messageId","personId","workspaceMemberId",role,handle,"displayName","deletedAt" FROM "${schema}"."messageParticipant" WHERE "messageId"=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [links.map((link) => link.messageId)],
      ),
    );
  if (participants.length !== links.length) return fail('PARTICIPANT_SCOPE');
  for (const link of links) {
    const author = link.immutableAuthorSnapshot;
    const conversation = conversations.find(
      (row) => row.id === link.conversationId,
    );
    const message = messages.find((row) => row.id === link.messageId);
    const matching = participants.filter(
      (row) => row.messageId === link.messageId,
    );
    if (
      author.externalIdentityId !== identity.id ||
      author.providerPeerId !== identity.providerPeerId ||
      link.authorVerification !== identity.verificationSource ||
      !conversation ||
      message?.messageThreadId !== conversation.messageThreadId ||
      matching.length !== 1 ||
      matching[0].personId !== identity.personId ||
      matching[0].handle !== identity.providerPeerId ||
      matching[0].displayName !== (author.sourceDisplayName ?? '')
    )
      return fail('NATIVE_AUTHOR_INTEGRITY');
    history.assertBirth(author);
  }
  const targets =
    identity.personId !== null && identity.personId !== personId
      ? z
          .array(targetSchema)
          .parse(
            await query(
              `SELECT id,"conversationId","objectMetadataId","recordId",active,revision,"projectionId" FROM core."omniConversationTarget" WHERE "workspaceId"=$1 AND "conversationId"=ANY($2::uuid[]) AND "objectMetadataId"=$3 AND "recordId"=$4 AND active=true ORDER BY id FOR UPDATE`,
              [
                workspaceId,
                conversationIds,
                personObjectMetadataId,
                identity.personId,
              ],
            ),
          )
      : [];
  const projectionIds = targets.map((target) =>
    uuid.parse(target.projectionId),
  );
  if (new Set(projectionIds).size !== projectionIds.length)
    return fail('PROJECTION_AMBIGUOUS');
  const projections = z
    .array(projectionSchema)
    .parse(
      await query(
        `SELECT id,"messageThreadId","targetPersonId","targetCompanyId","targetOpportunityId","isManuallyAssigned","isAutomaticallyAssigned","deletedAt" FROM "${schema}"."messageThreadTarget" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [projectionIds],
      ),
    );
  if (projections.length !== targets.length) return fail('PROJECTION_MISSING');
  for (const target of targets) {
    next(target.revision);
    const projection = projections.find(
      (row) => row.id === target.projectionId,
    );
    if (
      projection?.targetPersonId !== identity.personId ||
      projection.messageThreadId !==
        conversations.find((row) => row.id === target.conversationId)
          ?.messageThreadId
    )
      return fail('PROJECTION_SCOPE');
  }
  const audit = new CrmAuditTransactionContext(executor, {
    ...principal,
    operationId,
  });
  if (createdPerson && personId)
    audit.record({
      resourceKind: 'omniPerson',
      resourceId: personId,
      action: 'create',
      before: null,
      after: createdPerson,
      securityDescriptor: {
        resourceKind: 'omniPerson',
        resourceId: personId,
        bindingId: identity.bindingId,
      },
    });
  if (identity.personId !== personId)
    for (const participant of participants) {
      await nativePort.updateParticipantPerson(participant.id, personId);
      const conversationId = links.find(
        (link) => link.messageId === participant.messageId,
      )!.conversationId;
      audit.record({
        resourceKind: 'omniMessageParticipant',
        resourceId: participant.id,
        action: 'update',
        before: participant,
        after: { ...participant, personId: personId },
        securityDescriptor: {
          resourceKind: 'omniMessageParticipant',
          resourceId: participant.id,
          bindingId: identity.bindingId,
          conversationId,
        },
      });
    }
  for (const target of targets) {
    const projection = projections.find(
      (row) => row.id === target.projectionId,
    )!;
    await nativePort.deleteProjection(projection.id);
    const updated = one(
      targetSchema,
      await query(
        `WITH updated AS (UPDATE core."omniConversationTarget" SET active=false,revision=revision+1,"projectionId"=NULL,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND id=$2 AND revision=$3 RETURNING id,"conversationId","objectMetadataId","recordId",active,revision,"projectionId") SELECT * FROM updated`,
        [workspaceId, target.id, target.revision],
      ),
    );
    if (
      auditPayloadHash(updated) !==
      auditPayloadHash({
        ...target,
        active: false,
        revision: next(target.revision),
        projectionId: null,
      })
    )
      return fail('TARGET_UPDATE');
    audit.record({
      resourceKind: 'omniConversationTarget',
      resourceId: target.id,
      action: 'update',
      before: target,
      after: updated,
      securityDescriptor: {
        resourceKind: 'omniConversationTarget',
        resourceId: target.id,
        bindingId: identity.bindingId,
        conversationId: target.conversationId,
      },
    });
    audit.record({
      resourceKind: 'omniMessageThreadTarget',
      resourceId: projection.id,
      action: 'delete',
      before: projection,
      after: null,
      securityDescriptor: {
        resourceKind: 'omniMessageThreadTarget',
        resourceId: projection.id,
        bindingId: identity.bindingId,
        conversationId: target.conversationId,
      },
    });
  }
  const updatedIdentity = one(
    identitySchema,
    await query(
      `WITH updated AS (UPDATE core."omniExternalIdentity" SET "personId"=$1,revision=revision+1,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$2 AND id=$3 AND revision=$4 RETURNING id,"bindingId","personId",revision,"providerPeerId","verificationSource") SELECT * FROM updated`,
      [personId, workspaceId, identity.id, identity.revision],
    ),
  );
  if (
    auditPayloadHash(updatedIdentity) !==
    auditPayloadHash({ ...identity, personId: personId, revision })
  )
    return fail('IDENTITY_UPDATE');
  const updatedState = one(
    z.object({ epoch: counter }),
    await query(
      `WITH updated AS (UPDATE core."omniWorkspacePolicyState" SET epoch=epoch+1,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND epoch=$2 RETURNING epoch) SELECT epoch FROM updated`,
      [workspaceId, state.epoch],
    ),
  );
  if (updatedState.epoch !== epoch) return fail('EPOCH_UPDATE');
  audit.record({
    resourceKind: 'omniExternalIdentity',
    resourceId: identity.id,
    action: 'update',
    before: identity,
    after: updatedIdentity,
    securityDescriptor: descriptor,
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
  const result = {
    externalIdentityId: identity.id,
    personId: personId,
    revision,
    policyEpoch: epoch,
  };
  await query(
    `INSERT INTO core."omniPolicyMutationReceipt" ("workspaceId","actorKind","actorId","idempotencyKey","operationId",action,"resourceDescriptor","payloadHash","resultPublic","committedAt") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,clock_timestamp())`,
    [
      workspaceId,
      principal.actor.kind,
      principal.actor.id,
      idempotencyKey,
      operationId,
      action,
      JSON.stringify(descriptor),
      payloadHash,
      JSON.stringify(result),
    ],
  );
  const finalIdentity = one(
    identitySchema,
    await query(
      'SELECT id,"bindingId","personId",revision,"providerPeerId","verificationSource" FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND id=$2',
      [workspaceId, identity.id],
    ),
  );
  if (auditPayloadHash(finalIdentity) !== auditPayloadHash(updatedIdentity))
    return fail('FINAL_IDENTITY');
  const finalParticipants = z
    .array(participantSchema)
    .parse(
      await query(
        `SELECT id,"messageId","personId","workspaceMemberId",role,handle,"displayName","deletedAt" FROM "${schema}"."messageParticipant" WHERE "messageId"=ANY($1::uuid[]) ORDER BY id`,
        [links.map((link) => link.messageId)],
      ),
    );
  if (
    auditPayloadHash(finalParticipants) !==
    auditPayloadHash(
      participants.map((row) => ({ ...row, personId: personId })),
    )
  )
    return fail('FINAL_PARTICIPANTS');
  const finalTargets = z
    .array(targetSchema)
    .parse(
      await query(
        'SELECT id,"conversationId","objectMetadataId","recordId",active,revision,"projectionId" FROM core."omniConversationTarget" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id',
        [workspaceId, targets.map((row) => row.id)],
      ),
    );
  if (
    auditPayloadHash(finalTargets) !==
      auditPayloadHash(
        targets.map((row) => ({
          ...row,
          active: false,
          revision: next(row.revision),
          projectionId: null,
        })),
      ) ||
    (
      await query(
        `SELECT id FROM "${schema}"."messageThreadTarget" WHERE id=ANY($1::uuid[])`,
        [projectionIds],
      )
    ).length !== 0
  )
    return fail('FINAL_TARGETS');
  const finalLinks = z
    .array(linkSchema)
    .parse(
      await query(
        `SELECT id,"messageId","conversationId","immutableAuthorSnapshot","authorVerification" FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "immutableAuthorSnapshot"->>'externalIdentityId'=$3 ORDER BY id`,
        [workspaceId, command.bindingId, identity.id],
      ),
    );
  if (auditPayloadHash(finalLinks) !== auditPayloadHash(links))
    return fail('FINAL_AUTHOR');
  const finalState = one(
    z.object({ epoch: counter }),
    await query(
      'SELECT epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1',
      [workspaceId],
    ),
  );
  const finalReceipt = one(
    receiptSchema,
    await query(
      'SELECT "operationId",action,"payloadHash","resourceDescriptor","resultPublic" FROM core."omniPolicyMutationReceipt" WHERE "workspaceId"=$1 AND "actorKind"=$2 AND "actorId"=$3 AND "idempotencyKey"=$4',
      [workspaceId, principal.actor.kind, principal.actor.id, idempotencyKey],
    ),
  );
  if (
    finalState.epoch !== epoch ||
    auditPayloadHash(finalReceipt) !==
      auditPayloadHash({
        operationId,
        action,
        payloadHash,
        resourceDescriptor: descriptor,
        resultPublic: result,
      })
  )
    return fail('FINAL_RECEIPT');
  (
    await loadOmniIdentityBindingHistory(scope, workspaceId, finalIdentity)
  ).assertTransition(operationId, identity.revision, revision, personId, epoch);
  await verifyCreatedPerson();
  if (createdPerson && personId)
    await verifyCreationAudit(operationId, personId);
  return { ...result, operationId, replayed: false };
};

export const appendOmniIdentityPersonFailure = async (
  scope: OmniHistoryApplyScope,
  request: OmniIdentityPersonRequest,
  operationId: string,
  denied: boolean,
) => {
  if (scope.workspaceId !== request.principal.workspaceId)
    return fail('WORKSPACE_MISMATCH');
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const rows = await executor.query(
    'SELECT id FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3',
    [
      scope.workspaceId,
      request.command.bindingId,
      request.command.externalIdentityId,
    ],
  );
  if (!rows.length) return;
  if (rows.length !== 1) return fail('AMBIGUOUS_FAILURE_RESOURCE');
  await appendCrmAuditAttempt(
    executor,
    { ...request.principal, operationId },
    {
      attemptId: randomUUID(),
      resourceKind: 'omniExternalIdentity',
      resourceId: request.command.externalIdentityId,
      action: 'update',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: denied ? 'identity.person.denied' : 'identity.person.failed',
      securityDescriptor: {
        resourceKind: 'omniExternalIdentity',
        resourceId: request.command.externalIdentityId,
        bindingId: request.command.bindingId,
      },
    },
  );
};
