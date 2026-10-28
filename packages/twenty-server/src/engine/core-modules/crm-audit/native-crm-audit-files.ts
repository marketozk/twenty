import { type FileSettings } from 'src/engine/core-modules/file/types/file-settings.type';
import { type FileStatus } from 'src/engine/core-modules/file/types/file-status.type';
import { getNativeCrmAuditContext } from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';

type Executor = {
  execute: (statement: {
    text: string;
    values: unknown[];
  }) => Promise<Record<string, unknown>[]>;
};
type FileRow = {
  id: string;
  path: string;
  settings: FileSettings | null;
  status: FileStatus;
  settingsSnapshot: string | null;
  deletedAtSnapshot: string | null;
  rowSnapshot: string;
};
type FileDiff = Record<
  number,
  Record<
    string,
    {
      toAdd: { fileId: string }[];
      toUpdate: { fileId: string }[];
      toRemove: { fileId: string }[];
    }
  >
>;
type FileOwner = {
  parentRecordId: string;
  fieldName: string;
  fieldMetadataId: string;
  action: 'toAdd' | 'toUpdate' | 'toRemove';
};

export const createNativeCrmAuditFilesStore = (
  executor: Executor,
  workspaceId: string,
  shape: {
    objectMetadataId: string;
    schemaName: string;
    tableName: string;
    columnShapeByColumnName: Record<
      string,
      { fieldMetadataId: string; fieldMetadataType: string }
    >;
  },
  diffs: FileDiff,
  recordIds: string[],
  mode: 'update' | 'create' = 'update',
) => {
  const audit = getNativeCrmAuditContext(executor);
  if (!audit) return undefined;
  const plannedRecordIds = new Set(recordIds);
  const owners = new Map<string, FileOwner>();
  for (const [index, fields] of Object.entries(diffs)) {
    const parentRecordId = recordIds[Number(index)];
    if (!parentRecordId) throw new Error('Native file owner is missing');
    for (const [fieldName, diff] of Object.entries(fields)) {
      const field = shape.columnShapeByColumnName[fieldName];
      if (!field || field.fieldMetadataType !== 'FILES')
        throw new Error('Native file metadata is missing');
      for (const action of ['toAdd', 'toUpdate', 'toRemove'] as const) {
        for (const file of diff[action]) {
          if (typeof file.fileId !== 'string' || owners.has(file.fileId))
            throw new Error('Native file must have one unambiguous owner');
          owners.set(file.fileId, {
            parentRecordId,
            fieldName,
            fieldMetadataId: field.fieldMetadataId,
            action,
          });
        }
      }
    }
  }
  let before: Map<string, FileRow> | undefined;
  let applied = false;
  const snapshot = (row: FileRow) => ({
    settings: row.settingsSnapshot,
    deletedAt: row.deletedAtSnapshot,
  });
  const columns = `id, path, settings, status,
    settings::text AS "settingsSnapshot",
    to_jsonb("deletedAt")::text AS "deletedAtSnapshot",
    to_jsonb(file)::text AS "rowSnapshot"`;
  return {
    readFiles: async (
      ids: string[],
      requestedWorkspaceId: string,
    ): Promise<FileRow[]> => {
      if (
        before ||
        requestedWorkspaceId !== workspaceId ||
        new Set(ids).size !== owners.size ||
        ids.some((id) => !owners.has(id))
      )
        throw new Error('Native file read does not match its captured plan');
      const rows = (await executor.execute({
        text: `SELECT ${columns} FROM core.file
          WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) AND "deletedAt" IS NULL
          ORDER BY id FOR UPDATE`,
        values: [workspaceId, [...owners.keys()].sort()],
      })) as FileRow[];
      if (rows.length !== owners.size)
        throw new Error(
          'Native file is missing, deleted or outside this workspace',
        );
      before = new Map(rows.map((row) => [row.id, row]));
      return rows;
    },
    apply: async (writtenRecordIds: string[]): Promise<void> => {
      if (!before || applied)
        throw new Error('Native file plan must be read and applied once');
      applied = true;
      const written = new Set(writtenRecordIds);
      if (
        mode === 'create' &&
        writtenRecordIds.some((id) => !plannedRecordIds.has(id))
      )
        throw new Error('Native file insert returned an unplanned parent');
      if (
        mode === 'update' &&
        [...owners.values()].some((owner) => !written.has(owner.parentRecordId))
      )
        throw new Error('Native file parent was not updated');
      const writtenOwners =
        mode === 'create'
          ? new Map(
              [...owners].filter(([, owner]) =>
                written.has(owner.parentRecordId),
              ),
            )
          : owners;
      for (const [id, owner] of [...writtenOwners.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        if (owner.action === 'toUpdate') continue;
        const rows = (await executor.execute({
          text: `UPDATE core.file SET ${
            owner.action === 'toAdd'
              ? `settings='{"isTemporaryFile":false,"toDelete":false}'::jsonb`
              : `"deletedAt"=CURRENT_TIMESTAMP`
          }, "updatedAt"=CURRENT_TIMESTAMP
            WHERE "workspaceId"=$1 AND id=$2 AND "deletedAt" IS NULL
            RETURNING ${columns}`,
          values: [workspaceId, id],
        })) as FileRow[];
        if (rows.length !== 1)
          throw new Error('Native file update lost its locked row');
      }
      const actual = (await executor.execute({
        text: `SELECT ${columns} FROM core.file WHERE "workspaceId"=$1 AND id=ANY($2::uuid[])`,
        values: [workspaceId, [...owners.keys()]],
      })) as FileRow[];
      if (actual.length !== owners.size)
        throw new Error('Native file lost its workspace scope');
      for (const row of actual)
        if (
          !writtenOwners.has(row.id) &&
          row.rowSnapshot !== before.get(row.id)?.rowSnapshot
        )
          throw new Error('Native skipped insert changed a planned File');
      const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
      const parentFields = new Map<
        string,
        { recordId: string; fieldName: string; ids: string[] }
      >();
      for (const [id, owner] of writtenOwners) {
        const key = owner.parentRecordId + ':' + owner.fieldMetadataId;
        const parent = parentFields.get(key) ?? {
          recordId: owner.parentRecordId,
          fieldName: owner.fieldName,
          ids: [],
        };
        if (owner.action !== 'toRemove') parent.ids.push(id);
        parentFields.set(key, parent);
      }
      for (const parent of parentFields.values()) {
        const rows = await executor.execute({
          text: `SELECT ${quote(parent.fieldName)} AS files FROM ${quote(shape.schemaName)}.${quote(shape.tableName)} WHERE id=$1`,
          values: [parent.recordId],
        });
        const files = rows[0]?.files;
        if (
          rows.length !== 1 ||
          !Array.isArray(files) ||
          files.some((file) => !file || typeof file.fileId !== 'string') ||
          JSON.stringify(files.map((file) => file.fileId).sort()) !==
            JSON.stringify(parent.ids.sort())
        )
          throw new Error(
            'Native file parent link does not match the captured plan',
          );
      }
      for (const row of actual) {
        if (!writtenOwners.has(row.id)) continue;
        const owner = writtenOwners.get(row.id);
        if (!owner) throw new Error('Native file changed its identity');
        if (owner.action === 'toUpdate') {
          if (
            JSON.stringify(snapshot(row)) !==
            JSON.stringify(snapshot(before.get(row.id)!))
          )
            throw new Error('Native retained file changed unexpectedly');
          continue;
        }
        if (
          owner.action === 'toAdd'
            ? row.deletedAtSnapshot !== null ||
              row.settings?.isTemporaryFile !== false ||
              row.settings?.toDelete !== false
            : row.deletedAtSnapshot === null
        )
          throw new Error('Native file state does not match the captured plan');
        audit.record({
          resourceKind: 'crmFile',
          resourceId: row.id,
          action: 'update',
          before: snapshot(before.get(row.id)!),
          after: snapshot(row),
          securityDescriptor: {
            resourceKind: 'crmFile',
            resourceId: row.id,
            fileParent: {
              objectMetadataId: shape.objectMetadataId,
              recordId: owner.parentRecordId,
              fieldMetadataId: owner.fieldMetadataId,
            },
          },
        });
      }
    },
  };
};
