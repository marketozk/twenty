import { isUUID } from 'class-validator';
import { type NativeCrmAuditTableShape } from 'src/engine/core-modules/crm-audit/native-crm-audit-record';

export const CONTACT_CREATION_WRITE_TABLES = ['company', 'person'] as const;

export const CONTACT_CREATION_TABLES = [
  ...CONTACT_CREATION_WRITE_TABLES,
  'workspaceMember',
] as const;

export type ContactCreationWriteTable =
  (typeof CONTACT_CREATION_WRITE_TABLES)[number];
export type ContactCreationTable = (typeof CONTACT_CREATION_TABLES)[number];
export type ContactCreationSnapshot = { id: string } & Record<string, unknown>;

const SCALAR_WRITABLE_FIELDS: Record<
  ContactCreationWriteTable,
  readonly string[]
> = {
  company: ['id', 'name', 'position', 'deletedAt'],
  person: ['id', 'companyId', 'position', 'deletedAt'],
};

const COMPOSITE_WRITABLE_FIELDS: Record<
  ContactCreationWriteTable,
  Readonly<Record<string, readonly string[]>>
> = {
  company: {
    domainName: ['primaryLinkLabel', 'primaryLinkUrl', 'secondaryLinks'],
    address: ['addressCity'],
    createdBy: ['source', 'workspaceMemberId', 'name', 'context'],
  },
  person: {
    emails: ['primaryEmail', 'additionalEmails'],
    name: ['firstName', 'lastName'],
    createdBy: ['source', 'workspaceMemberId', 'name', 'context'],
  },
};

export const quoteContactCreationIdentifier = (name: string): string =>
  '"' + name.replaceAll('"', '""') + '"';

export const contactCreationTableSql = (
  shape: NativeCrmAuditTableShape,
): string =>
  quoteContactCreationIdentifier(shape.schemaName) +
  '.' +
  quoteContactCreationIdentifier(shape.tableName);

export const contactCreationColumns = (
  shape: NativeCrmAuditTableShape,
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const table = shape.nameSingular as ContactCreationWriteTable;
  const scalars = SCALAR_WRITABLE_FIELDS[table];
  const composites = COMPOSITE_WRITABLE_FIELDS[table];
  if (!scalars || !composites)
    throw new Error('Contact creation cannot write this object');
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(composites, key)) {
      const allowedProps = composites[key];
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Contact creation invalid composite value');
      for (const [property, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (!allowedProps.includes(property))
          throw new Error('Contact creation composite property outside plan');
        if (item === undefined) continue;
        const columnName = key + property[0].toUpperCase() + property.slice(1);
        const column = shape.columnShapeByColumnName[columnName];
        if (
          !column ||
          column.compositeParentFieldName !== key ||
          column.fieldMetadataType === 'FILES'
        )
          throw new Error('Contact creation composite metadata mismatch');
        result[columnName] = item;
      }
      continue;
    }
    if (!scalars.includes(key))
      throw new Error('Contact creation field outside plan');
    const column = shape.columnShapeByColumnName[key];
    if (
      !column ||
      column.compositeParentFieldName ||
      column.fieldMetadataType === 'FILES'
    )
      throw new Error('Contact creation column metadata mismatch');
    result[key] = value;
  }
  return result;
};

export const contactCreationActualIds = (
  result: { raw: unknown; affected?: number | null },
  requestedIds: readonly string[],
): string[] => {
  if (!Array.isArray(result.raw))
    throw new Error('Contact creation missing RETURNING records');
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
      throw new Error('Contact creation unexpected RETURNING identity');
    actual.push(row.id);
  }
  if (
    actual.length !== requestedIds.length ||
    (result.affected !== undefined &&
      result.affected !== null &&
      result.affected !== actual.length)
  )
    throw new Error('Contact creation RETURNING count mismatch');
  return actual;
};
