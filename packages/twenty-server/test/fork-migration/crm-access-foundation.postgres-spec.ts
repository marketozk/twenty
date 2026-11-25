import { randomUUID } from 'node:crypto';

import { DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { ForkMigrationRunner } from 'src/database/commands/fork-upgrade/fork-migration-runner';
import { FORK_MIGRATIONS } from 'src/database/commands/fork-upgrade/fork-migrations';
import { CrmAutomationArtifactScopeEntity } from 'src/engine/core-modules/crm-access/entities/crm-automation-artifact-scope.entity';
import { CrmQueueGrantEntity } from 'src/engine/core-modules/crm-access/entities/crm-queue-grant.entity';
import { CrmRecordRevisionEntity } from 'src/engine/core-modules/crm-access/entities/crm-record-revision.entity';
import { CrmResourceAssignmentEntity } from 'src/engine/core-modules/crm-access/entities/crm-resource-assignment.entity';
import { CrmResourceGrantEntity } from 'src/engine/core-modules/crm-access/entities/crm-resource-grant.entity';
import { CrmStageRuleEntity } from 'src/engine/core-modules/crm-access/entities/crm-stage-rule.entity';
import { CrmTeamEntity } from 'src/engine/core-modules/crm-access/entities/crm-team.entity';
import { CrmTeamMemberEntity } from 'src/engine/core-modules/crm-access/entities/crm-team-member.entity';
import { CRM_ACCESS_PRINCIPAL_KINDS } from 'src/engine/core-modules/crm-access/types/crm-access-schema.types';
import { OmniAccountBindingEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-account-binding.entity';
import { OmniAutomationPolicyEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-automation-policy.entity';
import { OmniAutomationPolicyVersionEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-automation-policy-version.entity';
import { OmniConversationEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-conversation.entity';
import { OmniQueueEntity } from 'src/engine/core-modules/omnichannel-storage/entities/omni-queue.entity';
import { FORK_SCHEMA_CHECKS } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-checks';
import { ForkSchemaVerifier } from 'src/engine/core-modules/omnichannel-storage/migrations/fork-schema-verifier';

@Entity({ name: 'workspace', schema: 'core' })
class WorkspaceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;
}

@Entity({ name: 'connectedAccount', schema: 'core' })
class ConnectedAccountEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;
}

@Entity({ name: 'messageChannel', schema: 'core' })
class MessageChannelEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;
}

const url = process.env.FORK_MIGRATION_TEST_URL;

if (!url || !/^\/twenty_rob764_test_[a-f0-9]{16}$/.test(new URL(url).pathname)) {
  throw new Error('An isolated migration database is required');
}

const db = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  extra: { max: 3, statement_timeout: 10000 },
});

const stepMigrations = FORK_MIGRATIONS.slice(0, 11);
const stepChecks = FORK_SCHEMA_CHECKS.slice(0, 11);
const migration = FORK_MIGRATIONS[10];
const applyStep = () => new ForkMigrationRunner(db, stepMigrations).apply();
const verifyStep = () => new ForkSchemaVerifier(db, stepChecks).verifyReady();

type PgDriverError = {
  driverError?: {
    code?: string;
    constraint?: string;
    column?: string;
  };
};

const expectPgError = async (
  operation: Promise<unknown>,
  expectedCode: string,
  expectedConstraintOrColumn?: { constraint?: string; column?: string },
): Promise<void> => {
  let caught: unknown;

  try {
    await operation;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  const driverError = (caught as PgDriverError).driverError;

  expect(driverError?.code).toBe(expectedCode);

  if (expectedConstraintOrColumn?.constraint) {
    expect(driverError?.constraint).toBe(expectedConstraintOrColumn.constraint);
  }

  if (expectedConstraintOrColumn?.column) {
    expect(driverError?.column).toBe(expectedConstraintOrColumn.column);
  }
};

const seedBindingAndQueue = async (workspaceId: string, label: string) => {
  const connectedAccountId = randomUUID();
  const messageChannelId = randomUUID();
  const bindingId = randomUUID();
  const queueId = randomUUID();
  const policyId = randomUUID();
  const conversationId = randomUUID();
  const messageThreadId = randomUUID();

  await db.query('INSERT INTO core."connectedAccount"(id) VALUES ($1)', [
    connectedAccountId,
  ]);
  await db.query('INSERT INTO core."messageChannel"(id) VALUES ($1)', [
    messageChannelId,
  ]);
  await db.query(
    `INSERT INTO core."omniAccountBinding"
      (id, "workspaceId", platform, "connectorInstanceId", "accountId", "connectedAccountId", "messageChannelId", "capabilitiesVersion", capabilities)
     VALUES ($1, $2, 'telegram', 'conn-1', $3, $4, $5, 'v1', '{}')`,
    [
      bindingId,
      workspaceId,
      `acc-${label}-${workspaceId.slice(0, 8)}`,
      connectedAccountId,
      messageChannelId,
    ],
  );
  await db.query(
    `INSERT INTO core."omniQueue" (id, "workspaceId", "bindingId", name, active)
     VALUES ($1, $2, $3, $4, true)`,
    [queueId, workspaceId, bindingId, `Queue-${label}`],
  );
  await db.query(
    `INSERT INTO core."omniAutomationPolicy" (id, "workspaceId", "bindingId")
     VALUES ($1, $2, $3)`,
    [policyId, workspaceId, bindingId],
  );
  await db.query(
    `INSERT INTO core."omniAutomationPolicyVersion"
      ("workspaceId", "policyId", version, settings, "settingsHash", "publishedBy", "publishedAt")
     VALUES ($1, $2, 0, '{}', $3, '{}', now())`,
    [workspaceId, policyId, 'a'.repeat(64)],
  );
  await db.query(
    `INSERT INTO core."omniConversation"
      (id, "workspaceId", "bindingId", "providerChatId", "messageThreadId", "queueId", "policyId", "policyVersion")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
    [
      conversationId,
      workspaceId,
      bindingId,
      `chat-${label}`,
      messageThreadId,
      queueId,
      policyId,
    ],
  );

  return {
    workspaceId,
    bindingId,
    queueId,
    conversationId,
  };
};

const seedWorkspaceGraph = async (workspaceId: string) => {
  await db.query('INSERT INTO core.workspace(id) VALUES ($1)', [workspaceId]);

  return seedBindingAndQueue(workspaceId, 'primary');
};

beforeAll(async () => {
  await db.initialize();
  await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
});

beforeEach(async () => {
  await db.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
  await db.query('DROP SCHEMA IF EXISTS core CASCADE');
  await db.query('CREATE SCHEMA core');
  await db.query(
    'CREATE TABLE core.workspace(id uuid PRIMARY KEY DEFAULT uuid_generate_v4())',
  );
  await db.query(
    'CREATE TABLE core."connectedAccount"(id uuid PRIMARY KEY DEFAULT uuid_generate_v4())',
  );
  await db.query(
    'CREATE TABLE core."messageChannel"(id uuid PRIMARY KEY DEFAULT uuid_generate_v4())',
  );
  await new ForkMigrationRunner(db, FORK_MIGRATIONS.slice(0, 10)).apply();
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  if (db.isInitialized) {
    await db.destroy();
  }
});

describe('crm-access foundation fork migration #11', () => {
  it('upgrades a populated ten-step prefix cleanly, replays idempotently, and preserves existing rows', async () => {
    const workspaceId = randomUUID();
    const graph = await seedWorkspaceGraph(workspaceId);

    await db.query(
      'CREATE TABLE core.existing_crm(id integer PRIMARY KEY, name text)',
    );
    await db.query("INSERT INTO core.existing_crm VALUES (1, 'retained CRM')");

    await expect(verifyStep()).rejects.toThrow('Pending fork migrations');
    expect(await applyStep()).toEqual([migration.migrationId]);
    expect(await applyStep()).toEqual([]);
    await verifyStep();

    expect(await db.query('SELECT * FROM core.existing_crm')).toEqual([
      { id: 1, name: 'retained CRM' },
    ]);
    expect(
      await db.query(
        'SELECT id FROM core."omniConversation" WHERE id = $1',
        [graph.conversationId],
      ),
    ).toEqual([{ id: graph.conversationId }]);
  });

  it('applies all eleven migrations from a fresh core schema and produces zero TypeORM SchemaBuilder diff', async () => {
    await db.query('DROP SCHEMA IF EXISTS crm_audit CASCADE');
    await db.query('DROP SCHEMA IF EXISTS core CASCADE');
    await db.query('CREATE SCHEMA core');
    await db.query(
      'CREATE TABLE core.workspace(id uuid PRIMARY KEY DEFAULT uuid_generate_v4())',
    );
    await db.query(
      'CREATE TABLE core."connectedAccount"(id uuid PRIMARY KEY DEFAULT uuid_generate_v4())',
    );
    await db.query(
      'CREATE TABLE core."messageChannel"(id uuid PRIMARY KEY DEFAULT uuid_generate_v4())',
    );

    const applied = await applyStep();

    expect(applied).toHaveLength(11);
    expect(applied[10]).toBe(migration.migrationId);
    await verifyStep();

    const metadataSource = new DataSource({
      type: 'postgres',
      url,
      synchronize: false,
      migrationsRun: false,
      entities: [
        WorkspaceEntity,
        ConnectedAccountEntity,
        MessageChannelEntity,
        OmniAccountBindingEntity,
        OmniQueueEntity,
        OmniAutomationPolicyEntity,
        OmniAutomationPolicyVersionEntity,
        OmniConversationEntity,
        CrmTeamEntity,
        CrmTeamMemberEntity,
        CrmResourceAssignmentEntity,
        CrmResourceGrantEntity,
        CrmStageRuleEntity,
        CrmQueueGrantEntity,
        CrmRecordRevisionEntity,
        CrmAutomationArtifactScopeEntity,
      ],
    });

    try {
      await metadataSource.initialize();
      const diff = await metadataSource.driver.createSchemaBuilder().log();
      const crmDiffs = diff.upQueries
        .map((entry) => entry.query)
        .filter((query) => query.includes('"crm'));

      expect(crmDiffs).toEqual([]);
    } finally {
      if (metadataSource.isInitialized) {
        await metadataSource.destroy();
      }
    }
  });

  it('enforces crmTeam and crmTeamMember tenant isolation, trimmed names, checks, and RESTRICT FK', async () => {
    await applyStep();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const teamA = randomUUID();
    const memberId = randomUUID();

    await db.query('INSERT INTO core.workspace(id) VALUES ($1), ($2)', [
      workspaceA,
      workspaceB,
    ]);
    await db.query(
      'INSERT INTO core."crmTeam" (id, "workspaceId", name) VALUES ($1, $2, $3)',
      [teamA, workspaceA, 'Sales'],
    );
    await db.query(
      'INSERT INTO core."crmTeam" ("workspaceId", name) VALUES ($1, $2)',
      [workspaceB, 'Sales'],
    );

    await expectPgError(
      db.query(
        'INSERT INTO core."crmTeam" ("workspaceId", name) VALUES ($1, $2)',
        [workspaceA, 'Sales'],
      ),
      '23505',
      { constraint: 'UQ_crmTeam_workspace_name' },
    );
    await expectPgError(
      db.query(
        'INSERT INTO core."crmTeam" ("workspaceId", name) VALUES ($1, $2)',
        [workspaceA, '   '],
      ),
      '23514',
      { constraint: 'CHK_crmTeam_name' },
    );
    await expectPgError(
      db.query(
        'INSERT INTO core."crmTeam" ("workspaceId", name) VALUES ($1, $2)',
        [workspaceA, ' Sales '],
      ),
      '23514',
      { constraint: 'CHK_crmTeam_name' },
    );
    await expectPgError(
      db.query(
        'INSERT INTO core."crmTeam" ("workspaceId", name, revision) VALUES ($1, $2, 0)',
        [workspaceA, 'Ops'],
      ),
      '23514',
      { constraint: 'CHK_crmTeam_revision' },
    );

    // Cross-workspace FK rejected even though teamA exists in workspaceA.
    await expectPgError(
      db.query(
        'INSERT INTO core."crmTeamMember" ("workspaceId", "teamId", "workspaceMemberId") VALUES ($1, $2, $3)',
        [workspaceB, teamA, memberId],
      ),
      '23503',
      { constraint: 'FK_1676f5b7ce406fcbdcddb9c42a9' },
    );

    await db.query(
      'INSERT INTO core."crmTeamMember" ("workspaceId", "teamId", "workspaceMemberId") VALUES ($1, $2, $3)',
      [workspaceA, teamA, memberId],
    );
    await expectPgError(
      db.query(
        'INSERT INTO core."crmTeamMember" ("workspaceId", "teamId", "workspaceMemberId") VALUES ($1, $2, $3)',
        [workspaceA, teamA, memberId],
      ),
      '23505',
      { constraint: 'UQ_crmTeamMember_team_member' },
    );
    await expectPgError(
      db.query(
        'INSERT INTO core."crmTeamMember" ("workspaceId", "teamId", "workspaceMemberId", revision) VALUES ($1, $2, $3, 0)',
        [workspaceA, teamA, randomUUID()],
      ),
      '23514',
      { constraint: 'CHK_crmTeamMember_revision' },
    );
    await expectPgError(
      db.query('DELETE FROM core."crmTeam" WHERE id = $1', [teamA]),
      '23503',
      { constraint: 'FK_1676f5b7ce406fcbdcddb9c42a9' },
    );
  });

  it('enforces single primary_owner partial unique index, trimmed resourceKind, and closed assignment kinds', async () => {
    await applyStep();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const resourceId = randomUUID();
    const memberA = randomUUID();
    const memberB = randomUUID();
    const teamA = randomUUID();
    const teamB = randomUUID();

    await db.query('INSERT INTO core.workspace(id) VALUES ($1), ($2)', [
      workspaceA,
      workspaceB,
    ]);

    await db.query(
      `INSERT INTO core."crmResourceAssignment"
        ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
       VALUES ($1, 'opportunity', $2, 'workspaceMember', $3, 'primary_owner')`,
      [workspaceA, resourceId, memberA],
    );

    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceAssignment"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
         VALUES ($1, 'opportunity', $2, 'workspaceMember', $3, 'primary_owner')`,
        [workspaceA, resourceId, memberB],
      ),
      '23505',
      { constraint: 'UQ_crmResourceAssignment_primary_owner' },
    );

    // Leading/trailing whitespace cannot bypass UQ_crmResourceAssignment_primary_owner.
    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceAssignment"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
         VALUES ($1, ' opportunity ', $2, 'workspaceMember', $3, 'primary_owner')`,
        [workspaceA, resourceId, memberB],
      ),
      '23514',
      { constraint: 'CHK_crmResourceAssignment_resourceKind' },
    );

    await db.query(
      `INSERT INTO core."crmResourceAssignment"
        ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
       VALUES ($1, 'opportunity', $2, 'team', $3, 'team'),
              ($1, 'opportunity', $2, 'team', $4, 'team')`,
      [workspaceA, resourceId, teamA, teamB],
    );

    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceAssignment"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
         VALUES ($1, 'opportunity', $2, 'team', $3, 'team')`,
        [workspaceA, resourceId, teamA],
      ),
      '23505',
      { constraint: 'UQ_crmResourceAssignment_assignment' },
    );

    await db.query(
      `INSERT INTO core."crmResourceAssignment"
        ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
       VALUES ($1, 'opportunity', $2, 'workspaceMember', $3, 'primary_owner'),
              ($4, 'company', $2, 'workspaceMember', $3, 'primary_owner')`,
      [workspaceB, resourceId, memberB, workspaceA],
    );

    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceAssignment"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
         VALUES ($1, 'person', $2, 'team', $3, 'primary_owner')`,
        [workspaceA, randomUUID(), teamA],
      ),
      '23514',
      { constraint: 'CHK_crmResourceAssignment_principal' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceAssignment"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
         VALUES ($1, 'person', $2, 'workspaceMember', $3, 'team')`,
        [workspaceA, randomUUID(), memberA],
      ),
      '23514',
      { constraint: 'CHK_crmResourceAssignment_principal' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceAssignment"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind")
         VALUES ($1, 'person', $2, 'workspaceMember', $3, 'collaborator')`,
        [workspaceA, randomUUID(), memberA],
      ),
      '23514',
      { constraint: 'CHK_crmResourceAssignment_kind' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceAssignment"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", "assignmentKind", revision)
         VALUES ($1, 'person', $2, 'workspaceMember', $3, 'primary_owner', 0)`,
        [workspaceA, randomUUID(), memberA],
      ),
      '23514',
      { constraint: 'CHK_crmResourceAssignment_revision' },
    );
  });

  it('enforces crmResourceGrant uniqueness, trimmed keys, and closed principalKind/effect domains', async () => {
    await applyStep();
    const workspaceId = randomUUID();
    const resourceId = randomUUID();
    const principalId = randomUUID();

    await db.query('INSERT INTO core.workspace(id) VALUES ($1)', [workspaceId]);

    for (const principalKind of CRM_ACCESS_PRINCIPAL_KINDS) {
      await db.query(
        `INSERT INTO core."crmResourceGrant"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", action, effect)
         VALUES ($1, 'opportunity', $2, $3, $4, 'read', 'allow')`,
        [workspaceId, resourceId, principalKind, randomUUID()],
      );
    }

    await db.query(
      `INSERT INTO core."crmResourceGrant"
        ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", action, effect)
       VALUES ($1, 'opportunity', $2, 'workspaceMember', $3, 'update', 'deny')`,
      [workspaceId, resourceId, principalId],
    );

    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceGrant"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", action, effect)
         VALUES ($1, 'opportunity', $2, 'workspaceMember', $3, 'update', 'allow')`,
        [workspaceId, resourceId, principalId],
      ),
      '23505',
      { constraint: 'UQ_crmResourceGrant_grant' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceGrant"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", action, effect)
         VALUES ($1, 'opportunity', $2, 'guest', $3, 'read', 'allow')`,
        [workspaceId, resourceId, principalId],
      ),
      '23514',
      { constraint: 'CHK_crmResourceGrant_principalKind' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceGrant"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", action, effect)
         VALUES ($1, 'opportunity', $2, 'role', $3, 'read', 'permit')`,
        [workspaceId, resourceId, principalId],
      ),
      '23514',
      { constraint: 'CHK_crmResourceGrant_effect' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmResourceGrant"
          ("workspaceId", "resourceKind", "resourceId", "principalKind", "principalId", action, effect)
         VALUES ($1, 'opportunity', $2, 'role', $3, ' read ', 'allow')`,
        [workspaceId, resourceId, principalId],
      ),
      '23514',
      { constraint: 'CHK_crmResourceGrant_action' },
    );
  });

  it('enforces crmStageRule action shapes without NULL, whitespace, or wildcard ambiguity (T30)', async () => {
    await applyStep();
    const workspaceId = randomUUID();
    const objectMetadataId = randomUUID();
    const fieldMetadataId = randomUUID();
    const principalId = randomUUID();

    await db.query('INSERT INTO core.workspace(id) VALUES ($1)', [workspaceId]);

    const validRules: Array<[string, string, string, string, string, string]> =
      [
        ['read', 'QUALIFIED', '*', '*', 'role', 'allow'],
        ['edit', 'QUALIFIED', '*', '*', 'apiKey', 'deny'],
        ['transition', '*', 'NEW', 'QUALIFIED', 'role', 'allow'],
        ['configure', '*', '*', '*', 'workflow', 'allow'],
      ];

    for (const [
      action,
      optionValue,
      fromValue,
      toValue,
      principalKind,
      effect,
    ] of validRules) {
      await db.query(
        `INSERT INTO core."crmStageRule"
          ("workspaceId", "objectMetadataId", "fieldMetadataId", action, "optionValue", "fromValue", "toValue", "principalKind", "principalId", effect)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          workspaceId,
          objectMetadataId,
          fieldMetadataId,
          action,
          optionValue,
          fromValue,
          toValue,
          principalKind,
          principalId,
          effect,
        ],
      );
    }

    await expectPgError(
      db.query(
        `INSERT INTO core."crmStageRule"
          ("workspaceId", "objectMetadataId", "fieldMetadataId", action, "optionValue", "fromValue", "toValue", "principalKind", "principalId", effect)
         VALUES ($1, $2, $3, 'transition', '*', 'NEW', 'QUALIFIED', 'role', $4, 'deny')`,
        [workspaceId, objectMetadataId, fieldMetadataId, principalId],
      ),
      '23505',
      { constraint: 'UQ_crmStageRule_rule' },
    );

    const invalidShapes: Array<[string, string, string, string, string]> = [
      ['read', '*', '*', '*', 'CHK_crmStageRule_shape'],
      ['read', 'NEW', 'NEW', '*', 'CHK_crmStageRule_shape'],
      ['edit', 'NEW', '*', 'QUALIFIED', 'CHK_crmStageRule_shape'],
      ['transition', 'NEW', 'NEW', 'QUALIFIED', 'CHK_crmStageRule_shape'],
      ['transition', '*', '*', 'QUALIFIED', 'CHK_crmStageRule_shape'],
      ['transition', '*', 'NEW', '*', 'CHK_crmStageRule_shape'],
      ['configure', 'NEW', '*', '*', 'CHK_crmStageRule_shape'],
      ['configure', '*', 'NEW', '*', 'CHK_crmStageRule_shape'],
      ['read', ' * ', '*', '*', 'CHK_crmStageRule_values'],
      ['read', '   ', '*', '*', 'CHK_crmStageRule_values'],
      ['delete', 'NEW', '*', '*', 'CHK_crmStageRule_action'],
    ];

    for (const [
      action,
      optionValue,
      fromValue,
      toValue,
      expectedConstraint,
    ] of invalidShapes) {
      await expectPgError(
        db.query(
          `INSERT INTO core."crmStageRule"
            ("workspaceId", "objectMetadataId", "fieldMetadataId", action, "optionValue", "fromValue", "toValue", "principalKind", "principalId", effect)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'role', $8, 'allow')`,
          [
            workspaceId,
            objectMetadataId,
            fieldMetadataId,
            action,
            optionValue,
            fromValue,
            toValue,
            randomUUID(),
          ],
        ),
        '23514',
        { constraint: expectedConstraint },
      );
    }

    // NULL values are rejected by NOT NULL constraints.
    await expectPgError(
      db.query(
        `INSERT INTO core."crmStageRule"
          ("workspaceId", "objectMetadataId", "fieldMetadataId", action, "optionValue", "fromValue", "toValue", "principalKind", "principalId", effect)
         VALUES ($1, $2, $3, 'transition', NULL, 'NEW', 'QUALIFIED', 'role', $4, 'allow')`,
        [workspaceId, objectMetadataId, fieldMetadataId, randomUUID()],
      ),
      '23502',
      { column: 'optionValue' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmStageRule"
          ("workspaceId", "objectMetadataId", "fieldMetadataId", action, "optionValue", "fromValue", "toValue", "principalKind", "principalId", effect)
         VALUES ($1, $2, $3, 'read', 'NEW', NULL, '*', 'role', $4, 'allow')`,
        [workspaceId, objectMetadataId, fieldMetadataId, randomUUID()],
      ),
      '23502',
      { column: 'fromValue' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmStageRule"
          ("workspaceId", "objectMetadataId", "fieldMetadataId", action, "optionValue", "fromValue", "toValue", "principalKind", "principalId", effect)
         VALUES ($1, $2, $3, 'read', 'NEW', '*', '*', 'invalid', $4, 'allow')`,
        [workspaceId, objectMetadataId, fieldMetadataId, randomUUID()],
      ),
      '23514',
      { constraint: 'CHK_crmStageRule_principalKind' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmStageRule"
          ("workspaceId", "objectMetadataId", "fieldMetadataId", action, "optionValue", "fromValue", "toValue", "principalKind", "principalId", effect, revision)
         VALUES ($1, $2, $3, 'read', 'NEW', '*', '*', 'role', $4, 'allow', 0)`,
        [workspaceId, objectMetadataId, fieldMetadataId, randomUUID()],
      ),
      '23514',
      { constraint: 'CHK_crmStageRule_revision' },
    );
  });

  it('enforces crmQueueGrant 3-column FK, crmRecordRevision CAS, and crmAutomationArtifactScope FKs and checks', async () => {
    await applyStep();
    const graphA = await seedWorkspaceGraph(randomUUID());
    const graphASecondBinding = await seedBindingAndQueue(
      graphA.workspaceId,
      'secondary',
    );
    const graphB = await seedWorkspaceGraph(randomUUID());
    const principalId = randomUUID();

    await db.query(
      `INSERT INTO core."crmQueueGrant"
        ("workspaceId", "bindingId", "queueId", "principalKind", "principalId", action, effect)
       VALUES ($1, $2, $3, 'team', $4, 'claim', 'allow')`,
      [graphA.workspaceId, graphA.bindingId, graphA.queueId, principalId],
    );
    // Duplicate grant rejected.
    await expectPgError(
      db.query(
        `INSERT INTO core."crmQueueGrant"
          ("workspaceId", "bindingId", "queueId", "principalKind", "principalId", action, effect)
         VALUES ($1, $2, $3, 'team', $4, 'claim', 'deny')`,
        [graphA.workspaceId, graphA.bindingId, graphA.queueId, principalId],
      ),
      '23505',
      { constraint: 'UQ_crmQueueGrant_grant' },
    );
    // Same workspace but mismatched bindingId rejected by 3-column composite FK.
    await expectPgError(
      db.query(
        `INSERT INTO core."crmQueueGrant"
          ("workspaceId", "bindingId", "queueId", "principalKind", "principalId", action, effect)
         VALUES ($1, $2, $3, 'team', $4, 'read', 'allow')`,
        [
          graphA.workspaceId,
          graphASecondBinding.bindingId,
          graphA.queueId,
          principalId,
        ],
      ),
      '23503',
      { constraint: 'FK_73c1c861fb9b97991266093247e' },
    );
    // Cross-workspace rejected by composite FK.
    await expectPgError(
      db.query(
        `INSERT INTO core."crmQueueGrant"
          ("workspaceId", "bindingId", "queueId", "principalKind", "principalId", action, effect)
         VALUES ($1, $2, $3, 'team', $4, 'claim', 'allow')`,
        [graphB.workspaceId, graphA.bindingId, graphA.queueId, principalId],
      ),
      '23503',
      { constraint: 'FK_73c1c861fb9b97991266093247e' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmQueueGrant"
          ("workspaceId", "bindingId", "queueId", "principalKind", "principalId", action, effect)
         VALUES ($1, $2, $3, 'team', $4, ' claim ', 'allow')`,
        [graphA.workspaceId, graphA.bindingId, graphA.queueId, randomUUID()],
      ),
      '23514',
      { constraint: 'CHK_crmQueueGrant_action' },
    );
    // Dedicated queue without conversations proves crmQueueGrant RESTRICT FK specifically blocks queue deletion.
    const grantOnlyQueueId = randomUUID();

    await db.query(
      `INSERT INTO core."omniQueue" (id, "workspaceId", "bindingId", name, active)
       VALUES ($1, $2, $3, 'GrantOnlyQueue', true)`,
      [grantOnlyQueueId, graphA.workspaceId, graphA.bindingId],
    );
    await db.query(
      `INSERT INTO core."crmQueueGrant"
        ("workspaceId", "bindingId", "queueId", "principalKind", "principalId", action, effect)
       VALUES ($1, $2, $3, 'team', $4, 'claim', 'allow')`,
      [graphA.workspaceId, graphA.bindingId, grantOnlyQueueId, principalId],
    );
    await expectPgError(
      db.query('DELETE FROM core."omniQueue" WHERE id = $1', [
        grantOnlyQueueId,
      ]),
      '23503',
      { constraint: 'FK_73c1c861fb9b97991266093247e' },
    );

    // crmRecordRevision conflict-safe CAS bump (§15.17).
    const objectMetadataId = randomUUID();
    const recordId = randomUUID();

    await db.query(
      `INSERT INTO core."crmRecordRevision" ("workspaceId", "objectMetadataId", "recordId", revision)
       VALUES ($1, $2, $3, 1)`,
      [graphA.workspaceId, objectMetadataId, recordId],
    );
    const bumped = await db.query<{ revision: string }[]>(
      `INSERT INTO core."crmRecordRevision" ("workspaceId", "objectMetadataId", "recordId", revision)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT ("workspaceId", "objectMetadataId", "recordId")
       DO UPDATE SET revision = core."crmRecordRevision".revision + 1, "updatedAt" = now()
       RETURNING revision`,
      [graphA.workspaceId, objectMetadataId, recordId],
    );

    expect(bumped).toEqual([{ revision: '2' }]);
    await expectPgError(
      db.query(
        `INSERT INTO core."crmRecordRevision" ("workspaceId", "objectMetadataId", "recordId", revision)
         VALUES ($1, $2, $3, 0)`,
        [graphA.workspaceId, objectMetadataId, randomUUID()],
      ),
      '23514',
      { constraint: 'CHK_crmRecordRevision_revision' },
    );

    // crmAutomationArtifactScope (§15.12).
    const artifactId = randomUUID();

    await db.query(
      `INSERT INTO core."crmAutomationArtifactScope"
        ("workspaceId", "artifactKind", "artifactId", "conversationId", "referenceId", "capturedResourceScope")
       VALUES ($1, 'workflowRun', $2, $3, NULL, '{"parents":[]}')`,
      [graphA.workspaceId, artifactId, graphA.conversationId],
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmAutomationArtifactScope"
          ("workspaceId", "artifactKind", "artifactId", "conversationId", "capturedResourceScope")
         VALUES ($1, 'workflowRun', $2, $3, '{}')`,
        [graphA.workspaceId, artifactId, graphA.conversationId],
      ),
      '23505',
      { constraint: 'UQ_crmAutomationArtifactScope_artifact' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmAutomationArtifactScope"
          ("workspaceId", "artifactKind", "artifactId", "conversationId", "capturedResourceScope")
         VALUES ($1, ' workflowRun ', $2, $3, '{}')`,
        [graphA.workspaceId, randomUUID(), graphA.conversationId],
      ),
      '23514',
      { constraint: 'CHK_crmAutomationArtifactScope_kind' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmAutomationArtifactScope"
          ("workspaceId", "artifactKind", "artifactId", "conversationId", "capturedResourceScope")
         VALUES ($1, 'workflowRun', $2, $3, '[]')`,
        [graphA.workspaceId, randomUUID(), graphA.conversationId],
      ),
      '23514',
      { constraint: 'CHK_crmAutomationArtifactScope_scope' },
    );
    await expectPgError(
      db.query(
        `INSERT INTO core."crmAutomationArtifactScope"
          ("workspaceId", "artifactKind", "artifactId", "conversationId", "capturedResourceScope")
         VALUES ($1, 'workflowRun', $2, $3, '{}')`,
        [graphB.workspaceId, randomUUID(), graphA.conversationId],
      ),
      '23503',
      { constraint: 'FK_3af4c29914f1c1fc2c9c99743f7' },
    );
    await expectPgError(
      db.query('DELETE FROM core."omniConversation" WHERE id = $1', [
        graphA.conversationId,
      ]),
      '23503',
      { constraint: 'FK_3af4c29914f1c1fc2c9c99743f7' },
    );
  });

  it('rolls DDL and ledger back atomically on failure mid-migration', async () => {
    const originalUp = migration.command.up.bind(migration.command);

    jest
      .spyOn(migration.command, 'up')
      .mockImplementation(async (queryRunner) => {
        await originalUp(queryRunner);
        await queryRunner.query('SELECT 1 / 0');
      });

    await expect(applyStep()).rejects.toThrow();
    expect(
      await db.query(
        'SELECT 1 FROM core."forkMigrationLedger" WHERE "migrationId" = $1',
        [migration.migrationId],
      ),
    ).toEqual([]);
    expect(
      await db.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'core' AND table_name LIKE 'crm%'`,
      ),
    ).toEqual([]);
    await new ForkSchemaVerifier(
      db,
      FORK_SCHEMA_CHECKS.slice(0, 10),
    ).verifyReady();
  });

  it('refuses an unexplained pre-existing table without its committed manifest step', async () => {
    await db.transaction((manager) =>
      migration.command.up(manager.queryRunner!),
    );
    await expect(applyStep()).rejects.toThrow();
    expect(
      await db.query(
        'SELECT 1 FROM core."forkMigrationLedger" WHERE "migrationId" = $1',
        [migration.migrationId],
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'dropped primary_owner partial index',
      async () => {
        await db.query(
          'DROP INDEX core."UQ_crmResourceAssignment_primary_owner"',
        );
      },
    ],
    [
      'primary_owner index without WHERE predicate',
      async () => {
        await db.query(
          'DROP INDEX core."UQ_crmResourceAssignment_primary_owner"',
        );
        await db.query(
          'CREATE UNIQUE INDEX "UQ_crmResourceAssignment_primary_owner" ON core."crmResourceAssignment" ("workspaceId", "resourceKind", "resourceId")',
        );
      },
    ],
    [
      'altered crmStageRule shape check',
      async () => {
        await db.query(
          'ALTER TABLE core."crmStageRule" DROP CONSTRAINT "CHK_crmStageRule_shape"',
        );
        await db.query(
          'ALTER TABLE core."crmStageRule" ADD CONSTRAINT "CHK_crmStageRule_shape" CHECK ("optionValue" <> \'\')',
        );
      },
    ],
  ])('rejects schema drift: %s', async (_label, tamper) => {
    await applyStep();
    await tamper();
    await expect(verifyStep()).rejects.toThrow(
      'CRM access foundation schema does not match its manifest',
    );
  });

  it('refuses destructive down when any crm-access table contains operational rows', async () => {
    await applyStep();
    const workspaceId = randomUUID();

    await db.query('INSERT INTO core.workspace(id) VALUES ($1)', [workspaceId]);
    await db.query(
      'INSERT INTO core."crmTeam" ("workspaceId", name) VALUES ($1, $2)',
      [workspaceId, 'Protected Team'],
    );

    await expect(
      db.transaction((manager) => migration.command.down(manager.queryRunner!)),
    ).rejects.toThrow('CRM_ACCESS_FOUNDATION_ROLLBACK_REQUIRES_RECONCILIATION');

    expect(
      await db.query('SELECT name FROM core."crmTeam" WHERE "workspaceId" = $1', [
        workspaceId,
      ]),
    ).toEqual([{ name: 'Protected Team' }]);
    await verifyStep();
  });

  it('drops all eight empty tables cleanly on down and re-applies cleanly', async () => {
    const graph = await seedWorkspaceGraph(randomUUID());

    await applyStep();
    await db.transaction(async (manager) => {
      await migration.command.down(manager.queryRunner!);
      await manager.query(
        'DELETE FROM core."forkMigrationLedger" WHERE "migrationId" = $1',
        [migration.migrationId],
      );
    });

    await new ForkSchemaVerifier(
      db,
      FORK_SCHEMA_CHECKS.slice(0, 10),
    ).verifyReady();
    expect(
      await db.query(
        'SELECT id FROM core."omniConversation" WHERE id = $1',
        [graph.conversationId],
      ),
    ).toEqual([{ id: graph.conversationId }]);

    expect(await applyStep()).toEqual([migration.migrationId]);
    await verifyStep();
  });
});
