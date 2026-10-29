import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  assertNativeCrmDeleteFilesEmpty,
  captureNativeCrmAuditSnapshot,
  readNativeCrmAuditRows,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';

const ROOT = 'calendarChannelEventAssociation';
const PAGE_SIZE = 500;
type NativeCalendarAssociationCleanupScope = Parameters<
  typeof createCrmAuditWorkspaceExecutor
>[0] & {
  getRepository: (
    name: string,
    permissions: { shouldBypassPermissionChecks: true },
  ) => {
    delete: (
      ids: string[],
      options: { columnsToReturn: string[] },
    ) => Promise<{ raw: unknown; affected?: number | null }>;
  };
};
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

// Terminal native mutation. Propagate failures and perform no further graph writes in the caller transaction.
export const deleteNativeCalendarChannelAssociationsWithAudit = async ({
  scope,
  calendarChannelId,
  operation,
}: {
  scope: NativeCalendarAssociationCleanupScope;
  calendarChannelId: string;
  operation: CrmAuditOperation;
}): Promise<number> => {
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    !isUUID(calendarChannelId) ||
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    operation?.workspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native calendar channel cleanup requires scoped system authority',
    );
  const channelId = calendarChannelId.toLowerCase();
  const capturedOperation = {
    ...operation,
    operationId: randomUUID(),
    actor: { ...operation.actor },
    ...(operation.initiator ? { initiator: { ...operation.initiator } } : {}),
  };
  const audit = new CrmAuditTransactionContext(
    createCrmAuditWorkspaceExecutor(scope),
    capturedOperation,
  );
  const candidates = context.objects.filter(
    ({ metadata }) =>
      metadata.nameSingular === ROOT &&
      metadata.universalIdentifier ===
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[ROOT] &&
      metadata.applicationUniversalIdentifier ===
        TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER &&
      metadata.workspaceId === scope.workspaceId &&
      !metadata.isRemote,
  );
  if (candidates.length !== 1)
    throw new Error(
      'Native calendar channel cleanup requires exact standard metadata',
    );
  const { metadata, shape } = candidates[0];
  if (
    shape.objectMetadataId !== metadata.id ||
    shape.nameSingular !== ROOT ||
    shape.tableName !== ROOT
  )
    throw new Error('Native calendar channel cleanup table metadata mismatch');
  const table = quote(shape.schemaName) + '.' + quote(shape.tableName);
  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      scope.executeRawQuery(text, values),
  };
  const assertAbsentChannel = async () => {
    if (
      (
        await scope.executeRawQuery(
          'SELECT id FROM core."calendarChannel" WHERE id=$1',
          [channelId],
        )
      ).length
    )
      throw new Error(
        'Native calendar channel cleanup requires a deleted channel',
      );
  };
  await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
  const [workspace] = await scope.executeRawQuery(
    'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
    [scope.workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null)
    throw new Error(
      'Native calendar channel cleanup requires active workspace',
    );
  // Calendar metadata creators do not yet share the native ownership fence.
  // This fixed SHARE lock blocks all calendar-channel INSERT/UPDATE/DELETE across workspaces until COMMIT.
  await scope.executeRawQuery(
    'LOCK TABLE core."calendarChannel" IN SHARE MODE',
  );
  await scope.executeRawQuery('LOCK TABLE ' + table + ' IN ROW EXCLUSIVE MODE');
  await assertAbsentChannel();

  const rootIds: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await scope.executeRawQuery(
      'SELECT id FROM ' +
        table +
        ' WHERE "calendarChannelId"=$1' +
        (cursor ? ' AND id>$2::uuid' : '') +
        ' ORDER BY id LIMIT ' +
        PAGE_SIZE +
        ' FOR UPDATE',
      cursor ? [channelId, cursor] : [channelId],
    );
    if (!page.length) break;
    for (const row of page) {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error(
          'Native calendar channel cleanup invalid record identity',
        );
      rootIds.push(row.id);
    }
    cursor = String(page[page.length - 1].id);
  }
  // Keep tombstones in the immutable graph proof; default repository semantics delete only live roots.
  const before = await readNativeCrmAuditRows(sql, shape, rootIds);
  if (before.length !== rootIds.length)
    throw new Error('Native calendar channel cleanup graph changed');
  const selected = before.filter(
    (row) => JSON.parse(String(row.deletedAt)) === null,
  );
  const selectedIds = selected.map((row) => row.id);
  assertNativeCrmDeleteFilesEmpty(shape, selected);
  // Calendar is outside OMNI_NATIVE_REPOSITORIES; do not invent messaging ownership for these rows.
  // The ordinary scoped repository still enforces its existing write/parent guards.
  const references = await getIncomingRecordForeignKeys(
    scope,
    shape.schemaName,
    shape.tableName,
  );
  for (const reference of references) {
    if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
    const predicate = reference.childColumns
      .map(
        (column, index) =>
          'child.' +
          quote(column) +
          '=parent.' +
          quote(reference.parentColumns[index]),
      )
      .join(' AND ');
    if (
      (
        await scope.executeRawQuery(
          'SELECT 1 FROM ' +
            quote(reference.schemaName) +
            '.' +
            quote(reference.tableName) +
            ' child JOIN ' +
            table +
            ' parent ON ' +
            predicate +
            ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
          [selectedIds],
        )
      ).length
    )
      throw new Error(
        'Native calendar channel cleanup excludes unsupported cascade effects',
      );
  }
  const repository = scope.getRepository(ROOT, {
    shouldBypassPermissionChecks: true,
  });
  const actualIds = new Set<string>();
  for (let offset = 0; offset < selectedIds.length; offset += PAGE_SIZE) {
    const ids = selectedIds.slice(offset, offset + PAGE_SIZE);
    const result = await repository.delete(ids, { columnsToReturn: ['id'] });
    const returned: unknown = result.raw;
    if (
      !Array.isArray(returned) ||
      result.affected !== returned.length ||
      returned.some(
        (row) => !row || typeof row.id !== 'string' || !ids.includes(row.id),
      ) ||
      new Set(returned.map((row) => row.id)).size !== returned.length
    )
      throw new Error(
        'Native calendar channel cleanup returned unexpected records',
      );
    for (const row of returned) actualIds.add(row.id);
  }
  const verify = async () => {
    const [currentWorkspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [scope.workspaceId],
    );
    if (
      currentWorkspace?.id !== workspace.id ||
      currentWorkspace.deletedAt !== null
    )
      throw new Error(
        'Native calendar channel cleanup workspace changed before commit',
      );
    await assertAbsentChannel();
    const currentIds = (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          table +
          ' WHERE "calendarChannelId"=$1 OR id=ANY($2::uuid[]) ORDER BY id',
        [channelId, rootIds],
      )
    ).map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error(
          'Native calendar channel cleanup invalid record identity',
        );
      return row.id;
    });
    const current = await readNativeCrmAuditRows(sql, shape, currentIds);
    if (
      current.length !== currentIds.length ||
      canonicalAuditJson(current) !==
        canonicalAuditJson(before.filter((row) => !actualIds.has(row.id)))
    )
      throw new Error('Native calendar channel cleanup effects mismatch');
  };
  await verify();
  for (const row of before.filter((row) => actualIds.has(row.id)))
    audit.record({
      resourceKind: 'crmRecord',
      resourceId: row.id,
      action: 'delete',
      before: captureNativeCrmAuditSnapshot(shape, row),
      after: null,
      securityDescriptor: {
        resourceKind: 'crmRecord',
        resourceId: row.id,
        objectMetadataId: shape.objectMetadataId,
        deletedRecord: { access: 'currentWorkspaceAdministration' },
      },
    });
  await audit.flush();
  await scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
  await verify();
  return actualIds.size;
};
