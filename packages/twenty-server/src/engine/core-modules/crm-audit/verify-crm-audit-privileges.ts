import { type QueryRunner } from 'typeorm';

export const verifyCrmAuditPrivileges = async (
  queryRunner: QueryRunner,
): Promise<void> => {
  if (!queryRunner.isTransactionActive || queryRunner.isReleased) {
    throw new Error('Audit requires an active transaction');
  }

  const rows: { permitted: boolean }[] = await queryRunner.query(`
    SELECT NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole
      AND NOT pg_has_role(current_user, database.datdba, 'MEMBER')
      AND NOT pg_has_role(current_user, namespace.nspowner, 'MEMBER')
      AND NOT pg_has_role(current_user, relation.relowner, 'MEMBER')
      AND has_schema_privilege(current_user, namespace.oid, 'USAGE')
      AND NOT has_schema_privilege(current_user, namespace.oid, 'CREATE')
      AND has_table_privilege(current_user, relation.oid, 'SELECT')
      AND has_table_privilege(current_user, relation.oid, 'INSERT')
      AND NOT has_table_privilege(current_user, relation.oid,
        'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      AND NOT has_any_column_privilege(current_user, relation.oid, 'UPDATE, REFERENCES')
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles reachable
        WHERE pg_has_role(current_user, reachable.oid, 'SET')
          AND (reachable.rolsuper OR reachable.rolcreatedb OR reachable.rolcreaterole
            OR reachable.oid IN (database.datdba, namespace.nspowner, relation.relowner)
            OR has_schema_privilege(reachable.oid, namespace.oid, 'CREATE')
            OR has_table_privilege(reachable.oid, relation.oid,
              'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR has_any_column_privilege(reachable.oid, relation.oid, 'UPDATE, REFERENCES'))
      ) AS permitted
    FROM pg_roles role
    JOIN pg_database database ON database.datname = current_database()
    JOIN pg_namespace namespace ON namespace.nspname = 'crm_audit'
    JOIN pg_class relation ON relation.relnamespace = namespace.oid
      AND relation.relname = 'crmAuditEntry' AND relation.relkind = 'r'
    WHERE role.rolname = current_user
  `);

  if (rows.length !== 1 || rows[0].permitted !== true) {
    throw new Error(
      'Audit runtime role does not satisfy append-only privileges',
    );
  }
};
