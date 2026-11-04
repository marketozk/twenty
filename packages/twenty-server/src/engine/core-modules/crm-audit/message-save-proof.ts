import { isUUID } from 'class-validator';
import { type NativeCrmAuditTableShape } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';

export const MESSAGE_SAVE_WRITE_TABLES = [
  'messageThread',
  'message',
  'messageChannelMessageAssociation',
  'messageParticipant',
  'messageChannelMessageAssociationMessageFolder',
] as const;

export const MESSAGE_SAVE_TABLES = [
  ...MESSAGE_SAVE_WRITE_TABLES,
  'messageThreadTarget',
] as const;

export type MessageSaveWriteTable = (typeof MESSAGE_SAVE_WRITE_TABLES)[number];
export type MessageSaveTable = (typeof MESSAGE_SAVE_TABLES)[number];
export type MessageSaveSnapshot = { id: string } & Record<string, unknown>;

const WRITABLE_FIELDS: Record<MessageSaveWriteTable, readonly string[]> = {
  messageThread: ['id', 'subject'],
  message: [
    'id',
    'headerMessageId',
    'subject',
    'receivedAt',
    'text',
    'messageThreadId',
    'isDraft',
  ],
  messageChannelMessageAssociation: [
    'id',
    'messageChannelId',
    'messageId',
    'messageExternalId',
    'messageThreadExternalId',
    'direction',
  ],
  messageParticipant: [
    'id',
    'messageId',
    'handle',
    'displayName',
    'role',
    'personId',
    'workspaceMemberId',
  ],
  messageChannelMessageAssociationMessageFolder: [
    'id',
    'messageChannelMessageAssociationId',
    'messageFolderId',
  ],
};

export const quoteMessageSaveIdentifier = (name: string): string =>
  '"' + name.replaceAll('"', '""') + '"';

export const messageSaveTableSql = (shape: NativeCrmAuditTableShape): string =>
  quoteMessageSaveIdentifier(shape.schemaName) +
  '.' +
  quoteMessageSaveIdentifier(shape.tableName);

export const messageSaveColumns = (
  shape: NativeCrmAuditTableShape,
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const allowed =
    WRITABLE_FIELDS[shape.nameSingular as MessageSaveWriteTable] ?? undefined;
  if (!allowed) throw new Error('Message save cannot write this object');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!allowed.includes(key))
      throw new Error('Message save field outside plan');
    const column = shape.columnShapeByColumnName[key];
    if (
      !column ||
      column.compositeParentFieldName ||
      column.fieldMetadataType === 'FILES'
    )
      throw new Error('Message save column metadata mismatch');
    result[key] = value;
  }
  return result;
};

export const messageSaveActualIds = (
  result: { raw: unknown; affected?: number | null },
  requestedIds: readonly string[],
): string[] => {
  if (!Array.isArray(result.raw))
    throw new Error('Message save missing RETURNING records');
  const requested = new Set(requestedIds);
  const actual: string[] = [];
  for (const row of result.raw) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      !isUUID(row.id) ||
      !requested.has(row.id) ||
      actual.includes(row.id)
    )
      throw new Error('Message save unexpected RETURNING identity');
    actual.push(row.id);
  }
  if (
    result.affected !== undefined &&
    result.affected !== null &&
    result.affected !== actual.length
  )
    throw new Error('Message save RETURNING count mismatch');
  return actual;
};
