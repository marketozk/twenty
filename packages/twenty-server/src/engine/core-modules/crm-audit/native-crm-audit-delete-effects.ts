import {
  assertNativeCrmAuditWriteSupported,
  assertNativeCrmDeleteFilesEmpty,
  readNativeCrmAuditRows,
  recordNativeCrmDeletes,
  recordNativeCrmUpdates,
  type NativeCrmAuditTableShape,
  type NativeCrmAuditObjectMetadata,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import {
  getIncomingRecordForeignKeys,
  hasReferencingRecords,
} from 'src/engine/twenty-orm/utils/has-referencing-records';

type Executor = {
  execute: (statement: {
    text: string;
    values: unknown[];
  }) => Promise<Record<string, unknown>[]>;
};
type ChildTable = {
  shape: NativeCrmAuditTableShape;
  metadata: NativeCrmAuditObjectMetadata;
  columnsReferencingParent: ReadonlySet<string>;
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Parent locks prevent new references; child locks make cascade before-images stable.
export const prepareNativeCrmDeleteEffects = async (
  executor: Executor,
  parent: NativeCrmAuditTableShape,
  parentIds: string[],
  workspaceId: string,
  resolveChild: (
    schemaName: string,
    tableName: string,
  ) => ChildTable | undefined,
  assertChildDeletionAllowed: (
    shape: NativeCrmAuditTableShape,
    ids: string[],
  ) => Promise<void>,
): Promise<(deletedIds: string[]) => Promise<void>> => {
  const groups = new Map<
    string,
    ChildTable & { ids: Set<string>; actions: Map<string, 'n' | 'c'> }
  >();
  const parentTable = `${quote(parent.schemaName)}.${quote(parent.tableName)}`;
  const scope = {
    executeRawQuery: (text: string, values: unknown[]) =>
      executor.execute({ text, values }),
  };
  if (parentIds.length)
    for (const reference of await getIncomingRecordForeignKeys(
      scope,
      parent.schemaName,
      parent.tableName,
    )) {
      const childTable = `${quote(reference.schemaName)}.${quote(reference.tableName)}`;
      const predicate = reference.childColumns
        .map(
          (column, index) =>
            `child.${quote(column)}=parent.${quote(reference.parentColumns[index])}`,
        )
        .join(' AND ');
      const from = `FROM ${childTable} child JOIN ${parentTable} parent ON ${predicate} WHERE parent.id=ANY($1::uuid[])`;
      if (
        !(
          await executor.execute({
            text: `SELECT 1 ${from} LIMIT 1`,
            values: [parentIds],
          })
        ).length
      )
        continue;
      const child = resolveChild(reference.schemaName, reference.tableName);
      const column = reference.childColumns[0];
      if (
        !child ||
        childTable === parentTable ||
        !['n', 'c'].includes(reference.deleteAction) ||
        reference.childColumns.length !== 1 ||
        reference.parentColumns[0] !== 'id' ||
        !child.columnsReferencingParent.has(column) ||
        !['RELATION', 'MORPH_RELATION'].includes(
          child.shape.columnShapeByColumnName[column]?.fieldMetadataType,
        )
      )
        throw new Error(
          'Native audit delete excludes referenced records outside direct FK coverage',
        );
      assertNativeCrmAuditWriteSupported(
        executor,
        child.shape,
        child.metadata,
        workspaceId,
        reference.deleteAction === 'c' ? 'delete' : 'update',
        reference.deleteAction === 'c' ? undefined : { [column]: null },
      );
      const group = groups.get(childTable) ?? {
        ...child,
        ids: new Set<string>(),
        actions: new Map<string, 'n' | 'c'>(),
      };
      const previousAction = group.actions.get(column);
      if (previousAction && previousAction !== reference.deleteAction)
        throw new Error('Native audit delete excludes conflicting FK actions');
      group.actions.set(column, reference.deleteAction as 'n' | 'c');
      for (const row of await executor.execute({
        text: `SELECT child.id ${from}`,
        values: [parentIds],
      })) {
        if (typeof row.id !== 'string')
          throw new Error('Native delete child has no record identity');
        group.ids.add(row.id);
      }
      groups.set(childTable, group);
    }
  const plans: {
    shape: NativeCrmAuditTableShape;
    actions: ReadonlyMap<string, 'n' | 'c'>;
    before: Awaited<ReturnType<typeof readNativeCrmAuditRows>>;
  }[] = [];
  const capturedParentIds = new Set(parentIds);
  for (const [table, group] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const locked = await executor.execute({
      text: `SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      values: [[...group.ids].sort()],
    });
    const before = await readNativeCrmAuditRows(
      executor,
      group.shape,
      locked.map((row) => String(row.id)),
    );
    const cascadeBefore = before.filter((row) =>
      [...group.actions].some(
        ([column, action]) =>
          action === 'c' &&
          capturedParentIds.has(JSON.parse(String(row[column]))),
      ),
    );
    if (cascadeBefore.length) {
      const cascadeIds = cascadeBefore.map((row) => row.id);
      assertNativeCrmDeleteFilesEmpty(group.shape, cascadeBefore);
      await assertChildDeletionAllowed(group.shape, cascadeIds);
      if (
        await hasReferencingRecords(
          scope,
          group.shape.schemaName,
          group.shape.tableName,
          cascadeIds,
        )
      )
        throw new Error(
          'Native delete excludes transitive foreign-key effects',
        );
    }
    for (const [column, action] of group.actions) {
      if (action !== 'n') continue;
      const changingIds = before
        .filter((row) => capturedParentIds.has(JSON.parse(String(row[column]))))
        .map((row) => row.id);
      if (
        await hasReferencingRecords(
          scope,
          group.shape.schemaName,
          group.shape.tableName,
          changingIds,
          new Set([column]),
        )
      )
        throw new Error(
          'Native delete excludes transitive foreign-key effects',
        );
    }
    plans.push({ ...group, before });
  }
  return async (deletedIds) => {
    const deleted = new Set(deletedIds);
    for (const plan of plans) {
      const after = await readNativeCrmAuditRows(
        executor,
        plan.shape,
        plan.before.map((row) => row.id),
      );
      const changedIds: string[] = [];
      const deletedChildIds: string[] = [];
      for (const before of plan.before) {
        const current = after.find((row) => row.id === before.id);
        const shouldDelete = [...plan.actions].some(
          ([column, action]) =>
            action === 'c' && deleted.has(JSON.parse(String(before[column]))),
        );
        if (shouldDelete) {
          if (current) throw new Error('Native delete CASCADE child remains');
          deletedChildIds.push(before.id);
          continue;
        }
        if (!current) throw new Error('Native delete SET NULL child vanished');
        const changedColumns = new Set(
          [...plan.actions]
            .filter(([column, action]) => {
              const previous = JSON.parse(String(before[column]));
              return (
                action === 'n' &&
                typeof previous === 'string' &&
                capturedParentIds.has(previous) &&
                deleted.has(previous)
              );
            })
            .map(([column]) => column),
        );
        for (const column of Object.keys(before)) {
          const expected = changedColumns.has(column) ? 'null' : before[column];
          if (current[column] !== expected)
            throw new Error('Native delete SET NULL postcondition failed');
        }
        if (changedColumns.size) changedIds.push(before.id);
      }
      await recordNativeCrmUpdates(
        executor,
        plan.shape,
        plan.before,
        changedIds,
      );
      await recordNativeCrmDeletes(
        executor,
        plan.shape,
        plan.before,
        deletedChildIds,
      );
    }
  };
};
