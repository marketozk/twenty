import { isUUID } from 'class-validator';
import { type NativeCrmAuditTableShape } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';

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
