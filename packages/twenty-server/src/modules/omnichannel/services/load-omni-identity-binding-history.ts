import { z } from 'zod';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { type OmniNativeOwnershipQuery } from 'src/modules/omnichannel/services/lock-omni-native-ownership';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$(?![\s\S])/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const identitySchema = z.object({
  id: uuid,
  bindingId: uuid,
  personId: uuid.nullable(),
  revision,
});
const value = z.object({ before: z.unknown(), after: z.unknown() });
const entrySchema = z.object({
  operationId: uuid,
  resourceId: uuid,
  securityDescriptor: z.unknown(),
  redactedDiff: z.object({
    changedFields: z.array(z.string()),
    values: z.record(z.string(), value),
  }),
});
const fail = (): never => {
  throw new Error('OMNI_IDENTITY_BINDING_HISTORY_INTEGRITY');
};

// Birth snapshots stay immutable. Only retained, audited transitions can explain
// a different current Person; raw row changes are never accepted as a rebind.
export const loadOmniIdentityBindingHistory = async (
  scope: OmniNativeOwnershipQuery,
  workspaceId: string,
  current: z.infer<typeof identitySchema>,
) => {
  const identity = identitySchema.parse(current);
  const entries = z.array(entrySchema).parse(
    await scope.executeRawQuery(
      `SELECT "operationId","resourceId","securityDescriptor","redactedDiff" FROM crm_audit."crmAuditEntry"
     WHERE "workspaceId"=$1 AND "resourceKind"='omniExternalIdentity' AND "resourceId"=$2 AND action='update' AND outcome='success'`,
      [workspaceId, identity.id],
    ),
  );
  if (BigInt(entries.length) !== BigInt(identity.revision) - 1n) return fail();
  const transitions = entries
    .map((entry) => {
      const beforeRevision = revision.parse(
        entry.redactedDiff.values.revision?.before,
      );
      const afterRevision = revision.parse(
        entry.redactedDiff.values.revision?.after,
      );
      const person = entry.redactedDiff.values.personId;
      const personChange = person
        ? z
            .object({ before: uuid.nullable(), after: uuid.nullable() })
            .parse(person)
        : null;
      const fields = personChange ? ['personId', 'revision'] : ['revision'];
      if (
        BigInt(afterRevision) !== BigInt(beforeRevision) + 1n ||
        auditPayloadHash([...entry.redactedDiff.changedFields].sort()) !==
          auditPayloadHash(fields) ||
        auditPayloadHash(Object.keys(entry.redactedDiff.values).sort()) !==
          auditPayloadHash(fields) ||
        auditPayloadHash(entry.securityDescriptor) !==
          auditPayloadHash({
            resourceKind: 'omniExternalIdentity',
            resourceId: identity.id,
            bindingId: identity.bindingId,
          })
      )
        return fail();
      return {
        operationId: entry.operationId,
        beforeRevision,
        afterRevision,
        personChange,
      };
    })
    .sort((left, right) =>
      BigInt(left.afterRevision) > BigInt(right.afterRevision) ? -1 : 1,
    );
  const states = new Map<string, string | null>([
    [identity.revision, identity.personId],
  ]);
  let currentRevision = identity.revision;
  let personId = identity.personId;
  for (const transition of transitions) {
    if (
      transition.afterRevision !== currentRevision ||
      (transition.personChange && transition.personChange.after !== personId)
    )
      return fail();
    personId = transition.personChange
      ? transition.personChange.before
      : personId;
    currentRevision = transition.beforeRevision;
    states.set(currentRevision, personId);
  }
  if (currentRevision !== '1') return fail();
  const policyEpochs = new Map<string, string>();
  if (transitions.length) {
    const policies = z.array(entrySchema).parse(
      await scope.executeRawQuery(
        `SELECT audit."operationId",audit."resourceId",audit."securityDescriptor",audit."redactedDiff" FROM crm_audit."crmAuditEntry" audit
       JOIN core."omniWorkspacePolicyState" state ON state."workspaceId"=audit."workspaceId" AND state.id::text=audit."resourceId"
       WHERE audit."workspaceId"=$1 AND audit."resourceKind"='omniWorkspacePolicyState' AND audit.action='update'
       AND audit.outcome='success' AND audit."operationId"=ANY($2::uuid[])`,
        [workspaceId, transitions.map((entry) => entry.operationId)],
      ),
    );
    for (const transition of transitions) {
      const matches = policies.filter(
        (entry) => entry.operationId === transition.operationId,
      );
      if (matches.length !== 1) return fail();
      const policy = matches[0];
      const before = revision.parse(policy.redactedDiff.values.epoch?.before);
      const after = revision.parse(policy.redactedDiff.values.epoch?.after);
      if (
        BigInt(after) !== BigInt(before) + 1n ||
        auditPayloadHash(policy.redactedDiff.changedFields) !==
          auditPayloadHash(['epoch']) ||
        auditPayloadHash(Object.keys(policy.redactedDiff.values)) !==
          auditPayloadHash(['epoch']) ||
        auditPayloadHash(policy.securityDescriptor) !==
          auditPayloadHash({
            resourceKind: 'omniWorkspacePolicyState',
            resourceId: policy.resourceId,
          })
      )
        return fail();
      policyEpochs.set(transition.operationId, after);
    }
  }
  return Object.freeze({
    assertBirth: (birth: {
      identityRevision: string;
      personId: string | null;
    }) => {
      const birthRevision = revision.parse(birth.identityRevision);
      if (
        !states.has(birthRevision) ||
        states.get(birthRevision) !== birth.personId
      )
        return fail();
    },
    assertTransition: (
      operationId: string,
      beforeRevision: string,
      afterRevision: string,
      personId: string | null,
      policyEpoch: string,
    ) => {
      if (
        !transitions.some(
          (entry) =>
            entry.operationId === operationId &&
            entry.beforeRevision === beforeRevision &&
            entry.afterRevision === afterRevision,
        ) ||
        policyEpochs.get(operationId) !== policyEpoch ||
        !states.has(afterRevision) ||
        states.get(afterRevision) !== personId
      )
        return fail();
    },
  });
};
