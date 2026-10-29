import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';
import { getNativeCrmAuditContext } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';
import { computeTableName } from 'src/engine/utils/compute-table-name.util';

type ObjectRecord = { id: string } & Record<string, unknown>;
type QueryExecutor = {
  execute: (statement: {
    text: string;
    values: unknown[];
  }) => Promise<Record<string, unknown>[]>;
};
export type NativeCrmAuditTableShape = {
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
type WorkspaceTableShape = NativeCrmAuditTableShape;

const VALUE_TYPES = new Set([
  'TEXT',
  'NUMBER',
  'POSITION',
  'NUMERIC',
  'BOOLEAN',
  'SELECT',
  'RATING',
  'DATE',
  'DATE_TIME',
  'UUID',
  'ARRAY',
  'MULTI_SELECT',
  'RAW_JSON',
  'RELATION',
  'MORPH_RELATION',
]);

const AUDITED_OBJECTS: Record<string, string> = {
  company: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company,
  person: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person,
  opportunity: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity,
};

export const isNativeCrmAuditObject = (
  name: string,
  universalIdentifier: string,
): boolean =>
  Object.hasOwn(AUDITED_OBJECTS, name) &&
  AUDITED_OBJECTS[name] === universalIdentifier;

export type NativeCrmAuditObjectMetadata = {
  id: string;
  workspaceId: string;
  nameSingular: string;
  universalIdentifier: string;
  applicationUniversalIdentifier: string;
  isSystem: boolean;
  isRemote: boolean;
};
const STANDARD_OBJECT_IDS = new Set<string>(
  Object.values(STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS),
);
const UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const isNativeCrmAuditMetadata = (
  metadata: NativeCrmAuditObjectMetadata,
  workspaceId: string,
): boolean => {
  if (
    metadata.workspaceId !== workspaceId ||
    metadata.isSystem !== false ||
    metadata.isRemote !== false ||
    ![
      metadata.id,
      metadata.universalIdentifier,
      metadata.applicationUniversalIdentifier,
    ].every((value) => typeof value === 'string' && UUID_PATTERN.test(value))
  )
    return false;
  if (
    metadata.applicationUniversalIdentifier ===
    TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER
  )
    return isNativeCrmAuditObject(
      metadata.nameSingular,
      metadata.universalIdentifier,
    );
  return (
    !STANDARD_OBJECT_IDS.has(metadata.universalIdentifier) &&
    !Object.hasOwn(STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS, metadata.nameSingular)
  );
};

const coverageError = () =>
  new Error(
    'Native audit update coverage does not include this value or field',
  );

const captureInputValue = (
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown => {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    value instanceof Date &&
    Number.isFinite(Date.prototype.getTime.call(value))
  )
    return new Date(Date.prototype.getTime.call(value));
  if (
    typeof value !== 'object' ||
    value === null ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw coverageError();
  ancestors.add(value);
  const captured = Array.isArray(value) ? [] : {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if ('get' in descriptor || 'set' in descriptor) throw coverageError();
    const item = captureInputValue(descriptor.value, ancestors);
    if (descriptor.enumerable)
      Object.defineProperty(captured, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else if (Array.isArray(captured) && key === 'length')
      captured.length = item as number;
  }
  ancestors.delete(value);
  return captured;
};

export const captureNativeCrmAuditWriteData = (
  data: Record<string, unknown>,
): Record<string, unknown> => {
  return captureInputValue(data) as Record<string, unknown>;
};

export const assertNativeCrmAuditWriteSupported = (
  executor: QueryExecutor,
  shape: WorkspaceTableShape,
  metadata: NativeCrmAuditObjectMetadata,
  workspaceId: string,
  kind: string,
  data: Record<string, unknown> = {},
): void => {
  if (!getNativeCrmAuditContext(executor)) return;
  if (
    !['create', 'update', 'soft-delete', 'restore', 'delete'].includes(kind) ||
    !isNativeCrmAuditMetadata(metadata, workspaceId) ||
    metadata.id !== shape.objectMetadataId ||
    metadata.nameSingular !== shape.nameSingular ||
    shape.tableName !==
      computeTableName(
        metadata.nameSingular,
        metadata.applicationUniversalIdentifier !==
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
      )
  )
    throw new Error('Native audit coverage excludes this object or mutation');
  for (const [name, value] of Object.entries(data)) {
    if (name === 'id' || value === undefined) continue;
    const column = shape.columnShapeByColumnName[name];
    if (column?.fieldMetadataType === 'FILES') {
      if (value === null) continue;
      if (!Array.isArray(value)) throw coverageError();
      const ids = new Set<string>();
      for (const file of value) {
        if (
          !file ||
          typeof file !== 'object' ||
          typeof file.fileId !== 'string' ||
          !UUID_PATTERN.test(file.fileId) ||
          typeof file.label !== 'string' ||
          (file.extension !== undefined &&
            typeof file.extension !== 'string') ||
          Object.keys(file).some(
            (key) => !['fileId', 'label', 'extension'].includes(key),
          ) ||
          ids.has(file.fileId.toLowerCase())
        )
          throw coverageError();
        ids.add(file.fileId.toLowerCase());
      }
      continue;
    }
    const compositeColumns = Object.values(
      shape.columnShapeByColumnName,
    ).filter((item) => item.compositeParentFieldName === name);
    if (compositeColumns.length) {
      if (
        value !== null &&
        (typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.getPrototypeOf(value) !== Object.prototype)
      )
        throw coverageError();
      for (const [property, item] of Object.entries(value ?? {})) {
        if (item === undefined) continue;
        const propertyColumn = compositeColumns.find(
          (candidate) =>
            candidate.columnName ===
            name + property.charAt(0).toUpperCase() + property.slice(1),
        );
        if (
          !propertyColumn ||
          !VALUE_TYPES.has(propertyColumn.fieldMetadataType)
        )
          throw coverageError();
      }
    } else if (
      !column ||
      column.compositeParentFieldName ||
      !VALUE_TYPES.has(column.fieldMetadataType)
    ) {
      throw coverageError();
    }
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

export const captureNativeCrmAuditSnapshot = (
  shape: WorkspaceTableShape,
  row: ObjectRecord,
): Record<string, unknown> => {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const column of Object.values(shape.columnShapeByColumnName)) {
    if (column.columnName === 'id') continue;
    if (!Object.hasOwn(row, column.columnName))
      throw new Error('Native audit snapshot is incomplete');
    (fields[column.fieldMetadataId] ??= {})[column.columnName] =
      row[column.columnName];
  }
  return fields;
};

export const recordNativeCrmCreates = async (
  executor: QueryExecutor,
  shape: WorkspaceTableShape,
  actualIds: string[],
  inputs: Record<string, unknown>[],
): Promise<void> => {
  const audit = getNativeCrmAuditContext(executor);
  if (!audit || !actualIds.length) return;
  const after = await readNativeCrmAuditRows(executor, shape, actualIds);
  if (after.length !== new Set(actualIds).size)
    throw new Error('Native audited row vanished after insert');
  const inputsById = new Map(
    inputs
      .filter((input) => typeof input.id === 'string')
      .map((input) => [String(input.id).toLowerCase(), input]),
  );
  for (const row of after) {
    // Also check omitted/empty fields, which have no File sync plan to validate.
    for (const column of Object.values(shape.columnShapeByColumnName))
      if (column.fieldMetadataType === 'FILES') {
        const expected = inputsById.get(row.id)?.[column.columnName];
        const expectedIds = Array.isArray(expected)
          ? expected.map((file) => String(file.fileId).toLowerCase()).sort()
          : [];
        const actual = JSON.parse(String(row[column.columnName]));
        if (actual === null && !expectedIds.length) continue;
        if (
          !Array.isArray(actual) ||
          actual.some((file) => !file || typeof file.fileId !== 'string') ||
          JSON.stringify(
            actual.map((file) => file.fileId.toLowerCase()).sort(),
          ) !== JSON.stringify(expectedIds)
        )
          throw new Error(
            'Native created file links do not match the captured plan',
          );
      }
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: row.id,
      action: 'create',
      before: null,
      after: captureNativeCrmAuditSnapshot(shape, row),
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.id,
        objectMetadataId: shape.objectMetadataId,
      },
    });
  }
};

export const assertNativeCrmDeleteFilesEmpty = (
  shape: WorkspaceTableShape,
  before: ObjectRecord[],
): void => {
  for (const row of before)
    for (const column of Object.values(shape.columnShapeByColumnName)) {
      if (column.fieldMetadataType !== 'FILES') continue;
      const value = JSON.parse(String(row[column.columnName]));
      if (value !== null && (!Array.isArray(value) || value.length))
        throw new Error('Native audit delete excludes linked files');
    }
};

export const recordNativeCrmDeletes = async (
  executor: QueryExecutor,
  shape: WorkspaceTableShape,
  before: ObjectRecord[],
  actualIds: string[],
): Promise<void> => {
  const audit = getNativeCrmAuditContext(executor);
  if (!audit || !actualIds.length) return;
  if ((await readNativeCrmAuditRows(executor, shape, actualIds)).length)
    throw new Error('Native audited row remains after delete');
  for (const id of new Set(actualIds)) {
    const previous = before.find((row) => row.id === id);
    if (!previous)
      throw new Error('Native audited delete has no locked before image');
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: id,
      action: 'delete',
      before: captureNativeCrmAuditSnapshot(shape, previous),
      after: null,
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: id,
        objectMetadataId: shape.objectMetadataId,
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      },
    });
  }
};

export const recordNativeCrmUpdates = async (
  executor: QueryExecutor,
  shape: WorkspaceTableShape,
  before: ObjectRecord[],
  actualIds: string[],
  explicitUpdatedAtIds: ReadonlySet<string> = new Set(),
  lifecycle?: 'soft-delete' | 'restore',
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
    if (
      lifecycle &&
      (row.deletedAt === undefined ||
        (lifecycle === 'restore'
          ? String(row.deletedAt) !== 'null'
          : String(row.deletedAt) === 'null'))
    )
      throw new Error('Native CRM lifecycle postcondition failed');
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: row.id,
      action: 'update',
      before: captureNativeCrmAuditSnapshot(shape, previous),
      after: captureNativeCrmAuditSnapshot(shape, row),
      implicitUpdatedAtFieldId: explicitUpdatedAtIds.has(row.id)
        ? undefined
        : shape.columnShapeByColumnName.updatedAt?.fieldMetadataId,
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.id,
        objectMetadataId: shape.objectMetadataId,
      },
    });
  }
};
