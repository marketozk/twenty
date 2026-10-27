import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCommand } from 'src/database/commands/fork-upgrade/fork-migration.type';

export class OmniTrustedCaptureFastInstanceCommand
  implements ForkMigrationCommand
{
  static readonly kind = 'fork' as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "core"."omniIncomingReceipt" ADD "trustedCaptureContext" jsonb',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniIncomingReceipt" ADD "trustedCaptureContextHash" text',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniIncomingReceipt" ADD CONSTRAINT "CHK_omniIncomingReceipt_trusted_capture" CHECK (("trustedCaptureContext" IS NULL AND "trustedCaptureContextHash" IS NULL) OR ("trustedCaptureContext" IS NOT NULL AND "trustedCaptureContextHash" IS NOT NULL AND jsonb_typeof("trustedCaptureContext") = \'object\' AND "trustedCaptureContextHash" ~ \'^[a-f0-9]{64}$\'))',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "core"."omniIncomingReceipt" DROP CONSTRAINT "CHK_omniIncomingReceipt_trusted_capture"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniIncomingReceipt" DROP COLUMN "trustedCaptureContextHash"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniIncomingReceipt" DROP COLUMN "trustedCaptureContext"',
    );
  }
}
