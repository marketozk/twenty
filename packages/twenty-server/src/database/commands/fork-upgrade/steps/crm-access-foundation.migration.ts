import { type QueryRunner } from 'typeorm';

import { type ForkMigrationCommand } from 'src/database/commands/fork-upgrade/fork-migration.type';

const CRM_ACCESS_TABLES = [
  'crmAutomationArtifactScope',
  'crmRecordRevision',
  'crmQueueGrant',
  'crmStageRule',
  'crmResourceGrant',
  'crmResourceAssignment',
  'crmTeamMember',
  'crmTeam',
] as const;

export class CrmAccessFoundationFastInstanceCommand
  implements ForkMigrationCommand
{
  static readonly kind = 'fork' as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "core"."crmAutomationArtifactScope" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "artifactKind" text NOT NULL, "artifactId" uuid NOT NULL, "conversationId" uuid NOT NULL, "referenceId" uuid, "capturedResourceScope" jsonb NOT NULL, CONSTRAINT "UQ_crmAutomationArtifactScope_artifact" UNIQUE ("workspaceId", "artifactKind", "artifactId"), CONSTRAINT "UQ_crmAutomationArtifactScope_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_crmAutomationArtifactScope_scope" CHECK (jsonb_typeof("capturedResourceScope") = \'object\'), CONSTRAINT "CHK_crmAutomationArtifactScope_kind" CHECK (btrim("artifactKind") = "artifactKind" AND "artifactKind" <> \'\'), CONSTRAINT "PK_9c22ab6e9351c0a4fb477a95dc1" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_crmAutomationArtifactScope_conversation" ON "core"."crmAutomationArtifactScope" ("workspaceId", "conversationId", "artifactKind") ',
    );
    await queryRunner.query(
      'CREATE TABLE "core"."crmQueueGrant" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "bindingId" uuid NOT NULL, "queueId" uuid NOT NULL, "principalKind" text NOT NULL, "principalId" uuid NOT NULL, "action" text NOT NULL, "effect" text NOT NULL, "revision" bigint NOT NULL DEFAULT \'1\', CONSTRAINT "UQ_crmQueueGrant_grant" UNIQUE ("workspaceId", "bindingId", "queueId", "principalKind", "principalId", "action"), CONSTRAINT "UQ_crmQueueGrant_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_crmQueueGrant_revision" CHECK ("revision" > 0), CONSTRAINT "CHK_crmQueueGrant_effect" CHECK ("effect" IN (\'allow\', \'deny\')), CONSTRAINT "CHK_crmQueueGrant_action" CHECK (btrim("action") = "action" AND "action" <> \'\'), CONSTRAINT "CHK_crmQueueGrant_principalKind" CHECK ("principalKind" IN (\'workspaceMember\', \'team\', \'role\', \'application\', \'agent\', \'apiKey\', \'workflow\')), CONSTRAINT "PK_ab28cfc17ae6cd0204668ebab02" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_crmQueueGrant_principal" ON "core"."crmQueueGrant" ("workspaceId", "principalKind", "principalId", "action") ',
    );
    await queryRunner.query(
      'CREATE TABLE "core"."crmRecordRevision" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "objectMetadataId" uuid NOT NULL, "recordId" uuid NOT NULL, "revision" bigint NOT NULL DEFAULT \'1\', CONSTRAINT "UQ_crmRecordRevision_record" UNIQUE ("workspaceId", "objectMetadataId", "recordId"), CONSTRAINT "UQ_crmRecordRevision_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_crmRecordRevision_revision" CHECK ("revision" > 0), CONSTRAINT "PK_61d2c1bbe4baf26d5fbbfb1460b" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE TABLE "core"."crmResourceAssignment" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "resourceKind" text NOT NULL, "resourceId" uuid NOT NULL, "principalKind" text NOT NULL, "principalId" uuid NOT NULL, "assignmentKind" text NOT NULL, "revision" bigint NOT NULL DEFAULT \'1\', CONSTRAINT "UQ_crmResourceAssignment_assignment" UNIQUE ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind"), CONSTRAINT "UQ_crmResourceAssignment_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_crmResourceAssignment_revision" CHECK ("revision" > 0), CONSTRAINT "CHK_crmResourceAssignment_principal" CHECK (("assignmentKind" = \'primary_owner\' AND "principalKind" = \'workspaceMember\') OR ("assignmentKind" = \'team\' AND "principalKind" = \'team\')), CONSTRAINT "CHK_crmResourceAssignment_kind" CHECK ("assignmentKind" IN (\'primary_owner\', \'team\')), CONSTRAINT "CHK_crmResourceAssignment_resourceKind" CHECK (btrim("resourceKind") = "resourceKind" AND "resourceKind" <> \'\'), CONSTRAINT "PK_b3b8cc2b57aa6e24bf2ceb23760" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_crmResourceAssignment_principal" ON "core"."crmResourceAssignment" ("workspaceId", "principalKind", "principalId", "resourceKind") ',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_crmResourceAssignment_primary_owner" ON "core"."crmResourceAssignment" ("workspaceId", "resourceKind", "resourceId") WHERE "assignmentKind" = \'primary_owner\'',
    );
    await queryRunner.query(
      'CREATE TABLE "core"."crmResourceGrant" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "resourceKind" text NOT NULL, "resourceId" uuid NOT NULL, "principalKind" text NOT NULL, "principalId" uuid NOT NULL, "action" text NOT NULL, "effect" text NOT NULL, "revision" bigint NOT NULL DEFAULT \'1\', CONSTRAINT "UQ_crmResourceGrant_grant" UNIQUE ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "action"), CONSTRAINT "UQ_crmResourceGrant_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_crmResourceGrant_revision" CHECK ("revision" > 0), CONSTRAINT "CHK_crmResourceGrant_effect" CHECK ("effect" IN (\'allow\', \'deny\')), CONSTRAINT "CHK_crmResourceGrant_action" CHECK (btrim("action") = "action" AND "action" <> \'\'), CONSTRAINT "CHK_crmResourceGrant_principalKind" CHECK ("principalKind" IN (\'workspaceMember\', \'team\', \'role\', \'application\', \'agent\', \'apiKey\', \'workflow\')), CONSTRAINT "CHK_crmResourceGrant_resourceKind" CHECK (btrim("resourceKind") = "resourceKind" AND "resourceKind" <> \'\'), CONSTRAINT "PK_90509fa6f7d8d5cfdc8b8f77b26" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_crmResourceGrant_principal_resource" ON "core"."crmResourceGrant" ("workspaceId", "principalKind", "principalId", "resourceKind", "action") ',
    );
    await queryRunner.query(
      'CREATE TABLE "core"."crmStageRule" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "objectMetadataId" uuid NOT NULL, "fieldMetadataId" uuid NOT NULL, "action" text NOT NULL, "optionValue" text NOT NULL, "fromValue" text NOT NULL, "toValue" text NOT NULL, "principalKind" text NOT NULL, "principalId" uuid NOT NULL, "effect" text NOT NULL, "revision" bigint NOT NULL DEFAULT \'1\', CONSTRAINT "UQ_crmStageRule_rule" UNIQUE ("workspaceId", "objectMetadataId", "fieldMetadataId", "action", "optionValue", "fromValue", "toValue", "principalKind", "principalId"), CONSTRAINT "UQ_crmStageRule_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_crmStageRule_revision" CHECK ("revision" > 0), CONSTRAINT "CHK_crmStageRule_effect" CHECK ("effect" IN (\'allow\', \'deny\')), CONSTRAINT "CHK_crmStageRule_principalKind" CHECK ("principalKind" IN (\'workspaceMember\', \'team\', \'role\', \'application\', \'agent\', \'apiKey\', \'workflow\')), CONSTRAINT "CHK_crmStageRule_shape" CHECK (("action" IN (\'read\', \'edit\') AND "optionValue" <> \'*\' AND "fromValue" = \'*\' AND "toValue" = \'*\') OR ("action" = \'transition\' AND "optionValue" = \'*\' AND "fromValue" <> \'*\' AND "toValue" <> \'*\') OR ("action" = \'configure\' AND "optionValue" = \'*\' AND "fromValue" = \'*\' AND "toValue" = \'*\')), CONSTRAINT "CHK_crmStageRule_values" CHECK (btrim("optionValue") = "optionValue" AND "optionValue" <> \'\' AND btrim("fromValue") = "fromValue" AND "fromValue" <> \'\' AND btrim("toValue") = "toValue" AND "toValue" <> \'\'), CONSTRAINT "CHK_crmStageRule_action" CHECK ("action" IN (\'read\', \'edit\', \'transition\', \'configure\')), CONSTRAINT "PK_76c5b3100d7e84539887cbddaed" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_crmStageRule_principal_field" ON "core"."crmStageRule" ("workspaceId", "principalKind", "principalId", "objectMetadataId", "fieldMetadataId", "action") ',
    );
    await queryRunner.query(
      'CREATE TABLE "core"."crmTeam" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" text NOT NULL, "revision" bigint NOT NULL DEFAULT \'1\', CONSTRAINT "UQ_crmTeam_workspace_name" UNIQUE ("workspaceId", "name"), CONSTRAINT "UQ_crmTeam_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_crmTeam_revision" CHECK ("revision" > 0), CONSTRAINT "CHK_crmTeam_name" CHECK (btrim("name") = "name" AND "name" <> \'\'), CONSTRAINT "PK_446ad057b973ab41284d2b1a73d" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE TABLE "core"."crmTeamMember" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspaceId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "teamId" uuid NOT NULL, "workspaceMemberId" uuid NOT NULL, "revision" bigint NOT NULL DEFAULT \'1\', CONSTRAINT "UQ_crmTeamMember_team_member" UNIQUE ("workspaceId", "teamId", "workspaceMemberId"), CONSTRAINT "UQ_crmTeamMember_workspace_id" UNIQUE ("workspaceId", "id"), CONSTRAINT "CHK_crmTeamMember_revision" CHECK ("revision" > 0), CONSTRAINT "PK_91c2efc09f26d6f9c17baf65983" PRIMARY KEY ("id"))',
    );
    await queryRunner.query(
      'CREATE INDEX "IDX_crmTeamMember_workspace_member" ON "core"."crmTeamMember" ("workspaceId", "workspaceMemberId") ',
    );

    await queryRunner.query(
      'ALTER TABLE "core"."crmAutomationArtifactScope" ADD CONSTRAINT "FK_08f4b81c4043144ea8f541b3a2d" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmAutomationArtifactScope" ADD CONSTRAINT "FK_3af4c29914f1c1fc2c9c99743f7" FOREIGN KEY ("workspaceId", "conversationId") REFERENCES "core"."omniConversation"("workspaceId","id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmQueueGrant" ADD CONSTRAINT "FK_64b288d52c7e2b89accd9c1ff5a" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmQueueGrant" ADD CONSTRAINT "FK_73c1c861fb9b97991266093247e" FOREIGN KEY ("workspaceId", "bindingId", "queueId") REFERENCES "core"."omniQueue"("workspaceId","bindingId","id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmRecordRevision" ADD CONSTRAINT "FK_f88186f3c5f6777a0c647c5de9c" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmResourceAssignment" ADD CONSTRAINT "FK_86b1af5c500aad320c40d43977d" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmResourceGrant" ADD CONSTRAINT "FK_871cd53af79f844673d17d794f3" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmStageRule" ADD CONSTRAINT "FK_805f60f9debc14efaf54ec5c58b" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmTeam" ADD CONSTRAINT "FK_d373552bee35234084718461a29" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmTeamMember" ADD CONSTRAINT "FK_e4ceaa1a2c208f6cd936b2af710" FOREIGN KEY ("workspaceId") REFERENCES "core"."workspace"("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."crmTeamMember" ADD CONSTRAINT "FK_1676f5b7ce406fcbdcddb9c42a9" FOREIGN KEY ("workspaceId", "teamId") REFERENCES "core"."crmTeam"("workspaceId","id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `LOCK TABLE ${CRM_ACCESS_TABLES.map((table) => `"core"."${table}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`,
    );

    for (const table of CRM_ACCESS_TABLES) {
      const existing: unknown[] = await queryRunner.query(
        `SELECT 1 FROM "core"."${table}" LIMIT 1`,
      );

      if (existing.length > 0) {
        throw new Error(
          'CRM_ACCESS_FOUNDATION_ROLLBACK_REQUIRES_RECONCILIATION',
        );
      }
    }

    for (const table of CRM_ACCESS_TABLES) {
      await queryRunner.query(`DROP TABLE "core"."${table}"`);
    }
  }
}
