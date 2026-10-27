import { randomUUID } from 'node:crypto';

import { type DataSource, type QueryRunner } from 'typeorm';
import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';

import { auditPayloadHash } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { omniBindingConfigChangedEventSchema } from 'src/engine/core-modules/omnichannel-storage/contracts/omni-binding-config-changed';
import {
  appendCrmAuditAttempt,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import {
  omniBindingConfigurationCommandSchema,
  omniBindingConfigurationPrincipalSchema,
  omniBindingConfigurationResourceSchema,
  omniBindingConfigurationResultSchema,
  type OmniBindingConfigurationCommand,
  type OmniBindingConfigurationPrincipal,
  type OmniBindingConfigurationResource,
  type OmniBindingConfigurationResult,
} from 'src/modules/omnichannel/contracts/omni-binding-configuration';

export type {
  OmniBindingConfigurationCommand,
  OmniBindingConfigurationPrincipal,
  OmniBindingConfigurationResource,
  OmniBindingConfigurationResult,
} from 'src/modules/omnichannel/contracts/omni-binding-configuration';

export type OmniBindingConfigurationAuthorizer = (
  queryRunner: QueryRunner,
  authorization: Readonly<
    OmniBindingConfigurationPrincipal & {
      action: OmniBindingConfigurationCommand['action'];
      command: OmniBindingConfigurationCommand;
      resourceDescriptor: OmniBindingConfigurationResource;
      activatingQueue: boolean;
      replay: boolean;
    }
  >,
) => Promise<void>;

export class OmniBindingConfigurationOutcomeUnknownError extends Error {
  constructor(
    readonly operationId: string,
    readonly phase: 'commit' | 'rollback' | 'release',
    cause: unknown,
  ) {
    super(
      `OMNI_BINDING_CONFIGURATION_OUTCOME_UNKNOWN: ${phase}; retry the same idempotency key`,
      { cause },
    );
    this.name = 'OmniBindingConfigurationOutcomeUnknownError';
  }
}

export const snapshotOmniBindingConfigurationRequest = (
  principal: OmniBindingConfigurationPrincipal,
  command: OmniBindingConfigurationCommand,
  authorize: OmniBindingConfigurationAuthorizer,
) => {
  if (typeof authorize !== 'function')
    throw new Error('OMNI_BINDING_CONFIGURATION_AUTHORIZER_REQUIRED');
  return Object.freeze({
    principal: omniBindingConfigurationPrincipalSchema.parse(principal),
    command: omniBindingConfigurationCommandSchema.parse(command),
    authorize,
  });
};

const uuid = z.uuid().transform((value) => value.toLowerCase());
const counter = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const fail = (code: string): never => {
  throw new Error(`OMNI_BINDING_CONFIGURATION_${code}`);
};
const one = <T extends z.ZodType>(schema: T, rows: unknown[]): z.infer<T> => {
  if (rows.length !== 1) return fail('MISSING_OR_AMBIGUOUS_RESOURCE');
  return schema.parse(rows[0]);
};
const nextCounter = (value: string) => {
  if (BigInt(value) >= 9223372036854775807n) return fail('COUNTER_EXHAUSTED');
  return (BigInt(value) + 1n).toString();
};
const bindingSchema = z.object({
  id: uuid,
  revision: counter,
  status: z.string(),
  defaultQueueId: uuid.nullable(),
  defaultConversationMode: z.string(),
});
const queueSchema = z.object({
  id: uuid,
  bindingId: uuid,
  revision: counter,
  name: z.string(),
  active: z.boolean(),
});
const stateSchema = z.object({ id: uuid, epoch: counter });
const receiptSchema = z.object({
  operationId: uuid,
  action: z.string(),
  payloadHash: z.string(),
  resourceDescriptor: z.unknown(),
  resultPublic: z.unknown(),
});

const appendFailure = async (
  dataSource: DataSource,
  principal: OmniBindingConfigurationPrincipal,
  bindingId: string,
  operationId: string,
  denied: boolean,
) => {
  const runner = dataSource.createQueryRunner('master');
  let failure: unknown;
  let failed = false;
  let commitAttempted = false;
  try {
    await runner.connect();
    await runner.startTransaction();
    const rows = await runner.query(
      `SELECT binding.id FROM core."omniAccountBinding" binding
       JOIN core."omniWorkspacePolicyState" policy ON policy."workspaceId"=binding."workspaceId"
       WHERE binding."workspaceId"=$1 AND binding.id=$2`,
      [principal.workspaceId, bindingId],
    );
    if (rows.length > 1) return fail('AMBIGUOUS_FAILURE_RESOURCE');
    if (rows.length === 1)
      await appendCrmAuditAttempt(
        runner,
        {
          workspaceId: principal.workspaceId,
          actor: principal.actor,
          operationId,
        },
        {
          attemptId: randomUUID(),
          resourceKind: 'omniAccountBinding',
          resourceId: bindingId,
          action: 'update',
          outcome: denied ? 'denied' : 'failed',
          reasonCode: denied
            ? 'binding.configuration.denied'
            : 'binding.configuration.failed',
          securityDescriptor: {
            resourceKind: 'omniAccountBinding',
            resourceId: bindingId,
            bindingId,
          },
        },
      );
    commitAttempted = true;
    await runner.commitTransaction();
  } catch (error) {
    failed = true;
    failure = error;
    if (runner.isTransactionActive) {
      try {
        await runner.rollbackTransaction();
      } catch (rollbackError) {
        failure = new AggregateError(
          [failure, rollbackError],
          'OMNI_BINDING_CONFIGURATION_FAILURE_AUDIT_ROLLBACK_UNCONFIRMED',
        );
        try {
          await runner.query('ROLLBACK');
        } catch (cleanupError) {
          failure = new AggregateError(
            [failure, cleanupError],
            'OMNI_BINDING_CONFIGURATION_FAILURE_AUDIT_ROLLBACK_UNCONFIRMED',
          );
        }
      }
    }
    if (commitAttempted)
      failure = new OmniBindingConfigurationOutcomeUnknownError(
        operationId,
        'commit',
        failure,
      );
  } finally {
    if (!runner.isReleased) {
      try {
        await runner.release();
      } catch (releaseError) {
        failure = failed
          ? new AggregateError([failure, releaseError])
          : releaseError;
        failed = true;
      }
    }
  }
  if (failed) throw failure;
};

// Internal policy writer; there is no controller, scheduler or default authorization.
export const mutateOmniBindingConfiguration = async (
  dataSource: DataSource,
  inputPrincipal: OmniBindingConfigurationPrincipal,
  inputCommand: OmniBindingConfigurationCommand,
  inputAuthorize: OmniBindingConfigurationAuthorizer,
): Promise<OmniBindingConfigurationResult> => {
  const { principal, command, authorize } =
    snapshotOmniBindingConfigurationRequest(
      inputPrincipal,
      inputCommand,
      inputAuthorize,
    );
  const { idempotencyKey, ...payload } = command;
  const payloadHash = auditPayloadHash({
    workspaceId: principal.workspaceId,
    ...payload,
  });
  const workspaceId = principal.workspaceId;
  let operationId: string = randomUUID();
  const allocatedQueueId = randomUUID();
  const runner = dataSource.createQueryRunner('master');
  let started = false;
  let commitAttempted = false;
  let rollbackConfirmed = false;
  let authorizationDenied = false;
  let failure: unknown;
  let failed = false;
  let unknownPhase: 'commit' | 'rollback' | 'release' | undefined;
  let result: OmniBindingConfigurationResult | undefined;

  try {
    await runner.connect();
    await runner.startTransaction();
    started = true;
    const state = one(
      stateSchema,
      await runner.query(
        'SELECT id,epoch FROM core."omniWorkspacePolicyState" WHERE "workspaceId"=$1 FOR UPDATE',
        [workspaceId],
      ),
    );
    const receipts = z.array(receiptSchema).parse(
      await runner.query(
        `SELECT "operationId",action,"payloadHash","resourceDescriptor","resultPublic" FROM core."omniPolicyMutationReceipt"
       WHERE "workspaceId"=$1 AND "actorKind"=$2 AND "actorId"=$3 AND "idempotencyKey"=$4 FOR UPDATE`,
        [workspaceId, principal.actor.kind, principal.actor.id, idempotencyKey],
      ),
    );
    if (receipts.length > 1) return fail('AMBIGUOUS_RECEIPT');
    const receipt = receipts[0];
    if (
      receipt &&
      receipt.action === command.action &&
      receipt.payloadHash === payloadHash
    )
      operationId = receipt.operationId;
    const binding = one(
      bindingSchema,
      await runner.query(
        'SELECT id,revision,status,"defaultQueueId","defaultConversationMode" FROM core."omniAccountBinding" WHERE "workspaceId"=$1 AND id=$2 FOR UPDATE',
        [workspaceId, command.bindingId],
      ),
    );
    const retainedResource = receipt
      ? omniBindingConfigurationResourceSchema.safeParse(
          receipt.resourceDescriptor,
        )
      : undefined;
    const replayQueueId =
      command.action === 'queue.create' &&
      receipt?.action === command.action &&
      receipt.payloadHash === payloadHash &&
      retainedResource?.success &&
      retainedResource.data.bindingId === binding.id &&
      retainedResource.data.resourceKind === 'omniQueue'
        ? retainedResource.data.resourceId
        : allocatedQueueId;
    const requestedResource = omniBindingConfigurationResourceSchema.parse({
      resourceKind:
        command.action === 'binding.defaults.update'
          ? 'omniAccountBinding'
          : 'omniQueue',
      resourceId:
        command.action === 'queue.create'
          ? replayQueueId
          : command.action === 'queue.update'
            ? command.queueId
            : binding.id,
      bindingId: binding.id,
    });
    const authorizeResource = async (
      resourceDescriptor: OmniBindingConfigurationResource,
      replay: boolean,
    ) => {
      try {
        await authorize(
          runner,
          Object.freeze({
            ...principal,
            action: command.action,
            command,
            resourceDescriptor,
            activatingQueue:
              command.action === 'queue.update' && command.active === true,
            replay,
          }),
        );
      } catch (error) {
        authorizationDenied = true;
        throw error;
      }
    };
    // Authorize the requested scope before disclosing retained-key conflicts or results.
    await authorizeResource(requestedResource, receipt !== undefined);

    if (receipt) {
      if (
        receipt.action !== command.action ||
        receipt.payloadHash !== payloadHash
      )
        return fail('IDEMPOTENCY_CONFLICT');
      const retained = omniBindingConfigurationResourceSchema.parse(
        receipt.resourceDescriptor,
      );
      if (
        retained.bindingId !== binding.id ||
        retained.resourceKind !== requestedResource.resourceKind ||
        (command.action !== 'queue.create' &&
          retained.resourceId !== requestedResource.resourceId)
      )
        return fail('RECEIPT_INTEGRITY');
      await authorizeResource(retained, true);
      operationId = receipt.operationId;
      if (receipt.resultPublic === null) return fail('RESULT_EXPIRED');
      result = omniBindingConfigurationResultSchema.parse(receipt.resultPublic);
      if (
        result.operationId !== receipt.operationId ||
        result.bindingId !== retained.bindingId ||
        result.resourceKind !== retained.resourceKind ||
        result.resourceId !== retained.resourceId
      )
        return fail('RECEIPT_INTEGRITY');
      if (
        (result.changed &&
          result.eventId !==
            uuidV5('omni:binding.config_changed:v1', receipt.operationId)) ||
        (command.action === 'queue.create' &&
          (!result.changed || result.revision !== '1'))
      )
        return fail('RECEIPT_INTEGRITY');
    } else {
      const audit = new CrmAuditTransactionContext(runner, {
        workspaceId,
        operationId,
        actor: principal.actor,
      });
      let changed = false;
      let resourceRevision = binding.revision;
      let bindingRevision = binding.revision;
      if (command.action === 'queue.create') {
        const created = one(
          queueSchema,
          await runner.query(
            `INSERT INTO core."omniQueue" (id,"workspaceId","bindingId",name,active) VALUES ($1,$2,$3,$4,false)
           RETURNING id,"bindingId",revision,name,active`,
            [allocatedQueueId, workspaceId, binding.id, command.name],
          ),
        );
        if (
          created.id !== allocatedQueueId ||
          created.bindingId !== binding.id ||
          created.revision !== '1' ||
          created.active ||
          created.name !== command.name
        )
          return fail('QUEUE_CREATE_POSTCONDITION');
        resourceRevision = created.revision;
        changed = true;
        audit.record({
          resourceKind: 'omniQueue',
          resourceId: created.id,
          action: 'create',
          before: null,
          after: {
            bindingId: created.bindingId,
            revision: created.revision,
            name: created.name,
            active: created.active,
          },
          securityDescriptor: requestedResource,
        });
      } else if (command.action === 'queue.update') {
        const before = one(
          queueSchema,
          await runner.query(
            'SELECT id,"bindingId",revision,name,active FROM core."omniQueue" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR UPDATE',
            [workspaceId, binding.id, command.queueId],
          ),
        );
        if (before.revision !== command.expectedRevision)
          return fail('REVISION_CONFLICT');
        const active = command.active ?? before.active;
        const name = command.name ?? before.name;
        if (!active) {
          const retained = await runner.query(
            'SELECT id FROM core."omniConversation" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND "queueId"=$3 LIMIT 1',
            [workspaceId, binding.id, before.id],
          );
          if (binding.defaultQueueId === before.id || retained.length > 0)
            return fail('QUEUE_REFERENCED');
        }
        changed = active !== before.active || name !== before.name;
        resourceRevision = changed
          ? nextCounter(before.revision)
          : before.revision;
        if (changed) {
          const after = one(
            queueSchema,
            await runner.query(
              `WITH updated AS (UPDATE core."omniQueue" SET name=$4,active=$5,revision=revision+1,"updatedAt"=clock_timestamp()
             WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 AND revision=$6 RETURNING id,"bindingId",revision,name,active) SELECT * FROM updated`,
              [
                workspaceId,
                binding.id,
                before.id,
                name,
                active,
                command.expectedRevision,
              ],
            ),
          );
          if (
            after.id !== before.id ||
            after.bindingId !== binding.id ||
            after.revision !== resourceRevision ||
            after.name !== name ||
            after.active !== active
          )
            return fail('QUEUE_UPDATE_POSTCONDITION');
          audit.record({
            resourceKind: 'omniQueue',
            resourceId: before.id,
            action: 'update',
            before: {
              bindingId: before.bindingId,
              revision: before.revision,
              name: before.name,
              active: before.active,
            },
            after: {
              bindingId: after.bindingId,
              revision: after.revision,
              name: after.name,
              active: after.active,
            },
            securityDescriptor: requestedResource,
          });
        }
      } else {
        if (binding.revision !== command.expectedRevision)
          return fail('REVISION_CONFLICT');
        const queue = one(
          queueSchema,
          await runner.query(
            'SELECT id,"bindingId",revision,name,active FROM core."omniQueue" WHERE "workspaceId"=$1 AND "bindingId"=$2 AND id=$3 FOR SHARE',
            [workspaceId, binding.id, command.defaultQueueId],
          ),
        );
        if (!queue.active) return fail('DEFAULT_QUEUE_INACTIVE');
        changed =
          binding.defaultQueueId !== queue.id ||
          binding.defaultConversationMode !== 'human';
        bindingRevision = changed
          ? nextCounter(binding.revision)
          : binding.revision;
        resourceRevision = bindingRevision;
        if (changed) {
          const after = one(
            bindingSchema,
            await runner.query(
              `WITH updated AS (UPDATE core."omniAccountBinding" SET "defaultQueueId"=$3,"defaultConversationMode"='human',revision=revision+1,"updatedAt"=clock_timestamp()
             WHERE "workspaceId"=$1 AND id=$2 AND revision=$4 RETURNING id,revision,status,"defaultQueueId","defaultConversationMode") SELECT * FROM updated`,
              [workspaceId, binding.id, queue.id, command.expectedRevision],
            ),
          );
          if (
            after.id !== binding.id ||
            after.revision !== bindingRevision ||
            after.status !== binding.status ||
            after.defaultQueueId !== queue.id ||
            after.defaultConversationMode !== 'human'
          )
            return fail('BINDING_UPDATE_POSTCONDITION');
          audit.record({
            resourceKind: 'omniAccountBinding',
            resourceId: binding.id,
            action: 'update',
            before: {
              revision: binding.revision,
              defaultQueueId: binding.defaultQueueId,
              defaultConversationMode: binding.defaultConversationMode,
            },
            after: {
              revision: after.revision,
              defaultQueueId: after.defaultQueueId,
              defaultConversationMode: after.defaultConversationMode,
            },
            securityDescriptor: requestedResource,
          });
        }
      }
      let policyEpoch = state.epoch;
      let eventId: string | null = null;
      if (changed) {
        policyEpoch = nextCounter(state.epoch);
        const updatedState = one(
          stateSchema,
          await runner.query(
            'WITH updated AS (UPDATE core."omniWorkspacePolicyState" SET epoch=epoch+1,"updatedAt"=clock_timestamp() WHERE "workspaceId"=$1 AND id=$2 AND epoch=$3 RETURNING id,epoch) SELECT * FROM updated',
            [workspaceId, state.id, state.epoch],
          ),
        );
        if (updatedState.id !== state.id || updatedState.epoch !== policyEpoch)
          return fail('EPOCH_POSTCONDITION');
        audit.record({
          resourceKind: 'omniWorkspacePolicyState',
          resourceId: state.id,
          action: 'update',
          before: { epoch: state.epoch },
          after: { epoch: policyEpoch },
          securityDescriptor: {
            resourceKind: 'omniWorkspacePolicyState',
            resourceId: state.id,
          },
        });
        eventId = uuidV5('omni:binding.config_changed:v1', operationId);
        const event = omniBindingConfigChangedEventSchema.parse({
          kind: 'binding.config_changed',
          origin: 'configuration_change',
          payloadVersion: 1,
          conversationId: null,
          conversationSequence: null,
          rootExecutionId: null,
          causationId: null,
          payload: {
            bindingId: binding.id,
            bindingRevision,
            resourceKind: requestedResource.resourceKind,
            resourceId: requestedResource.resourceId,
            resourceRevision,
            policyEpoch,
          },
        });
        const insertedEvent = one(
          z.object({ id: uuid }),
          await runner.query(
            `INSERT INTO core."omniDomainEvent" (id,"workspaceId",kind,origin,"payloadVersion",payload,"conversationId","conversationSequence","rootExecutionId","causationId")
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,NULL,NULL,NULL,NULL) RETURNING id`,
            [
              eventId,
              workspaceId,
              event.kind,
              event.origin,
              event.payloadVersion,
              JSON.stringify(event.payload),
            ],
          ),
        );
        if (insertedEvent.id !== eventId) return fail('EVENT_POSTCONDITION');
        audit.record({
          resourceKind: 'omniDomainEvent',
          resourceId: eventId,
          action: 'create',
          before: null,
          after: event,
          securityDescriptor: {
            resourceKind: 'omniDomainEvent',
            resourceId: eventId,
            bindingId: binding.id,
          },
        });
      }
      result = omniBindingConfigurationResultSchema.parse({
        operationId,
        ...requestedResource,
        revision: resourceRevision,
        bindingRevision,
        policyEpoch,
        eventId,
        changed,
      });
      await audit.flush();
      await runner.query(
        `INSERT INTO core."omniPolicyMutationReceipt" ("workspaceId","actorKind","actorId","idempotencyKey","operationId",action,"resourceDescriptor","payloadHash","resultPublic","committedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,clock_timestamp())`,
        [
          workspaceId,
          principal.actor.kind,
          principal.actor.id,
          idempotencyKey,
          operationId,
          command.action,
          JSON.stringify(requestedResource),
          payloadHash,
          JSON.stringify(result),
        ],
      );
    }
    commitAttempted = true;
    await runner.commitTransaction();
  } catch (error) {
    failed = true;
    failure = error;
    if (commitAttempted) unknownPhase = 'commit';
    if (runner.isTransactionActive) {
      try {
        await runner.rollbackTransaction();
        rollbackConfirmed = true;
      } catch (rollbackError) {
        unknownPhase ??= 'rollback';
        failure = new AggregateError(
          [failure, rollbackError],
          'OMNI_BINDING_CONFIGURATION_ROLLBACK_UNCONFIRMED',
        );
        try {
          await runner.query('ROLLBACK');
        } catch (cleanupError) {
          failure = new AggregateError(
            [failure, cleanupError],
            'OMNI_BINDING_CONFIGURATION_ROLLBACK_UNCONFIRMED',
          );
        }
      }
    } else if (started && !commitAttempted) unknownPhase = 'rollback';
  } finally {
    if (!runner.isReleased) {
      try {
        await runner.release();
      } catch (releaseError) {
        failure = failed
          ? new AggregateError([failure, releaseError])
          : releaseError;
        failed = true;
        unknownPhase ??= 'release';
      }
    }
  }
  if (unknownPhase)
    throw new OmniBindingConfigurationOutcomeUnknownError(
      operationId,
      unknownPhase,
      failure,
    );
  if (failed) {
    if (rollbackConfirmed) {
      try {
        await appendFailure(
          dataSource,
          principal,
          command.bindingId,
          operationId,
          authorizationDenied,
        );
      } catch (auditError) {
        throw new AggregateError(
          [failure, auditError],
          'OMNI_BINDING_CONFIGURATION_FAILURE_AUDIT_UNCONFIRMED',
        );
      }
    }
    throw failure;
  }
  if (!result) return fail('RESULT_MISSING');
  return result;
};
