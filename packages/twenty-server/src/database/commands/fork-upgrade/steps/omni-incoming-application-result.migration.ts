import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCommand } from 'src/database/commands/fork-upgrade/fork-migration.type';

export class OmniIncomingApplicationResultFastInstanceCommand
  implements ForkMigrationCommand
{
  static readonly kind = 'fork' as const;
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE core."omniIncomingReceipt" ADD COLUMN "applicationResult" jsonb',
    );
    await queryRunner.query(`ALTER TABLE core."omniIncomingReceipt" ADD CONSTRAINT "CHK_omniIncomingReceipt_application_result" CHECK (
      "applicationResult" IS NULL OR ((state='applied' AND "resultId" IS NOT NULL
      AND jsonb_typeof("applicationResult")='object'
      AND "applicationResult"->'schemaVersion'='1'::jsonb
      AND "applicationResult"->>'kind'='incoming_text_revision'
      AND "applicationResult"->>'disposition' IN ('created','advanced','duplicate','stale')) IS TRUE))`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'LOCK TABLE core."omniIncomingReceipt" IN ACCESS EXCLUSIVE MODE',
    );
    const retained: unknown[] = await queryRunner.query(
      'SELECT id FROM core."omniIncomingReceipt" WHERE "applicationResult" IS NOT NULL LIMIT 1',
    );
    if (retained.length)
      throw new Error(
        'OMNI_APPLICATION_RESULT_ROLLBACK_REQUIRES_RECONCILIATION',
      );
    await queryRunner.query(
      'ALTER TABLE core."omniIncomingReceipt" DROP CONSTRAINT "CHK_omniIncomingReceipt_application_result", DROP COLUMN "applicationResult"',
    );
  }
}
