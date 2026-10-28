import { z } from 'zod';
import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { type OmniNativeOwnershipQuery } from 'src/modules/omnichannel/services/lock-omni-native-ownership';

const uuid = z.uuid();
const positive = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$(?![\s\S])/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const edgeSchema = z.object({
  id: uuid,
  conversationId: uuid,
  objectMetadataId: uuid,
  recordId: uuid,
  active: z.boolean(),
  revision: positive,
  projectionId: uuid.nullable(),
});
const entrySchema = z.object({
  operationId: uuid,
  resourceId: uuid,
  resourceKind: z.string(),
  action: z.enum(['create', 'update', 'delete']),
  securityDescriptor: z.unknown(),
  redactedDiff: z.object({
    changedFields: z.array(z.string()),
    values: z.record(
      z.string(),
      z.object({ before: z.unknown(), after: z.unknown() }),
    ),
  }),
});
const fail = (): never => {
  throw new Error('OMNI_CONVERSATION_TARGET_TRANSITION_PROOF');
};
const equal = (a: unknown, b: unknown) =>
  auditPayloadHash(a) === auditPayloadHash(b);
const fields = [
  'conversationId',
  'objectMetadataId',
  'recordId',
  'active',
  'revision',
  'projectionId',
];

// A renewal may change only revision. Reconstruct the complete retained state;
// validating only the latest diff would allow tampered unchanged fields.
export const verifyOmniConversationTargetHistory = async (
  scope: OmniNativeOwnershipQuery,
  facts: {
    workspaceId: string;
    bindingId: string;
    messageThreadId: string;
    policyState: { id: string; epoch: string };
    edge: z.infer<typeof edgeSchema>;
    projectionField:
      | 'targetPersonId'
      | 'targetCompanyId'
      | 'targetOpportunityId'
      | null;
  },
) => {
  const {
    workspaceId,
    bindingId,
    messageThreadId,
    policyState,
    projectionField,
  } = facts;
  const current = edgeSchema.parse(facts.edge);
  const entries = z
    .array(entrySchema)
    .parse(
      await scope.executeRawQuery(
        `SELECT "operationId","resourceId","resourceKind",action,"securityDescriptor","redactedDiff" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "resourceKind"='omniConversationTarget' AND "resourceId"=$2 AND outcome='success'`,
        [workspaceId, current.id],
      ),
    );
  if (BigInt(entries.length) !== BigInt(current.revision)) return fail();
  for (const entry of entries)
    positive.parse(entry.redactedDiff.values.revision?.after);
  entries.sort((a, b) =>
    BigInt(a.redactedDiff.values.revision.after as string) <
    BigInt(b.redactedDiff.values.revision.after as string)
      ? -1
      : 1,
  );
  const operations = entries.map((entry) => entry.operationId);
  if (new Set(operations).size !== operations.length) return fail();
  const related = z
    .array(entrySchema)
    .parse(
      await scope.executeRawQuery(
        `SELECT "operationId","resourceId","resourceKind",action,"securityDescriptor","redactedDiff" FROM crm_audit."crmAuditEntry" WHERE "workspaceId"=$1 AND "operationId"=ANY($2::uuid[]) AND "resourceKind" IN ('omniMessageThreadTarget','omniWorkspacePolicyState') AND outcome='success'`,
        [workspaceId, operations],
      ),
    );
  const descriptor = (kind: string, id: string) => ({
    resourceKind: kind,
    resourceId: id,
    bindingId,
    conversationId: current.conversationId,
  });
  const checkDiff = (
    entry: z.infer<typeof entrySchema>,
    expected: Record<string, { before: unknown; after: unknown }>,
  ) => {
    if (
      !equal(
        entry.redactedDiff.changedFields.slice().sort(),
        Object.keys(expected).sort(),
      ) ||
      !equal(entry.redactedDiff.values, expected)
    )
      return fail();
  };
  const checkProjection = (
    operationId: string,
    id: string,
    action: 'create' | 'delete',
  ) => {
    if (!projectionField) return fail();
    const candidates = related.filter(
      (entry) =>
        entry.operationId === operationId &&
        entry.resourceKind === 'omniMessageThreadTarget' &&
        entry.resourceId === id,
    );
    if (candidates.length !== 1) return fail();
    const entry = candidates[0];
    if (
      entry.action !== action ||
      !equal(
        entry.securityDescriptor,
        descriptor('omniMessageThreadTarget', id),
      )
    )
      return fail();
    const values: Record<string, unknown> = {
      messageThreadId,
      targetPersonId: null,
      targetCompanyId: null,
      targetOpportunityId: null,
      [projectionField]: current.recordId,
      isManuallyAssigned: true,
      isAutomaticallyAssigned: false,
    };
    checkDiff(
      entry,
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          action === 'create'
            ? { before: null, after: value }
            : { before: value, after: null },
        ]),
      ),
    );
  };
  let previous: z.infer<typeof edgeSchema> | null = null;
  let lastEpoch = '0';
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index],
      values = entry.redactedDiff.values;
    if (
      !equal(
        entry.securityDescriptor,
        descriptor('omniConversationTarget', current.id),
      ) ||
      !equal(
        entry.redactedDiff.changedFields.slice().sort(),
        Object.keys(values).sort(),
      ) ||
      Object.keys(values).some((field) => !fields.includes(field))
    )
      return fail();
    const nextRevision = (BigInt(index) + 1n).toString();
    if (values.revision?.after !== nextRevision) return fail();
    let state: z.infer<typeof edgeSchema>;
    if (!previous) {
      if (
        entry.action !== 'create' ||
        Object.values(values).some((change) => change.before !== null)
      )
        return fail();
      state = edgeSchema.parse({
        id: current.id,
        projectionId: null,
        ...Object.fromEntries(
          Object.entries(values).map(([field, change]) => [
            field,
            change.after,
          ]),
        ),
      });
    } else {
      if (
        entry.action !== 'update' ||
        values.revision?.before !== previous.revision ||
        Object.keys(values).some(
          (field) => !['active', 'revision', 'projectionId'].includes(field),
        )
      )
        return fail();
      for (const [field, change] of Object.entries(values))
        if (!equal(change.before, previous[field as keyof typeof previous]))
          return fail();
      state = edgeSchema.parse({
        ...previous,
        ...Object.fromEntries(
          Object.entries(values).map(([field, change]) => [
            field,
            change.after,
          ]),
        ),
      });
    }
    if (
      state.conversationId !== current.conversationId ||
      state.objectMetadataId !== current.objectMetadataId ||
      state.recordId !== current.recordId ||
      Boolean(state.projectionId) !== (state.active && projectionField !== null)
    )
      return fail();
    if (previous?.projectionId !== state.projectionId) {
      if (previous?.projectionId)
        checkProjection(entry.operationId, previous.projectionId, 'delete');
      if (state.projectionId)
        checkProjection(entry.operationId, state.projectionId, 'create');
    }
    const policies = related.filter(
      (candidate) =>
        candidate.operationId === entry.operationId &&
        candidate.resourceKind === 'omniWorkspacePolicyState' &&
        candidate.resourceId === policyState.id,
    );
    if (policies.length !== 1) return fail();
    const policy = policies[0];
    if (
      policy.action !== 'update' ||
      !equal(policy.securityDescriptor, {
        resourceKind: 'omniWorkspacePolicyState',
        resourceId: policyState.id,
      })
    )
      return fail();
    const epoch = z
      .object({ before: positive, after: positive })
      .parse(policy.redactedDiff.values.epoch);
    checkDiff(policy, { epoch });
    if (
      BigInt(epoch.after) !== BigInt(epoch.before) + 1n ||
      BigInt(epoch.before) < BigInt(lastEpoch) ||
      BigInt(epoch.after) > BigInt(policyState.epoch)
    )
      return fail();
    lastEpoch = epoch.after;
    previous = state;
  }
  if (!previous || !equal(previous, current)) return fail();
  return {
    operationId: entries[entries.length - 1].operationId,
    policyEpoch: lastEpoch,
  };
};
