import { type CrmAuditTransactionExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';

import {
  appendCrmAuditEntry,
  type CrmAuditEntryPayload,
} from 'src/engine/core-modules/crm-audit/append-crm-audit-entry';

import {
  auditPayloadHash,
  canonicalAuditJson,
} from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  type CrmAuditMutation,
  type CrmAuditOperation,
  type CrmAuditPrincipal,
  type CrmAuditResourceKind,
  type CrmAuditSecurityDescriptor,
} from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { verifyCrmAuditPrivileges } from 'src/engine/core-modules/crm-audit/verify-crm-audit-privileges';
import {
  omniBindingConfigChangedEventSchema,
  type OmniBindingConfigChangedEvent,
} from 'src/engine/core-modules/omnichannel-storage/contracts/omni-binding-config-changed';

const CATALOG: Record<
  CrmAuditResourceKind,
  { values: string[]; redacted: string[] }
> = {
  omniAccountBinding: {
    values: [
      'platform',
      'status',
      'routeGeneration',
      'revision',
      'defaultConversationMode',
      'autoCreatePersonEnabled',
      'defaultQueueId',
      'capabilitiesVersion',
      'connectedAccountId',
      'messageChannelId',
    ],
    redacted: ['capabilities', 'accountId', 'connectorInstanceId'],
  },
  omniBindingConfigWakeup: {
    values: [
      'bindingId',
      'eventId',
      'handlerVersion',
      'state',
      'attempts',
      'leaseToken',
      'leaseUntil',
      'nextAttemptAt',
      'cursorNextAttemptAt',
      'cursorReceiptId',
      'needsRescan',
      'observedRouteGeneration',
      'errorCode',
    ],
    redacted: ['leaseOwner'],
  },
  omniAutomationPolicy: {
    values: ['bindingId', 'currentVersion', 'revision'],
    redacted: [],
  },
  omniAutomationPolicyVersion: {
    values: ['policyId', 'version', 'settingsHash'],
    redacted: ['settings', 'publishedBy', 'publishedAt'],
  },
  omniWorkspacePolicyState: {
    values: ['epoch'],
    redacted: ['restoreIncarnation'],
  },
  omniQueue: {
    values: ['bindingId', 'active', 'revision'],
    redacted: ['name'],
  },
  omniIncomingReceipt: {
    values: [
      'bindingId',
      'kind',
      'schemaVersion',
      'routeGeneration',
      'state',
      'attempts',
      'leaseToken',
      'leaseUntil',
      'nextAttemptAt',
      'errorCode',
      'resultId',
    ],
    redacted: [
      'eventId',
      'validatedEnvelope',
      'leaseOwner',
      'trustedCaptureContext',
    ],
  },
  omniMessage: {
    values: ['messageThreadId', 'isDraft'],
    redacted: ['text', 'subject', 'headerMessageId', 'receivedAt', 'deletedAt'],
  },
  omniMessageThread: {
    values: [],
    redacted: ['subject'],
  },
  omniMessageParticipant: {
    values: ['messageId', 'personId', 'workspaceMemberId', 'role'],
    redacted: ['handle', 'displayName'],
  },
  omniMessageAssociation: {
    values: ['messageId', 'messageChannelId', 'direction'],
    redacted: ['messageExternalId', 'messageThreadExternalId'],
  },
  omniMessageLink: {
    values: [
      'bindingId',
      'conversationId',
      'messageId',
      'nativeMessageKeyVersion',
      'displayTimeSource',
      'senderProvenance',
      'correlationState',
    ],
    redacted: [
      'rawNativeMessageId',
      'nativeMessageKey',
      'sourcePosition',
      'displayOccurredAt',
      'immutableAuthorSnapshot',
      'sourceAuthorId',
      'sourceDisplayName',
      'authorVerification',
    ],
  },
  omniMessageRevision: {
    values: ['messageLinkId', 'tombstone', 'origin', 'contentHash'],
    redacted: ['sourceRevisionKey', 'sourceEventId'],
  },
  omniOutgoingCommand: {
    values: [
      'conversationId',
      'actorKind',
      'senderClass',
      'contentProvenance',
      'payloadHash',
      'expectedAutomationEpoch',
      'policyId',
      'policyVersion',
      'generation',
      'createdRestoreIncarnation',
      'producerTurnId',
      'capturedTurnFence',
      'referenceId',
      'replacesCommandId',
      'outboundSequence',
      'replyToMessageLinkId',
      'state',
      'statusRevision',
      'journalSequence',
      'nextAttemptAt',
      'leaseUntil',
      'cancelRequestedAt',
      'cancelReason',
    ],
    redacted: [
      'actorId',
      'initiatingActorId',
      'idempotencyKey',
      'payload',
      'workflowCancellationRefs',
      'resolvedReplyNativeRef',
      'connectorAcceptedEvidence',
      'connectorJobId',
      'cancelEvidence',
      'leaseToken',
    ],
  },
  omniConversation: {
    values: [
      'bindingId',
      'messageThreadId',
      'queueId',
      'mode',
      'status',
      'assigneeMemberId',
      'policyId',
      'policyVersion',
      'controlEpoch',
      'automationEpoch',
      'nextOutboundSequence',
      'conversationSequence',
      'replyRevision',
    ],
    redacted: ['providerChatId'],
  },
  omniDomainEvent: {
    values: [
      'conversationId',
      'conversationSequence',
      'kind',
      'origin',
      'rootExecutionId',
      'payloadVersion',
    ],
    redacted: ['payload'],
  },
  omniRootExecution: {
    values: [
      'rootKind',
      'rootId',
      'policyId',
      'policyVersion',
      'origin',
      'state',
      'maxCrmEffects',
      'maxHops',
      'usedCrmEffects',
      'usedHops',
    ],
    redacted: ['sourceKey', 'initialEventIds', 'scope', 'coveredRoots'],
  },
  omniEventDispatchPlan: {
    values: [
      'eventId',
      'rootKind',
      'rootId',
      'policyId',
      'policyVersion',
      'activationVersion',
      'initialPlan',
      'state',
      'payloadHash',
    ],
    redacted: ['targets'],
  },
};

type CapturedValue = { hash: string; value?: unknown };
type Snapshot = Record<string, CapturedValue>;
type CapturedMutation = Omit<CrmAuditMutation, 'before' | 'after'> & {
  before: Snapshot;
  after: Snapshot;
};

const requireIdentifier = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error('Audit identifier is invalid');
  }

  return value;
};

const requireUuid = (value: string): string => {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw new Error('Audit UUID is invalid');
  }

  return value.toLowerCase();
};

const principal = (value: CrmAuditPrincipal): CrmAuditPrincipal => {
  if (
    !['workspaceMember', 'system', 'agent', 'workflow', 'application'].includes(
      value.kind,
    )
  ) {
    throw new Error('Audit principal kind is invalid');
  }

  return { kind: value.kind, id: requireIdentifier(value.id) };
};

const descriptor = (
  mutation: Pick<
    CrmAuditMutation,
    'resourceKind' | 'resourceId' | 'securityDescriptor'
  >,
  bindingConfigEvent?: OmniBindingConfigChangedEvent,
): CrmAuditSecurityDescriptor => {
  const source = mutation.securityDescriptor;

  if (
    mutation.resourceKind === 'omniBindingConfigWakeup' &&
    (source.bindingId === undefined ||
      source.conversationId !== undefined ||
      source.queueId !== undefined)
  ) {
    throw new Error('Binding config wakeup audit requires binding-only scope');
  }

  if (
    bindingConfigEvent &&
    (mutation.resourceKind !== 'omniDomainEvent' ||
      source.bindingId === undefined ||
      requireUuid(source.bindingId) !== bindingConfigEvent.payload.bindingId ||
      source.conversationId !== undefined ||
      source.queueId !== undefined)
  ) {
    throw new Error(
      'Binding configuration audit requires its exact binding scope',
    );
  }

  if (
    !bindingConfigEvent &&
    [
      'omniMessage',
      'omniMessageThread',
      'omniMessageParticipant',
      'omniMessageAssociation',
      'omniMessageLink',
      'omniMessageRevision',
      'omniOutgoingCommand',
      'omniConversation',
      'omniDomainEvent',
      'omniRootExecution',
      'omniEventDispatchPlan',
    ].includes(mutation.resourceKind) &&
    (source.bindingId === undefined || source.conversationId === undefined)
  ) {
    throw new Error('Message audit requires binding and conversation scope');
  }

  if (
    source.resourceKind !== mutation.resourceKind ||
    requireUuid(source.resourceId) !== requireUuid(mutation.resourceId)
  ) {
    throw new Error('Audit security descriptor does not match its resource');
  }

  return {
    resourceKind: mutation.resourceKind,
    resourceId: requireUuid(mutation.resourceId),
    ...(source.bindingId === undefined
      ? {}
      : { bindingId: requireUuid(source.bindingId) }),
    ...(source.conversationId === undefined
      ? {}
      : { conversationId: requireUuid(source.conversationId) }),
    ...(source.queueId === undefined
      ? {}
      : { queueId: requireUuid(source.queueId) }),
  };
};

const capture = (
  resourceKind: CrmAuditResourceKind,
  input: Record<string, unknown> | null,
): Snapshot => {
  const catalog = CATALOG[resourceKind];

  if (!Object.hasOwn(CATALOG, resourceKind)) {
    throw new Error('Audit resource is not in the catalog');
  }

  const output: Snapshot = {};

  for (const field of [...catalog.values, ...catalog.redacted]) {
    if (input === null || !Object.hasOwn(input, field)) continue;
    const value = input[field];

    if (catalog.values.includes(field)) {
      if (
        value !== null &&
        !['string', 'boolean', 'number'].includes(typeof value)
      ) {
        throw new Error('Audit catalog value must be a JSON scalar');
      }
      output[field] = { hash: auditPayloadHash(value), value };
    } else {
      output[field] = { hash: auditPayloadHash(value) };
    }
  }

  return output;
};

const redactedDiff = (mutation: CapturedMutation) => {
  const changedFields = [
    ...new Set([
      ...Object.keys(mutation.before),
      ...Object.keys(mutation.after),
    ]),
  ]
    .filter(
      (field) => mutation.before[field]?.hash !== mutation.after[field]?.hash,
    )
    .sort();
  const values: Record<string, { before: unknown; after: unknown }> = {};

  for (const field of changedFields) {
    if (CATALOG[mutation.resourceKind].values.includes(field)) {
      values[field] = {
        before: mutation.before[field]?.value ?? null,
        after: mutation.after[field]?.value ?? null,
      };
    }
  }

  return { changedFields, values };
};

export class CrmAuditTransactionContext {
  private readonly mutations = new Map<string, CapturedMutation>();
  private readonly operation: CrmAuditOperation;
  private flushed = false;

  constructor(
    private readonly queryRunner: CrmAuditTransactionExecutor,
    operation: CrmAuditOperation,
  ) {
    this.operation = {
      workspaceId: requireUuid(operation.workspaceId),
      operationId: requireUuid(operation.operationId),
      actor: principal(operation.actor),
      ...(operation.initiator
        ? { initiator: principal(operation.initiator) }
        : {}),
      ...(operation.correlationId
        ? { correlationId: requireIdentifier(operation.correlationId) }
        : {}),
      ...(operation.causationId
        ? { causationId: requireIdentifier(operation.causationId) }
        : {}),
    };
    if (
      queryRunner.workspaceId !== undefined &&
      requireUuid(queryRunner.workspaceId) !== this.operation.workspaceId
    ) {
      throw new Error('Audit workspace does not match its transaction');
    }
    this.assertOpen();
  }

  private assertOpen(): void {
    if (
      this.flushed ||
      !this.queryRunner.isTransactionActive ||
      this.queryRunner.isReleased
    ) {
      throw new Error('Audit context must be open inside its transaction');
    }
  }

  record(mutation: CrmAuditMutation): void {
    this.assertOpen();
    if (!['create', 'update', 'delete'].includes(mutation.action)) {
      throw new Error('Audit action must be normalized create/update/delete');
    }
    let bindingConfigEvent: OmniBindingConfigChangedEvent | undefined;
    if (
      mutation.resourceKind === 'omniDomainEvent' &&
      (mutation.after?.kind === 'binding.config_changed' ||
        mutation.before?.kind === 'binding.config_changed')
    ) {
      if (mutation.action !== 'create' || mutation.before !== null) {
        throw new Error(
          'Binding configuration events require an immutable create audit',
        );
      }
      bindingConfigEvent = omniBindingConfigChangedEventSchema.parse(
        mutation.after,
      );
    }
    const securityDescriptor = descriptor(mutation, bindingConfigEvent);
    const before = capture(mutation.resourceKind, mutation.before);
    const after = capture(
      mutation.resourceKind,
      bindingConfigEvent ?? mutation.after,
    );
    const key = canonicalAuditJson([
      mutation.resourceKind,
      securityDescriptor.resourceId,
      mutation.action,
    ]);
    const previous = this.mutations.get(key);

    if (
      previous &&
      canonicalAuditJson(previous.securityDescriptor) !==
        canonicalAuditJson(securityDescriptor)
    ) {
      throw new Error('Audit resource scope changed inside one operation');
    }

    this.mutations.set(key, {
      ...mutation,
      resourceId: securityDescriptor.resourceId,
      before: previous?.before ?? before,
      after,
      securityDescriptor,
    });
  }

  async flush(): Promise<void> {
    this.assertOpen();
    this.flushed = true;
    await verifyCrmAuditPrivileges(this.queryRunner);

    for (const mutation of this.mutations.values()) {
      const eventKey = auditPayloadHash([
        this.operation.workspaceId,
        this.operation.operationId,
        mutation.resourceKind,
        mutation.resourceId,
        mutation.action,
      ]);
      const payload: CrmAuditEntryPayload = {
        schemaVersion: 1,
        ...this.operation,
        initiator: this.operation.initiator ?? null,
        correlationId: this.operation.correlationId ?? null,
        causationId: this.operation.causationId ?? null,
        eventKey,
        attemptId: null,
        action: mutation.action,
        resourceKind: mutation.resourceKind,
        resourceId: mutation.resourceId,
        outcome: 'success',
        reasonCode: null,
        redactedDiff: redactedDiff(mutation),
        securityDescriptor: mutation.securityDescriptor,
      };
      await appendCrmAuditEntry(this.queryRunner, payload);
    }
  }
}

export const appendCrmAuditAttempt = async (
  queryRunner: CrmAuditTransactionExecutor,
  operation: CrmAuditOperation,
  attempt: Pick<
    CrmAuditMutation,
    'resourceKind' | 'resourceId' | 'action' | 'securityDescriptor'
  > & {
    attemptId: string;
    outcome: 'denied' | 'failed';
    reasonCode: string;
  },
): Promise<void> => {
  await verifyCrmAuditPrivileges(queryRunner);
  capture(attempt.resourceKind, null);
  if (
    !['create', 'update', 'delete'].includes(attempt.action) ||
    !['denied', 'failed'].includes(attempt.outcome) ||
    !/^[a-z0-9_.:-]{1,128}$/.test(attempt.reasonCode)
  ) {
    throw new Error('Audit attempt metadata is invalid');
  }
  const workspaceId = requireUuid(operation.workspaceId);
  if (
    queryRunner.workspaceId !== undefined &&
    requireUuid(queryRunner.workspaceId) !== workspaceId
  ) {
    throw new Error('Audit workspace does not match its transaction');
  }
  const operationId = requireUuid(operation.operationId);
  const attemptId = requireUuid(attempt.attemptId);
  const securityDescriptor = descriptor(attempt);

  await appendCrmAuditEntry(queryRunner, {
    schemaVersion: 1,
    workspaceId,
    operationId,
    actor: principal(operation.actor),
    initiator: operation.initiator ? principal(operation.initiator) : null,
    correlationId: operation.correlationId
      ? requireIdentifier(operation.correlationId)
      : null,
    causationId: operation.causationId
      ? requireIdentifier(operation.causationId)
      : null,
    eventKey: auditPayloadHash([
      workspaceId,
      operationId,
      attempt.resourceKind,
      securityDescriptor.resourceId,
      attempt.action,
      attemptId,
      attempt.outcome,
    ]),
    attemptId,
    action: attempt.action,
    resourceKind: attempt.resourceKind,
    resourceId: securityDescriptor.resourceId,
    outcome: attempt.outcome,
    reasonCode: attempt.reasonCode,
    redactedDiff: { changedFields: [], values: {} },
    securityDescriptor,
  });
};
