import { z } from 'zod';
import { type OmniNativeOwnershipQuery } from 'src/modules/omnichannel/services/lock-omni-native-ownership';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// The caller holds the parent FOR UPDATE. FK checks cannot race another insert.
export const assertNoUnhandledParentReferences = async (
  scope: OmniNativeOwnershipQuery,
  schemaName: string,
  tableName: 'person' | 'company',
  recordId: string,
): Promise<void> => {
  const parent = `${quote(schemaName)}.${quote(tableName)}`;
  const references = z
    .array(
      z.object({
        schemaName: z.string(),
        tableName: z.string(),
        childColumns: z.array(z.string()).min(1),
        parentColumns: z.array(z.string()).min(1),
      }),
    )
    .parse(
      await scope.executeRawQuery(
        `
    SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName",
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
    GROUP BY constraint_row.oid,namespace.nspname,relation.relname ORDER BY constraint_row.oid`,
        [parent],
      ),
    );
  for (const reference of references) {
    if (reference.childColumns.length !== reference.parentColumns.length)
      throw new Error('OMNI_PARENT_FOREIGN_KEY_METADATA');
    const predicate = reference.childColumns
      .map(
        (column, index) =>
          `child.${quote(column)}=parent.${quote(reference.parentColumns[index])}`,
      )
      .join(' AND ');
    const rows = await scope.executeRawQuery(
      `SELECT 1 FROM ${quote(reference.schemaName)}.${quote(reference.tableName)} child
       JOIN ${parent} parent ON ${predicate} WHERE parent.id=$1 LIMIT 1`,
      [recordId],
    );
    if (rows.length) throw new Error('OMNI_PARENT_UNHANDLED_FOREIGN_REFERENCE');
  }
};
