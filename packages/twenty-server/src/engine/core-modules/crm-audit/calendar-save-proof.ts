import { isUUID } from 'class-validator';
import { captureCrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { type NativeCrmAuditTableShape } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { type OrdinaryMetadataSyncRun } from 'src/modules/omnichannel/services/ordinary-metadata-sync-run';

export const CALENDAR_IMPORT_MATCHING_INTENT_NAME =
  'reconcile_calendarImportMatching' as const;

export type CalendarImportMatchingAuthority = Readonly<{
  workspaceId: string;
  connectedAccountId: string;
  channelId: string;
  run?: OrdinaryMetadataSyncRun;
}>;

export type CalendarImportMatchingIntentUnsafeOutcome = Readonly<{
  reason: string;
}>;

export type CalendarImportMatchingIntentPayload = Readonly<{
  version: 1;
  operation: CrmAuditOperation;
  authority: CalendarImportMatchingAuthority;
  participantIds: readonly string[];
  eventIds: readonly string[];
  unsafeOutcome?: CalendarImportMatchingIntentUnsafeOutcome;
}>;

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !isUUID(value))
    throw new Error('Calendar save intent requires UUID identity');
  return value.toLowerCase();
};

export const captureCalendarImportMatchingIntentPayload = (
  input: unknown,
): CalendarImportMatchingIntentPayload => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Calendar import matching intent payload invalid');
  const raw = input as Record<string, unknown>;
  const allowedKeys = new Set([
    'version',
    'operation',
    'authority',
    'participantIds',
    'eventIds',
    'unsafeOutcome',
  ]);
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.participantIds) ||
    !Array.isArray(raw.eventIds) ||
    !raw.authority ||
    typeof raw.authority !== 'object' ||
    Array.isArray(raw.authority) ||
    Object.keys(raw).some((key) => !allowedKeys.has(key))
  )
    throw new Error('Calendar import matching intent payload invalid');
  const operation = captureCrmAuditOperation(
    raw.operation as CrmAuditOperation,
  );
  const rawAuthority = raw.authority as Record<string, unknown>;
  const allowedAuthorityKeys = new Set([
    'workspaceId',
    'connectedAccountId',
    'channelId',
    'run',
  ]);
  if (Object.keys(rawAuthority).some((key) => !allowedAuthorityKeys.has(key)))
    throw new Error('Calendar import matching intent authority invalid');
  const workspaceId = uuid(rawAuthority.workspaceId);
  const connectedAccountId = uuid(rawAuthority.connectedAccountId);
  const channelId = uuid(rawAuthority.channelId);
  if (operation.workspaceId !== workspaceId)
    throw new Error('Calendar import matching intent workspace mismatch');
  let run: OrdinaryMetadataSyncRun | undefined;
  if (rawAuthority.run !== undefined) {
    if (
      !rawAuthority.run ||
      typeof rawAuthority.run !== 'object' ||
      Array.isArray(rawAuthority.run)
    )
      throw new Error('Calendar import matching intent run invalid');
    const rawRun = rawAuthority.run as Record<string, unknown>;
    const allowedRunKeys = new Set([
      'workspaceId',
      'channelId',
      'connectedAccountId',
      'kind',
      'stage',
      'startedAt',
    ]);
    if (
      Object.keys(rawRun).some((key) => !allowedRunKeys.has(key)) ||
      rawRun.kind !== 'calendar' ||
      uuid(rawRun.workspaceId) !== workspaceId ||
      uuid(rawRun.channelId) !== channelId ||
      uuid(rawRun.connectedAccountId) !== connectedAccountId ||
      typeof rawRun.stage !== 'string' ||
      !rawRun.stage.length ||
      typeof rawRun.startedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(rawRun.startedAt)
    )
      throw new Error('Calendar import matching intent run invalid');
    run = Object.freeze({
      workspaceId,
      channelId,
      connectedAccountId,
      kind: 'calendar' as const,
      stage: rawRun.stage as OrdinaryMetadataSyncRun['stage'],
      startedAt: rawRun.startedAt,
    });
  }
  const participantIds = Object.freeze([
    ...new Set(raw.participantIds.map((id) => uuid(id))),
  ]);
  const eventIds = Object.freeze([
    ...new Set(raw.eventIds.map((id) => uuid(id))),
  ]);
  if (
    eventIds.length > 1000 ||
    (participantIds.length === 0 && eventIds.length === 0)
  )
    throw new Error('Calendar import matching intent scope invalid');
  let unsafeOutcome: CalendarImportMatchingIntentUnsafeOutcome | undefined;
  if (raw.unsafeOutcome !== undefined) {
    if (
      !raw.unsafeOutcome ||
      typeof raw.unsafeOutcome !== 'object' ||
      Array.isArray(raw.unsafeOutcome)
    )
      throw new Error('Calendar import matching intent outcome invalid');
    const outcome = raw.unsafeOutcome as Record<string, unknown>;
    if (
      Object.keys(outcome).some((key) => key !== 'reason') ||
      typeof outcome.reason !== 'string' ||
      !outcome.reason.length
    )
      throw new Error('Calendar import matching intent outcome invalid');
    unsafeOutcome = Object.freeze({ reason: outcome.reason });
  }
  return Object.freeze({
    version: 1,
    operation,
    authority: Object.freeze({
      workspaceId,
      connectedAccountId,
      channelId,
      ...(run === undefined ? {} : { run }),
    }),
    participantIds,
    eventIds,
    ...(unsafeOutcome === undefined ? {} : { unsafeOutcome }),
  });
};

export const CALENDAR_SAVE_TABLES = [
  'calendarEvent',
  'calendarChannelEventAssociation',
  'calendarEventParticipant',
  'calendarEventTarget',
  'callRecording',
] as const;
export type CalendarSaveTable = (typeof CALENDAR_SAVE_TABLES)[number];
export type CalendarSaveSnapshot = { id: string } & Record<string, unknown>;

const WRITABLE_FIELDS: Record<string, readonly string[]> = {
  calendarEvent: [
    'id',
    'iCalUid',
    'title',
    'description',
    'startsAt',
    'endsAt',
    'location',
    'isFullDay',
    'isCanceled',
    'conferenceSolution',
    'conferenceLink',
    'externalCreatedAt',
    'externalUpdatedAt',
  ],
  calendarChannelEventAssociation: [
    'id',
    'calendarEventId',
    'calendarChannelId',
    'eventExternalId',
    'recurringEventExternalId',
  ],
  calendarEventParticipant: [
    'id',
    'calendarEventId',
    'handle',
    'displayName',
    'responseStatus',
    'isOrganizer',
  ],
};

export const calendarSaveTableSql = (shape: NativeCrmAuditTableShape): string =>
  quoteCalendarSaveIdentifier(shape.schemaName) +
  '.' +
  quoteCalendarSaveIdentifier(shape.tableName);

export const quoteCalendarSaveIdentifier = (name: string): string =>
  '"' + name.replaceAll('"', '""') + '"';

// Only the existing calendar planners' scalar fields and conferenceLink composite.
// Do not import the general ORM formatter or grant writes to arbitrary metadata fields.
export const calendarSaveColumns = (
  shape: NativeCrmAuditTableShape,
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const allowed = WRITABLE_FIELDS[shape.nameSingular];
  if (!allowed) throw new Error('Calendar save cannot write this object');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!allowed.includes(key))
      throw new Error('Calendar save field outside plan');
    if (key === 'conferenceLink') {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Calendar save invalid conference link');
      for (const [property, item] of Object.entries(value)) {
        if (
          !['primaryLinkLabel', 'primaryLinkUrl', 'secondaryLinks'].includes(
            property,
          )
        )
          throw new Error('Calendar save invalid conference property');
        if (item === undefined) continue;
        const name: string =
          key + property[0].toUpperCase() + property.slice(1);
        const column: NativeCrmAuditTableShape['columnShapeByColumnName'][string] =
          shape.columnShapeByColumnName[name];
        if (column?.compositeParentFieldName !== key)
          throw new Error('Calendar save composite metadata mismatch');
        result[name] = item;
      }
      continue;
    }
    const column = shape.columnShapeByColumnName[key];
    if (
      !column ||
      column.compositeParentFieldName ||
      column.fieldMetadataType === 'FILES'
    )
      throw new Error('Calendar save column metadata mismatch');
    result[key] = value;
  }
  return result;
};

export const calendarSaveActualIds = (
  result: { raw: unknown; affected?: number | null },
  requestedIds: readonly string[],
): string[] => {
  if (!Array.isArray(result.raw))
    throw new Error('Calendar save missing RETURNING records');
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
      throw new Error('Calendar save unexpected RETURNING identity');
    actual.push(row.id);
  }
  if (
    result.affected !== undefined &&
    result.affected !== null &&
    result.affected !== actual.length
  )
    throw new Error('Calendar save RETURNING count mismatch');
  return actual;
};

// Keep each PostgreSQL JSON value as text, including large NUMERIC/JSON numbers.
export const calendarSaveSnapshotJson = (row: CalendarSaveSnapshot): string =>
  JSON.stringify({ ...row, id: JSON.stringify(row.id) });
