import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCommand } from 'src/database/commands/fork-upgrade/fork-migration.type';

export class OmniBindingConfigWakeupFastInstanceCommand
  implements ForkMigrationCommand
{
  static readonly kind = 'fork' as const;
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "core"."omniBindingConfigWakeup" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "eventId" uuid NOT NULL, "bindingId" uuid NOT NULL, "handlerVersion" integer NOT NULL DEFAULT \'1\', "state" text NOT NULL DEFAULT \'pending\', "attempts" integer NOT NULL DEFAULT \'0\', "leaseOwner" text, "leaseToken" bigint NOT NULL DEFAULT \'0\', "leaseUntil" TIMESTAMP WITH TIME ZONE, "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "cursorNextAttemptAt" TIMESTAMP WITH TIME ZONE, "cursorReceiptId" uuid, "needsRescan" boolean NOT NULL DEFAULT false, "observedRouteGeneration" bigint, "errorCode" text, CONSTRAINT "UQ_omniBindingConfigWakeup_event" UNIQUE ("workspaceId", "eventId"), CONSTRAINT "UQ_omniBindingConfigWakeup_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_omniBindingConfigWakeup_error" CHECK ("errorCode" IS NULL OR "errorCode" IN (\'binding_inactive\', \'unsupported_handler\', \'rescan_required\', \'transient_failure\')), CONSTRAINT "CHK_omniBindingConfigWakeup_generation" CHECK ("observedRouteGeneration" IS NULL OR "observedRouteGeneration" > 0), CONSTRAINT "CHK_omniBindingConfigWakeup_cursor" CHECK (("cursorNextAttemptAt" IS NULL) = ("cursorReceiptId" IS NULL)), CONSTRAINT "CHK_omniBindingConfigWakeup_lease" CHECK (("state" = \'running\' AND "leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL AND "leaseToken" > 0) OR ("state" <> \'running\' AND "leaseOwner" IS NULL AND "leaseUntil" IS NULL)), CONSTRAINT "CHK_omniBindingConfigWakeup_counters" CHECK ("handlerVersion" > 0 AND "attempts" >= 0 AND "leaseToken" >= 0), CONSTRAINT "CHK_omniBindingConfigWakeup_state" CHECK ("state" IN (\'pending\', \'running\', \'retryable\', \'completed\', \'blocked\')), CONSTRAINT "PK_d5e36325ecfcc0f74195fdad033" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_omniBindingConfigWakeup_due" ON "core"."omniBindingConfigWakeup" ("workspaceId", "bindingId", "state", "nextAttemptAt") ',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniBindingConfigWakeup" ADD CONSTRAINT "FK_7df4731ac2c854486ceb3a6c11a" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniBindingConfigWakeup" ADD CONSTRAINT "FK_7f990cf2ad0376683193eff5f48" FOREIGN KEY ("workspaceId", "eventId") REFERENCES "core"."omniDomainEvent"("workspaceId","id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniBindingConfigWakeup" ADD CONSTRAINT "FK_63f99757b2fea1b29d5bc593815" FOREIGN KEY ("workspaceId", "bindingId") REFERENCES "core"."omniAccountBinding"("workspaceId","id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "core"."omniBindingConfigWakeup" DROP CONSTRAINT "FK_63f99757b2fea1b29d5bc593815"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniBindingConfigWakeup" DROP CONSTRAINT "FK_7f990cf2ad0376683193eff5f48"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."omniBindingConfigWakeup" DROP CONSTRAINT "FK_7df4731ac2c854486ceb3a6c11a"',
    );
    await queryRunner.query(
      'DROP INDEX "core"."IDX_omniBindingConfigWakeup_due"',
    );
    await queryRunner.query('DROP TABLE "core"."omniBindingConfigWakeup"');
  }
}
