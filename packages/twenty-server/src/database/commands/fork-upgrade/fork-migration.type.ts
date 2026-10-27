import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCheck } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-migration-check.type';

export type ForkMigration = ForkMigrationCheck & {
  kind: 'fork';
  command: {
    up: (queryRunner: QueryRunner) => Promise<void>;
    down: (queryRunner: QueryRunner) => Promise<void>;
  };
};
