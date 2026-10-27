import { type QueryRunner } from 'typeorm';

export type ForkMigrationCheck = {
  migrationId: string;
  checksum: string;
  verify: (queryRunner: QueryRunner) => Promise<void>;
};
