import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCommand } from 'src/database/commands/fork-upgrade/fork-migration.type';

export class OmniCommandRestoreContextFastInstanceCommand
  implements ForkMigrationCommand
{
  static readonly kind = 'fork' as const;
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE core."omniOutgoingCommand" ADD COLUMN "createdRestoreIncarnation" uuid',
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE core."omniOutgoingCommand" DROP COLUMN "createdRestoreIncarnation"',
    );
  }
}
