import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { type DataSource } from 'typeorm';

import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { runInCoreAuditTransaction } from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { isTransactionUnsafeToRetry } from 'src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown';
import { DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/constants/deferred-workspace-migration-action-max-attempts.constant';

export const FILES_FIELD_HARD_DELETE_INTENT_NAME = 'delete_filesFieldFiles';
export const FILES_FIELD_HARD_DELETE_RECONCILIATION =
  'FILES_FIELD_HARD_DELETE_RECONCILIATION';

const FILES_FIELD_FOLDER = 'files-field' as const;
const FILES_FIELD_PREFIX = `${FILES_FIELD_FOLDER}/`;
const FENCED_ERROR_MESSAGE =
  'Files field hard-delete intent fenced by unsafe outcome';

export type FilesFieldHardDeleteTarget = Readonly<{
  fileId: string;
  objectMetadataId: string;
  recordId: string;
  fieldMetadataId: string;
}>;

export type FilesFieldHardDeleteUnsafeOutcome = Readonly<{
  reason: string;
  at: string;
}>;

export type FilesFieldHardDeleteIntentPayload = Readonly<{
  version: 1;
  nextFileIndex: number;
  sourceOperationId: string;
  correlationId?: string;
  files: readonly FilesFieldHardDeleteTarget[];
  unsafeOutcome?: FilesFieldHardDeleteUnsafeOutcome;
}>;

export type FilesFieldHardDeleteReconciliationPort = {
  reconcileFilesFieldHardDeleteIntentsWithAudit(args: {
    workspaceId: string;
    intentId?: string;
  }): Promise<{
    processedIntents: number;
    completedIntents: number;
    deletedFiles: number;
  }>;
};

type FileHardDeleteRow = {
  id: string;
  path: string;
  size: string | number;
  applicationId: string | null;
  status: string;
  settings: { isTemporaryFile?: unknown; toDelete?: unknown } | null;
  deletedAt: Date | string | null;
  settingsSnapshot: string | null;
  deletedAtSnapshot: string | null;
};

const uuid = (value: unknown, label = 'UUID'): string => {
  if (typeof value !== 'string' || !isUUID(value)) {
    throw new Error(`Files field hard-delete ${label} is invalid`);
  }

  return value.toLowerCase();
};

const optionalIdentifier = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 256) {
    throw new Error('Files field hard-delete identifier is invalid');
  }

  return value;
};

const normalizeReturnedRows = (raw: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(raw)) return [];
  if (Array.isArray(raw[0])) {
    return raw[0] as Record<string, unknown>[];
  }

  return raw as Record<string, unknown>[];
};

const formatErrorMessage = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);

  return text.slice(0, 1000);
};

const isStorageNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'FILE_NOT_FOUND';

export const captureFilesFieldHardDeleteIntentPayload = (
  payload: unknown,
): FilesFieldHardDeleteIntentPayload => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Files field hard-delete payload is invalid');
  }

  const record = payload as Record<string, unknown>;
  const allowedKeys = new Set([
    'version',
    'nextFileIndex',
    'sourceOperationId',
    'correlationId',
    'files',
    'unsafeOutcome',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error('Files field hard-delete payload has unexpected field');
    }
  }

  if (record.version !== 1) {
    throw new Error('Files field hard-delete payload version is unsupported');
  }

  if (!Array.isArray(record.files) || record.files.length === 0) {
    throw new Error('Files field hard-delete payload requires files');
  }

  if (
    typeof record.nextFileIndex !== 'number' ||
    !Number.isInteger(record.nextFileIndex) ||
    record.nextFileIndex < 0 ||
    record.nextFileIndex > record.files.length
  ) {
    throw new Error('Files field hard-delete nextFileIndex is invalid');
  }

  const sourceOperationId = uuid(record.sourceOperationId, 'sourceOperationId');
  const correlationId = optionalIdentifier(record.correlationId);

  const seenFileIds = new Set<string>();
  const files: FilesFieldHardDeleteTarget[] = [];
  for (const item of record.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Files field hard-delete entry is invalid');
    }
    const entry = item as Record<string, unknown>;
    const entryKeys = Object.keys(entry).sort().join(',');
    if (entryKeys !== 'fieldMetadataId,fileId,objectMetadataId,recordId') {
      throw new Error('Files field hard-delete entry fields are invalid');
    }
    const fileId = uuid(entry.fileId, 'fileId');
    if (seenFileIds.has(fileId)) {
      throw new Error('Files field hard-delete payload has duplicate fileId');
    }
    seenFileIds.add(fileId);
    files.push(
      Object.freeze({
        fileId,
        objectMetadataId: uuid(entry.objectMetadataId, 'objectMetadataId'),
        recordId: uuid(entry.recordId, 'recordId'),
        fieldMetadataId: uuid(entry.fieldMetadataId, 'fieldMetadataId'),
      }),
    );
  }

  let unsafeOutcome: FilesFieldHardDeleteUnsafeOutcome | undefined;
  if (record.unsafeOutcome !== undefined) {
    if (
      !record.unsafeOutcome ||
      typeof record.unsafeOutcome !== 'object' ||
      Array.isArray(record.unsafeOutcome)
    ) {
      throw new Error('Files field hard-delete unsafeOutcome is invalid');
    }
    const unsafe = record.unsafeOutcome as Record<string, unknown>;
    if (
      typeof unsafe.reason !== 'string' ||
      !unsafe.reason.length ||
      typeof unsafe.at !== 'string' ||
      !unsafe.at.length
    ) {
      throw new Error('Files field hard-delete unsafeOutcome fields invalid');
    }
    unsafeOutcome = Object.freeze({
      reason: unsafe.reason,
      at: unsafe.at,
    });
  }

  return Object.freeze({
    version: 1,
    nextFileIndex: record.nextFileIndex,
    sourceOperationId,
    ...(correlationId !== undefined ? { correlationId } : {}),
    files: Object.freeze(files),
    ...(unsafeOutcome !== undefined ? { unsafeOutcome } : {}),
  });
};

class TerminalFilesFieldIntentError extends Error {}

const assertRetirableFileRow = (row: FileHardDeleteRow): string => {
  if (
    row.status !== 'UPLOADED' ||
    row.deletedAt === null ||
    row.deletedAt === undefined ||
    row.settings?.isTemporaryFile === true ||
    row.settings?.toDelete !== true ||
    typeof row.path !== 'string' ||
    !row.path.startsWith(FILES_FIELD_PREFIX) ||
    row.path.length <= FILES_FIELD_PREFIX.length
  ) {
    throw new Error(
      'Files field hard-delete refuses active or non-retirable file row',
    );
  }

  return uuid(row.applicationId, 'applicationId');
};

const snapshotFileRow = (row: Pick<FileHardDeleteRow, 'settingsSnapshot' | 'deletedAtSnapshot'>) => ({
  settings: row.settingsSnapshot,
  deletedAt: row.deletedAtSnapshot,
});

const markIntentFailed = async (
  coreDataSource: DataSource,
  intentId: string,
  workspaceId: string,
  attempts: number,
  lastError: string,
): Promise<void> => {
  await coreDataSource.query(
    `UPDATE core."deferredWorkspaceMigrationAction"
     SET status = 'FAILED', "startedAt" = NULL, "lastError" = $3, "updatedAt" = now()
     WHERE id = $1 AND "workspaceId" = $2 AND name = $4 AND status = 'IN_PROGRESS' AND attempts = $5`,
    [
      intentId,
      workspaceId,
      lastError,
      FILES_FIELD_HARD_DELETE_INTENT_NAME,
      attempts,
    ],
  );
};

const markIntentUnsafeOutcomeBestEffort = async (
  coreDataSource: DataSource,
  intentId: string,
  workspaceId: string,
  attempts: number,
  error: unknown,
): Promise<void> => {
  const message = formatErrorMessage(error);
  const unsafeOutcome = JSON.stringify({
    reason: message,
    at: new Date().toISOString(),
  });
  try {
    await coreDataSource.query(
      `UPDATE core."deferredWorkspaceMigrationAction"
       SET status = 'FAILED',
           "startedAt" = NULL,
           "lastError" = $3,
           payload = jsonb_set(payload, '{unsafeOutcome}', $4::jsonb, true),
           "updatedAt" = now()
       WHERE id = $1 AND "workspaceId" = $2 AND name = $5 AND status = 'IN_PROGRESS' AND attempts = $6`,
      [
        intentId,
        workspaceId,
        message,
        unsafeOutcome,
        FILES_FIELD_HARD_DELETE_INTENT_NAME,
        attempts,
      ],
    );
  } catch {
    // Best effort: the strict transaction may already have deleted the intent before the ACK was lost.
  }
};

const releaseClaimedIntent = async (
  coreDataSource: DataSource,
  intentId: string,
  workspaceId: string,
  attempts: number,
  error: unknown,
): Promise<void> => {
  const nextStatus =
    attempts >= DEFERRED_WORKSPACE_MIGRATION_ACTION_MAX_ATTEMPTS
      ? 'FAILED'
      : 'PENDING';
  await coreDataSource.query(
    `UPDATE core."deferredWorkspaceMigrationAction"
     SET status = $3, "startedAt" = NULL, "lastError" = $4, "updatedAt" = now()
     WHERE id = $1 AND "workspaceId" = $2 AND name = $5
       AND status = 'IN_PROGRESS' AND attempts = $6 AND NOT (payload ? 'unsafeOutcome')`,
    [
      intentId,
      workspaceId,
      nextStatus,
      formatErrorMessage(error),
      FILES_FIELD_HARD_DELETE_INTENT_NAME,
      attempts,
    ],
  );
};

export const reconcileFilesFieldHardDeleteIntentsWithAudit = async ({
  coreDataSource,
  workspaceId,
  intentId,
  deleteFileObject,
  releaseStorageStock,
}: {
  coreDataSource: DataSource;
  workspaceId: string;
  intentId?: string;
  deleteFileObject: (params: {
    workspaceId: string;
    applicationUniversalIdentifier: string;
    fileFolder: 'files-field';
    resourcePath: string;
  }) => Promise<void>;
  releaseStorageStock: (params: {
    workspaceId: string;
    applicationId: string;
    bytes: number;
    quantity: number;
  }) => Promise<void>;
}): Promise<{
  processedIntents: number;
  completedIntents: number;
  deletedFiles: number;
}> => {
  const canonicalWorkspaceId = uuid(workspaceId, 'workspaceId');
  const canonicalIntentId =
    intentId !== undefined ? uuid(intentId, 'intentId') : undefined;

  const workspaceRows = (await coreDataSource.query(
    'SELECT "deletedAt" FROM core.workspace WHERE id = $1',
    [canonicalWorkspaceId],
  )) as Array<{ deletedAt: Date | string | null }>;
  const workspaceActive =
    workspaceRows.length === 1 && workspaceRows[0].deletedAt === null;

  const fencedRaw = await coreDataSource.query(
    canonicalIntentId === undefined
      ? `UPDATE core."deferredWorkspaceMigrationAction"
         SET status = 'FAILED', "startedAt" = NULL, "lastError" = $3, "updatedAt" = now()
         WHERE "workspaceId" = $1 AND name = $2 AND status = 'PENDING' AND (payload ? 'unsafeOutcome')
         RETURNING id`
      : `UPDATE core."deferredWorkspaceMigrationAction"
         SET status = 'FAILED', "startedAt" = NULL, "lastError" = $4, "updatedAt" = now()
         WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND status = 'PENDING' AND (payload ? 'unsafeOutcome')
         RETURNING id`,
    canonicalIntentId === undefined
      ? [
          canonicalWorkspaceId,
          FILES_FIELD_HARD_DELETE_INTENT_NAME,
          FENCED_ERROR_MESSAGE,
        ]
      : [
          canonicalIntentId,
          canonicalWorkspaceId,
          FILES_FIELD_HARD_DELETE_INTENT_NAME,
          FENCED_ERROR_MESSAGE,
        ],
  );
  if (normalizeReturnedRows(fencedRaw).length > 0) {
    throw new Error(FENCED_ERROR_MESSAGE);
  }

  if (!workspaceActive) {
    await coreDataSource.query(
      canonicalIntentId === undefined
        ? `DELETE FROM core."deferredWorkspaceMigrationAction"
           WHERE "workspaceId" = $1 AND name = $2 AND status = 'PENDING' AND NOT (payload ? 'unsafeOutcome')`
        : `DELETE FROM core."deferredWorkspaceMigrationAction"
           WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND status = 'PENDING' AND NOT (payload ? 'unsafeOutcome')`,
      canonicalIntentId === undefined
        ? [canonicalWorkspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME]
        : [
            canonicalIntentId,
            canonicalWorkspaceId,
            FILES_FIELD_HARD_DELETE_INTENT_NAME,
          ],
    );

    return { processedIntents: 0, completedIntents: 0, deletedFiles: 0 };
  }

  const pendingRows = (await coreDataSource.query(
    canonicalIntentId === undefined
      ? `SELECT id FROM core."deferredWorkspaceMigrationAction"
         WHERE "workspaceId" = $1 AND name = $2 AND status = 'PENDING' AND NOT (payload ? 'unsafeOutcome')
         ORDER BY "createdAt" ASC, position ASC, id ASC`
      : `SELECT id FROM core."deferredWorkspaceMigrationAction"
         WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND status = 'PENDING' AND NOT (payload ? 'unsafeOutcome')`,
    canonicalIntentId === undefined
      ? [canonicalWorkspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME]
      : [
          canonicalIntentId,
          canonicalWorkspaceId,
          FILES_FIELD_HARD_DELETE_INTENT_NAME,
        ],
  )) as Array<{ id: string }>;

  let processedIntents = 0;
  let completedIntents = 0;
  let deletedFiles = 0;

  for (const pending of pendingRows) {
    const claimedRaw = await coreDataSource.query(
      `UPDATE core."deferredWorkspaceMigrationAction"
       SET status = 'IN_PROGRESS', attempts = attempts + 1, "startedAt" = now(), "updatedAt" = now()
       WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND status = 'PENDING' AND NOT (payload ? 'unsafeOutcome')
       RETURNING id, payload, attempts`,
      [pending.id, canonicalWorkspaceId, FILES_FIELD_HARD_DELETE_INTENT_NAME],
    );
    const claimedRows = normalizeReturnedRows(claimedRaw) as Array<{
      id: string;
      payload: unknown;
      attempts: number;
    }>;
    if (claimedRows.length !== 1) {
      continue;
    }

    const claimed = claimedRows[0];
    const attempts = Number(claimed.attempts);
    processedIntents += 1;

    let payload: FilesFieldHardDeleteIntentPayload;
    try {
      payload = captureFilesFieldHardDeleteIntentPayload(claimed.payload);
    } catch (error) {
      await markIntentFailed(
        coreDataSource,
        claimed.id,
        canonicalWorkspaceId,
        attempts,
        formatErrorMessage(error),
      );
      throw error;
    }

    if (payload.unsafeOutcome !== undefined) {
      await markIntentFailed(
        coreDataSource,
        claimed.id,
        canonicalWorkspaceId,
        attempts,
        FENCED_ERROR_MESSAGE,
      );
      throw new Error(FENCED_ERROR_MESSAGE);
    }

    const parseLockedIntentPayload = (
      rawPayload: unknown,
    ): FilesFieldHardDeleteIntentPayload => {
      try {
        const parsed = captureFilesFieldHardDeleteIntentPayload(rawPayload);
        if (parsed.unsafeOutcome !== undefined) {
          throw new TerminalFilesFieldIntentError(FENCED_ERROR_MESSAGE);
        }
        return parsed;
      } catch (error) {
        if (error instanceof TerminalFilesFieldIntentError) throw error;
        throw new TerminalFilesFieldIntentError(formatErrorMessage(error));
      }
    };

    try {
      if (payload.nextFileIndex >= payload.files.length) {
        await runInCoreAuditTransaction(coreDataSource, async (runner) => {
          await runner.query("SET LOCAL lock_timeout = '8s'");
          const lockedIntent = (await runner.query(
            `SELECT id, status, attempts, payload FROM core."deferredWorkspaceMigrationAction"
             WHERE id = $1 AND "workspaceId" = $2 AND name = $3 FOR UPDATE`,
            [
              claimed.id,
              canonicalWorkspaceId,
              FILES_FIELD_HARD_DELETE_INTENT_NAME,
            ],
          )) as Array<{
            id: string;
            status: string;
            attempts: number;
            payload: unknown;
          }>;
          if (
            lockedIntent.length !== 1 ||
            lockedIntent[0].status !== 'IN_PROGRESS' ||
            Number(lockedIntent[0].attempts) !== attempts
          ) {
            throw new Error('Files field hard-delete intent lock lost');
          }
          parseLockedIntentPayload(lockedIntent[0].payload);
          await runner.query(
            `DELETE FROM core."deferredWorkspaceMigrationAction"
             WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND attempts = $4`,
            [
              claimed.id,
              canonicalWorkspaceId,
              FILES_FIELD_HARD_DELETE_INTENT_NAME,
              attempts,
            ],
          );
        });
        completedIntents += 1;
        continue;
      }

      for (
        let index = payload.nextFileIndex;
        index < payload.files.length;
        index += 1
      ) {
        const target = payload.files[index];
        const isLast = index + 1 >= payload.files.length;
        const nextPayload = {
          version: 1,
          nextFileIndex: index + 1,
          sourceOperationId: payload.sourceOperationId,
          ...(payload.correlationId !== undefined
            ? { correlationId: payload.correlationId }
            : {}),
          files: payload.files,
        };

        const preRows = (await coreDataSource.query(
          `SELECT id, path, size, "applicationId", status, settings, "deletedAt",
                  settings::text AS "settingsSnapshot",
                  to_jsonb("deletedAt")::text AS "deletedAtSnapshot"
           FROM core.file
           WHERE "workspaceId" = $1 AND id = $2`,
          [canonicalWorkspaceId, target.fileId],
        )) as FileHardDeleteRow[];

        if (preRows.length === 0) {
          await runInCoreAuditTransaction(coreDataSource, async (runner) => {
            await runner.query("SET LOCAL lock_timeout = '8s'");
            const lockedIntent = (await runner.query(
              `SELECT id, status, attempts, payload FROM core."deferredWorkspaceMigrationAction"
               WHERE id = $1 AND "workspaceId" = $2 AND name = $3 FOR UPDATE`,
              [
                claimed.id,
                canonicalWorkspaceId,
                FILES_FIELD_HARD_DELETE_INTENT_NAME,
              ],
            )) as Array<{
              id: string;
              status: string;
              attempts: number;
              payload: unknown;
            }>;
            if (
              lockedIntent.length !== 1 ||
              lockedIntent[0].status !== 'IN_PROGRESS' ||
              Number(lockedIntent[0].attempts) !== attempts
            ) {
              throw new Error('Files field hard-delete intent lock lost');
            }
            const current = parseLockedIntentPayload(lockedIntent[0].payload);
            if (current.nextFileIndex !== index) {
              throw new Error(
                'Files field hard-delete intent cursor diverged',
              );
            }
            const recheck = (await runner.query(
              'SELECT 1 FROM core.file WHERE "workspaceId" = $1 AND id = $2 FOR UPDATE',
              [canonicalWorkspaceId, target.fileId],
            )) as unknown[];
            if (recheck.length !== 0) {
              throw new Error(
                'Files field hard-delete file reappeared before advancing intent',
              );
            }
            if (isLast) {
              await runner.query(
                `DELETE FROM core."deferredWorkspaceMigrationAction"
                 WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND attempts = $4`,
                [
                  claimed.id,
                  canonicalWorkspaceId,
                  FILES_FIELD_HARD_DELETE_INTENT_NAME,
                  attempts,
                ],
              );
            } else {
              await runner.query(
                `UPDATE core."deferredWorkspaceMigrationAction"
                 SET payload = $4::jsonb, "updatedAt" = now()
                 WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND attempts = $5`,
                [
                  claimed.id,
                  canonicalWorkspaceId,
                  FILES_FIELD_HARD_DELETE_INTENT_NAME,
                  JSON.stringify(nextPayload),
                  attempts,
                ],
              );
            }
          });
          continue;
        }

        const preRow = preRows[0];
        const applicationId = assertRetirableFileRow(preRow);

        const appRows = (await coreDataSource.query(
          'SELECT "universalIdentifier" FROM core.application WHERE id = $1 AND "workspaceId" = $2',
          [applicationId, canonicalWorkspaceId],
        )) as Array<{ universalIdentifier?: unknown }>;
        if (
          appRows.length !== 1 ||
          typeof appRows[0].universalIdentifier !== 'string' ||
          !appRows[0].universalIdentifier.length
        ) {
          throw new Error(
            'Files field hard-delete application metadata is unavailable',
          );
        }

        try {
          await deleteFileObject({
            workspaceId: canonicalWorkspaceId,
            applicationUniversalIdentifier: appRows[0].universalIdentifier,
            fileFolder: FILES_FIELD_FOLDER,
            resourcePath: preRow.path.slice(FILES_FIELD_PREFIX.length),
          });
        } catch (storageError) {
          if (!isStorageNotFoundError(storageError)) {
            throw storageError;
          }
        }

        const committed = await runInCoreAuditTransaction(
          coreDataSource,
          async (runner) => {
            await runner.query("SET LOCAL lock_timeout = '8s'");
            const lockedIntent = (await runner.query(
              `SELECT id, status, attempts, payload FROM core."deferredWorkspaceMigrationAction"
               WHERE id = $1 AND "workspaceId" = $2 AND name = $3 FOR UPDATE`,
              [
                claimed.id,
                canonicalWorkspaceId,
                FILES_FIELD_HARD_DELETE_INTENT_NAME,
              ],
            )) as Array<{
              id: string;
              status: string;
              attempts: number;
              payload: unknown;
            }>;
            if (
              lockedIntent.length !== 1 ||
              lockedIntent[0].status !== 'IN_PROGRESS' ||
              Number(lockedIntent[0].attempts) !== attempts
            ) {
              throw new Error('Files field hard-delete intent lock lost');
            }
            const current = parseLockedIntentPayload(lockedIntent[0].payload);
            if (current.nextFileIndex !== index) {
              throw new Error(
                'Files field hard-delete intent cursor diverged',
              );
            }

            const lockedFiles = (await runner.query(
              `SELECT id, path, size, "applicationId", status, settings, "deletedAt",
                      settings::text AS "settingsSnapshot",
                      to_jsonb("deletedAt")::text AS "deletedAtSnapshot"
               FROM core.file
               WHERE "workspaceId" = $1 AND id = $2
               FOR UPDATE`,
              [canonicalWorkspaceId, target.fileId],
            )) as FileHardDeleteRow[];
            if (lockedFiles.length !== 1) {
              throw new Error(
                'Files field hard-delete file vanished before commit',
              );
            }
            const lockedApplicationId = assertRetirableFileRow(lockedFiles[0]);

            const deletedRaw = await runner.query(
              `DELETE FROM core.file
               WHERE "workspaceId" = $1 AND id = $2
               RETURNING id, path, size, "applicationId", status, settings, "deletedAt",
                         settings::text AS "settingsSnapshot",
                         to_jsonb("deletedAt")::text AS "deletedAtSnapshot"`,
              [canonicalWorkspaceId, target.fileId],
            );
            const deletedRows = normalizeReturnedRows(
              deletedRaw,
            ) as FileHardDeleteRow[];
            if (deletedRows.length !== 1) {
              throw new Error('Files field hard-delete failed to delete row');
            }

            const operation: CrmAuditOperation = {
              workspaceId: canonicalWorkspaceId,
              operationId: randomUUID(),
              actor: { kind: 'system', id: 'files_field_hard_delete' },
              ...(payload.correlationId !== undefined
                ? { correlationId: payload.correlationId }
                : {}),
              causationId: payload.sourceOperationId,
            };
            const audit = new CrmAuditTransactionContext(runner, operation);
            audit.record({
              resourceKind: 'crmFile',
              resourceId: target.fileId,
              action: 'delete',
              before: snapshotFileRow(deletedRows[0]),
              after: null,
              securityDescriptor: {
                resourceKind: 'crmFile',
                resourceId: target.fileId,
                fileParent: {
                  objectMetadataId: target.objectMetadataId,
                  recordId: target.recordId,
                  fieldMetadataId: target.fieldMetadataId,
                },
                deletedRecord: { access: 'currentWorkspaceAdministration' },
              },
            });
            await audit.flush();

            if (isLast) {
              await runner.query(
                `DELETE FROM core."deferredWorkspaceMigrationAction"
                 WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND attempts = $4`,
                [
                  claimed.id,
                  canonicalWorkspaceId,
                  FILES_FIELD_HARD_DELETE_INTENT_NAME,
                  attempts,
                ],
              );
            } else {
              await runner.query(
                `UPDATE core."deferredWorkspaceMigrationAction"
                 SET payload = $4::jsonb, "updatedAt" = now()
                 WHERE id = $1 AND "workspaceId" = $2 AND name = $3 AND attempts = $5`,
                [
                  claimed.id,
                  canonicalWorkspaceId,
                  FILES_FIELD_HARD_DELETE_INTENT_NAME,
                  JSON.stringify(nextPayload),
                  attempts,
                ],
              );
            }

            return {
              applicationId: lockedApplicationId,
              size: deletedRows[0].size,
            };
          },
        );

        deletedFiles += 1;

        const bytes = Number(committed.size);
        if (Number.isSafeInteger(bytes) && bytes >= 0) {
          try {
            await releaseStorageStock({
              workspaceId: canonicalWorkspaceId,
              applicationId: committed.applicationId,
              bytes,
              quantity: 1,
            });
          } catch {
            // Best effort after confirmed COMMIT: do not replay an already-committed deletion.
          }
        }
      }

      completedIntents += 1;
    } catch (error) {
      if (isTransactionUnsafeToRetry(error)) {
        await markIntentUnsafeOutcomeBestEffort(
          coreDataSource,
          claimed.id,
          canonicalWorkspaceId,
          attempts,
          error,
        );
      } else if (error instanceof TerminalFilesFieldIntentError) {
        await markIntentFailed(
          coreDataSource,
          claimed.id,
          canonicalWorkspaceId,
          attempts,
          formatErrorMessage(error),
        );
      } else {
        await releaseClaimedIntent(
          coreDataSource,
          claimed.id,
          canonicalWorkspaceId,
          attempts,
          error,
        );
      }
      throw error;
    }
  }

  return { processedIntents, completedIntents, deletedFiles };
};
