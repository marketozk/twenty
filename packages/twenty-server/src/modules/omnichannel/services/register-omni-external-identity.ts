import { randomUUID } from 'node:crypto';

import { type DataSource, type QueryRunner } from 'typeorm';
import { z } from 'zod';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  appendCrmAuditAttempt,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { omniBindingConfigurationPrincipalSchema } from 'src/modules/omnichannel/contracts/omni-binding-configuration';
import { withOmniNativeOwnershipTransaction } from 'src/modules/omnichannel/services/omni-core-transaction';
import { assertOmniWorkspaceAcceptsBootstrap } from 'src/modules/omnichannel/services/omni-workspace-deletion';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value)
    .refine((value) => !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value));
const counter = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$(?![\s\S])/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const commandSchema = z
  .strictObject({
    bindingId: uuid,
    routeGeneration: counter,
    providerPeerId: text(512),
    verificationSource: text(256),
    expectedRevision: z.literal('0'),
    idempotencyKey: text(256),
  })
  .readonly();
const descriptorSchema = z
  .strictObject({
    resourceKind: z.literal('omniExternalIdentity'),
    resourceId: uuid,
    bindingId: uuid,
  })
  .readonly();
const resultSchema = z
  .strictObject({
    externalIdentityId: uuid,
    revision: z.literal('1'),
    personId: z.null(),
  })
  .readonly();
const identitySchema = z.object({
  id: uuid,
  bindingId: uuid,
  providerPeerId: text(512),
  verificationSource: text(256),
  personId: uuid.nullable(),
  revision: counter,
});
const receiptSchema = z.object({
  operationId: uuid,
  action: z.string(),
  payloadHash: z.string(),
  resourceDescriptor: z.unknown(),
  resultPublic: z.unknown(),
});
type Principal = z.infer<typeof omniBindingConfigurationPrincipalSchema>;
export type OmniIdentityRegistrationCommand = z.infer<typeof commandSchema>;
export type OmniIdentityRegistrationAuthorizer = (
  runner: QueryRunner,
  facts: Readonly<
    Principal & {
      action: 'identity.register';
      command: OmniIdentityRegistrationCommand;
      resourceDescriptor: z.infer<typeof descriptorSchema>;
      currentIdentity: Readonly<z.infer<typeof identitySchema>> | null;
      replay: boolean;
    }
  >,
) => Promise<void>;

const fail = (code: string): never => {
  throw new Error(`OMNI_IDENTITY_REGISTRATION_${code}`);
};
const one = <TSchema extends z.ZodType>(schema: TSchema, rows: unknown[]) => {
  if (rows.length !== 1) return fail('MISSING_OR_AMBIGUOUS_RESOURCE');
  return schema.parse(rows[0]);
};

const verifyRegistrationAudit = async (
  runner: QueryRunner,
  principal: Principal,
  operationId: string,
  descriptor: z.infer<typeof descriptorSchema>,
  state: { id: string; epoch: string },
) => {
  const entries = z
    .array(
      z.object({
        actor: z.unknown(),
        resourceKind: z.string(),
        resourceId: uuid,
        action: z.string(),
        securityDescriptor: z.unknown(),
        redactedDiff: z.object({
          changedFields: z.array(z.string()),
          values: z.record(
            z.string(),
            z.object({ before: z.unknown(), after: z.unknown() }),
          ),
        }),
      }),
    )
    .parse(
      await runner.query(
        `SELECT actor,"resourceKind","resourceId",action,"securityDescriptor","redactedDiff" FROM crm_audit."crmAuditEntry"
     WHERE "workspaceId"=$1 AND "operationId"=$2 AND outcome='success'`,
        [principal.workspaceId, operationId],
      ),
    );
  const identity = entries.find(
    (entry) =>
      entry.resourceKind === 'omniExternalIdentity' &&
      entry.resourceId === descriptor.resourceId &&
      entry.action === 'create',
  );
  const policy = entries.find(
    (entry) =>
      entry.resourceKind === 'omniWorkspacePolicyState' &&
      entry.resourceId === state.id &&
      entry.action === 'update',
  );
  if (
    entries.length !== 2 ||
    !identity ||
    !policy ||
    entries.some(
      (entry) =>
        auditPayloadHash(entry.actor) !== auditPayloadHash(principal.actor),
    ) ||
    auditPayloadHash(identity.securityDescriptor) !==
      auditPayloadHash(descriptor) ||
    auditPayloadHash(policy.securityDescriptor) !==
      auditPayloadHash({
        resourceKind: 'omniWorkspacePolicyState',
        resourceId: state.id,
      }) ||
    auditPayloadHash(identity.redactedDiff) !==
      auditPayloadHash({
        changedFields: [
          'bindingId',
          'personId',
          'providerPeerId',
          'revision',
          'verificationSource',
        ],
        values: {
          bindingId: { before: null, after: descriptor.bindingId },
          personId: { before: null, after: null },
          revision: { before: null, after: '1' },
        },
      }) ||
    auditPayloadHash(policy.redactedDiff.changedFields) !==
      auditPayloadHash(['epoch']) ||
    Object.keys(policy.redactedDiff.values).length !== 1
  )
    return fail('RETAINED_AUDIT_INTEGRITY');
  const before = counter.parse(policy.redactedDiff.values.epoch?.before);
  const after = counter.parse(policy.redactedDiff.values.epoch?.after);
  if (
    BigInt(after) !== BigInt(before) + 1n ||
    BigInt(after) > BigInt(state.epoch)
  )
    return fail('RETAINED_AUDIT_INTEGRITY');
};

// Peer qualification and current grants are supplied by the trusted server caller.
// This is not an ingress endpoint and never infers a Person from profile data.
export const registerOmniExternalIdentity = async (
  dataSource: DataSource,
  inputPrincipal: Principal,
  inputCommand: OmniIdentityRegistrationCommand,
  inputAuthorize: OmniIdentityRegistrationAuthorizer,
) => {
  if (typeof inputAuthorize !== 'function') return fail('AUTHORIZER_REQUIRED');
  const principal =
    omniBindingConfigurationPrincipalSchema.parse(inputPrincipal);
  const command = commandSchema.parse(inputCommand);
  const authorize = inputAuthorize;
  const { workspaceId, actor } = principal;
  const { idempotencyKey, ...payload } = command;
  const action = 'identity.register' as const;
  const payloadHash = auditPayloadHash({ workspaceId, action, ...payload });
  const allocatedIdentityId = randomUUID();
  let operationId: string = randomUUID();
  let failureResourceId: string = allocatedIdentityId;
  let callbackFailure: unknown;
  let callbackFailed = false;
  let auditEligible = false;
  let denied = false;
  try {
    return await withOmniNativeOwnershipTransaction(
      dataSource,
      workspaceId,
      'exclusive',
      async (runner) => {
        try {
          await assertOmniWorkspaceAcceptsBootstrap(runner, workspaceId);
          const state = one(
            z.object({ id: uuid, epoch: counter }),
            await runner.query(
              'SELECT id,epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE',
              [workspaceId],
            ),
          );
          const receipts = z.array(receiptSchema).parse(
            await runner.query(
              `SELECT "operationId",action,"payloadHash","resourceDescriptor","resultPublic" FROM core."omniPolicyMutationReceipt"
           WHERE "workspaceId"=$1 AND "actorKind"=$2 AND "actorId"=$3 AND "idempotencyKey"=$4 FOR UPDATE`,
              [workspaceId, actor.kind, actor.id, idempotencyKey],
            ),
          );
          if (receipts.length > 1) return fail('AMBIGUOUS_RECEIPT');
          const receipt = receipts[0];
          const binding = one(
            z.object({
              id: uuid,
              routeGeneration: counter,
              status: z.enum(['active', 'inactive']),
            }),
            await runner.query(
              'SELECT id,"routeGeneration",status FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR SHARE',
              [workspaceId, command.bindingId],
            ),
          );
          const identities = z.array(identitySchema).parse(
            await runner.query(
              `SELECT id,"bindingId","providerPeerId","verificationSource","personId",revision FROM core."omniExternalIdentity"
           WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "providerPeerId"=$3 FOR UPDATE`,
              [workspaceId, binding.id, command.providerPeerId],
            ),
          );
          if (identities.length > 1) return fail('AMBIGUOUS_IDENTITY');
          const currentIdentity = identities[0]
            ? Object.freeze(identities[0])
            : null;
          const matchingReceipt =
            receipt?.action === action && receipt.payloadHash === payloadHash;
          const descriptor = matchingReceipt
            ? descriptorSchema.parse(receipt.resourceDescriptor)
            : descriptorSchema.parse({
                resourceKind: 'omniExternalIdentity',
                resourceId: currentIdentity?.id ?? allocatedIdentityId,
                bindingId: binding.id,
              });
          if (descriptor.bindingId !== binding.id)
            return fail('RECEIPT_SCOPE_MISMATCH');
          failureResourceId = descriptor.resourceId;
          if (matchingReceipt) operationId = receipt.operationId;
          auditEligible = true;
          try {
            await authorize(
              runner,
              Object.freeze({
                ...principal,
                action,
                command,
                resourceDescriptor: descriptor,
                currentIdentity,
                replay: Boolean(receipt),
              }),
            );
          } catch (error) {
            denied = true;
            throw error;
          }
          if (receipt) {
            if (!matchingReceipt) return fail('IDEMPOTENCY_CONFLICT');
            if (receipt.resultPublic === null) return fail('RESULT_EXPIRED');
            const result = resultSchema.parse(receipt.resultPublic);
            if (
              result.externalIdentityId !== descriptor.resourceId ||
              currentIdentity?.id !== result.externalIdentityId
            )
              return fail('RECEIPT_IDENTITY_MISMATCH');
            await verifyRegistrationAudit(
              runner,
              principal,
              operationId,
              descriptor,
              state,
            );
            return { ...result, operationId, replayed: true };
          }
          if (binding.routeGeneration !== command.routeGeneration)
            return fail('STALE_ROUTE_GENERATION');
          if (currentIdentity) return fail('ALREADY_REGISTERED');
          if (BigInt(state.epoch) >= 9223372036854775807n)
            return fail('COUNTER_EXHAUSTED');
          const identity = one(
            identitySchema,
            await runner.query(
              `INSERT INTO core."omniExternalIdentity" (id,"workspaceId","bindingId","providerPeerId","verificationSource","personId",revision)
           VALUES ($1,$2,$3,$4,$5,NULL,1) RETURNING id,"bindingId","providerPeerId","verificationSource","personId",revision`,
              [
                allocatedIdentityId,
                workspaceId,
                binding.id,
                command.providerPeerId,
                command.verificationSource,
              ],
            ),
          );
          const expectedIdentity = {
            id: allocatedIdentityId,
            bindingId: binding.id,
            providerPeerId: command.providerPeerId,
            verificationSource: command.verificationSource,
            personId: null,
            revision: '1',
          };
          if (auditPayloadHash(identity) !== auditPayloadHash(expectedIdentity))
            return fail('INSERT_INTEGRITY');
          const epoch = (BigInt(state.epoch) + 1n).toString();
          const updatedState = one(
            z.object({ epoch: counter }),
            await runner.query(
              `WITH updated AS (UPDATE core."omniWorkspacePolicyState" SET epoch=epoch+1,"updatedAt"=clock_timestamp()
           WHERE "workspaceId"=$1 AND epoch=$2 RETURNING epoch) SELECT epoch FROM updated`,
              [workspaceId, state.epoch],
            ),
          );
          if (updatedState.epoch !== epoch) return fail('EPOCH_INTEGRITY');
          const audit = new CrmAuditTransactionContext(runner, {
            ...principal,
            operationId,
          });
          audit.record({
            resourceKind: 'omniExternalIdentity',
            resourceId: identity.id,
            action: 'create',
            before: null,
            after: identity,
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
          const result = resultSchema.parse({
            externalIdentityId: identity.id,
            personId: null,
            revision: '1',
          });
          await runner.query(
            `INSERT INTO core."omniPolicyMutationReceipt" ("workspaceId","actorKind","actorId","idempotencyKey","operationId",action,"resourceDescriptor","payloadHash","resultPublic","committedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,clock_timestamp())`,
            [
              workspaceId,
              actor.kind,
              actor.id,
              idempotencyKey,
              operationId,
              action,
              JSON.stringify(descriptor),
              payloadHash,
              JSON.stringify(result),
            ],
          );
          const persistedIdentity = one(
            identitySchema,
            await runner.query(
              'SELECT id,"bindingId","providerPeerId","verificationSource","personId",revision FROM core."omniExternalIdentity" WHERE "workspaceId"=$1 AND id=$2',
              [workspaceId, identity.id],
            ),
          );
          const persistedReceipt = one(
            receiptSchema,
            await runner.query(
              `SELECT "operationId",action,"payloadHash","resourceDescriptor","resultPublic" FROM core."omniPolicyMutationReceipt"
           WHERE "workspaceId"=$1 AND "actorKind"=$2 AND "actorId"=$3 AND "idempotencyKey"=$4`,
              [workspaceId, actor.kind, actor.id, idempotencyKey],
            ),
          );
          const persistedState = one(
            z.object({ epoch: counter }),
            await runner.query(
              'SELECT epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1',
              [workspaceId],
            ),
          );
          if (
            auditPayloadHash(persistedIdentity) !==
              auditPayloadHash(expectedIdentity) ||
            persistedState.epoch !== epoch ||
            auditPayloadHash(persistedReceipt) !==
              auditPayloadHash({
                operationId,
                action,
                payloadHash,
                resourceDescriptor: descriptor,
                resultPublic: result,
              })
          )
            return fail('FINAL_INTEGRITY');
          await verifyRegistrationAudit(
            runner,
            principal,
            operationId,
            descriptor,
            { id: state.id, epoch },
          );
          return { ...result, operationId, replayed: false };
        } catch (error) {
          callbackFailed = true;
          callbackFailure = error;
          throw error;
        }
      },
    );
  } catch (error) {
    // The owner preserves the callback error only after confirmed rollback/release.
    // Unknown commit or cleanup must not be recorded as a failed business operation.
    if (auditEligible && callbackFailed && error === callbackFailure) {
      try {
        await withOmniNativeOwnershipTransaction(
          dataSource,
          workspaceId,
          'shared',
          async (runner) => {
            await appendCrmAuditAttempt(
              runner,
              { ...principal, operationId },
              {
                attemptId: randomUUID(),
                resourceKind: 'omniExternalIdentity',
                resourceId: failureResourceId,
                action: 'create',
                outcome: denied ? 'denied' : 'failed',
                reasonCode: denied
                  ? 'identity.registration.denied'
                  : 'identity.registration.failed',
                securityDescriptor: {
                  resourceKind: 'omniExternalIdentity',
                  resourceId: failureResourceId,
                  bindingId: command.bindingId,
                },
              },
            );
          },
        );
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          'OMNI_IDENTITY_REGISTRATION_FAILURE_AUDIT_FAILED',
        );
      }
    }
    throw error;
  }
};
