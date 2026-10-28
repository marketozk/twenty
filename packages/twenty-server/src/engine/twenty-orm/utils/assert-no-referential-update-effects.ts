import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

type Statement = { text: string; values: unknown[] };
const quoteColumn = (alias: string, column: string) =>
  `${escapeIdentifier(alias)}.${escapeIdentifier(column)}`;

// The native owner already holds FOR UPDATE on all candidate parent rows.
// Referencing inserts/updates therefore cannot appear between this probe and SET.
export const assertNoReferentialUpdateEffects = async (
  executor: {
    execute: (statement: Statement) => Promise<Record<string, unknown>[]>;
  },
  state: {
    kind: string;
    alias: string;
    tableShape: { schemaName: string; tableName: string };
    setClauses: { columnName: string; valueExpression: string }[];
  },
  parameters: Record<string, unknown>,
  where: string,
  compile: (text: string, parameters: Record<string, unknown>) => Statement,
): Promise<void> => {
  if (state.kind === 'delete') return;
  const references = (
    await getIncomingRecordForeignKeys(
      { executeRawQuery: (text, values) => executor.execute({ text, values }) },
      state.tableShape.schemaName,
      state.tableShape.tableName,
    )
  ).filter((reference) => ['c', 'n', 'd'].includes(reference.updateAction));
  if (!references.length) return;
  // A custom BEFORE trigger can rewrite a key absent from the declared SET.
  // Refuse actual incoming references conservatively rather than trust its body.
  const parent = `${escapeIdentifier(state.tableShape.schemaName)}.${escapeIdentifier(state.tableShape.tableName)}`;
  const mayRewriteKeys =
    (
      await executor.execute({
        text: `SELECT 1 FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal
      AND tgenabled IN ('O','A') AND (tgtype & 2)=2 AND (tgtype & 16)=16 LIMIT 1`,
        values: [parent],
      })
    ).length > 0;
  for (const reference of references) {
    // NO ACTION and RESTRICT were excluded: they cannot mutate another row.
    const changing = state.setClauses.filter((clause) =>
      reference.parentColumns.includes(clause.columnName),
    );
    if (!changing.length && !mayRewriteKeys) continue;
    const childAlias = `${state.alias}_incoming_fk`;
    const join = reference.childColumns
      .map(
        (column, index) =>
          `${quoteColumn(childAlias, column)}=${quoteColumn(state.alias, reference.parentColumns[index])}`,
      )
      .join(' AND ');
    const changed = mayRewriteKeys
      ? 'TRUE'
      : changing
          .map(
            (clause) =>
              `${quoteColumn(state.alias, clause.columnName)} IS DISTINCT FROM ${clause.valueExpression}`,
          )
          .join(' OR ');
    const text = `SELECT 1 FROM ${escapeIdentifier(state.tableShape.schemaName)}.${escapeIdentifier(state.tableShape.tableName)} AS ${escapeIdentifier(state.alias)}
      JOIN ${escapeIdentifier(reference.schemaName)}.${escapeIdentifier(reference.tableName)} AS ${escapeIdentifier(childAlias)} ON ${join}
      WHERE ${where ? `(${where}) AND ` : ''}(${changed}) LIMIT 1`;
    if ((await executor.execute(compile(text, parameters))).length)
      throw new Error('Native audit excludes referential UPDATE effects');
  }
};
