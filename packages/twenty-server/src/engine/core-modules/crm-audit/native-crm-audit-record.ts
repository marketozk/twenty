import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-shared/application-runtime';
import { getNativeCrmAuditContext } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';

type ObjectRecord = { id: string } & Record<string, unknown>;
type QueryExecutor = {
  execute: (statement: {
    text: string;
    values: unknown[];
  }) => Promise<Record<string, unknown>[]>;
};
type WorkspaceTableShape = {
  objectMetadataId: string;
  nameSingular: string;
  schemaName: string;
  tableName: string;
  columnShapeByColumnName: Record<
    string,
    {
      columnName: string;
      fieldMetadataId: string;
      fieldMetadataType: string;
      compositeParentFieldName?: string;
    }
  >;
};

const SCALAR_TYPES = new Set([
  'TEXT',
  'NUMBER',
  'POSITION',
  'NUMERIC',
  'BOOLEAN',
  'SELECT',
  'RATING',
  'DATE',
  'DATE_TIME',
]);

export const assertNativeCrmAuditWriteSupported = (
  executor: QueryExecutor,
  shape: WorkspaceTableShape,
  universalIdentifier: string,
  kind: string,
  data: Record<string, unknown> = {},
): void => {
  if (!getNativeCrmAuditContext(executor)) return;
  if (
    kind !== 'update' ||
    shape.nameSingular !== 'company' ||
    universalIdentifier !== STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company
  )
    throw new Error(
      'Native audit currently supports only standard Company scalar updates',
    );
  for (const [name, value] of Object.entries(data)) {
    if (name === 'id') continue; // The update kernels exclude id from SET.
    const column = shape.columnShapeByColumnName[name];
    if (
      !column ||
      column.compositeParentFieldName ||
      !SCALAR_TYPES.has(column.fieldMetadataType) ||
      ['createdAt', 'updatedAt', 'deletedAt'].includes(name) ||
      (value !== null &&
        !['string', 'number', 'boolean'].includes(typeof value)) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      throw new Error(
        'Native audit scalar coverage does not include this field write',
      );
  }
};

export const readNativeCrmAuditRows = async (
  executor: QueryExecutor,
  shape: WorkspaceTableShape,
  ids: string[],
): Promise<ObjectRecord[]> => {
  if (!ids.length) return [];
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const rows = await executor.execute({
    // Keep PostgreSQL numeric precision before the driver decodes JSON values.
    text: `SELECT r.id, (SELECT jsonb_object_agg(key, value::text)
      FROM jsonb_each(to_jsonb(r))) AS row
      FROM ${quote(shape.schemaName)}.${quote(shape.tableName)} r
      WHERE id=ANY($1::uuid[]) ORDER BY id`,
    values: [[...new Set(ids)].sort()],
  });
  return rows.map((result) => {
    const row = result.row as ObjectRecord;
    if (!row || typeof result.id !== 'string')
      throw new Error('Invalid native audit row snapshot');
    return { ...row, id: result.id };
  });
};

const snapshot = (
  shape: WorkspaceTableShape,
  row: ObjectRecord,
): Record<string, unknown> => {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const column of Object.values(shape.columnShapeByColumnName)) {
    if (['id', 'createdAt', 'updatedAt'].includes(column.columnName)) continue;
    if (!Object.hasOwn(row, column.columnName))
      throw new Error('Native audit snapshot is incomplete');
    (fields[column.fieldMetadataId] ??= {})[column.columnName] =
      row[column.columnName];
  }
  return fields;
};

export const recordNativeCrmUpdates = async (
  executor: QueryExecutor,
  shape: WorkspaceTableShape,
  before: ObjectRecord[],
  actualIds: string[],
): Promise<void> => {
  const audit = getNativeCrmAuditContext(executor);
  if (!audit || !actualIds.length) return;
  const after = await readNativeCrmAuditRows(executor, shape, actualIds);
  if (after.length !== new Set(actualIds).size)
    throw new Error('Native audited row vanished after update');
  for (const row of after) {
    const previous = before.find((item) => item.id === row.id);
    if (!previous)
      throw new Error('Native audited update has no locked before image');
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: row.id,
      action: 'update',
      before: snapshot(shape, previous),
      after: snapshot(shape, row),
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.id,
        objectMetadataId: shape.objectMetadataId,
      },
    });
  }
};
