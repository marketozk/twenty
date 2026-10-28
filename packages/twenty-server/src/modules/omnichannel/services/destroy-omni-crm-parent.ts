import { randomUUID } from 'node:crypto';
import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';
import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  CrmAuditTransactionContext,
  appendCrmAuditAttempt,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type OmniHistoryApplyScope } from 'src/modules/omnichannel/services/apply-omni-history-receipt';
import { omniBindingConfigurationPrincipalSchema } from 'src/modules/omnichannel/contracts/omni-binding-configuration';
import { assertNoUnhandledParentReferences } from 'src/modules/omnichannel/services/assert-no-unhandled-parent-references';
import {
  setOmniIdentityPerson,
  snapshotOmniIdentityPersonRequest,
} from 'src/modules/omnichannel/services/set-omni-identity-person';
import {
  setOmniConversationTarget,
  snapshotOmniConversationTargetRequest,
  type OmniConversationTargetMetadata,
} from 'src/modules/omnichannel/services/set-omni-conversation-target';
import {
  verifyOmniDetachedParent,
  type OmniDetachedParentManifest,
} from 'src/modules/omnichannel/services/verify-omni-detached-parent';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const counter = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$(?![\s\S])/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const revision = z.strictObject({ id: uuid, revision: counter }).readonly();
const revisions = z
  .array(revision)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length)
  .transform((rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id)))
  .readonly();
const commandSchema = z
  .strictObject({
    objectMetadataId: uuid,
    recordId: uuid,
    expectedParentFingerprint: z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
    expectedIdentities: revisions,
    expectedTargets: revisions,
    idempotencyKey: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          value.trim() === value &&
          !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value),
      ),
  })
  .readonly();
const identitySchema = z.object({
  id: uuid,
  bindingId: uuid,
  revision: counter,
  personId: uuid,
});
const targetSchema = z.object({
  id: uuid,
  bindingId: uuid,
  conversationId: uuid,
  revision: counter,
  active: z.boolean(),
});
const conversationSchema = z.object({
  id: uuid,
  bindingId: uuid,
  queueId: uuid.nullable(),
});
const deletedParentSchema = z
  .strictObject({
    objectMetadataId: uuid,
    name: z.enum(['person', 'company']),
    access: z.literal('currentWorkspaceAdministration'),
  })
  .readonly();
const descriptorSchema = z
  .strictObject({
    resourceKind: z.enum(['omniPerson', 'omniCompany']),
    resourceId: uuid,
    deletedParent: deletedParentSchema,
  })
  .readonly();
const retainedSchema = z
  .strictObject({
    descriptor: descriptorSchema,
    identities: z.array(identitySchema.readonly()).readonly(),
    targets: z.array(targetSchema.readonly()).readonly(),
    conversations: z.array(conversationSchema.readonly()).readonly(),
  })
  .readonly();
const resultSchema = z
  .strictObject({
    recordId: uuid,
    objectMetadataId: uuid,
    deleted: z.literal(true),
    policyEpoch: counter,
  })
  .readonly();
const receiptSchema = z.object({
  operationId: uuid,
  action: z.string(),
  payloadHash: z.string(),
  resourceDescriptor: z.unknown(),
  resultPublic: z.unknown(),
});
const fail = (code: string): never => {
  throw new Error(`OMNI_PARENT_DESTROY_${code}`);
};
const one = <TSchema extends z.ZodType>(
  schema: TSchema,
  rows: unknown[],
): z.infer<TSchema> => {
  if (rows.length !== 1) return fail('RESOURCE_SCOPE');
  return schema.parse(rows[0]);
};
const next = (value: string) => {
  if (BigInt(value) >= 9223372036854775807n) return fail('COUNTER_EXHAUSTED');
  return (BigInt(value) + 1n).toString();
};
export type OmniParentDestroyCommand = z.infer<typeof commandSchema>;
export type OmniParentDestroyPrincipal = z.infer<
  typeof omniBindingConfigurationPrincipalSchema
>;
export type OmniParentDestroyAuthorizer = (
  scope: OmniHistoryApplyScope,
  facts: Readonly<
    OmniParentDestroyPrincipal & {
      action: 'crmParent.destroy';
      requiredPermission: 'workspace.administration.destroyCrmParent';
      command: OmniParentDestroyCommand;
      replay: boolean;
      retained: z.infer<typeof retainedSchema>;
      currentConversations: readonly Readonly<
        z.infer<typeof conversationSchema>
      >[];
    }
  >,
) => Promise<void>;
export const snapshotOmniParentDestroyRequest = (
  principal: OmniParentDestroyPrincipal,
  command: OmniParentDestroyCommand,
  authorize: OmniParentDestroyAuthorizer,
) => {
  if (typeof authorize !== 'function') return fail('AUTHORIZER_REQUIRED');
  return Object.freeze({
    principal: omniBindingConfigurationPrincipalSchema.parse(principal),
    command: commandSchema.parse(command),
    authorize,
  });
};
type Request = ReturnType<typeof snapshotOmniParentDestroyRequest>;
export type OmniParentDestroyPort = {
  identity: Parameters<typeof setOmniIdentityPerson>[4];
  target: Parameters<typeof setOmniConversationTarget>[5];
  deleteParent: (manifest: OmniDetachedParentManifest) => Promise<void>;
};

export const destroyOmniCrmParent = async (
  scope: OmniHistoryApplyScope,
  request: Request,
  metadata: OmniConversationTargetMetadata,
  attemptOperationId: string,
  port: OmniParentDestroyPort,
) => {
  const { principal, command } = request,
    { workspaceId } = principal;
  if (
    scope.workspaceId !== workspaceId ||
    metadata.workspaceId !== workspaceId ||
    metadata.id !== command.objectMetadataId ||
    !metadata.isActive ||
    metadata.isSystem
  )
    return fail('METADATA_SCOPE');
  const name =
    metadata.projectionField === 'targetPersonId'
      ? 'person'
      : metadata.projectionField === 'targetCompanyId'
        ? 'company'
        : fail('UNSUPPORTED_PARENT');
  if (metadata.tableName !== name) return fail('METADATA_TABLE');
  const resourceKind = name === 'person' ? 'omniPerson' : 'omniCompany';
  const descriptor = descriptorSchema.parse({
    resourceKind,
    resourceId: command.recordId,
    deletedParent: {
      objectMetadataId: metadata.id,
      name,
      access: 'currentWorkspaceAdministration',
    },
  });
  const operationId = uuid.parse(attemptOperationId);
  const executor = createCrmAuditWorkspaceExecutor(scope),
    query = executor.query;
  const schema = `workspace_${BigInt(`0x${workspaceId.replaceAll('-', '')}`).toString(36)}`;
  const { idempotencyKey, ...payload } = command;
  const action = 'crmParent.destroy',
    payloadHash = auditPayloadHash({ workspaceId, action, ...payload });
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
        'SELECT "operationId",action,"payloadHash","resourceDescriptor","resultPublic" FROM core."omniPolicyMutationReceipt" WHERE "workspaceId"=$1 AND "actorKind"=$2 AND "actorId"=$3 AND "idempotencyKey"=$4 FOR UPDATE',
        [workspaceId, principal.actor.kind, principal.actor.id, idempotencyKey],
      ),
    );
  if (receipts.length > 1) return fail('AMBIGUOUS_RECEIPT');
  const readConversations = async (ids: readonly string[]) =>
    z
      .array(conversationSchema)
      .parse(
        await query(
          'SELECT id,"bindingId","queueId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
          [workspaceId, ids],
        ),
      );
  const authorize = async (
    retained: z.infer<typeof retainedSchema>,
    replay: boolean,
  ) => {
    const currentConversations = await readConversations(
      retained.conversations.map((row) => row.id),
    );
    await request.authorize(
      scope,
      Object.freeze({
        ...principal,
        action,
        requiredPermission: 'workspace.administration.destroyCrmParent',
        command,
        replay,
        retained,
        currentConversations: Object.freeze(
          currentConversations.map((row) => Object.freeze(row)),
        ),
      }),
    );
  };
  const verifyAudit = async (
    recordedOperation: string,
    retained: z.infer<typeof retainedSchema>,
    result: z.infer<typeof resultSchema>,
  ) => {
    const rows = await query(
      `SELECT "securityDescriptor","redactedDiff" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 AND "resourceKind"=$3 AND "resourceId"=$4 AND action='delete' AND outcome='success'`,
      [workspaceId, recordedOperation, resourceKind, command.recordId],
    );
    const audit = one(
      z.object({ securityDescriptor: z.unknown(), redactedDiff: z.unknown() }),
      rows,
    );
    if (
      auditPayloadHash(audit.securityDescriptor) !==
        auditPayloadHash(retained.descriptor) ||
      auditPayloadHash(audit.redactedDiff) !==
        auditPayloadHash({
          changedFields: ['destroyScopeHash', 'name'],
          values: {
            destroyScopeHash: {
              before: auditPayloadHash(retained),
              after: null,
            },
          },
        })
    )
      return fail('AUDIT_PROOF');
    const epochs = await query(
      `SELECT "redactedDiff" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=$2 AND "resourceKind"='omniWorkspacePolicyState' AND "resourceId"=$3 AND action='update' AND outcome='success'`,
      [workspaceId, recordedOperation, state.id],
    );
    const epoch = one(z.object({ redactedDiff: z.unknown() }), epochs);
    if (
      auditPayloadHash(epoch.redactedDiff) !==
      auditPayloadHash({
        changedFields: ['epoch'],
        values: {
          epoch: {
            before: (BigInt(result.policyEpoch) - 1n).toString(),
            after: result.policyEpoch,
          },
        },
      })
    )
      return fail('AUDIT_POLICY_PROOF');
  };
  if (receipts[0]) {
    const receipt = receipts[0],
      retained = retainedSchema.parse(receipt.resourceDescriptor);
    await authorize(retained, true);
    if (receipt.action !== action || receipt.payloadHash !== payloadHash)
      return fail('IDEMPOTENCY_CONFLICT');
    if (auditPayloadHash(retained.descriptor) !== auditPayloadHash(descriptor))
      return fail('RECEIPT_SCOPE');
    if (receipt.resultPublic === null) return fail('RESULT_EXPIRED');
    const result = resultSchema.parse(receipt.resultPublic);
    if (
      result.recordId !== command.recordId ||
      result.objectMetadataId !== metadata.id ||
      BigInt(result.policyEpoch) > BigInt(state.epoch)
    )
      return fail('RECEIPT_INTEGRITY');
    await verifyAudit(receipt.operationId, retained, result);
    return { ...result, operationId: receipt.operationId, replayed: true };
  }
  const parent = one(
    z.object({
      fingerprint: z.string(),
      record: z.record(z.string(), z.unknown()),
    }),
    await query(
      `SELECT encode(sha256(convert_to(to_jsonb(parent)::text,'UTF8')),'hex') AS fingerprint,to_jsonb(parent) AS record FROM "${schema}"."${name}" parent WHERE id=$1`,
      [command.recordId],
    ),
  );
  const identities = z
    .array(identitySchema)
    .parse(
      name === 'person'
        ? await query(
            'SELECT id,"bindingId",revision,"personId" FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND "personId"=$2 ORDER BY id',
            [workspaceId, command.recordId],
          )
        : [],
    );
  const readTargets = async () =>
    z
      .array(targetSchema)
      .parse(
        await query(
          `SELECT target.id,conversation."bindingId",target."conversationId",target.revision,target.active FROM core."omniConversationTarget" target LEFT JOIN core."omniConversation" conversation ON conversation."workspaceId"=target."workspaceId" AND conversation.id=target."conversationId" WHERE target."workspaceId"=$1 AND target."objectMetadataId"=$2 AND target."recordId"=$3 ORDER BY target.id`,
          [workspaceId, metadata.id, command.recordId],
        ),
      );
  const targets = await readTargets();
  const identityLinks = z
    .array(z.object({ conversationId: uuid }))
    .parse(
      await query(
        `SELECT DISTINCT "conversationId" FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND "immutableAuthorSnapshot"->>'externalIdentityId'=ANY($2::text[])`,
        [workspaceId, identities.map((row) => row.id)],
      ),
    );
  const conversationIds = [
    ...new Set([
      ...identityLinks.map((row) => row.conversationId),
      ...targets.map((row) => row.conversationId),
    ]),
  ].sort();
  const bindingIds = [
    ...new Set([
      ...identities.map((row) => row.bindingId),
      ...targets.map((row) => row.bindingId),
    ]),
  ].sort();
  const bindings = await query(
    'SELECT id FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
    [workspaceId, bindingIds],
  );
  if (bindings.length !== bindingIds.length) return fail('BINDING_SCOPE');
  const conversations = await readConversations(conversationIds);
  if (conversations.length !== conversationIds.length)
    return fail('CONVERSATION_SCOPE');
  if (identities.length) {
    const locked = await query(
      'SELECT id,"bindingId",revision,"personId" FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [workspaceId, identities.map((row) => row.id)],
    );
    if (
      auditPayloadHash(z.array(identitySchema).parse(locked)) !==
      auditPayloadHash(identities)
    )
      return fail('IDENTITY_CHANGED');
  }
  one(
    z.object({ id: uuid }),
    await query(`SELECT id FROM "${schema}"."${name}" WHERE id=$1 FOR UPDATE`, [
      command.recordId,
    ]),
  );
  const retained = retainedSchema.parse({
    descriptor,
    identities,
    targets,
    conversations,
  });
  await authorize(retained, false);
  const historyFingerprint = async (detach: boolean) =>
    one(
      z.object({ fingerprint: z.string() }),
      await query(
        `
    SELECT encode(sha256(convert_to(jsonb_build_object(
      'links',(SELECT jsonb_agg(to_jsonb(link) ORDER BY link.id) FROM core."omniMessageLink" link WHERE link."workspaceId"=$1 AND link."conversationId"=ANY($2::uuid[])),
      'threads',(SELECT jsonb_agg(to_jsonb(thread) ORDER BY thread.id) FROM "${schema}"."messageThread" thread WHERE thread.id IN (SELECT "messageThreadId" FROM core."omniConversation" WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]))),
      'messages',(SELECT jsonb_agg(to_jsonb(message) ORDER BY message.id) FROM "${schema}"."message" message WHERE message.id IN (SELECT "messageId" FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND "conversationId"=ANY($2::uuid[]))),
      'participants',(SELECT jsonb_agg(CASE WHEN $3 AND participant."personId"=$4 THEN to_jsonb(jsonb_populate_record(NULL::"${schema}"."messageParticipant",to_jsonb(participant)||jsonb_build_object('personId',null,'updatedAt',CURRENT_TIMESTAMP))) ELSE to_jsonb(participant) END ORDER BY participant.id) FROM "${schema}"."messageParticipant" participant WHERE participant."messageId" IN (SELECT "messageId" FROM core."omniMessageLink" WHERE "workspaceId"=$1 AND "conversationId"=ANY($2::uuid[])))
    )::text,'UTF8')),'hex') AS fingerprint`,
        [workspaceId, conversationIds, detach, command.recordId],
      ),
    ).fingerprint;
  const expectedHistory = await historyFingerprint(name === 'person');
  const revisionList = (rows: { id: string; revision: string }[]) =>
    rows.map(({ id, revision }) => ({ id, revision }));
  if (
    parent.fingerprint !== command.expectedParentFingerprint ||
    auditPayloadHash(revisionList(identities)) !==
      auditPayloadHash(command.expectedIdentities) ||
    auditPayloadHash(revisionList(targets)) !==
      auditPayloadHash(command.expectedTargets)
  )
    return fail('REVISION_CONFLICT');
  for (const identity of identities) {
    const childOperation = uuidV5(
      `omni:parent-destroy:identity:${identity.id}`,
      operationId,
    );
    await setOmniIdentityPerson(
      scope,
      snapshotOmniIdentityPersonRequest(
        principal,
        {
          bindingId: identity.bindingId,
          externalIdentityId: identity.id,
          personId: null,
          expectedRevision: identity.revision,
          idempotencyKey: `omni:parent-destroy:${operationId}:${identity.id}`,
        },
        async (_childScope, facts) => {
          if (
            facts.replay ||
            facts.currentIdentity.personId !== command.recordId ||
            facts.currentIdentity.revision !== identity.revision ||
            facts.conversations.some((row) => !conversationIds.includes(row.id))
          )
            return fail('CHILD_IDENTITY_SCOPE');
        },
      ),
      metadata.id,
      childOperation,
      port.identity,
    );
  }
  for (const target of await readTargets()) {
    if (!target.active) continue;
    await setOmniConversationTarget(
      scope,
      snapshotOmniConversationTargetRequest(
        principal,
        {
          bindingId: target.bindingId,
          conversationId: target.conversationId,
          objectMetadataId: metadata.id,
          recordId: command.recordId,
          expectedTargetRevision: target.revision,
          active: false,
        },
        async (_childScope, facts) => {
          if (facts.replay || !conversationIds.includes(facts.conversation.id))
            return fail('CHILD_TARGET_SCOPE');
        },
      ),
      metadata,
      uuidV5(`omni:parent-destroy:target:${target.id}`, operationId),
      randomUUID(),
      port.target,
    );
  }
  const manifest: OmniDetachedParentManifest = {
    workspaceId,
    objectMetadataId: metadata.id,
    recordId: command.recordId,
    name,
    retainedTargets: revisionList(await readTargets()),
  };
  await verifyOmniDetachedParent(scope, manifest);
  await assertNoUnhandledParentReferences(
    scope,
    schema,
    name,
    command.recordId,
  );
  if (
    one(
      z.object({ fingerprint: z.string() }),
      await query(
        `SELECT encode(sha256(convert_to(to_jsonb(parent)::text,'UTF8')),'hex') AS fingerprint FROM "${schema}"."${name}" parent WHERE id=$1`,
        [command.recordId],
      ),
    ).fingerprint !== parent.fingerprint
  )
    return fail('PARENT_CHANGED');
  const beforeState = one(
    z.object({ epoch: counter }),
    await query(
      'SELECT epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1',
      [workspaceId],
    ),
  );
  const epoch = next(beforeState.epoch);
  await port.deleteParent(manifest);
  if (
    (
      await query(
        'UPDATE core."omniWorkspacePolicyState" SET epoch=$3 WHERE "workspaceId"=$1 AND epoch=$2 RETURNING id',
        [workspaceId, beforeState.epoch, epoch],
      )
    ).length !== 1
  )
    return fail('POLICY_CAS');
  const audit = new CrmAuditTransactionContext(executor, {
    ...principal,
    operationId,
  });
  audit.record({
    resourceKind,
    resourceId: command.recordId,
    action: 'delete',
    before: {
      destroyScopeHash: auditPayloadHash(retained),
      name:
        name === 'person'
          ? {
              firstName: parent.record.nameFirstName ?? null,
              lastName: parent.record.nameLastName ?? null,
            }
          : (parent.record.name ?? null),
    },
    after: null,
    securityDescriptor: descriptor,
  });
  audit.record({
    resourceKind: 'omniWorkspacePolicyState',
    resourceId: state.id,
    action: 'update',
    before: { epoch: beforeState.epoch },
    after: { epoch },
    securityDescriptor: {
      resourceKind: 'omniWorkspacePolicyState',
      resourceId: state.id,
    },
  });
  await audit.flush();
  const result = resultSchema.parse({
    recordId: command.recordId,
    objectMetadataId: metadata.id,
    deleted: true,
    policyEpoch: epoch,
  });
  await query(
    'INSERT INTO core."omniPolicyMutationReceipt" ("workspaceId","actorKind","actorId","idempotencyKey","operationId",action,"resourceDescriptor","payloadHash","resultPublic","committedAt") VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,clock_timestamp())',
    [
      workspaceId,
      principal.actor.kind,
      principal.actor.id,
      idempotencyKey,
      operationId,
      action,
      JSON.stringify(retained),
      payloadHash,
      JSON.stringify(result),
    ],
  );
  if (
    (
      await query(`SELECT id FROM "${schema}"."${name}" WHERE id=$1`, [
        command.recordId,
      ])
    ).length
  )
    return fail('FINAL_PARENT');
  if ((await historyFingerprint(false)) !== expectedHistory)
    return fail('FINAL_HISTORY');
  await verifyOmniDetachedParent(scope, manifest);
  await verifyAudit(operationId, retained, result);
  const finalReceipt = one(
    receiptSchema,
    await query(
      'SELECT "operationId",action,"payloadHash","resourceDescriptor","resultPublic" FROM core."omniPolicyMutationReceipt" WHERE "workspaceId"=$1 AND "actorKind"=$2 AND "actorId"=$3 AND "idempotencyKey"=$4',
      [workspaceId, principal.actor.kind, principal.actor.id, idempotencyKey],
    ),
  );
  if (
    auditPayloadHash(finalReceipt) !==
    auditPayloadHash({
      operationId,
      action,
      payloadHash,
      resourceDescriptor: retained,
      resultPublic: result,
    })
  )
    return fail('FINAL_RECEIPT');
  if (
    one(
      z.object({ epoch: counter }),
      await query(
        'SELECT epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1',
        [workspaceId],
      ),
    ).epoch !== epoch
  )
    return fail('FINAL_POLICY');
  return { ...result, operationId, replayed: false };
};

export const appendOmniParentDestroyFailure = async (
  scope: OmniHistoryApplyScope,
  request: Request,
  name: 'person' | 'company',
  operationId: string,
  denied: boolean,
) => {
  if (scope.workspaceId !== request.principal.workspaceId)
    return fail('WORKSPACE_MISMATCH');
  const resourceKind = name === 'person' ? 'omniPerson' : 'omniCompany';
  await appendCrmAuditAttempt(
    createCrmAuditWorkspaceExecutor(scope),
    { ...request.principal, operationId },
    {
      attemptId: randomUUID(),
      resourceKind,
      resourceId: request.command.recordId,
      action: 'delete',
      outcome: denied ? 'denied' : 'failed',
      reasonCode: denied
        ? 'crm.parent.destroy.denied'
        : 'crm.parent.destroy.failed',
      securityDescriptor: {
        resourceKind,
        resourceId: request.command.recordId,
        deletedParent: {
          objectMetadataId: request.command.objectMetadataId,
          name,
          access: 'currentWorkspaceAdministration',
        },
      },
    },
  );
};
