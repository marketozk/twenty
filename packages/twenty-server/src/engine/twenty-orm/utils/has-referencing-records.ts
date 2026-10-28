import { z } from 'zod';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// The caller holds the parent FOR UPDATE. FK checks cannot race another insert.
export const getIncomingRecordForeignKeys = async (
  scope: {
    executeRawQuery: (
      text: string,
      values: unknown[],
    ) => Promise<Record<string, unknown>[]>;
  },
  schemaName: string,
  tableName: string,
): Promise<
  {
    schemaName: string;
    tableName: string;
    childColumns: string[];
    parentColumns: string[];
    deleteAction: string;
    updateAction: string;
  }[]
> => {
  const parent = `${quote(schemaName)}.${quote(tableName)}`;
  const references = z
    .array(
      z.object({
        schemaName: z.string(),
        tableName: z.string(),
        childColumns: z.array(z.string()).min(1),
        parentColumns: z.array(z.string()).min(1),
        deleteAction: z.string(),
        updateAction: z.string(),
      }),
    )
    .parse(
      await scope.executeRawQuery(
        `
    SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName",
      constraint_row.confdeltype::text AS "deleteAction",
      constraint_row.confupdtype::text AS "updateAction",
      array_agg(child.attname::text ORDER BY key.ordinality) AS "childColumns",
      array_agg(parent.attname::text ORDER BY key.ordinality) AS "parentColumns"
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid=constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum,ordinality)
    JOIN pg_attribute child ON child.attrelid=relation.oid AND child.attnum=key.attnum
    JOIN pg_attribute parent ON parent.attrelid=constraint_row.confrelid
      AND parent.attnum=constraint_row.confkey[key.ordinality]
    WHERE constraint_row.contype='f' AND constraint_row.confrelid=$1::regclass
    GROUP BY constraint_row.oid,constraint_row.confdeltype,constraint_row.confupdtype,namespace.nspname,relation.relname ORDER BY constraint_row.oid`,
        [parent],
      ),
    );
  for (const reference of references)
    if (reference.childColumns.length !== reference.parentColumns.length)
      throw new Error('Foreign key metadata has mismatched columns');
  return references;
};

export const hasReferencingRecords = async (
  scope: {
    executeRawQuery: (
      text: string,
      values: unknown[],
    ) => Promise<Record<string, unknown>[]>;
  },
  schemaName: string,
  tableName: string,
  recordIds: string[],
  referencedColumns?: ReadonlySet<string>,
): Promise<boolean> => {
  if (!recordIds.length) return false;
  const parent = `${quote(schemaName)}.${quote(tableName)}`;
  const references = await getIncomingRecordForeignKeys(
    scope,
    schemaName,
    tableName,
  );
  for (const reference of references) {
    if (
      referencedColumns &&
      !reference.parentColumns.some((column) => referencedColumns.has(column))
    )
      continue;
    const predicate = reference.childColumns
      .map(
        (column, index) =>
          `child.${quote(column)}=parent.${quote(reference.parentColumns[index])}`,
      )
      .join(' AND ');
    const rows = await scope.executeRawQuery(
      `SELECT 1 FROM ${quote(reference.schemaName)}.${quote(reference.tableName)} child
       JOIN ${parent} parent ON ${predicate} WHERE parent.id=ANY($1::uuid[]) LIMIT 1`,
      [recordIds],
    );
    if (rows.length) return true;
  }
  return false;
};
