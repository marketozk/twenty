import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCommand } from 'src/database/commands/fork-upgrade/fork-migration.type';

export class CrmAuditOperationIndexFastInstanceCommand
  implements ForkMigrationCommand
{
  static readonly kind = 'fork' as const;
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX "IDX_crmAuditEntry_workspace_operation" ON "crm_audit"."crmAuditEntry" ("workspaceId", "operationId") ',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX "crm_audit"."IDX_crmAuditEntry_workspace_operation"',
    );
  }
}
