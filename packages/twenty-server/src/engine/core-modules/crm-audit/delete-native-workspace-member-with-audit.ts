import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
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
  captureNativeCrmAuditSnapshot,
  isNativeCrmAuditMetadata,
  readNativeCrmAuditRows,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import {
  assertIssuedOmniNativeScope,
  getIssuedNativeCleanupMetadata,
} from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import {
  getIncomingRecordForeignKeys,
  hasReferencingRecords,
} from 'src/engine/twenty-orm/utils/has-referencing-records';

type NativeCleanupScope = Parameters<
  typeof createCrmAuditWorkspaceExecutor
>[0] & {
  getRepository: (
    name: string,
    permissions: { shouldBypassPermissionChecks: true },
  ) => {
    delete: (criteria: {
      id: string;
      userId: string;
    }) => Promise<{ affected?: number | null; raw: unknown }>;
  };
};

type Snapshot = Awaited<ReturnType<typeof readNativeCrmAuditRows>>[number];
type Effect = {
  shape: NativeCrmAuditTableShape;
  before: Snapshot;
  deleted: boolean;
  cleared: Set<string>;
};
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const table = (shape: NativeCrmAuditTableShape) =>
  quote(shape.schemaName) + '.' + quote(shape.tableName);

// Private security cleanup: ordinary public native audit remains fail-closed.
export const deleteNativeWorkspaceMemberWithAudit = async ({
  scope,
  workspaceMemberId,
  userId,
  operation,
}: {
  scope: NativeCleanupScope;
  workspaceMemberId: string;
  userId: string;
  operation: CrmAuditOperation | undefined;
}): Promise<boolean> => {
  assertIssuedOmniNativeScope(scope);
  if (!isUUID(workspaceMemberId) || !isUUID(userId))
    throw new Error('Native member deletion identity invalid');
  workspaceMemberId = workspaceMemberId.toLowerCase();
  userId = userId.toLowerCase();
  const capturedOperation = operation
    ? {
        ...operation,
        operationId: randomUUID(),
        actor: { ...operation.actor },
        ...(operation.initiator
          ? { initiator: { ...operation.initiator } }
          : {}),
      }
    : undefined;
  const executor = createCrmAuditWorkspaceExecutor(scope);
  const audit = capturedOperation
    ? new CrmAuditTransactionContext(executor, capturedOperation)
    : undefined;
  const context = getIssuedNativeCleanupMetadata(scope);
  if (
    context.authType !== 'system' ||
    context.authWorkspaceId !== scope.workspaceId
  )
    throw new Error(
      'Native member cleanup requires its private workspace context',
    );
  const member = context.objects.find(
    ({ metadata }) =>
      metadata.universalIdentifier ===
      STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember,
  );
  if (!member)
    throw new Error('Native member cleanup requires exact standard metadata');
  const schemaName = member.shape.schemaName;
  const shapes = new Map<string, NativeCrmAuditTableShape>();
  for (const { metadata, shape } of context.objects) {
    if (
      !metadata ||
      metadata.workspaceId !== scope.workspaceId ||
      metadata.isRemote
    )
      continue;
    const standard =
      metadata.applicationUniversalIdentifier ===
        TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER &&
      Object.entries(STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS).some(
        ([name, id]) =>
          name === metadata.nameSingular && id === metadata.universalIdentifier,
      );
    if (!standard && !isNativeCrmAuditMetadata(metadata, scope.workspaceId))
      continue;
    if (shape.schemaName !== schemaName)
      throw new Error('Native member cleanup metadata schema mismatch');
    if (shapes.has(shape.tableName))
      throw new Error('Native member cleanup duplicate table metadata');
    shapes.set(shape.tableName, shape);
  }
  const memberMetadata = member.metadata;
  const root = shapes.get('workspaceMember');
  if (
    !root ||
    !memberMetadata ||
    memberMetadata.id !== root.objectMetadataId ||
    memberMetadata.id !== context.memberObjectId ||
    memberMetadata.workspaceId !== scope.workspaceId ||
    !memberMetadata.isSystem ||
    memberMetadata.isRemote ||
    memberMetadata.nameSingular !== 'workspaceMember' ||
    memberMetadata.applicationUniversalIdentifier !==
      TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER
  ) {
    throw new Error('Native member cleanup requires exact standard metadata');
  }
  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      scope.executeRawQuery(text, values),
  };
  await executor.query("SET LOCAL lock_timeout = '8s'");
  await executor.query(
    'SELECT id FROM ' + table(root) + ' WHERE id=$1 FOR UPDATE',
    [workspaceMemberId],
  );
  const before = await readNativeCrmAuditRows(sql, root, [workspaceMemberId]);
  if (!before.length) return false;
  if (before.length !== 1 || JSON.parse(String(before[0].userId)) !== userId)
    throw new Error('Native member target changed user');
  const effects = new Map<string, Effect>();
  const pending: Effect[] = [];
  const remember = (
    shape: NativeCrmAuditTableShape,
    row: Snapshot,
    deleted: boolean,
    column?: string,
  ) => {
    const key = table(shape) + ':' + row.id;
    const existing = effects.get(key);
    const effect = existing ?? {
      shape,
      before: row,
      deleted: false,
      cleared: new Set<string>(),
    };
    if (deleted && !effect.deleted) {
      effect.deleted = true;
      pending.push(effect);
    }
    if (column) effect.cleared.add(column);
    effects.set(key, effect);
  };
  remember(root, before[0], true);
  while (pending.length) {
    const parent = pending.shift()!;
    for (const reference of await getIncomingRecordForeignKeys(
      scope,
      parent.shape.schemaName,
      parent.shape.tableName,
    )) {
      const childTable =
        quote(reference.schemaName) + '.' + quote(reference.tableName);
      const predicate = reference.childColumns
        .map(
          (column, index) =>
            'child.' +
            quote(column) +
            '=parent.' +
            quote(reference.parentColumns[index]),
        )
        .join(' AND ');
      const from =
        'FROM ' +
        childTable +
        ' child JOIN ' +
        table(parent.shape) +
        ' parent ON ' +
        predicate +
        ' WHERE parent.id=$1';
      if (
        !(
          await executor.query('SELECT 1 ' + from + ' LIMIT 1', [
            parent.before.id,
          ])
        ).length
      )
        continue;
      if (['a', 'r'].includes(reference.deleteAction)) continue;
      const shape = shapes.get(reference.tableName);
      const column = reference.childColumns[0];
      if (
        reference.schemaName !== schemaName ||
        !shape ||
        !['n', 'c'].includes(reference.deleteAction) ||
        reference.childColumns.length !== 1 ||
        reference.parentColumns[0] !== 'id' ||
        !['RELATION', 'MORPH_RELATION'].includes(
          shape.columnShapeByColumnName[column]?.fieldMetadataType,
        )
      ) {
        throw new Error(
          'Native member cleanup excludes unproven foreign-key effects',
        );
      }
      const rows = await executor.query(
        'SELECT child.id ' + from + ' ORDER BY child.id FOR UPDATE OF child',
        [parent.before.id],
      );
      const snapshots = await readNativeCrmAuditRows(
        sql,
        shape,
        rows.map((row) => String((row as { id: unknown }).id)),
      );
      for (const row of snapshots) {
        if (JSON.parse(String(row[column])) !== parent.before.id) continue;
        remember(
          shape,
          row,
          reference.deleteAction === 'c',
          reference.deleteAction === 'n' ? column : undefined,
        );
      }
    }
  }
  for (const effect of effects.values()) {
    captureNativeCrmAuditSnapshot(effect.shape, effect.before);
    if (
      effect.cleared.size > 0 &&
      (await hasReferencingRecords(
        scope,
        effect.shape.schemaName,
        effect.shape.tableName,
        [effect.before.id],
        effect.cleared,
      ))
    ) {
      throw new Error(
        'Native member cleanup excludes transitive update effects',
      );
    }
  }
  const verify = async () => {
    for (const effect of effects.values()) {
      const rows = await readNativeCrmAuditRows(sql, effect.shape, [
        effect.before.id,
      ]);
      if (effect.deleted) {
        if (rows.length)
          throw new Error('Native member deletion effects mismatch');
      } else {
        const expected = { ...effect.before };
        for (const column of effect.cleared) expected[column] = 'null';
        if (
          rows.length !== 1 ||
          canonicalAuditJson(rows[0]) !== canonicalAuditJson(expected)
        )
          throw new Error('Native member update effects mismatch');
      }
    }
  };
  const result = await scope
    .getRepository('workspaceMember', { shouldBypassPermissionChecks: true })
    .delete({ id: workspaceMemberId, userId });
  if (
    result.affected !== 1 ||
    !Array.isArray(result.raw) ||
    result.raw.length !== 1 ||
    result.raw[0].id !== workspaceMemberId
  )
    throw new Error('Native member deletion result mismatch');
  await verify();
  let unavailable = !audit;
  if (audit) {
    await executor.query('SAVEPOINT native_member_audit');
    try {
      for (const effect of effects.values()) {
        const after = { ...effect.before };
        for (const column of effect.cleared) after[column] = 'null';
        audit.record({
          resourceKind: 'crmRecord',
          resourceId: effect.before.id,
          action: effect.deleted ? 'delete' : 'update',
          before: captureNativeCrmAuditSnapshot(effect.shape, effect.before),
          after: effect.deleted
            ? null
            : captureNativeCrmAuditSnapshot(effect.shape, after),
          securityDescriptor: {
            resourceKind: 'crmRecord',
            resourceId: effect.before.id,
            objectMetadataId: effect.shape.objectMetadataId,
            ...(effect.deleted
              ? {
                  deletedRecord: {
                    access: 'currentWorkspaceAdministration' as const,
                  },
                }
              : {}),
          },
        });
      }
      await audit.flush();
      await verify();
      await executor.query('RELEASE SAVEPOINT native_member_audit');
    } catch {
      await executor.query('ROLLBACK TO SAVEPOINT native_member_audit');
      await verify();
      await executor.query('RELEASE SAVEPOINT native_member_audit');
      unavailable = true;
    }
  }
  if (unavailable)
    new Logger('NativeMemberCleanup').error(
      'NATIVE_MEMBER_DELETION_AUDIT_UNAVAILABLE',
    );
  return true;
};
