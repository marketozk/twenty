import { randomUUID } from 'node:crypto';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { withOmniDetachedParentDelete } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { type OmniDetachedParentManifest } from 'src/modules/omnichannel/services/verify-omni-detached-parent';
import { withOmniRepositoryOptions } from 'src/modules/omnichannel/services/with-omni-repository-options';
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
let metadata: Record<string, string>;
let records: Record<string, string>;
const permissions = { shouldBypassPermissionChecks: true as const };
const principal = () => ({
  workspaceId: fixture.workspaceId,
  actor: context.principal.actor,
});
const core = (table: string): Promise<Record<string, unknown>[]> =>
  fixture.owner.query(`SELECT * FROM core."${table}" ORDER BY id`);
const snapshot = async () => ({
  people: await fixture.read('person'),
  companies: await fixture.read('company'),
  messages: await fixture.read('message'),
  participants: await fixture.read('messageParticipant'),
  threads: await fixture.read('messageThread'),
  projections: await fixture.read('messageThreadTarget'),
  targets: await core('omniConversationTarget'),
  identities: await core('omniExternalIdentity'),
  links: await core('omniMessageLink'),
});
const target = (
  name: string,
  active: boolean,
  revision: string,
  authorize = async () => {},
) =>
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
    authorize,
  );
const prepare = async (name: 'person' | 'company') => {
  await target(name, true, '0');
  await target(name, false, '1');
  if (name === 'person')
    await fixture.service.setOmniIdentityPerson(
      principal(),
      {
        bindingId: context.bindingId,
        externalIdentityId: context.externalIdentityId,
        personId: null,
        expectedRevision: '1',
        idempotencyKey: randomUUID(),
      },
      async () => {},
    );
  return manifest(name);
};
const manifest = async (
  name: 'person' | 'company',
): Promise<OmniDetachedParentManifest> => ({
  workspaceId: fixture.workspaceId,
  objectMetadataId: metadata[name],
  recordId: records[name],
  name,
  retainedTargets: (await core('omniConversationTarget'))
    .filter(
      (row) =>
        row.objectMetadataId === metadata[name] &&
        row.recordId === records[name],
    )
    .map((row) => ({ id: String(row.id), revision: String(row.revision) })),
});
const scoped = <T>(
  work: Parameters<typeof fixture.dataSource.transaction<T>>[0],
  exclusive = true,
) =>
  fixture.withContext(() =>
    fixture.dataSource.transaction(work, {
      commitOutcome: 'strict',
      nativeOwnershipLock: exclusive ? 'exclusive' : 'shared',
    }),
  );
const remove = async (input: OmniDetachedParentManifest) =>
  scoped(async (scope) => {
    const repository = scope.getRepository(input.name, permissions, {
      shouldSkipEventEmission: true,
    });
    return withOmniDetachedParentDelete(scope, repository, input, () =>
      repository.delete(input.recordId),
    );
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
    `INSERT INTO "${fixture.schemaName}".company(id) VALUES($1)`,
    [records.company],
  );
  fixture.eventEmitter.mockClear();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => fixture.dispose());

describe('transaction-bound detached parent deletion capability', () => {
  it.each(['person', 'company'] as const)(
    'exempts only audited inactive %s tombstones and preserves history',
    async (name) => {
      const input = await prepare(name);
      const before = await snapshot();
      const result = await remove(input);
      expect(result.affected).toBe(1);
      expect(
        (await fixture.read(name)).some(
          (row: { id: string }) => row.id === records[name],
        ),
      ).toBe(false);
      expect(await core('omniConversationTarget')).toEqual(before.targets);
      expect(await core('omniMessageLink')).toEqual(before.links);
      expect(await fixture.read('message')).toEqual(before.messages);
      expect(await fixture.read('messageThread')).toEqual(before.threads);
      expect(await fixture.read('messageParticipant')).toEqual(
        before.participants,
      );
      expect(fixture.eventEmitter).not.toHaveBeenCalled();
    },
  );
  it('keeps generic delete blocked after every current reference is detached', async () => {
    await prepare('person');
    await expect(
      scoped((scope) =>
        scope.getRepository('person', permissions).delete(records.person),
      ),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
  });
  it('does not accept active edges', async () => {
    await target('company', true, '0');
    const before = await snapshot();
    await expect(remove(await manifest('company'))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it.each(['missing', 'revision', 'extra'] as const)(
    'rejects %s retained manifest',
    async (variant) => {
      const input = await prepare('company');
      const altered = {
        ...input,
        retainedTargets:
          variant === 'missing'
            ? []
            : variant === 'extra'
              ? [...input.retainedTargets, { id: randomUUID(), revision: '1' }]
              : input.retainedTargets.map((row) => ({ ...row, revision: '1' })),
      };
      const before = await snapshot();
      await expect(remove(altered)).rejects.toThrow('PARENT_NOT_DETACHED');
      expect(await snapshot()).toEqual(before);
    },
  );
  it('refuses an inactive edge whose transition audit is missing', async () => {
    const input = await prepare('company');
    await fixture.owner.query(
      `DELETE FROM crm_audit."crmAuditEntry" WHERE "resourceKind"='omniConversationTarget' AND "resourceId"=$1`,
      [input.retainedTargets[0].id],
    );
    await expect(remove(input)).rejects.toThrow('TRANSITION_PROOF');
  });
  it('rejects a retained identity even when it has no matching native participants', async () => {
    await fixture.owner.query(
      `UPDATE "${fixture.schemaName}"."messageParticipant" SET "personId"=NULL`,
    );
    const before = await snapshot();
    await expect(remove(await manifest('person'))).rejects.toThrow(
      'PARENT_NOT_DETACHED',
    );
    expect(await snapshot()).toEqual(before);
  });
  it.each([false, true])(
    'refuses an unexplained native participant; soft-deleted %s',
    async (deleted) => {
      const input = await prepare('person');
      await scoped(async (scope) => {
        await withOmniRepositoryOptions(scope)
          .getRepository('messageParticipant', permissions)
          .update((await fixture.read('messageParticipant'))[0].id, {
            personId: records.person,
            ...(deleted ? { deletedAt: new Date() } : {}),
          });
      });
      const before = await snapshot();
      await expect(remove(input)).rejects.toThrow('PARENT_NOT_DETACHED');
      expect(await snapshot()).toEqual(before);
    },
  );
  it.each([false, true])(
    'refuses an extra native target; soft-deleted %s',
    async (deleted) => {
      const input = await prepare('company');
      await scoped(async (scope) => {
        await withOmniRepositoryOptions(scope)
          .getRepository('messageThreadTarget', permissions)
          .insert({
            id: randomUUID(),
            messageThreadId: context.threadId,
            targetCompanyId: records.company,
            ...(deleted ? { deletedAt: new Date() } : {}),
          });
      });
      await expect(remove(input)).rejects.toThrow('PARENT_NOT_DETACHED');
    },
  );
  it('cannot grant on a copied scope or an ordinary shared transaction', async () => {
    const input = await prepare('company');
    await expect(
      scoped((scope) =>
        withOmniDetachedParentDelete(
          { ...scope },
          scope.getRepository('company', permissions),
          input,
          async () => undefined,
        ),
      ),
    ).rejects.toThrow('UNISSUED_NATIVE_WRITE_SCOPE');
    await expect(
      scoped(
        (scope) =>
          withOmniDetachedParentDelete(
            scope,
            scope.getRepository('company', permissions),
            input,
            async () => undefined,
          ),
        false,
      ),
    ).rejects.toThrow('UNISSUED_NATIVE_WRITE_SCOPE');
  });
  it('cannot use a copied repository or a foreign workspace manifest', async () => {
    const input = await prepare('company');
    await expect(
      scoped((scope) =>
        withOmniDetachedParentDelete(
          scope,
          { ...scope.getRepository('company', permissions) },
          input,
          async () => undefined,
        ),
      ),
    ).rejects.toThrow('FOREIGN_PARENT_DELETE_SCOPE');
    await expect(
      remove({ ...input, workspaceId: randomUUID() }),
    ).rejects.toThrow('FOREIGN_PARENT_DELETE_SCOPE');
  });
  it('does not transfer authority to another repository in the same scope', async () => {
    const input = await prepare('company');
    await expect(
      scoped(async (scope) => {
        const issued = scope.getRepository('company', permissions);
        const different = scope.getRepository('company', permissions);
        return withOmniDetachedParentDelete(scope, issued, input, () =>
          different.delete(records.company),
        );
      }),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
  });
  it('does not authorize another metadata identity or a mixed batch', async () => {
    const input = await prepare('company');
    await expect(
      scoped(async (scope) => {
        const person = scope.getRepository('person', permissions);
        return withOmniDetachedParentDelete(scope, person, input, () =>
          person.delete(records.person),
        );
      }),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
    const ordinary = randomUUID();
    await fixture.owner.query(
      `INSERT INTO "${fixture.schemaName}".company(id) VALUES($1)`,
      [ordinary],
    );
    await expect(
      scoped(async (scope) => {
        const repository = scope.getRepository('company', permissions);
        return withOmniDetachedParentDelete(scope, repository, input, () =>
          repository.delete([records.company, ordinary]),
        );
      }),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
    expect(await fixture.read('company')).toHaveLength(2);
  });
  it('revokes authority after callback failure even when the caller catches it', async () => {
    const input = await prepare('company');
    await expect(
      scoped(async (scope) => {
        const repository = scope.getRepository('company', permissions);
        await expect(
          withOmniDetachedParentDelete(scope, repository, input, async () => {
            throw new Error('INJECTED');
          }),
        ).rejects.toThrow('INJECTED');
        return repository.delete(records.company);
      }),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
  });
  it('rechecks detachment after the callback changes references', async () => {
    const input = await prepare('company');
    const before = await snapshot();
    await expect(
      scoped(async (scope) => {
        const repository = scope.getRepository('company', permissions);
        return withOmniDetachedParentDelete(
          scope,
          repository,
          input,
          async () => {
            await scope.executeRawQuery(
              'UPDATE core."omniConversationTarget" SET active=true WHERE "workspaceId"=$1 AND id=$2',
              [fixture.workspaceId, input.retainedTargets[0].id],
            );
            return repository.delete(records.company);
          },
        );
      }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('snapshots the caller manifest before awaiting policy acquisition', async () => {
    const input = await prepare('company');
    const mutable = {
      ...input,
      retainedTargets: input.retainedTargets.map((row) => ({ ...row })),
    };
    await scoped(async (scope) => {
      const repository = scope.getRepository('company', permissions);
      const pending = withOmniDetachedParentDelete(
        scope,
        repository,
        mutable,
        () => repository.delete(input.recordId),
      );
      mutable.recordId = randomUUID();
      mutable.retainedTargets[0].revision = '99';
      expect((await pending).affected).toBe(1);
    });
  });
});

describe('detached parent authority lifetime and races', () => {
  const barrier = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  it('revokes after normal callback completion', async () => {
    const input = await prepare('company');
    await expect(
      scoped(async (scope) => {
        const repository = scope.getRepository('company', permissions);
        await withOmniDetachedParentDelete(
          scope,
          repository,
          input,
          async () => undefined,
        );
        return repository.delete(records.company);
      }),
    ).rejects.toThrow('OMNI_PARENT_DELETE_REQUIRES_DOMAIN_COMMAND');
  });
  it('refuses a repository issued by an earlier transaction', async () => {
    const input = await prepare('company');
    let previous: unknown;
    await scoped(async (scope) => {
      previous = scope.getRepository('company', permissions);
    });
    await expect(
      scoped((scope) =>
        withOmniDetachedParentDelete(
          scope,
          previous,
          input,
          async () => undefined,
        ),
      ),
    ).rejects.toThrow('FOREIGN_PARENT_DELETE_SCOPE');
  });
  it.each(['person', 'company'] as const)(
    'delete wins against later %s target reactivation',
    async (name) => {
      const input = await prepare(name);
      const entered = barrier(),
        finish = barrier();
      const deletion = scoped(async (scope) => {
        const repository = scope.getRepository(name, permissions, {
          shouldSkipEventEmission: true,
        });
        return withOmniDetachedParentDelete(
          scope,
          repository,
          input,
          async () => {
            entered.release();
            await finish.promise;
            return repository.delete(records[name]);
          },
        );
      });
      await entered.promise;
      const link = target(name, true, '2').then(
        () => null,
        (error) => error,
      );
      finish.release();
      expect((await deletion).affected).toBe(1);
      expect(await link).toBeInstanceOf(Error);
      expect((await core('omniConversationTarget'))[0].active).toBe(false);
    },
  );
  it.each(['person', 'company'] as const)(
    '%s target reactivation wins against later deletion',
    async (name) => {
      const input = await prepare(name);
      if (name === 'person')
        await fixture.service.setOmniIdentityPerson(
          principal(),
          {
            bindingId: context.bindingId,
            externalIdentityId: context.externalIdentityId,
            personId: records.person,
            expectedRevision: '2',
            idempotencyKey: randomUUID(),
          },
          async () => {},
        );
      const entered = barrier(),
        finish = barrier();
      const link = target(name, true, '2', async () => {
        entered.release();
        await finish.promise;
      });
      await entered.promise;
      const deletion = remove(input).then(
        () => null,
        (error) => error,
      );
      finish.release();
      expect((await link).active).toBe(true);
      expect(await deletion).toBeInstanceOf(Error);
      expect(
        (await fixture.read(name)).some(
          (row: { id: string }) => row.id === records[name],
        ),
      ).toBe(true);
    },
  );
  it.each([true, false])(
    'serializes Person delete and identity bind, delete first: %s',
    async (deleteFirst) => {
      const input = await prepare('person');
      const entered = barrier(),
        finish = barrier();
      const bind = (hold: boolean) =>
        fixture.service.setOmniIdentityPerson(
          principal(),
          {
            bindingId: context.bindingId,
            externalIdentityId: context.externalIdentityId,
            personId: records.person,
            expectedRevision: '2',
            idempotencyKey: randomUUID(),
          },
          async () => {
            if (hold) {
              entered.release();
              await finish.promise;
            }
          },
        );
      if (deleteFirst) {
        const deletion = scoped(async (scope) => {
          const repository = scope.getRepository('person', permissions, {
            shouldSkipEventEmission: true,
          });
          return withOmniDetachedParentDelete(
            scope,
            repository,
            input,
            async () => {
              entered.release();
              await finish.promise;
              return repository.delete(records.person);
            },
          );
        });
        await entered.promise;
        const binding = bind(false).then(
          () => null,
          (error) => error,
        );
        finish.release();
        expect((await deletion).affected).toBe(1);
        expect(await binding).toBeInstanceOf(Error);
        expect((await core('omniExternalIdentity'))[0].personId).toBeNull();
      } else {
        const binding = bind(true);
        await entered.promise;
        const deletion = remove(input).then(
          () => null,
          (error) => error,
        );
        finish.release();
        expect((await binding).personId).toBe(records.person);
        expect(await deletion).toBeInstanceOf(Error);
        expect(
          (await fixture.read('person')).some(
            (row: { id: string }) => row.id === records.person,
          ),
        ).toBe(true);
      }
    },
  );
});
