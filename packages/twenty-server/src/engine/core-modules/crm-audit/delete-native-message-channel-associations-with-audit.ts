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
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { findOmniNativeWriteOwnedRecords } from 'src/modules/omnichannel/services/assert-omni-native-write-unowned';

const ROOT = 'messageChannelMessageAssociation';
const CHILD = 'messageChannelMessageAssociationMessageFolder';
const PARENT_COLUMN = 'messageChannelMessageAssociationId';
const PAGE_SIZE = 500;
type NativeAssociationCleanupScope = Parameters<
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
type Snapshot = Awaited<ReturnType<typeof readNativeCrmAuditRows>>[number];
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const table = (shape: NativeCrmAuditTableShape) =>
  quote(shape.schemaName) + '.' + quote(shape.tableName);
const decode = (row: Snapshot): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key === 'id' ? value : JSON.parse(String(value)),
    ]),
  );

export const deleteNativeMessageChannelAssociationsWithAudit = async ({
  scope,
  messageChannelId,
  operation,
}: {
  scope: NativeAssociationCleanupScope;
  messageChannelId: string;
  operation: CrmAuditOperation;
}): Promise<number> => {
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    !isUUID(messageChannelId) ||
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId ||
    operation?.workspaceId !== scope.workspaceId
  )
    throw new Error('Native channel cleanup requires scoped system authority');
  messageChannelId = messageChannelId.toLowerCase();
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
  const shapeFor = (name: typeof ROOT | typeof CHILD) => {
    const candidates = context.objects.filter(
      ({ metadata }) =>
        metadata.nameSingular === name &&
        metadata.universalIdentifier ===
          STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name] &&
        metadata.applicationUniversalIdentifier ===
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER &&
        metadata.workspaceId === scope.workspaceId &&
        !metadata.isRemote,
    );
    if (candidates.length !== 1)
      throw new Error(
        'Native channel cleanup requires exact standard metadata',
      );
    const { metadata, shape } = candidates[0];
    if (
      shape.objectMetadataId !== metadata.id ||
      shape.nameSingular !== name ||
      shape.tableName !== name
    )
      throw new Error('Native channel cleanup table metadata mismatch');
    return shape;
  };
  const rootShape = shapeFor(ROOT);
  const childShape = shapeFor(CHILD);
  if (rootShape.schemaName !== childShape.schemaName)
    throw new Error('Native channel cleanup schema mismatch');
  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      scope.executeRawQuery(text, values),
  };
  const assertAbsentChannel = async () => {
    // Supported channel writers share the ownership fence held exclusively here.
    if (
      (
        await scope.executeRawQuery(
          'SELECT id FROM core."messageChannel" WHERE id=$1',
          [messageChannelId],
        )
      ).length
    )
      throw new Error('Native channel cleanup requires a deleted channel');
  };
  await scope.executeRawQuery("SET LOCAL lock_timeout='8s'");
  const [workspace] = await scope.executeRawQuery(
    'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1 FOR NO KEY UPDATE',
    [scope.workspaceId],
  );
  if (!workspace || workspace.deletedAt !== null)
    throw new Error('Native channel cleanup requires active workspace');
  await assertAbsentChannel();
  await scope.executeRawQuery(
    'LOCK TABLE ' +
      [table(rootShape), table(childShape)].sort().join(',') +
      ' IN ROW EXCLUSIVE MODE',
  );
  const rootIds: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await scope.executeRawQuery(
      'SELECT id FROM ' +
        table(rootShape) +
        ' WHERE "messageChannelId"=$1' +
        (cursor ? ' AND id>$2::uuid' : '') +
        ' ORDER BY id LIMIT ' +
        PAGE_SIZE +
        ' FOR UPDATE',
      cursor ? [messageChannelId, cursor] : [messageChannelId],
    );
    if (!page.length) break;
    for (const row of page) {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Invalid cleanup root identity');
      rootIds.push(row.id);
    }
    cursor = String(page[page.length - 1].id);
  }
  const childIds = (
    await scope.executeRawQuery(
      'SELECT id FROM ' +
        table(childShape) +
        ' WHERE ' +
        quote(PARENT_COLUMN) +
        '=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [rootIds],
    )
  ).map((row) => {
    if (typeof row.id !== 'string' || !isUUID(row.id))
      throw new Error('Invalid cleanup child identity');
    return row.id;
  });
  const roots = await readNativeCrmAuditRows(sql, rootShape, rootIds);
  const children = await readNativeCrmAuditRows(sql, childShape, childIds);
  if (roots.length !== rootIds.length || children.length !== childIds.length)
    throw new Error('Native channel cleanup graph changed');
  const ownedRoots = await findOmniNativeWriteOwnedRecords(
    scope,
    scope.workspaceId,
    ROOT,
    roots.map(decode),
  );
  const ownedChildren = await findOmniNativeWriteOwnedRecords(
    scope,
    scope.workspaceId,
    CHILD,
    children.map(decode),
  );
  const retainedIds = new Set([
    ...ownedRoots.map((row) => String(row.id)),
    ...ownedChildren.map((row) => String(row[PARENT_COLUMN])),
  ]);
  const selected = roots.filter(
    (row) => !retainedIds.has(row.id) && decode(row).deletedAt === null,
  );
  const selectedIds = selected.map((row) => row.id);
  const selectedSet = new Set(selectedIds);
  const selectedChildren = children.filter((row) =>
    selectedSet.has(String(decode(row)[PARENT_COLUMN])),
  );
  assertNativeCrmDeleteFilesEmpty(rootShape, selected);
  assertNativeCrmDeleteFilesEmpty(childShape, selectedChildren);
  for (const [shape, records] of [
    [rootShape, selected],
    [childShape, selectedChildren],
  ] as const) {
    const references = await getIncomingRecordForeignKeys(
      scope,
      shape.schemaName,
      shape.tableName,
    );
    const isExpectedJunctionCascade = (
      reference: (typeof references)[number],
    ) =>
      shape === rootShape &&
      reference.schemaName === childShape.schemaName &&
      reference.tableName === childShape.tableName &&
      reference.deleteAction === 'c' &&
      canonicalAuditJson(reference.parentColumns) === '["id"]' &&
      canonicalAuditJson(reference.childColumns) ===
        canonicalAuditJson([PARENT_COLUMN]);
    if (shape === rootShape && !references.some(isExpectedJunctionCascade))
      throw new Error(
        'Native channel cleanup requires the folder junction cascade',
      );
    for (const reference of references) {
      if (!['c', 'n', 'd'].includes(reference.deleteAction)) continue;
      if (isExpectedJunctionCascade(reference)) continue;
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
              table(shape) +
              ' parent ON ' +
              predicate +
              ' WHERE parent.id=ANY($1::uuid[]) LIMIT 1',
            [records.map((row) => row.id)],
          )
        ).length
      )
        throw new Error(
          'Native channel cleanup excludes unsupported cascade effects',
        );
    }
  }
  const repository = scope.getRepository(ROOT, {
    shouldBypassPermissionChecks: true,
  });
  const actualIds = new Set<string>();
  for (let index = 0; index < selectedIds.length; index += PAGE_SIZE) {
    const ids = selectedIds.slice(index, index + PAGE_SIZE);
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
      throw new Error('Native channel cleanup returned unexpected records');
    for (const row of returned) actualIds.add(row.id);
  }
  const deletedRoots = roots.filter((row) => actualIds.has(row.id));
  const deletedChildren = children.filter((row) =>
    actualIds.has(String(decode(row)[PARENT_COLUMN])),
  );
  const deletedChildIds = new Set(deletedChildren.map((row) => row.id));
  const verify = async () => {
    const [currentWorkspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt" FROM core.workspace WHERE id=$1',
      [scope.workspaceId],
    );
    if (
      currentWorkspace?.id !== workspace.id ||
      currentWorkspace.deletedAt !== null
    )
      throw new Error('Native channel cleanup workspace changed before commit');
    await assertAbsentChannel();
    for (const [name, records] of [
      [ROOT, deletedRoots],
      [CHILD, deletedChildren],
    ] as const) {
      if (
        (
          await findOmniNativeWriteOwnedRecords(
            scope,
            scope.workspaceId,
            name,
            records.map(decode),
          )
        ).length
      )
        throw new Error(
          'Native channel cleanup ownership changed before commit',
        );
    }
    const currentRootIds = (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          table(rootShape) +
          ' WHERE "messageChannelId"=$1 OR id=ANY($2::uuid[]) ORDER BY id',
        [messageChannelId, rootIds],
      )
    ).map((row) => String(row.id));
    const currentChildIds = (
      await scope.executeRawQuery(
        'SELECT id FROM ' +
          table(childShape) +
          ' WHERE ' +
          quote(PARENT_COLUMN) +
          '=ANY($1::uuid[]) OR id=ANY($2::uuid[]) ORDER BY id',
        [rootIds, childIds],
      )
    ).map((row) => String(row.id));
    const currentRoots = await readNativeCrmAuditRows(
      sql,
      rootShape,
      currentRootIds,
    );
    const currentChildren = await readNativeCrmAuditRows(
      sql,
      childShape,
      currentChildIds,
    );
    if (
      canonicalAuditJson(currentRoots) !==
        canonicalAuditJson(roots.filter((row) => !actualIds.has(row.id))) ||
      canonicalAuditJson(currentChildren) !==
        canonicalAuditJson(
          children.filter((row) => !deletedChildIds.has(row.id)),
        )
    )
      throw new Error('Native channel cleanup effects mismatch');
  };
  await verify();
  for (const [shape, records] of [
    [rootShape, deletedRoots],
    [childShape, deletedChildren],
  ] as const)
    for (const row of records)
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
  await verify();
  return actualIds.size;
};
