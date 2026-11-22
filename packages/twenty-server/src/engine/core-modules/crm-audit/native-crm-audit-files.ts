import { randomUUID } from 'node:crypto';
import { TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER } from 'twenty-shared/application-runtime';

import { type FileSettings } from 'src/engine/core-modules/file/types/file-settings.type';
import { type FileStatus } from 'src/engine/core-modules/file/types/file-status.type';
import { FILES_FIELD_HARD_DELETE_INTENT_NAME } from 'src/engine/core-modules/crm-audit/files-field-hard-delete-audit';
import {
  getNativeCrmAuditContext,
  getNativeCrmAuditOperation,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-transaction';

type Executor = {
  execute: (statement: {
    text: string;
    values: unknown[];
  }) => Promise<Record<string, unknown>[]>;
};
type FileRow = {
  id: string;
  path: string;
  applicationId: string | null;
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
type HardDeleteFileTarget = {
  fileId: string;
  objectMetadataId: string;
  recordId: string;
  fieldMetadataId: string;
};

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FILES_FIELD_PATH_PREFIX = 'files-field/';

const FILE_ROW_COLUMNS = `id, path, "applicationId", settings, status,
  settings::text AS "settingsSnapshot",
  to_jsonb("deletedAt")::text AS "deletedAtSnapshot",
  to_jsonb(file)::text AS "rowSnapshot"`;

const assertEligibleForAuditedFileRemoval = (row: FileRow): void => {
  if (
    row.status !== 'UPLOADED' ||
    typeof row.path !== 'string' ||
    !row.path.startsWith(FILES_FIELD_PATH_PREFIX) ||
    row.path.length <= FILES_FIELD_PATH_PREFIX.length ||
    row.settings?.isTemporaryFile !== false ||
    row.settings?.toDelete !== false ||
    typeof row.applicationId !== 'string' ||
    !UUID_PATTERN.test(row.applicationId)
  ) {
    throw new Error('Native file is not eligible for audited deletion');
  }
};

const persistFilesFieldHardDeleteIntent = async (
  executor: Executor,
  workspaceId: string,
  deletedFiles: readonly HardDeleteFileTarget[],
): Promise<void> => {
  if (deletedFiles.length === 0) return;

  const operation = getNativeCrmAuditOperation(executor);
  if (!operation) {
    throw new Error('Native file delete requires an active audit operation');
  }
  const sortedFiles = [...deletedFiles]
    .sort((left, right) => left.fileId.localeCompare(right.fileId))
    .map((target) => ({
      fileId: target.fileId.toLowerCase(),
      objectMetadataId: target.objectMetadataId.toLowerCase(),
      recordId: target.recordId.toLowerCase(),
      fieldMetadataId: target.fieldMetadataId.toLowerCase(),
    }));
  const intentPayload = {
    version: 1,
    nextFileIndex: 0,
    sourceOperationId: operation.operationId,
    ...(operation.correlationId !== undefined
      ? { correlationId: operation.correlationId }
      : {}),
    files: sortedFiles,
  };
  const inserted = await executor.execute({
    text: `INSERT INTO core."deferredWorkspaceMigrationAction"
      (id, "workspaceId", "applicationUniversalIdentifier", name, payload, position, "runByVersion", status, attempts)
      VALUES ($1, $2, $3, $4, $5::jsonb, 0, NULL, 'PENDING', 0)
      RETURNING id`,
    values: [
      randomUUID(),
      workspaceId,
      TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
      FILES_FIELD_HARD_DELETE_INTENT_NAME,
      JSON.stringify(intentPayload),
    ],
  });
  if (inserted.length !== 1) {
    throw new Error('Native file delete failed to persist cleanup intent');
  }
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
  if (
    typeof shape.objectMetadataId !== 'string' ||
    !UUID_PATTERN.test(shape.objectMetadataId)
  ) {
    throw new Error('Native file metadata is missing');
  }
  const normalizedObjectMetadataId = shape.objectMetadataId.toLowerCase();
  const plannedRecordIds = new Set(
    recordIds.map((recordId) =>
      typeof recordId === 'string' ? recordId.toLowerCase() : recordId,
    ),
  );
  const owners = new Map<string, FileOwner>();
  for (const [index, fields] of Object.entries(diffs)) {
    const rawParentRecordId = recordIds[Number(index)];
    if (
      typeof rawParentRecordId !== 'string' ||
      !UUID_PATTERN.test(rawParentRecordId)
    )
      throw new Error('Native file owner is missing');
    const parentRecordId = rawParentRecordId.toLowerCase();
    for (const [fieldName, diff] of Object.entries(fields)) {
      const field = shape.columnShapeByColumnName[fieldName];
      if (
        !field ||
        field.fieldMetadataType !== 'FILES' ||
        typeof field.fieldMetadataId !== 'string' ||
        !UUID_PATTERN.test(field.fieldMetadataId)
      )
        throw new Error('Native file metadata is missing');
      const fieldMetadataId = field.fieldMetadataId.toLowerCase();
      for (const action of ['toAdd', 'toUpdate', 'toRemove'] as const) {
        for (const file of diff[action]) {
          if (mode === 'create' && action === 'toRemove') {
            throw new Error('Native file insert cannot remove files');
          }
          if (
            typeof file.fileId !== 'string' ||
            !UUID_PATTERN.test(file.fileId)
          ) {
            throw new Error('Native file must have one unambiguous owner');
          }
          const normalizedFileId = file.fileId.toLowerCase();
          if (owners.has(normalizedFileId))
            throw new Error('Native file must have one unambiguous owner');
          owners.set(normalizedFileId, {
            parentRecordId,
            fieldName,
            fieldMetadataId,
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
  return {
    readFiles: async (
      ids: string[],
      requestedWorkspaceId: string,
    ): Promise<FileRow[]> => {
      const normalizedIds = ids.map((id) =>
        typeof id === 'string' ? id.toLowerCase() : '',
      );
      if (
        before ||
        requestedWorkspaceId !== workspaceId ||
        new Set(normalizedIds).size !== owners.size ||
        normalizedIds.some((id) => !owners.has(id))
      )
        throw new Error('Native file read does not match its captured plan');
      const rows = (await executor.execute({
        text: `SELECT ${FILE_ROW_COLUMNS} FROM core.file
          WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) AND "deletedAt" IS NULL
          ORDER BY id FOR UPDATE`,
        values: [workspaceId, [...owners.keys()].sort()],
      })) as FileRow[];
      if (rows.length !== owners.size)
        throw new Error(
          'Native file is missing, deleted or outside this workspace',
        );
      for (const row of rows) {
        if (owners.get(row.id.toLowerCase())?.action === 'toRemove') {
          assertEligibleForAuditedFileRemoval(row);
        }
      }
      before = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
      return rows;
    },
    apply: async (writtenRecordIds: string[]): Promise<void> => {
      if (!before || applied)
        throw new Error('Native file plan must be read and applied once');
      applied = true;
      const normalizedWrittenIds = writtenRecordIds.map((id) =>
        typeof id === 'string' ? id.toLowerCase() : '',
      );
      const written = new Set(normalizedWrittenIds);
      if (
        mode === 'create' &&
        normalizedWrittenIds.some((id) => !plannedRecordIds.has(id))
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
              : `"deletedAt"=CURRENT_TIMESTAMP, settings='{"isTemporaryFile":false,"toDelete":true}'::jsonb`
          }, "updatedAt"=CURRENT_TIMESTAMP
            WHERE "workspaceId"=$1 AND id=$2 AND "deletedAt" IS NULL
            RETURNING ${FILE_ROW_COLUMNS}`,
          values: [workspaceId, id],
        })) as FileRow[];
        if (rows.length !== 1)
          throw new Error('Native file update lost its locked row');
      }
      const actual = (await executor.execute({
        text: `SELECT ${FILE_ROW_COLUMNS} FROM core.file WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
        values: [workspaceId, [...owners.keys()].sort()],
      })) as FileRow[];
      if (actual.length !== owners.size)
        throw new Error('Native file lost its workspace scope');
      for (const row of actual) {
        const rowId = row.id.toLowerCase();
        if (
          !writtenOwners.has(rowId) &&
          row.rowSnapshot !== before.get(rowId)?.rowSnapshot
        )
          throw new Error('Native skipped insert changed a planned File');
      }
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
          JSON.stringify(
            files.map((file) => file.fileId.toLowerCase()).sort(),
          ) !== JSON.stringify(parent.ids.sort())
        )
          throw new Error(
            'Native file parent link does not match the captured plan',
          );
      }
      const removedFiles: HardDeleteFileTarget[] = [];
      for (const row of actual) {
        const rowId = row.id.toLowerCase();
        if (!writtenOwners.has(rowId)) continue;
        const owner = writtenOwners.get(rowId);
        if (!owner) throw new Error('Native file changed its identity');
        if (owner.action === 'toUpdate') {
          if (
            JSON.stringify(snapshot(row)) !==
            JSON.stringify(snapshot(before.get(rowId)!))
          )
            throw new Error('Native retained file changed unexpectedly');
          continue;
        }
        if (
          owner.action === 'toAdd'
            ? row.deletedAtSnapshot !== null ||
              row.settings?.isTemporaryFile !== false ||
              row.settings?.toDelete !== false
            : row.deletedAtSnapshot === null ||
              row.settings?.isTemporaryFile !== false ||
              row.settings?.toDelete !== true
        )
          throw new Error('Native file state does not match the captured plan');
        audit.record({
          resourceKind: 'crmFile',
          resourceId: rowId,
          action: 'update',
          before: snapshot(before.get(rowId)!),
          after: snapshot(row),
          securityDescriptor: {
            resourceKind: 'crmFile',
            resourceId: rowId,
            fileParent: {
              objectMetadataId: normalizedObjectMetadataId,
              recordId: owner.parentRecordId,
              fieldMetadataId: owner.fieldMetadataId,
            },
          },
        });
        if (owner.action === 'toRemove') {
          removedFiles.push({
            fileId: rowId,
            objectMetadataId: normalizedObjectMetadataId,
            recordId: owner.parentRecordId,
            fieldMetadataId: owner.fieldMetadataId,
          });
        }
      }
      await persistFilesFieldHardDeleteIntent(
        executor,
        workspaceId,
        removedFiles,
      );
    },
  };
};

type DeleteFileOwner = {
  objectMetadataId: string;
  recordId: string;
  fieldMetadataId: string;
};

type DeleteFilesTarget = {
  shape: {
    objectMetadataId: string;
    columnShapeByColumnName: Record<
      string,
      { columnName: string; fieldMetadataId: string; fieldMetadataType: string }
    >;
  };
  before: Record<string, unknown>[];
};

export const prepareNativeCrmDeleteFiles = async (
  executor: Executor,
  workspaceId: string,
  targets: readonly DeleteFilesTarget[],
): Promise<{
  apply: (
    deletedIdsByObjectMetadataId: ReadonlyMap<string, readonly string[]>,
  ) => Promise<void>;
}> => {
  const audit = getNativeCrmAuditContext(executor);
  if (!audit) return { apply: async () => undefined };

  const owners = new Map<string, DeleteFileOwner>();
  for (const target of targets) {
    const filesColumns = Object.values(
      target.shape.columnShapeByColumnName,
    ).filter((column) => column.fieldMetadataType === 'FILES');
    if (filesColumns.length === 0) continue;

    for (const row of target.before) {
      const recordId =
        typeof row.id === 'string' && UUID_PATTERN.test(row.id)
          ? row.id.toLowerCase()
          : undefined;
      if (!recordId) throw new Error('Native file delete owner is missing');

      for (const column of filesColumns) {
        const raw = row[column.columnName];
        if (raw === undefined) {
          throw new Error('Native file delete column is missing');
        }
        if (raw === null || raw === 'null') continue;
        let parsed: unknown;
        try {
          parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          throw new Error('Native file delete payload is malformed');
        }
        if (parsed === null) continue;
        if (!Array.isArray(parsed)) {
          throw new Error('Native file delete payload is malformed');
        }
        for (const item of parsed) {
          if (
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            typeof (item as { fileId?: unknown }).fileId !== 'string' ||
            !UUID_PATTERN.test((item as { fileId: string }).fileId)
          ) {
            throw new Error('Native file delete entry is invalid');
          }
          const fileId = (item as { fileId: string }).fileId.toLowerCase();
          if (owners.has(fileId)) {
            throw new Error('Native file must have one unambiguous owner');
          }
          owners.set(fileId, {
            objectMetadataId: target.shape.objectMetadataId.toLowerCase(),
            recordId,
            fieldMetadataId: column.fieldMetadataId.toLowerCase(),
          });
        }
      }
    }
  }

  if (owners.size === 0) {
    return { apply: async () => undefined };
  }

  const lockedRows = (await executor.execute({
    text: `SELECT ${FILE_ROW_COLUMNS} FROM core.file
      WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) AND "deletedAt" IS NULL
      ORDER BY id FOR UPDATE`,
    values: [workspaceId, [...owners.keys()].sort()],
  })) as FileRow[];

  if (lockedRows.length !== owners.size) {
    throw new Error(
      'Native file is missing, deleted or outside this workspace',
    );
  }

  for (const row of lockedRows) {
    assertEligibleForAuditedFileRemoval(row);
  }

  const beforeById = new Map(
    lockedRows.map((row) => [row.id.toLowerCase(), row]),
  );
  const snapshot = (row: FileRow) => ({
    settings: row.settingsSnapshot,
    deletedAt: row.deletedAtSnapshot,
  });
  let applied = false;

  return {
    apply: async (deletedIdsByObjectMetadataId) => {
      if (applied) {
        throw new Error('Native file delete plan must be applied once');
      }
      applied = true;

      const deletedSets = new Map<string, Set<string>>();
      for (const [objectId, ids] of deletedIdsByObjectMetadataId) {
        deletedSets.set(
          objectId.toLowerCase(),
          new Set(ids.map((id) => id.toLowerCase())),
        );
      }

      const deletedOwners = new Map<string, DeleteFileOwner>();
      for (const [fileId, owner] of owners) {
        if (deletedSets.get(owner.objectMetadataId)?.has(owner.recordId)) {
          deletedOwners.set(fileId, owner);
        }
      }

      for (const fileId of [...deletedOwners.keys()].sort()) {
        const updated = (await executor.execute({
          text: `UPDATE core.file
            SET "deletedAt"=CURRENT_TIMESTAMP,
                settings='{"isTemporaryFile":false,"toDelete":true}'::jsonb,
                "updatedAt"=CURRENT_TIMESTAMP
            WHERE "workspaceId"=$1 AND id=$2 AND "deletedAt" IS NULL
            RETURNING ${FILE_ROW_COLUMNS}`,
          values: [workspaceId, fileId],
        })) as FileRow[];
        if (updated.length !== 1) {
          throw new Error('Native file delete lost its locked row');
        }
      }

      const actualRows = (await executor.execute({
        text: `SELECT ${FILE_ROW_COLUMNS} FROM core.file WHERE "workspaceId"=$1 AND id=ANY($2::uuid[])`,
        values: [workspaceId, [...owners.keys()].sort()],
      })) as FileRow[];
      if (actualRows.length !== owners.size) {
        throw new Error('Native file lost its workspace scope');
      }

      const actualById = new Map(
        actualRows.map((row) => [row.id.toLowerCase(), row]),
      );
      for (const [fileId] of owners) {
        const row = actualById.get(fileId);
        const beforeRow = beforeById.get(fileId);
        if (!row || !beforeRow) {
          throw new Error('Native file changed its identity');
        }
        if (!deletedOwners.has(fileId)) {
          if (row.rowSnapshot !== beforeRow.rowSnapshot) {
            throw new Error('Native skipped delete changed a planned File');
          }
          continue;
        }
        if (
          row.deletedAtSnapshot === null ||
          row.settings?.isTemporaryFile !== false ||
          row.settings?.toDelete !== true
        ) {
          throw new Error('Native file delete state does not match its plan');
        }
        const owner = deletedOwners.get(fileId)!;
        audit.record({
          resourceKind: 'crmFile',
          resourceId: fileId,
          action: 'update',
          before: snapshot(beforeRow),
          after: snapshot(row),
          securityDescriptor: {
            resourceKind: 'crmFile',
            resourceId: fileId,
            fileParent: {
              objectMetadataId: owner.objectMetadataId,
              recordId: owner.recordId,
              fieldMetadataId: owner.fieldMetadataId,
            },
          },
        });
      }

      if (deletedOwners.size === 0) return;

      await persistFilesFieldHardDeleteIntent(
        executor,
        workspaceId,
        [...deletedOwners.entries()].map(([fileId, owner]) => ({
          fileId,
          objectMetadataId: owner.objectMetadataId,
          recordId: owner.recordId,
          fieldMetadataId: owner.fieldMetadataId,
        })),
      );
    },
  };
};
