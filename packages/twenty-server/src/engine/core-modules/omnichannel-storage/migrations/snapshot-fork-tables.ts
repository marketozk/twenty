import { type QueryRunner } from 'typeorm';

export const snapshotForkTables = async (
  queryRunner: QueryRunner,
  tableNames: string[],
) => {
  const tables = await queryRunner.getTables(tableNames);
  // TypeORM introspection does not preserve composite index column order.
  const indexes: {
    tableName: string;
    name: string;
    definition: string;
  }[] = await queryRunner.query(
    `SELECT namespace.nspname || '.' || table_relation.relname AS "tableName",
            index_relation.relname AS name, pg_get_indexdef(index_data.indexrelid) AS definition
       FROM pg_index index_data
       JOIN pg_class table_relation ON table_relation.oid = index_data.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
       JOIN pg_class index_relation ON index_relation.oid = index_data.indexrelid
      WHERE namespace.nspname || '.' || table_relation.relname = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conindid = index_data.indexrelid AND contype IN ('p', 'u')
        )`,
    [tableNames],
  );

  return tables
    .map((table) => ({
      name: table.name,
      columns: table.columns
        .map((column) => ({
          name: column.name,
          type: column.type,
          length: column.length,
          nullable: column.isNullable,
          primary: column.isPrimary,
          array: column.isArray,
          default: column.default ?? null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      uniques: table.uniques
        .map((unique) => ({ name: unique.name, columns: unique.columnNames }))
        .sort((left, right) =>
          (left.name ?? '').localeCompare(right.name ?? ''),
        ),
      checks: table.checks
        .map((check) => ({ name: check.name, expression: check.expression }))
        .sort((left, right) =>
          (left.name ?? '').localeCompare(right.name ?? ''),
        ),
      foreignKeys: table.foreignKeys
        .map((foreignKey) => ({
          name: foreignKey.name,
          columns: foreignKey.columnNames,
          target: foreignKey.referencedTableName,
          targetColumns: foreignKey.referencedColumnNames,
          onDelete: foreignKey.onDelete,
          onUpdate: foreignKey.onUpdate,
        }))
        .sort((left, right) =>
          (left.name ?? '').localeCompare(right.name ?? ''),
        ),
      indices: indexes
        .filter((index) => index.tableName === table.name)
        .map((index) => ({
          name: index.name,
          definition: index.definition,
        }))
        .sort((left, right) =>
          (left.name ?? '').localeCompare(right.name ?? ''),
        ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};
