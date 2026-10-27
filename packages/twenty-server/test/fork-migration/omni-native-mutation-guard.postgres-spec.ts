import { randomUUID } from 'node:crypto';
import { MessageParticipantRole } from 'twenty-shared/types';

import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { withOmniRepositoryOptions } from 'src/modules/omnichannel/services/with-omni-repository-options';
import { bootstrapOmniAccountBinding } from 'src/modules/omnichannel/services/omni-binding-bootstrap';
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
  includeFolderAssociations: true,
});
const names = [
  'messageThread',
  'message',
  'messageParticipant',
  'messageChannelMessageAssociation',
  'messageChannelMessageAssociationMessageFolder',
  'messageThreadTarget',
] as const;
type Name = (typeof names)[number];
let context: Awaited<ReturnType<typeof fixture.reset>>;
let owned: Record<Name, string>;
let normal: Record<Name, string>;
const denied = 'OMNI_NATIVE_MUTATION_REQUIRES_DOMAIN_COMMAND';
const permissions = { shouldBypassPermissionChecks: true as const };
const repository = (name: Name, skip = true) =>
  fixture.dataSource.getRepository(name, permissions, {
    shouldSkipEventEmission: skip,
  });
const insertRaw = async (name: Name, values: Record<string, unknown>) => {
  const row = { id: randomUUID(), ...values };
  const keys = Object.keys(row);
  await fixture.owner.query(
    `INSERT INTO "${fixture.schemaName}"."${name}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
  return row.id;
};
const seed = async (
  thread: string,
  channel: string,
): Promise<Record<Name, string>> => {
  const message = await insertRaw('message', {
    messageThreadId: thread,
    text: 'unchanged',
    headerMessageId: randomUUID(),
  });
  const association = await insertRaw('messageChannelMessageAssociation', {
    messageId: message,
    messageChannelId: channel,
    messageExternalId: randomUUID(),
  });
  return {
    messageThread: thread,
    message,
    messageParticipant: await insertRaw('messageParticipant', {
      messageId: message,
      role: MessageParticipantRole.FROM,
      handle: 'fixture',
      personId: context.personId,
    }),
    messageChannelMessageAssociation: association,
    messageChannelMessageAssociationMessageFolder: await insertRaw(
      'messageChannelMessageAssociationMessageFolder',
      {
        messageChannelMessageAssociationId: association,
        messageFolderId: await fixture.coreInsert('messageFolder', {
          workspaceId: fixture.workspaceId,
          messageChannelId: channel,
        }),
      },
    ),
    messageThreadTarget: await insertRaw('messageThreadTarget', {
      messageThreadId: thread,
      targetPersonId: context.personId,
    }),
  };
};
const snapshot = async () =>
  Promise.all(names.map((name) => fixture.read(name)));
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const waitForBlockedAdvisory = async () => {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] = await fixture.owner.query(
      `SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
    );
    if (row.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected a genuinely blocked native ownership fence');
};
beforeAll(() => fixture.initialize());
beforeEach(async () => {
  context = await fixture.reset();
  owned = await seed(context.threadId, context.channelId);
  normal = await seed(
    await insertRaw('messageThread', { subject: 'ordinary' }),
    await fixture.coreInsert('messageChannel', {
      workspaceId: fixture.workspaceId,
      type: 'EMAIL',
      connectedAccountId: context.connectedAccountId,
    }),
  );
  fixture.eventEmitter.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('generic native mutation boundary on real PostgreSQL', () => {
  it.each(
    names.flatMap((name) =>
      [
        'update',
        'delete',
        'softDelete',
        'restore',
        'save',
        'upsert',
        'updateMany',
        'mergeKernel',
      ].map((operation) => [name, operation] as const),
    ),
  )(
    'rejects %s %s even with bypass permissions and suppressed events',
    async (name, operation) => {
      if (operation === 'restore')
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."${name}" SET "deletedAt"=now() WHERE id=$1`,
          [owned[name]],
        );
      const before = await snapshot();
      const repo = repository(name);
      const id = owned[name];
      const data = { updatedAt: new Date('2026-10-27T10:00:00Z') };
      const write = () => {
        switch (operation) {
          case 'update':
            return repo.update(id, data);
          case 'delete':
            return repo.delete(id);
          case 'softDelete':
            return repo.softDelete(id);
          case 'restore':
            return repo.restore(id);
          case 'save':
            return repo.save({ id, ...data });
          case 'upsert':
            return repo.upsert({ id, ...data }, ['id']);
          case 'updateMany':
            return repo.updateMany([{ criteria: id, partialEntity: data }]);
          default:
            return repo.runMutation({
              selectQueryBuilder: repo.createQueryBuilder().where({ id }),
              rowLevelPermissionsApplied: true,
              kind: 'update',
              columnsToReturn: ['id'],
              data,
            });
        }
      };
      await expect(write()).rejects.toThrow(denied);
      expect(await snapshot()).toEqual(before);
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );

  const references = () =>
    [
      ['message', 'messageThreadId', owned.messageThread],
      ['messageParticipant', 'messageId', owned.message],
      ['messageChannelMessageAssociation', 'messageId', owned.message],
      [
        'messageChannelMessageAssociation',
        'messageChannelId',
        context.channelId,
      ],
      [
        'messageChannelMessageAssociationMessageFolder',
        'messageChannelMessageAssociationId',
        owned.messageChannelMessageAssociation,
      ],
      ['messageThreadTarget', 'messageThreadId', owned.messageThread],
    ] as const;
  it.each(['insert', 'update', 'batch'] as const)(
    'rejects %s injection/reparenting into every owned parent',
    async (mode) => {
      const before = await snapshot();
      for (const [name, key, value] of references()) {
        const repo = repository(name);
        const data = { [key]: value };
        const write =
          mode === 'insert'
            ? () => repo.insert({ id: randomUUID(), ...data })
            : mode === 'update'
              ? () => repo.update(normal[name], data)
              : () =>
                  repo.updateMany([
                    { criteria: normal[name], partialEntity: data },
                  ]);
        await expect(write()).rejects.toThrow(denied);
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it('rolls back a mixed batch and previous unrelated writes in the transaction', async () => {
    const before = await snapshot();
    const personBefore = await fixture.read('person');
    await expect(
      fixture.dataSource.transaction(async (scope) => {
        await scope
          .getRepository('person', permissions)
          .update(context.personId, {
            name: { firstName: 'must rollback', lastName: 'Person' },
          });
        await scope.getRepository('message', permissions).updateMany([
          {
            criteria: normal.message,
            partialEntity: { text: 'must rollback' },
          },
          { criteria: owned.message, partialEntity: { text: 'forbidden' } },
        ]);
      }),
    ).rejects.toThrow(denied);
    expect(await snapshot()).toEqual(before);
    expect(await fixture.read('person')).toEqual(personBefore);
    expect(fixture.eventEmitter).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves ordinary email/APP CRUD, soft-delete, restore and event setting skip=%s',
    async (skip) => {
      const repo = repository('message', skip);
      await repo.update(normal.message, { text: 'ordinary edit' });
      await repo.softDelete(normal.message);
      await repo.restore(normal.message);
      const [row] = (await fixture.read('message')).filter(
        (item: { id: string }) => item.id === normal.message,
      );
      expect(row).toMatchObject({ text: 'ordinary edit', deletedAt: null });
      expect(fixture.eventEmitter.mock.calls.length > 0).toBe(!skip);
      await repository('messageParticipant', skip).delete(
        normal.messageParticipant,
      );
      expect(
        (await fixture.read('messageParticipant')).some(
          (row: { id: string }) => row.id === normal.messageParticipant,
        ),
      ).toBe(false);
    },
  );

  it.each(['insert', 'update', 'batch', 'delete', 'restore'] as const)(
    'guards %s through an owned folder even for an ordinary association',
    async (mode) => {
      const [folder] = await fixture.owner.query(
        'SELECT id FROM core."messageFolder" WHERE "messageChannelId"=$1',
        [context.channelId],
      );
      const name = 'messageChannelMessageAssociationMessageFolder';
      const repo = repository(name);
      if (mode === 'delete' || mode === 'restore')
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."${name}" SET "messageFolderId"=$1, "deletedAt"=$2 WHERE id=$3`,
          [folder.id, mode === 'restore' ? new Date() : null, normal[name]],
        );
      const before = await snapshot();
      const data = { messageFolderId: folder.id };
      const write = () => {
        if (mode === 'insert')
          return repo.insert({
            ...data,
            messageChannelMessageAssociationId:
              normal.messageChannelMessageAssociation,
          });
        if (mode === 'update') return repo.update(normal[name], data);
        if (mode === 'batch')
          return repo.updateMany([
            { criteria: normal[name], partialEntity: data },
          ]);
        if (mode === 'restore') return repo.restore(normal[name]);
        return repo.delete(normal[name]);
      };
      await expect(write()).rejects.toThrow(denied);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('does not treat an omni-looking header as ownership', async () => {
    await repository('message').update(normal.message, {
      headerMessageId: 'omni:v1:looks-owned',
      text: 'allowed',
    });
    expect(
      (await fixture.read('message')).find(
        (row: { id: string }) => row.id === normal.message,
      ).text,
    ).toBe('allowed');
  });

  it.each(['inactive', 'disconnected'])(
    'retains ownership for %s bindings and deleted associations',
    async (status) => {
      await fixture.owner.query(
        'UPDATE core."omniAccountBinding" SET status=$1 WHERE id=$2',
        [status, context.bindingId],
      );
      await fixture.owner.query(
        `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "deletedAt"=now() WHERE id=$1`,
        [owned.messageChannelMessageAssociation],
      );
      // A separate ordinary thread isolates channel ownership from Conversation.
      await fixture.owner.query(
        `UPDATE "${fixture.schemaName}"."message" SET "messageThreadId"=$1 WHERE id=$2`,
        [normal.messageThread, owned.message],
      );
      await expect(repository('message').delete(owned.message)).rejects.toThrow(
        denied,
      );
      await expect(
        repository('messageThread').delete(normal.messageThread),
      ).rejects.toThrow(denied);
    },
  );

  it('retains Conversation-only ownership without channel association or MessageLink', async () => {
    await fixture.owner.query(
      `DELETE FROM "${fixture.schemaName}"."messageChannelMessageAssociationMessageFolder" WHERE id=$1`,
      [owned.messageChannelMessageAssociationMessageFolder],
    );
    await fixture.owner.query(
      `DELETE FROM "${fixture.schemaName}"."messageChannelMessageAssociation" WHERE id=$1`,
      [owned.messageChannelMessageAssociation],
    );
    await expect(
      repository('message').update(owned.message, { text: 'forbidden' }),
    ).rejects.toThrow(denied);
  });

  it('retains MessageLink-only ownership after native associations disappear', async () => {
    const item = await fixture.capture(context);
    const result = await fixture.service.applyOmniHistoryReceipt(
      context.principal,
      item.proof,
      fixture.authorizeFor(context),
    );
    await fixture.owner.query(
      `DELETE FROM "${fixture.schemaName}"."messageChannelMessageAssociation" WHERE "messageId"=$1`,
      [result.messageId],
    );
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."message" SET "messageThreadId"=$1 WHERE id=$2`,
      [normal.messageThread, result.messageId],
    );
    await expect(
      repository('message').delete(result.messageId),
    ).rejects.toThrow(denied);
    await expect(
      repository('messageThread').update(normal.messageThread, {
        subject: 'forbidden',
      }),
    ).rejects.toThrow(denied);
  });

  it('fails closed when ownership cannot be read', async () => {
    await fixture.owner.query(
      `REVOKE SELECT ON core."omniMessageLink" FROM "${fixture.roleName}"`,
    );
    try {
      await expect(
        repository('message').update(normal.message, { text: 'forbidden' }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await fixture.owner.query(
        `GRANT SELECT ON core."omniMessageLink" TO "${fixture.roleName}"`,
      );
    }
    expect(
      (await fixture.read('message')).find(
        (row: { id: string }) => row.id === normal.message,
      ).text,
    ).toBe('unchanged');
  });

  it('requires an issued strict exclusive scope; lock mode alone never authorizes writes', async () => {
    await fixture.dataSource.transaction(
      async (scope) => {
        expect(() => withOmniRepositoryOptions(scope)).toThrow(
          'OMNI_UNISSUED_NATIVE_WRITE_SCOPE',
        );
        expect(() => withOmniRepositoryOptions({ ...scope })).toThrow(
          'OMNI_UNISSUED_NATIVE_WRITE_SCOPE',
        );
      },
      { commitOutcome: 'strict' },
    );
    await expect(
      fixture.dataSource.transaction(
        async (scope) => {
          await scope
            .getRepository('message', permissions, {
              shouldSkipEventEmission: true,
            })
            .update(owned.message, { text: 'no grant' });
        },
        { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
      ),
    ).rejects.toThrow(denied);
  });

  it.each(['workspaceId', 'transactionLifecycle'] as const)(
    'rejects alteration of issued scope %s',
    async (field) => {
      await fixture.dataSource.transaction(
        async (scope) => {
          const original = scope[field];
          Reflect.set(
            scope,
            field,
            field === 'workspaceId'
              ? randomUUID()
              : { ...scope.transactionLifecycle },
          );
          expect(() => withOmniRepositoryOptions(scope)).toThrow(
            'OMNI_ALTERED_NATIVE_WRITE_SCOPE',
          );
          Reflect.set(scope, field, original);
        },
        { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
      );
    },
  );

  it('rejects copied scope and foreign repository, and closes retained capability', async () => {
    const foreign = repository('message');
    let retained: WorkspaceRepository | undefined;
    let retainedScope: WorkspaceTransactionScope | undefined;
    await fixture.dataSource.transaction(
      async (scope) => {
        expect(() => withOmniRepositoryOptions({ ...scope })).toThrow(
          'OMNI_UNISSUED_NATIVE_WRITE_SCOPE',
        );
        const source = scope.getRepository;
        scope.getRepository = (() =>
          foreign) as WorkspaceTransactionScope['getRepository'];
        expect(() =>
          withOmniRepositoryOptions(scope).getRepository('message'),
        ).toThrow('OMNI_FOREIGN_NATIVE_WRITE_REPOSITORY');
        scope.getRepository = source;
        retainedScope = scope;
        retained = withOmniRepositoryOptions(scope).getRepository(
          'message',
          permissions,
        );
      },
      { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
    );
    expect(() => withOmniRepositoryOptions(retainedScope!)).toThrow(
      'active workspace transaction',
    );
    await expect(
      retained!.update(owned.message, { text: 'expired' }),
    ).rejects.toThrow('OMNI_INACTIVE_NATIVE_WRITE_SCOPE');
  });

  it('freezes OR predicates to captured IDs despite a newly matching concurrent row', async () => {
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."message" SET text='a' WHERE id=$1`,
      [normal.message],
    );
    const phantom = await insertRaw('message', {
      messageThreadId: normal.messageThread,
      text: 'c',
      headerMessageId: randomUUID(),
    });
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    let injected = false;
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (
        !injected &&
        text.includes('SELECT * FROM') &&
        text.includes('."message"') &&
        text.includes('FOR UPDATE')
      ) {
        injected = true;
        await fixture.owner.query(
          `UPDATE "${fixture.schemaName}"."message" SET text='a' WHERE id=$1`,
          [phantom],
        );
      }
      return query(sql, values);
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    const repo = repository('message');
    const result = await repo.runMutation({
      selectQueryBuilder: repo
        .createQueryBuilder()
        .where({ text: 'a' })
        .orWhere({ text: 'b' }),
      rowLevelPermissionsApplied: true,
      kind: 'update',
      columnsToReturn: ['id'],
      data: { text: 'changed' },
    });
    expect(injected).toBe(true);
    expect(result.map((row) => row.id)).toEqual([normal.message]);
    expect(
      (await fixture.read('message')).find(
        (row: { id: string }) => row.id === phantom,
      ).text,
    ).toBe('a');
  });

  it('holds the fence before Person locks in multi-object transactions while history apply waits', async () => {
    const item = await fixture.capture(context);
    let apply!: ReturnType<typeof fixture.service.applyOmniHistoryReceipt>;
    await fixture.dataSource.transaction(async (scope) => {
      await scope
        .getRepository('person', permissions)
        .update(context.personId, {
          name: { firstName: 'Changed', lastName: 'Person' },
        });
      apply = fixture.service.applyOmniHistoryReceipt(
        context.principal,
        item.proof,
        fixture.authorizeFor(context),
      );
      // This was the former deadlock: apply held exclusive fence waiting for
      // Person while the generic transaction waited for the fence at native write.
      await waitForBlockedAdvisory();
      await scope
        .getRepository('message', permissions)
        .update(normal.message, { text: 'ordinary' });
    });
    await expect(apply).resolves.toMatchObject({ state: 'applied' });
  });

  it.each(['history-first', 'delete-first'] as const)(
    'serializes actual history apply and parent deletion: %s',
    async (order) => {
      const item = await fixture.capture(context);
      const entered = barrier();
      const release = barrier();
      const apply = () =>
        fixture.service.applyOmniHistoryReceipt(
          context.principal,
          item.proof,
          async (scope, request) => {
            await fixture.authorizeFor(context)(scope, request);
            if (order === 'history-first') {
              entered.release();
              await release.promise;
            }
          },
        );
      const remove = () =>
        fixture.dataSource.transaction(async (scope) => {
          if (order === 'delete-first') {
            entered.release();
            await release.promise;
          }
          return scope
            .getRepository('person', permissions)
            .delete(context.personId);
        });
      const first = (order === 'history-first' ? apply() : remove()).then(
        (result) => ({ result }),
        (error: Error) => ({ error }),
      );
      await entered.promise;
      const second = (order === 'history-first' ? remove() : apply()).then(
        (result) => ({ result }),
        (error: Error) => ({ error }),
      );
      try {
        await waitForBlockedAdvisory();
      } finally {
        release.release();
      }
      const results = await Promise.all([first, second]);
      const applied = results[order === 'history-first' ? 0 : 1];
      const deleted = results[order === 'history-first' ? 1 : 0];
      expect(applied).toMatchObject({ result: { state: 'applied' } });
      expect(deleted).toMatchObject({
        error: { message: 'OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND' },
      });
      expect(
        (await fixture.read('person')).some(
          (row: { id: string }) => row.id === context.personId,
        ),
      ).toBe(true);
    },
  );

  it('uses the checked parent assignment when a caller mutates its input during ownership IO', async () => {
    const data = { messageThreadId: normal.messageThread, text: 'checked' };
    const client = await fixture.pool.connect();
    const query = client.query.bind(client);
    let injected = false;
    jest.spyOn(client, 'query').mockImplementation((async (
      sql: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (
        !injected &&
        text.includes('SELECT candidate.id') &&
        text.includes('omniMessageLink')
      ) {
        injected = true;
        data.messageThreadId = owned.messageThread;
        data.text = 'unchecked';
      }
      return query(sql, values);
    }) as typeof client.query);
    jest
      .spyOn(fixture.pool, 'connect')
      .mockImplementationOnce(() => Promise.resolve(client));
    await repository('message').update(normal.message, data);
    expect(injected).toBe(true);
    expect(
      (await fixture.read('message')).find(
        (row: { id: string }) => row.id === normal.message,
      ),
    ).toMatchObject({ messageThreadId: normal.messageThread, text: 'checked' });
  });

  it.each(['bootstrap-first', 'generic-first'] as const)(
    'serializes channel enrollment and generic writes: %s',
    async (order) => {
      // A workspace with existing native mail but no first omni policy/binding.
      await fixture.owner.query(
        `ALTER TABLE core."connectedAccount" ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'app'`,
      );
      await fixture.owner.query(
        'TRUNCATE core.workspace, core."connectedAccount", core."messageChannel" CASCADE',
      );
      await fixture.owner.query('INSERT INTO core.workspace(id) VALUES ($1)', [
        fixture.workspaceId,
      ]);
      const accountId = await fixture.coreInsert('connectedAccount', {
        workspaceId: fixture.workspaceId,
      });
      const channelId = await fixture.coreInsert('messageChannel', {
        workspaceId: fixture.workspaceId,
        connectedAccountId: accountId,
        type: 'APP',
      });
      await fixture.owner.query(
        `UPDATE "${fixture.schemaName}"."messageChannelMessageAssociation" SET "messageChannelId"=$1 WHERE id=$2`,
        [channelId, normal.messageChannelMessageAssociation],
      );
      expect(
        await fixture.owner.query(
          'SELECT id FROM core."omniWorkspacePolicyState"',
        ),
      ).toEqual([]);
      await fixture.owner.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core TO "${fixture.roleName}"`,
      );
      await fixture.owner.query(
        `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA crm_audit TO "${fixture.roleName}"`,
      );
      const entered = barrier();
      const release = barrier();
      const bootstrap = () =>
        bootstrapOmniAccountBinding(
          fixture.runtime,
          { kind: 'system', id: 'fixture-bootstrap' },
          {
            workspaceId: fixture.workspaceId,
            platform: 'telegram',
            connectorInstanceId: 'fixture-new',
            accountId: 'fixture-account',
            connectedAccountId: accountId,
            messageChannelId: channelId,
            idempotencyKey: randomUUID(),
            expectedRevision: '0',
          },
          async () => {
            if (order === 'bootstrap-first') {
              entered.release();
              await release.promise;
            }
          },
        );
      const generic = () =>
        fixture.dataSource.transaction(async (scope) => {
          if (order === 'generic-first') {
            entered.release();
            await release.promise;
          }
          return scope
            .getRepository('message', permissions)
            .update(normal.message, { text: 'before enrollment' });
        });
      const first = (
        order === 'bootstrap-first' ? bootstrap() : generic()
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await entered.promise;
      const second = (
        order === 'bootstrap-first' ? generic() : bootstrap()
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitForBlockedAdvisory();
      } finally {
        release.release();
      }
      const results = await Promise.all([first, second]);
      expect(results[0]).toHaveProperty('value');
      if (order === 'bootstrap-first')
        expect(results[1]).toMatchObject({ error: new Error(denied) });
      else expect(results[1]).toHaveProperty('value');
    },
  );
});
