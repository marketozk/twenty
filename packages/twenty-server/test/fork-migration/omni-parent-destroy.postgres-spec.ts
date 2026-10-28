import { randomUUID } from 'node:crypto';
import { CrmAuditTransactionContext } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditMutation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import {
  type OmniParentDestroyCommand,
  type OmniParentDestroyAuthorizer,
} from 'src/modules/omnichannel/services/destroy-omni-crm-parent';
import { createOmniHistoryApplyFixture } from 'test/fork-migration/omni-history-apply.fixture';
jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock('src/modules/match-participant/match-participant.service', () => ({
  MatchParticipantService: class {},
}));
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/message-queue.service',
  () => ({ MessageQueueService: class {} }),
);
jest.mock(
  'src/modules/contact-creation-manager/jobs/create-company-and-contact.job',
  () => ({ CreateCompanyAndContactJob: class {} }),
);
jest.mock(
  'src/modules/messaging/message-import-manager/services/messaging-message-folder-association.service',
  () => ({ MessagingMessageFolderAssociationService: class {} }),
);

const fixture = createOmniHistoryApplyFixture({
  includeTargets: true,
  includeCrmTargets: true,
  useStandardForeignKeyActions: true,
});
let context: Awaited<ReturnType<typeof fixture.reset>>;
let metadata: Record<string, string>, records: Record<string, string>;
const principal = () => ({
  workspaceId: fixture.workspaceId,
  actor: context.principal.actor,
});
const core = (name: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${name}" ORDER BY id`);
const audits = (): Promise<Record<string, unknown>[]> =>
  fixture.owner.query('SELECT * FROM crm_audit."crmAuditEntry" ORDER BY id');
const authorize: OmniParentDestroyAuthorizer = async (_scope, facts) => {
  if (
    facts.workspaceId !== fixture.workspaceId ||
    facts.requiredPermission !== 'workspace.administration.destroyCrmParent'
  )
    throw new Error('DENIED');
};
const command = async (
  name: 'person' | 'company',
  key = randomUUID(),
): Promise<OmniParentDestroyCommand> => ({
  objectMetadataId: metadata[name],
  recordId: records[name],
  idempotencyKey: key,
  expectedParentFingerprint: (
    await fixture.owner.query(
      `SELECT encode(sha256(convert_to(to_jsonb(parent)::text,'UTF8')),'hex') AS fingerprint FROM "${fixture.schemaName}"."${name}" parent WHERE id=$1`,
      [records[name]],
    )
  )[0].fingerprint,
  expectedIdentities: (await core('omniExternalIdentity'))
    .filter((row) => name === 'person' && row.personId === records[name])
    .map((row) => ({ id: String(row.id), revision: String(row.revision) })),
  expectedTargets: (await core('omniConversationTarget'))
    .filter(
      (row) =>
        row.objectMetadataId === metadata[name] &&
        row.recordId === records[name],
    )
    .map((row) => ({ id: String(row.id), revision: String(row.revision) })),
});
const destroy = (input: OmniParentDestroyCommand, auth = authorize) =>
  fixture.service.destroyOmniCrmParent(principal(), input, auth);
const target = (name: 'person' | 'company', active = true, revision = '0') =>
  fixture.service.setOmniConversationTarget(
    principal(),
    {
      bindingId: context.bindingId,
      conversationId: context.conversationId,
      objectMetadataId: metadata[name],
      recordId: records[name],
      expectedTargetRevision: revision,
      active,
    },
    async () => {},
  );
const snapshot = async () => ({
  people: await fixture.read('person'),
  companies: await fixture.read('company'),
  messages: await fixture.read('message'),
  threads: await fixture.read('messageThread'),
  participants: await fixture.read('messageParticipant'),
  projections: await fixture.read('messageThreadTarget'),
  identities: await core('omniExternalIdentity'),
  targets: await core('omniConversationTarget'),
  links: await core('omniMessageLink'),
  receipts: await core('omniPolicyMutationReceipt'),
  state: await core('omniWorkspacePolicyState'),
  success: (await audits()).filter((row) => row.outcome === 'success'),
});
beforeAll(async () => {
  await fixture.initialize();
  await fixture.owner.query(
    `GRANT INSERT,UPDATE ON core."omniConversationTarget",core."omniWorkspacePolicyState",core."omniExternalIdentity",core."omniPolicyMutationReceipt" TO "${fixture.roleName}"`,
  );
});
beforeEach(async () => {
  context = await fixture.reset();
  await fixture.service.applyOmniHistoryReceipt(
    context.principal,
    (await fixture.capture(context)).proof,
    fixture.authorizeFor(context),
  );
  metadata = await fixture.withContext(
    async () => getWorkspaceContext().objectIdByNameSingular,
  );
  records = { person: context.personId, company: randomUUID() };
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}".company(id,name) VALUES($1,'Sensitive Company')`,
    [records.company],
  );
  fixture.eventEmitter.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('atomic permitted CRM parent destruction', () => {
  it.each(['person', 'company'] as const)(
    'refuses composite FK from a soft-deleted child to %s',
    async (name) => {
      await target(name);
      const nameColumn = name === 'person' ? 'nameFirstName' : 'name';
      await fixture.owner.query(
        `ALTER TABLE "${fixture.schemaName}"."${name}" ADD CONSTRAINT test_parent_pair UNIQUE(id,"${nameColumn}")`,
      );
      await fixture.owner.query(
        `CREATE TABLE "${fixture.schemaName}".composite_reference(parent_id uuid,parent_name text,"deletedAt" timestamptz,FOREIGN KEY(parent_id,parent_name) REFERENCES "${fixture.schemaName}"."${name}"(id,"${nameColumn}") ON DELETE CASCADE)`,
      );
      await fixture.owner.query(
        `GRANT SELECT ON "${fixture.schemaName}".composite_reference TO "${fixture.roleName}"`,
      );
      await fixture.owner.query(
        `INSERT INTO "${fixture.schemaName}".composite_reference SELECT id,"${nameColumn}",now() FROM "${fixture.schemaName}"."${name}" WHERE id=$1`,
        [records[name]],
      );
      try {
        const input = await command(name),
          before = await snapshot();
        await expect(destroy(input)).rejects.toThrow(
          'UNHANDLED_FOREIGN_REFERENCE',
        );
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          `DROP TABLE "${fixture.schemaName}".composite_reference`,
        );
        await fixture.owner.query(
          `ALTER TABLE "${fixture.schemaName}"."${name}" DROP CONSTRAINT test_parent_pair`,
        );
      }
    },
  );
  it('retains and unbinds identities from multiple bindings under one administrator decision', async () => {
    const account = await fixture.coreInsert('connectedAccount', {
      workspaceId: fixture.workspaceId,
      applicationId: null,
      connectionProviderId: null,
    });
    const channel = await fixture.coreInsert('messageChannel', {
      workspaceId: fixture.workspaceId,
      type: 'APP',
      connectedAccountId: account,
    });
    const binding = await fixture.coreInsert('omniAccountBinding', {
      workspaceId: fixture.workspaceId,
      platform: 'telegram',
      connectorInstanceId: 'second-destroy-fixture',
      accountId: randomUUID(),
      connectedAccountId: account,
      messageChannelId: channel,
      capabilitiesVersion: 'fixture-v1',
      capabilities: '{}',
    });
    await fixture.coreInsert('omniExternalIdentity', {
      workspaceId: fixture.workspaceId,
      bindingId: binding,
      providerPeerId: 'second-author',
      personId: records.person,
      verificationSource: 'fixture-confirmed',
    });
    const input = await command('person'),
      auth: OmniParentDestroyAuthorizer = async (scope, facts) => {
        await authorize(scope, facts);
        expect(
          new Set(facts.retained.identities.map((row) => row.bindingId)),
        ).toEqual(new Set([context.bindingId, binding]));
      };
    await destroy(input, auth);
    expect(
      (await core('omniExternalIdentity')).every(
        (row) => row.personId === null,
      ),
    ).toBe(true);
    expect((await destroy(input, auth)).replayed).toBe(true);
  });
  it('uses current conversation scope on replay, retaining its original scope separately', async () => {
    const input = await command('person');
    await destroy(input);
    const queue = await fixture.coreInsert('omniQueue', {
      workspaceId: fixture.workspaceId,
      bindingId: context.bindingId,
      name: 'Current queue',
      active: true,
    });
    await fixture.owner.query(
      'UPDATE core."omniConversation" SET "queueId"=$1 WHERE id=$2',
      [queue, context.conversationId],
    );
    const auth: OmniParentDestroyAuthorizer = async (scope, facts) => {
      await authorize(scope, facts);
      expect(facts.retained.conversations[0].queueId).toBe(context.queueId);
      expect(facts.currentConversations[0].queueId).toBe(queue);
    };
    expect((await destroy(input, auth)).replayed).toBe(true);
  });
  it('preserves the caller command snapshot through an awaited authorizer', async () => {
    const input = await command('person');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      seen = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const pending = destroy(input, async (scope, facts) => {
      entered();
      await gate;
      await authorize(scope, facts);
    });
    await seen;
    Reflect.set(input, 'recordId', randomUUID());
    Reflect.set(input.expectedIdentities[0], 'revision', '999');
    release();
    expect((await pending).recordId).toBe(records.person);
  });
  it.each(['body', 'author', 'participant'] as const)(
    'rolls back late %s corruption after the root receipt write',
    async (field) => {
      const input = await command('person'),
        before = await snapshot();
      const statement =
        field === 'body'
          ? `UPDATE "${fixture.schemaName}".message SET text='Changed'`
          : field === 'author'
            ? `UPDATE core."omniMessageLink" SET "immutableAuthorSnapshot"=jsonb_set("immutableAuthorSnapshot",'{sourceDisplayName}','"Changed"')`
            : `UPDATE "${fixture.schemaName}"."messageParticipant" SET "displayName"='Changed'`;
      await fixture.owner.query(
        `CREATE FUNCTION crm_audit.corrupt_parent_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN IF NEW.action='crmParent.destroy' THEN ${statement}; END IF; RETURN NEW; END $$`,
      );
      await fixture.owner.query(
        'CREATE TRIGGER corrupt_parent_history AFTER INSERT ON core."omniPolicyMutationReceipt" FOR EACH ROW EXECUTE FUNCTION crm_audit.corrupt_parent_history()',
      );
      try {
        const error = await destroy(input).then(
          () => null,
          (error: unknown) => error,
        );
        const messages: string[] = [];
        let cause: unknown = error;
        for (let depth = 0; cause instanceof Error && depth < 10; depth++) {
          messages.push(cause.message);
          cause = Reflect.get(cause, 'cause');
        }
        expect(messages.join(' ')).toContain('FINAL_HISTORY');
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          'DROP TRIGGER corrupt_parent_history ON core."omniPolicyMutationReceipt"',
        );
        await fixture.owner.query(
          'DROP FUNCTION crm_audit.corrupt_parent_history()',
        );
      }
    },
  );
  it.each(['missing', 'binding', 'wrongName', 'extra', 'wrongAction'] as const)(
    'refuses invalid deleted-parent audit descriptor: %s',
    async (variant) => {
      const deletedParent = {
        objectMetadataId: metadata.person,
        name: 'person',
        access: 'currentWorkspaceAdministration',
        ...(variant === 'extra' ? { other: true } : {}),
      };
      if (variant === 'wrongName') deletedParent.name = 'company';
      await expect(
        fixture.withContext(() =>
          fixture.dataSource.transaction(
            async (scope) => {
              const audit = new CrmAuditTransactionContext(
                createCrmAuditWorkspaceExecutor(scope),
                { ...principal(), operationId: randomUUID() },
              );
              audit.record({
                resourceKind: 'omniPerson',
                resourceId: records.person,
                action: variant === 'wrongAction' ? 'create' : 'delete',
                before: { name: 'Test' },
                after: null,
                securityDescriptor: {
                  resourceKind: 'omniPerson',
                  resourceId: records.person,
                  ...(variant === 'missing' ? {} : { deletedParent }),
                  ...(variant === 'binding'
                    ? { bindingId: context.bindingId }
                    : {}),
                },
              } as unknown as CrmAuditMutation);
            },
            { commitOutcome: 'strict' },
          ),
        ),
      ).rejects.toThrow('administrative scope');
    },
  );
  it.each(['person', 'company'] as const)(
    'deletes %s, preserving history and audited target tombstones',
    async (name) => {
      await target(name);
      const input = await command(name);
      const before = await snapshot();
      const result = await destroy(input);
      expect(result.deleted).toBe(true);
      expect(result.replayed).toBe(false);
      const after = await snapshot();
      expect(await fixture.read(name)).toHaveLength(0);
      expect(after.messages).toEqual(before.messages);
      expect(after.threads).toEqual(before.threads);
      expect(after.links).toEqual(before.links);
      expect(after.targets[0]).toMatchObject({
        active: false,
        projectionId: null,
        revision: '2',
      });
      expect(after.projections).toHaveLength(0);
      expect(after.identities[0].personId).toBe(
        name === 'person' ? null : context.personId,
      );
      expect(after.participants[0].personId).toBe(
        name === 'person' ? null : context.personId,
      );
      const audit = after.success.find(
        (row) =>
          row.operationId === result.operationId && row.action === 'delete',
      );
      expect(audit?.securityDescriptor).toEqual({
        resourceKind: name === 'person' ? 'omniPerson' : 'omniCompany',
        resourceId: records[name],
        deletedParent: {
          objectMetadataId: metadata[name],
          name,
          access: 'currentWorkspaceAdministration',
        },
      });
      expect(JSON.stringify(audit)).not.toContain('Sensitive');
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
      expect(await destroy(input)).toEqual({ ...result, replayed: true });
      expect(await snapshot()).toEqual(after);
    },
  );
  it.each(['person', 'company'] as const)(
    'allows %s with no target and refuses an absent parent without receipt',
    async (name) => {
      const input = await command(name);
      await destroy(input);
      const before = await snapshot();
      await expect(
        destroy({ ...input, idempotencyKey: randomUUID() }),
      ).rejects.toThrow('RESOURCE_SCOPE');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('authorizes current policy again on retained replay after the parent is gone', async () => {
    await target('person');
    const input = await command('person');
    await destroy(input);
    const before = await snapshot();
    const auth: OmniParentDestroyAuthorizer = async (_scope, facts) => {
      expect(facts.replay).toBe(true);
      expect(facts.retained.conversations[0].id).toBe(context.conversationId);
      throw new Error('REVOKED');
    };
    await expect(destroy(input, auth)).rejects.toThrow('REVOKED');
    expect(await snapshot()).toEqual(before);
    expect(
      (await audits()).some(
        (row) => row.outcome === 'denied' && row.action === 'delete',
      ),
    ).toBe(true);
  });
  it.each(['fingerprint', 'identity', 'target'] as const)(
    'rejects stale %s without partial unlink',
    async (field) => {
      await target('person');
      const input = await command('person');
      const changed = {
        ...input,
        ...(field === 'fingerprint'
          ? { expectedParentFingerprint: '0'.repeat(64) }
          : field === 'identity'
            ? { expectedIdentities: [] }
            : { expectedTargets: [] }),
      };
      const before = await snapshot();
      await expect(destroy(changed)).rejects.toThrow('REVISION_CONFLICT');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('rejects duplicate expected IDs and missing authorizer before writes', async () => {
    const input = await command('person');
    const before = await snapshot();
    await expect(
      destroy({
        ...input,
        expectedIdentities: [
          ...input.expectedIdentities,
          ...input.expectedIdentities,
        ],
      }),
    ).rejects.toThrow();
    await expect(
      destroy(input, null as unknown as OmniParentDestroyAuthorizer),
    ).rejects.toThrow('AUTHORIZER_REQUIRED');
    expect(await snapshot()).toEqual(before);
  });
  it('refuses unknown metadata and non-parent object', async () => {
    const input = await command('person'),
      before = await snapshot();
    await expect(
      destroy({ ...input, objectMetadataId: randomUUID() }),
    ).rejects.toThrow('METADATA_SCOPE');
    await expect(
      destroy({ ...input, objectMetadataId: metadata.opportunity }),
    ).rejects.toThrow('METADATA_SCOPE');
    expect(await snapshot()).toEqual(before);
  });
  it('serializes twenty retries with one destroy and no duplicate history/audit', async () => {
    await target('person');
    const input = await command('person');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => destroy(input)),
    );
    expect(results.filter((row) => !row.replayed)).toHaveLength(1);
    expect(new Set(results.map((row) => row.operationId)).size).toBe(1);
    expect(
      (await audits()).filter(
        (row) =>
          row.resourceKind === 'omniPerson' &&
          row.action === 'delete' &&
          row.outcome === 'success',
      ),
    ).toHaveLength(1);
  });
  it('recovers lost real COMMIT acknowledgement without false failed audit', async () => {
    const input = await command('person'),
      client = await fixture.pool.connect(),
      query = client.query.bind(client);
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string,
      values?: unknown[],
    ) => {
      const result = await query(sql, values);
      if (sql === 'COMMIT') throw new Error('LOST_ACK');
      return result;
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await expect(destroy(input)).rejects.toThrow(/unknown/i);
    const before = await snapshot();
    expect((await destroy(input)).replayed).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect(
      (await audits()).filter((row) => row.outcome !== 'success'),
    ).toHaveLength(0);
  });
  it('refuses changed payload under an already committed actor key', async () => {
    const input = await command('person');
    await destroy(input);
    const before = await snapshot();
    await expect(
      destroy({ ...input, expectedParentFingerprint: '0'.repeat(64) }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await snapshot()).toEqual(before);
  });
  it.each(['audit', 'scope', 'policy'] as const)(
    'refuses replay with missing or changed %s proof',
    async (kind) => {
      await target('person');
      const input = await command('person'),
        first = await destroy(input);
      if (kind === 'scope')
        await fixture.owner.query(
          `UPDATE core."omniPolicyMutationReceipt" SET "resourceDescriptor"=jsonb_set("resourceDescriptor",'{conversations}','[]') WHERE "operationId"=$1`,
          [first.operationId],
        );
      else
        await fixture.owner.query(
          `DELETE FROM crm_audit."crmAuditEntry" WHERE "operationId"=$1 AND "resourceKind"=$2`,
          [
            first.operationId,
            kind === 'audit' ? 'omniPerson' : 'omniWorkspacePolicyState',
          ],
        );
      const before = await snapshot();
      await expect(destroy(input)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );
  it.each(['identity', 'target', 'parent', 'audit', 'receipt'] as const)(
    'rolls back the whole destroy on %s failure',
    async (stage) => {
      await target('person');
      const input = await command('person'),
        before = await snapshot();
      const table =
        stage === 'identity'
          ? 'core."omniExternalIdentity"'
          : stage === 'target'
            ? 'core."omniConversationTarget"'
            : stage === 'parent'
              ? `"${fixture.schemaName}".person`
              : stage === 'audit'
                ? 'crm_audit."crmAuditEntry"'
                : 'core."omniPolicyMutationReceipt"';
      const event =
        stage === 'parent'
          ? 'DELETE'
          : ['audit', 'receipt'].includes(stage)
            ? 'INSERT'
            : 'UPDATE';
      const condition =
        stage === 'audit'
          ? `IF NEW."resourceKind" <> 'omniPerson' OR NEW.outcome <> 'success' THEN RETURN NEW; END IF;`
          : stage === 'receipt'
            ? `IF NEW.action <> 'crmParent.destroy' THEN RETURN NEW; END IF;`
            : '';
      await fixture.owner.query(
        `CREATE FUNCTION crm_audit.fail_parent_destroy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${condition} RAISE EXCEPTION 'PARENT_DESTROY_INJECTED'; END $$`,
      );
      await fixture.owner.query(
        `CREATE TRIGGER fail_parent_destroy BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION crm_audit.fail_parent_destroy()`,
      );
      try {
        const error = await destroy(input).then(
          () => null,
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(Error);
        const messages: string[] = [];
        let cause: unknown = error;
        for (let depth = 0; cause instanceof Error && depth < 10; depth++) {
          messages.push(cause.message);
          cause = Reflect.get(cause, 'cause');
        }
        expect(messages.join(' ')).toContain('PARENT_DESTROY_INJECTED');
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          `DROP TRIGGER fail_parent_destroy ON ${table}`,
        );
        await fixture.owner.query(
          'DROP FUNCTION crm_audit.fail_parent_destroy()',
        );
      }
    },
  );
  it.each(['person', 'company'] as const)(
    'refuses unhandled custom FK effects for %s and rolls back detach',
    async (name) => {
      await target(name);
      const input = await command(name);
      await fixture.owner.query(
        `CREATE TABLE "${fixture.schemaName}".custom_reference(id uuid PRIMARY KEY,parent_id uuid REFERENCES "${fixture.schemaName}"."${name}"(id) ON DELETE SET NULL)`,
      );
      await fixture.owner.query(
        `GRANT SELECT ON "${fixture.schemaName}".custom_reference TO "${fixture.roleName}"`,
      );
      await fixture.owner.query(
        `INSERT INTO "${fixture.schemaName}".custom_reference VALUES($1,$2)`,
        [randomUUID(), records[name]],
      );
      try {
        const before = await snapshot();
        await expect(destroy(input)).rejects.toThrow(
          'UNHANDLED_FOREIGN_REFERENCE',
        );
        expect(await snapshot()).toEqual(before);
      } finally {
        await fixture.owner.query(
          `DROP TABLE "${fixture.schemaName}".custom_reference`,
        );
      }
    },
  );
  it('does not delete a new row reusing the ID during old command replay', async () => {
    const input = await command('person');
    await destroy(input);
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}".person(id,"nameFirstName") VALUES($1,'Replacement')`,
      [records.person],
    );
    const before = await snapshot();
    expect((await destroy(input)).replayed).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});
