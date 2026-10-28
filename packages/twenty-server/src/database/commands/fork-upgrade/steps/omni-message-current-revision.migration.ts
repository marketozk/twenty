import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCommand } from 'src/database/commands/fork-upgrade/fork-migration.type';

export class OmniMessageCurrentRevisionFastInstanceCommand
  implements ForkMigrationCommand
{
  static readonly kind = 'fork' as const;
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE core."omniMessageRevision" ADD CONSTRAINT "UQ_omniMessageRevision_link_id" UNIQUE ("workspaceId","messageLinkId",id)',
    );
    await queryRunner.query(
      'ALTER TABLE core."omniMessageLink" ADD COLUMN "currentRevisionId" uuid',
    );
    await queryRunner.query(
      'ALTER TABLE core."omniMessageLink" ADD CONSTRAINT "FK_omniMessageLink_current_revision" FOREIGN KEY ("workspaceId",id,"currentRevisionId") REFERENCES core."omniMessageRevision" ("workspaceId","messageLinkId",id) ON DELETE RESTRICT',
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'LOCK TABLE core."omniMessageLink" IN ACCESS EXCLUSIVE MODE',
    );
    const heads: unknown[] = await queryRunner.query(
      'SELECT id FROM core."omniMessageLink" WHERE "currentRevisionId" IS NOT NULL LIMIT 1',
    );
    if (heads.length)
      throw new Error('OMNI_CURRENT_REVISION_ROLLBACK_REQUIRES_RECONCILIATION');
    await queryRunner.query(
      'ALTER TABLE core."omniMessageLink" DROP CONSTRAINT "FK_omniMessageLink_current_revision", DROP COLUMN "currentRevisionId"',
    );
    await queryRunner.query(
      'ALTER TABLE core."omniMessageRevision" DROP CONSTRAINT "UQ_omniMessageRevision_link_id"',
    );
  }
}
