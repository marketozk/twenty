import { randomUUID } from 'node:crypto';
import { type QueryRunner } from 'typeorm';

import {
  captureCrmAuditOperation,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { projectUnsubscribeTopic } from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { UnsubscribeTopicVisibility } from 'src/engine/core-modules/emailing-domain/types/unsubscribe-topic-visibility.type';
import { generateSeedId } from 'src/engine/workspace-manager/dev-seeder/core/utils/generate-seed-id.util';

const tableName = 'unsubscribeTopic';

const UNSUBSCRIBE_TOPIC_SEEDS = [
  {
    seedName: 'unsubscribe-topic-product-updates',
    name: 'Product updates',
    description: 'New features, improvements and release notes',
    visibility: UnsubscribeTopicVisibility.PUBLIC,
  },
  {
    seedName: 'unsubscribe-topic-newsletter',
    name: 'Monthly newsletter',
    description: 'A monthly digest of company news',
    visibility: UnsubscribeTopicVisibility.PUBLIC,
  },
  {
    seedName: 'unsubscribe-topic-events',
    name: 'Events and webinars',
    description: 'Invitations to live events and webinars',
    visibility: UnsubscribeTopicVisibility.PUBLIC,
  },
] as const;

export type SeededUnsubscribeTopicName =
  (typeof UNSUBSCRIBE_TOPIC_SEEDS)[number]['seedName'];

export const getSeededUnsubscribeTopicIds = (
  workspaceId: string,
): Record<SeededUnsubscribeTopicName, string> =>
  Object.fromEntries(
    UNSUBSCRIBE_TOPIC_SEEDS.map(({ seedName }) => [
      seedName,
      generateSeedId(workspaceId, seedName),
    ]),
  ) as Record<SeededUnsubscribeTopicName, string>;

type SeedUnsubscribeTopicsArgs = {
  queryRunner: QueryRunner;
  schemaName: string;
  workspaceId: string;
};

export const seedUnsubscribeTopics = async ({
  queryRunner,
  schemaName,
  workspaceId,
}: SeedUnsubscribeTopicsArgs) => {
  const topicIds = getSeededUnsubscribeTopicIds(workspaceId);

  const existingRows: Array<{ id: string }> = await queryRunner.query(
    `SELECT id FROM ${schemaName}."${tableName}" WHERE "workspaceId"=$1`,
    [workspaceId],
  );
  const existingIds = new Set(
    existingRows.map((row) => String(row.id).toLowerCase()),
  );

  await queryRunner.manager
    .createQueryBuilder()
    .insert()
    .into(`${schemaName}.${tableName}`, [
      'id',
      'workspaceId',
      'name',
      'description',
      'visibility',
    ])
    .orIgnore()
    .values(
      UNSUBSCRIBE_TOPIC_SEEDS.map(
        ({ seedName, name, description, visibility }) => ({
          id: topicIds[seedName],
          workspaceId,
          name,
          description,
          visibility,
        }),
      ),
    )
    .execute();

  const [auditReg] = await queryRunner.query(
    `SELECT to_regclass('crm_audit."crmAuditEntry"') IS NOT NULL AS "hasAudit"`,
  );
  if (auditReg?.hasAudit === true) {
    const afterEntries: Array<{ row: Record<string, unknown> }> =
      await queryRunner.query(
        `SELECT to_jsonb(ut) AS row FROM ${schemaName}."${tableName}" ut WHERE ut."workspaceId"=$1 ORDER BY ut.id ASC`,
        [workspaceId],
      );
    const createdRows = afterEntries
      .map((entry) => entry.row)
      .filter((row) => !existingIds.has(String(row.id).toLowerCase()));
    if (createdRows.length > 0) {
      const operation = captureCrmAuditOperation({
        workspaceId,
        operationId: randomUUID(),
        actor: {
          kind: 'system',
          id: 'dev-seeder:seed-unsubscribe-topics',
        },
        correlationId: randomUUID(),
      });
      const audit = new CrmAuditTransactionContext(queryRunner, operation);
      for (const row of createdRows) {
        const resourceId = String(row.id).toLowerCase();
        audit.record({
          resourceKind: 'unsubscribeTopic',
          resourceId,
          action: 'create',
          before: null,
          after: projectUnsubscribeTopic(row),
          securityDescriptor: {
            resourceKind: 'unsubscribeTopic',
            resourceId,
            metadataAccess: 'currentWorkspaceAdministration',
          },
        });
      }
      await audit.flush();
    }
  }
};
