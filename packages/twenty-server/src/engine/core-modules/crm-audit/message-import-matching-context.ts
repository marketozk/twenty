import { isUUID } from 'class-validator';
import { captureCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';

export type SavedMessageReference = Readonly<{
  messageId: string;
  messageThreadId: string;
}>;
export type SavedParticipantReference = Readonly<{
  id: string;
  messageId: string;
  handle: string | null;
  personId: string | null;
  workspaceMemberId: string | null;
}>;
export type MessageImportMatchingManifest = Readonly<{
  participants: readonly SavedParticipantReference[];
  messages: readonly SavedMessageReference[];
  mode: 'both' | 'targetsOnly';
}>;
type ImportAuthorityScope = Readonly<{
  workspaceId: string;
  connectedAccountId: string;
  channelId: string;
  channelType: string;
}>;
export type MessageImportMatchingAuthority = ImportAuthorityScope &
  (
    | { kind: 'provider'; run: OrdinaryMetadataSyncRun }
    | { kind: 'inbound'; recipient: string }
    | { kind: 'sent'; userWorkspaceId: string; effectiveUserId?: string }
    | {
        kind: 'sent-tool';
        userWorkspaceId: string | null;
        effectiveUserId?: string;
        applicationId?: string;
      }
    | {
        kind: 'application';
        applicationId: string;
        requestUserWorkspaceId: string | null;
      }
  );
export type MessageImportMatchingContext = Readonly<{
  operation: CrmAuditOperation;
  authority: MessageImportMatchingAuthority;
}>;
const uuid = (value: string): string => {
  if (typeof value !== 'string' || !isUUID(value))
    throw new Error('Native message import requires UUID identity');
  return value.toLowerCase();
};
const nullableUuid = (value: string | null) =>
  value === null ? null : uuid(value);

export const captureMessageImportMatchingContext = (
  context: MessageImportMatchingContext,
): MessageImportMatchingContext => {
  const operation = captureCrmAuditOperation(context.operation);
  const input = context.authority;
  const scope = {
    workspaceId: uuid(input.workspaceId),
    connectedAccountId: uuid(input.connectedAccountId),
    channelId: uuid(input.channelId),
    channelType: input.channelType,
  };
  if (
    operation.workspaceId !== scope.workspaceId ||
    typeof scope.channelType !== 'string' ||
    !scope.channelType.length
  )
    throw new Error('Native message import authority mismatch');
  let authority: MessageImportMatchingAuthority;
  switch (input.kind) {
    case 'provider': {
      const run = {
        ...input.run,
        workspaceId: uuid(input.run.workspaceId),
        channelId: uuid(input.run.channelId),
        connectedAccountId: uuid(input.run.connectedAccountId),
      };
      if (
        run.kind !== 'message' ||
        run.workspaceId !== scope.workspaceId ||
        run.channelId !== scope.channelId ||
        run.connectedAccountId !== scope.connectedAccountId ||
        typeof run.stage !== 'string' ||
        !run.stage.length ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(run.startedAt) ||
        operation.actor.kind !== 'system'
      )
        throw new Error('Native message import invalid provider proof');
      authority = { ...scope, kind: 'provider', run: Object.freeze(run) };
      break;
    }
    case 'inbound':
      if (
        typeof input.recipient !== 'string' ||
        !input.recipient.length ||
        scope.channelType !== 'EMAIL_GROUP' ||
        operation.actor.kind !== 'system'
      )
        throw new Error('Native message import invalid inbound proof');
      authority = { ...scope, kind: 'inbound', recipient: input.recipient };
      break;
    case 'sent': {
      if (operation.actor.kind === 'system')
        throw new Error('Native message import requires request attribution');
      const effectiveUserId =
        input.effectiveUserId === undefined
          ? operation.actor.kind === 'coreUser'
            ? operation.actor.id
            : undefined
          : uuid(input.effectiveUserId);
      if (
        operation.actor.kind === 'coreUser' &&
        effectiveUserId !== operation.actor.id
      )
        throw new Error('Native message import caller attribution mismatch');
      authority = {
        ...scope,
        kind: 'sent',
        userWorkspaceId: uuid(input.userWorkspaceId),
        ...(effectiveUserId === undefined ? {} : { effectiveUserId }),
      };
      break;
    }
    case 'sent-tool': {
      if (operation.actor.kind === 'system')
        throw new Error('Native message import requires tool attribution');
      const attributedApplicationId =
        operation.actor.kind === 'application'
          ? operation.actor.id
          : operation.actor.kind === 'agent' &&
              operation.initiator?.kind === 'application'
            ? operation.initiator.id
            : undefined;
      const applicationId =
        input.applicationId === undefined
          ? attributedApplicationId
          : uuid(input.applicationId);
      if (
        (operation.actor.kind === 'agent' && applicationId === undefined) ||
        (attributedApplicationId !== undefined &&
          applicationId !== attributedApplicationId)
      )
        throw new Error(
          'Native message import tool application attribution mismatch',
        );
      const effectiveUserId =
        input.effectiveUserId === undefined
          ? operation.actor.kind === 'coreUser'
            ? operation.actor.id
            : undefined
          : uuid(input.effectiveUserId);
      if (
        operation.actor.kind === 'coreUser' &&
        effectiveUserId !== operation.actor.id
      )
        throw new Error('Native message import tool user attribution mismatch');
      authority = {
        ...scope,
        kind: 'sent-tool',
        userWorkspaceId: nullableUuid(input.userWorkspaceId),
        ...(effectiveUserId === undefined ? {} : { effectiveUserId }),
        ...(applicationId === undefined ? {} : { applicationId }),
      };
      break;
    }
    case 'application': {
      const applicationId = uuid(input.applicationId);
      if (
        scope.channelType !== 'APP' ||
        !['application', 'agent'].includes(operation.actor.kind) ||
        (operation.actor.kind === 'application' &&
          operation.actor.id !== applicationId) ||
        (operation.actor.kind === 'agent' &&
          operation.initiator?.kind === 'application' &&
          operation.initiator.id !== applicationId)
      )
        throw new Error(
          'Native message import application attribution mismatch',
        );
      authority = {
        ...scope,
        kind: 'application',
        applicationId,
        requestUserWorkspaceId: nullableUuid(input.requestUserWorkspaceId),
      };
      break;
    }
    default:
      throw new Error('Native message import requires origin authority');
  }
  return Object.freeze({ operation, authority: Object.freeze(authority) });
};

export const captureMessageImportMatchingManifest = (
  input: MessageImportMatchingManifest,
): MessageImportMatchingManifest => {
  if (
    !Array.isArray(input.participants) ||
    !Array.isArray(input.messages) ||
    !['both', 'targetsOnly'].includes(input.mode)
  )
    throw new Error('Native message import requires saved record manifest');
  const messages = new Map<string, SavedMessageReference>();
  for (const row of input.messages) {
    const next = Object.freeze({
      messageId: uuid(row.messageId),
      messageThreadId: uuid(row.messageThreadId),
    });
    const previous = messages.get(next.messageId);
    if (previous && previous.messageThreadId !== next.messageThreadId)
      throw new Error('Native message import conflicting message reference');
    messages.set(next.messageId, next);
  }
  const participants = new Map<string, SavedParticipantReference>();
  for (const row of input.participants) {
    if (row.handle !== null && typeof row.handle !== 'string')
      throw new Error('Native message import invalid saved handle');
    const next = Object.freeze({
      id: uuid(row.id),
      messageId: uuid(row.messageId),
      handle: row.handle,
      personId: nullableUuid(row.personId),
      workspaceMemberId: nullableUuid(row.workspaceMemberId),
    });
    if (!messages.has(next.messageId))
      throw new Error('Native message import missing original message');
    const previous = participants.get(next.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(next))
      throw new Error(
        'Native message import conflicting participant reference',
      );
    participants.set(next.id, next);
  }
  return Object.freeze({
    mode: input.mode,
    messages: Object.freeze([...messages.values()]),
    participants: Object.freeze([...participants.values()]),
  });
};
