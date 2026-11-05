import { randomUUID } from 'node:crypto';
import {
  ConnectedAccountProvider,
  FieldActorSource,
} from 'twenty-shared/types';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CreateCompanyAndContactJob } from 'src/modules/contact-creation-manager/jobs/create-company-and-contact.job';
import { CreateCompanyAndPersonService } from 'src/modules/contact-creation-manager/services/create-company-and-contact.service';
import { CreateCompanyService } from 'src/modules/contact-creation-manager/services/create-company.service';
import { CreatePersonService } from 'src/modules/contact-creation-manager/services/create-person.service';
import { createOmniNativeCleanupFixture } from 'test/fork-migration/omni-native-cleanup.fixture';

jest.mock('src/engine/twenty-orm/workspace-orm.manager', () => ({
  WorkspaceOrmManager: class {},
}));
jest.mock(
  'src/engine/core-modules/secure-http-client/secure-http-client.service',
  () => ({ SecureHttpClientService: class {} }),
);
jest.mock(
  'src/engine/core-modules/exception-handler/exception-handler.service',
  () => ({ ExceptionHandlerService: class {} }),
);
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.entity',
  () => ({ UserWorkspaceEntity: class {} }),
);
jest.mock('src/engine/core-modules/workspace/workspace.entity', () => ({
  WorkspaceEntity: class {},
}));
jest.mock(
  'src/engine/metadata-modules/message-channel/entities/message-channel.entity',
  () => ({ MessageChannelEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/connected-account/entities/connected-account.entity',
  () => ({ ConnectedAccountEntity: class {} }),
);
jest.mock(
  'src/engine/metadata-modules/index-metadata/index-metadata.entity',
  () => ({ IndexMetadataEntity: class {} }),
);

const f = createOmniNativeCleanupFixture();
const table = (name: string) => `"${f.schemaName}"."${name}"`;
const audit = () =>
  f.owner.query(
    'SELECT * FROM crm_audit."crmAuditEntry" ORDER BY "createdAt" ASC, "resourceId" ASC',
  );
const companies = () =>
  f.owner.query(
    `SELECT * FROM ${table('company')} ORDER BY position ASC, id ASC`,
  );
const people = () =>
  f.owner.query(
    `SELECT * FROM ${table('person')} ORDER BY "emailsPrimaryEmail" ASC, id ASC`,
  );

const insert = async (name: string, fields: Record<string, unknown>) => {
  const id = randomUUID();
  await f.seedNative((scope) =>
    scope
      .getRepository(name, { shouldBypassPermissionChecks: true })
      .insert({ id, ...fields }),
  );
  f.eventEmitter.mockClear();
  return id;
};

const createHarness = async (
  options: {
    source?: FieldActorSource;
    provider?: ConnectedAccountProvider;
    isContactAutoCreationEnabled?: boolean;
    isInternalMessagesImportEnabled?: boolean;
  } = {},
) => {
  const source = options.source ?? FieldActorSource.EMAIL;
  const provider = options.provider ?? ConnectedAccountProvider.GOOGLE;
  const isContactAutoCreationEnabled =
    options.isContactAutoCreationEnabled ?? true;
  if (options.isInternalMessagesImportEnabled !== undefined) {
    await f.owner.query(
      'UPDATE core.workspace SET "isInternalMessagesImportEnabled"=$2 WHERE id=$1',
      [f.workspaceId, options.isInternalMessagesImportEnabled],
    );
  }
  const userId = randomUUID();
  const userWorkspaceId = randomUUID();
  await f.owner.query('INSERT INTO core."user"(id) VALUES($1)', [userId]);
  await f.owner.query(
    'INSERT INTO core."userWorkspace"(id,"userId","workspaceId") VALUES($1,$2,$3)',
    [userWorkspaceId, userId, f.workspaceId],
  );
  const memberId = await insert('workspaceMember', {
    userId,
    name: { firstName: 'Alice', lastName: 'Owner' },
    userEmail: 'owner@acme.com',
  });
  const accountId = await f.coreInsert('connectedAccount', {
    workspaceId: f.workspaceId,
    provider,
    scope: 'USER',
    userWorkspaceId,
    handle: 'owner@acme.com',
    handleAliases: ['alias@acme.com'],
  });
  const channelId =
    source === FieldActorSource.EMAIL
      ? await f.coreInsert('messageChannel', {
          workspaceId: f.workspaceId,
          type: 'EMAIL',
          connectedAccountId: accountId,
          handle: 'owner@acme.com',
          isContactAutoCreationEnabled,
        })
      : await f.coreInsert('calendarChannel', {
          workspaceId: f.workspaceId,
          connectedAccountId: accountId,
          handle: 'owner@acme.com',
          isContactAutoCreationEnabled,
        });

  const httpGet = jest.fn().mockImplementation(async (url: string) => ({
    data: {
      name: `Enriched ${url.replace(/^\//, '')}`,
      city: 'San Francisco',
    },
  }));
  const captureExceptions = jest.fn();
  const createCompanyService = new CreateCompanyService(f.manager, {
    getHttpClient: () => ({ get: httpGet }),
  } as never);
  const createPersonService = new CreatePersonService(f.manager);
  const service = new CreateCompanyAndPersonService(
    createPersonService,
    createCompanyService,
    f.manager,
    { captureExceptions } as never,
    {} as never,
    {} as never,
  );
  const job = new CreateCompanyAndContactJob(service);
  const connectedAccount = {
    id: accountId,
    userWorkspaceId,
    provider,
    scope: 'USER',
    handle: 'owner@acme.com',
    handleAliases: ['alias@acme.com'],
  };

  return {
    userId,
    userWorkspaceId,
    memberId,
    accountId,
    channelId,
    httpGet,
    captureExceptions,
    createCompanyService,
    createPersonService,
    service,
    job,
    connectedAccount,
    runJob: (
      contactsToCreate = [
        { handle: 'jane.doe@partner.io', displayName: 'Jane Doe' },
      ],
    ) =>
      job.handle({
        workspaceId: f.workspaceId,
        connectedAccount: connectedAccount as never,
        contactsToCreate,
        source,
      }),
  };
};

beforeAll(async () => {
  await f.initialize();
  await f.owner.query(
    'ALTER TABLE core.workspace ADD COLUMN IF NOT EXISTS "isInternalMessagesImportEnabled" boolean NOT NULL DEFAULT false',
  );
  await f.owner.query(
    'ALTER TABLE core."connectedAccount" ADD COLUMN IF NOT EXISTS "workspaceId" uuid,ADD COLUMN IF NOT EXISTS provider text,ADD COLUMN IF NOT EXISTS scope text,ADD COLUMN IF NOT EXISTS "userWorkspaceId" uuid,ADD COLUMN IF NOT EXISTS handle text,ADD COLUMN IF NOT EXISTS "handleAliases" text[],ADD COLUMN IF NOT EXISTS "archivedAt" timestamptz',
  );
  await f.owner.query(
    'ALTER TABLE core."messageChannel" ADD COLUMN IF NOT EXISTS "isContactAutoCreationEnabled" boolean NOT NULL DEFAULT true',
  );
  await f.owner.query(
    'CREATE TABLE IF NOT EXISTS core."calendarChannel"(id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"connectedAccountId" uuid NOT NULL,handle text,"isContactAutoCreationEnabled" boolean NOT NULL DEFAULT true)',
  );
  await f.owner.query(
    'CREATE TABLE IF NOT EXISTS core."user"(id uuid PRIMARY KEY,disabled boolean NOT NULL DEFAULT false,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    'CREATE TABLE IF NOT EXISTS core."userWorkspace"(id uuid PRIMARY KEY,"userId" uuid NOT NULL,"workspaceId" uuid NOT NULL,"deletedAt" timestamptz)',
  );
  await f.owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA core TO "${f.roleName}"`,
  );
});

beforeEach(async () => {
  await f.owner.query(
    `DROP TRIGGER IF EXISTS contact_creation_test ON ${table('company')}`,
  );
  await f.owner.query(
    `DROP TRIGGER IF EXISTS contact_creation_test ON ${table('person')}`,
  );
  await f.owner.query(
    'DROP TRIGGER IF EXISTS contact_creation_audit_test ON crm_audit."crmAuditEntry"',
  );
  await f.owner.query(
    `DROP FUNCTION IF EXISTS "${f.schemaName}".contact_creation_test()`,
  );
  await f.owner.query(
    `DROP TABLE IF EXISTS "${f.schemaName}"._test_company_fk_cascade CASCADE`,
  );
  await f.reset();
  await f.owner.query(
    'TRUNCATE core."user",core."userWorkspace",core."calendarChannel" CASCADE',
  );
});

afterAll(async () => f.dispose());

it.each([FieldActorSource.EMAIL, FieldActorSource.CALENDAR] as const)(
  'creates company and person with one atomic audit operation for %s and performs HTTP prefetch before DB transaction',
  async (source) => {
    const h = await createHarness({ source });
    const trace: string[] = [];
    h.httpGet.mockImplementationOnce(async (url: string) => {
      trace.push(`http:${url}`);
      return {
        data: { name: 'Partner Corp', city: 'Austin' },
      };
    });
    const originalRunInTx = f.manager.runInWorkspaceTransaction.bind(f.manager);
    const txSpy = jest
      .spyOn(f.manager, 'runInWorkspaceTransaction')
      .mockImplementation((async (work: unknown, options: unknown) => {
        trace.push('tx:start');
        return originalRunInTx(work as never, options as never);
      }) as typeof f.manager.runInWorkspaceTransaction);

    await h.runJob([
      { handle: 'Jane.Doe@Partner.io', displayName: 'Jane Doe' },
    ]);
    txSpy.mockRestore();

    expect(trace).toEqual(['http:/partner.io', 'tx:start']);
    const savedCompanies = await companies();
    expect(savedCompanies).toHaveLength(1);
    expect(savedCompanies[0]).toMatchObject({
      name: 'Partner Corp',
      domainNamePrimaryLinkUrl: 'partner.io',
      addressAddressCity: 'Austin',
      createdBySource: source,
      createdByWorkspaceMemberId: h.memberId,
      createdByName: 'Alice Owner',
      position: 1,
    });

    const savedPeople = await people();
    expect(savedPeople).toHaveLength(1);
    expect(savedPeople[0]).toMatchObject({
      companyId: savedCompanies[0].id,
      emailsPrimaryEmail: 'jane.doe@partner.io',
      nameFirstName: 'Jane',
      nameLastName: 'Doe',
      createdBySource: source,
      createdByWorkspaceMemberId: h.memberId,
      createdByName: 'Alice Owner',
      position: 0,
    });

    const entries = await audit();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry: { action: string }) => entry.action)).toEqual([
      'create',
      'create',
    ]);
    expect(entries[0].operationId).toBe(entries[1].operationId);
    expect(entries[0].actor).toEqual({
      kind: 'system',
      id: 'CreateCompanyAndContactJob',
    });
    expect(f.eventEmitter).toHaveBeenCalled();
  },
);

it('restores soft-deleted companies (by primary or secondary link) and soft-deleted people (by primary or additional email) and aggregates restore + name enrichment into one update audit entry', async () => {
  const h = await createHarness();
  const deletedCompanyId = await insert('company', {
    name: 'Secondary Corp',
    domainName: {
      primaryLinkUrl: 'primary-corp.io',
      secondaryLinks: [{ url: 'secondary-corp.io', label: 'Sec' }],
    },
    deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    position: 5,
  });
  const deletedPersonId = await insert('person', {
    emails: {
      primaryEmail: 'primary@secondary-corp.io',
      additionalEmails: ['alt@secondary-corp.io'],
    },
    name: { firstName: '', lastName: '' },
    createdBy: {
      source: FieldActorSource.EMAIL,
      workspaceMemberId: h.memberId,
      name: 'Alice Owner',
      context: { provider: ConnectedAccountProvider.GOOGLE },
    },
    deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    position: 3,
  });
  const manualPersonId = await insert('person', {
    emails: { primaryEmail: 'manual@secondary-corp.io', additionalEmails: [] },
    name: { firstName: '', lastName: '' },
    createdBy: {
      source: FieldActorSource.MANUAL,
      workspaceMemberId: h.memberId,
      name: 'Alice Owner',
      context: {},
    },
    position: 4,
  });

  await h.runJob([
    { handle: 'alt@secondary-corp.io', displayName: 'Restored User' },
    { handle: 'primary@secondary-corp.io', displayName: 'Restored User' },
    { handle: 'manual@secondary-corp.io', displayName: 'Ignored Manual Name' },
  ]);

  expect(h.httpGet).not.toHaveBeenCalled();
  const [restoredCompany] = await companies();
  expect(restoredCompany.id).toBe(deletedCompanyId);
  expect(restoredCompany.deletedAt).toBeNull();

  const savedPeople = await people();
  const restoredPerson = savedPeople.find(
    (p: { id: string }) => p.id === deletedPersonId,
  );
  const manualPerson = savedPeople.find(
    (p: { id: string }) => p.id === manualPersonId,
  );
  expect(restoredPerson).toMatchObject({
    deletedAt: null,
    companyId: deletedCompanyId,
    nameFirstName: 'Restored',
    nameLastName: 'User',
  });
  expect(manualPerson).toMatchObject({
    nameFirstName: '',
    nameLastName: '',
  });

  const entries = await audit();
  expect(entries).toHaveLength(2);
  expect(entries.every((e: { action: string }) => e.action === 'update')).toBe(
    true,
  );
  expect(
    new Set(entries.map((e: { resourceId: string }) => e.resourceId)),
  ).toEqual(new Set([deletedCompanyId, deletedPersonId]));
});

it('uses fresh locked connectedAccount handles/aliases and workspace internal-message policy instead of stale queue payload', async () => {
  const h = await createHarness({ isInternalMessagesImportEnabled: false });
  await f.owner.query(
    `UPDATE core."connectedAccount" SET "handleAliases"=ARRAY['fresh-alias@partner.io'] WHERE id=$1`,
    [h.accountId],
  );
  await h.runJob([
    { handle: 'fresh-alias@partner.io', displayName: 'Fresh Self Alias' },
    { handle: 'colleague@acme.com', displayName: 'Same Domain Colleague' },
  ]);
  expect(await people()).toHaveLength(0);
  expect(await companies()).toHaveLength(0);
  expect(await audit()).toHaveLength(0);

  await f.owner.query(
    'UPDATE core.workspace SET "isInternalMessagesImportEnabled"=true WHERE id=$1',
    [f.workspaceId],
  );
  await h.runJob([
    { handle: 'colleague@acme.com', displayName: 'Same Domain Colleague' },
  ]);
  expect(await people()).toHaveLength(1);
  expect(await companies()).toHaveLength(1);
  expect(await audit()).toHaveLength(2);
});

it.each([
  [
    'archived connectedAccount',
    async (h: Awaited<ReturnType<typeof createHarness>>) =>
      f.owner.query(
        'UPDATE core."connectedAccount" SET "archivedAt"=now() WHERE id=$1',
        [h.accountId],
      ),
  ],
  [
    'soft-deleted userWorkspace',
    async (h: Awaited<ReturnType<typeof createHarness>>) =>
      f.owner.query(
        'UPDATE core."userWorkspace" SET "deletedAt"=now() WHERE id=$1',
        [h.userWorkspaceId],
      ),
  ],
  [
    'disabled core user',
    async (h: Awaited<ReturnType<typeof createHarness>>) =>
      f.owner.query('UPDATE core."user" SET disabled=true WHERE id=$1', [
        h.userId,
      ]),
  ],
  [
    'disabled channel auto-creation',
    async (h: Awaited<ReturnType<typeof createHarness>>) =>
      f.owner.query(
        'UPDATE core."messageChannel" SET "isContactAutoCreationEnabled"=false WHERE id=$1',
        [h.channelId],
      ),
  ],
])(
  'skips contact creation cleanly with zero writes and zero audit when %s',
  async (_label, disableAuthority) => {
    const h = await createHarness();
    await disableAuthority(h);
    await h.runJob();
    expect(await companies()).toHaveLength(0);
    expect(await people()).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  },
);

it('refuses and rolls back when connectedAccount or messageChannel is enrolled into omnichannel', async () => {
  const h = await createHarness();
  await f.owner.query(
    `INSERT INTO core."omniAccountBinding"(id,"workspaceId","connectedAccountId","messageChannelId",platform,"accountId","connectorInstanceId",status,"autoCreatePersonEnabled","capabilitiesVersion",capabilities) VALUES($1,$2,$3,$4,'telegram','acct-1','conn-1','inactive',false,'1','{}'::jsonb)`,
    [randomUUID(), f.workspaceId, h.accountId, h.channelId],
  );
  await h.runJob();
  expect(h.captureExceptions).toHaveBeenCalledTimes(1);
  expect(String(h.captureExceptions.mock.calls[0][0][0]?.message)).toContain(
    'Contact creation excludes omnichannel accounts',
  );
  expect(await companies()).toHaveLength(0);
  expect(await people()).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it.each([
  [
    'skipped company insert',
    'company',
    'BEFORE INSERT',
    'RETURN NULL;',
    /RETURNING count mismatch/,
  ],
  [
    'rewritten person primary email',
    'person',
    'BEFORE INSERT',
    'NEW."emailsPrimaryEmail" := \'tampered@partner.io\'; RETURN NEW;',
    /insert effects mismatch/,
  ],
])(
  'rolls back company, person and audit when a trigger causes %s',
  async (_label, targetTable, timing, body, expectedPattern) => {
    const h = await createHarness();
    await f.owner.query(
      `CREATE FUNCTION "${f.schemaName}".contact_creation_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN ${body} END $$; CREATE TRIGGER contact_creation_test ${timing} ON ${table(targetTable)} FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".contact_creation_test()`,
    );
    await expect(
      h.service.createCompaniesAndPeople(
        h.connectedAccount as never,
        [{ handle: 'jane@partner.io', displayName: 'Jane Doe' }],
        f.workspaceId,
        FieldActorSource.EMAIL,
      ),
    ).rejects.toThrow(expectedPattern);
    expect(await companies()).toHaveLength(0);
    expect(await people()).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  },
);

it('rolls back when a deferred trigger mutates core authority or workspaceMember sources before COMMIT', async () => {
  const h = await createHarness();
  await f.owner.query(
    `CREATE FUNCTION "${f.schemaName}".contact_creation_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN UPDATE core."user" SET disabled=true WHERE id='${h.userId}'; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER contact_creation_audit_test AFTER INSERT ON crm_audit."crmAuditEntry" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${f.schemaName}".contact_creation_test()`,
  );
  await expect(
    h.service.createCompaniesAndPeople(
      h.connectedAccount as never,
      [{ handle: 'jane@partner.io', displayName: 'Jane Doe' }],
      f.workspaceId,
      FieldActorSource.EMAIL,
    ),
  ).rejects.toThrow('Contact creation authority changed before commit');
  expect(await companies()).toHaveLength(0);
  expect(await people()).toHaveLength(0);
  expect(await audit()).toHaveLength(0);
});

it('refuses incoming ON UPDATE CASCADE foreign keys on updated person rows before DML executes', async () => {
  const h = await createHarness();
  const existingPersonId = await insert('person', {
    emails: { primaryEmail: 'jane@partner.io', additionalEmails: [] },
    name: { firstName: '', lastName: '' },
    createdBy: {
      source: FieldActorSource.EMAIL,
      workspaceMemberId: h.memberId,
      name: 'Alice Owner',
      context: { provider: ConnectedAccountProvider.GOOGLE },
    },
    position: 1,
  });
  await f.owner.query(
    `ALTER TABLE ${table('person')} ADD CONSTRAINT person_id_first_name_uq UNIQUE (id, "nameFirstName")`,
  );
  await f.owner.query(
    `CREATE TABLE "${f.schemaName}"._test_company_fk_cascade(id uuid PRIMARY KEY, "personId" uuid NOT NULL, "nameFirstName" text, CONSTRAINT fk_person_cascade FOREIGN KEY ("personId", "nameFirstName") REFERENCES ${table('person')}(id, "nameFirstName") ON UPDATE CASCADE)`,
  );
  await f.owner.query(
    `GRANT SELECT ON "${f.schemaName}"._test_company_fk_cascade TO "${f.roleName}"`,
  );
  await f.owner.query(
    `INSERT INTO "${f.schemaName}"._test_company_fk_cascade(id, "personId", "nameFirstName") VALUES ($1, $2, '')`,
    [randomUUID(), existingPersonId],
  );

  await expect(
    h.service.createCompaniesAndPeople(
      h.connectedAccount as never,
      [{ handle: 'jane@partner.io', displayName: 'Jane Enriched' }],
      f.workspaceId,
      FieldActorSource.EMAIL,
    ),
  ).rejects.toThrow(/referential update effects/i);
  await f.owner.query(
    `DROP TABLE "${f.schemaName}"._test_company_fk_cascade CASCADE`,
  );
  await f.owner.query(
    `ALTER TABLE ${table('person')} DROP CONSTRAINT person_id_first_name_uq`,
  );
});

it('processes >100 contacts in sequential batches sharing one correlationId and stops immediately on NativeTransactionOutcomeUnknownError', async () => {
  const h = await createHarness();
  const batchContacts = Array.from({ length: 102 }, (_, index) => ({
    handle: `person-${index}@domain-${index}.io`,
    displayName: `Person ${index}`,
  }));
  await h.runJob(batchContacts);
  expect(await people()).toHaveLength(102);
  expect(await companies()).toHaveLength(102);
  const entries = await audit();
  expect(entries).toHaveLength(204);
  const correlationIds = new Set(
    entries.map((e: { correlationId: string }) => e.correlationId),
  );
  const operationIds = new Set(
    entries.map((e: { operationId: string }) => e.operationId),
  );
  expect(correlationIds.size).toBe(1);
  expect(operationIds.size).toBe(2);

  const unknownError = new NativeTransactionOutcomeUnknownError(
    'commit',
    new Error('lost commit ACK on batch 1'),
  );
  const spy = jest
    .spyOn(h.service, 'createCompaniesAndPeople')
    .mockRejectedValueOnce(unknownError);
  await expect(
    h.runJob([
      { handle: 'new-1@other.io', displayName: 'New 1' },
      { handle: 'new-2@other.io', displayName: 'New 2' },
    ]),
  ).rejects.toBe(unknownError);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(h.captureExceptions).not.toHaveBeenCalled();
  spy.mockRestore();
});

it('falls back to getCompanyNameFromDomainName on HTTP failure and emits no redundant update audit when linking a new person to an already-live company', async () => {
  const h = await createHarness();
  h.httpGet.mockRejectedValueOnce(new Error('HTTP timeout'));
  await h.runJob([
    { handle: 'first@acme-fallback.io', displayName: 'First User' },
  ]);

  const [createdCompany] = await companies();
  expect(createdCompany).toMatchObject({
    name: 'Acme-fallback',
    domainNamePrimaryLinkUrl: 'acme-fallback.io',
    addressAddressCity: '',
  });
  expect(await audit()).toHaveLength(2);

  await h.runJob([
    { handle: 'second@acme-fallback.io', displayName: 'Second User' },
  ]);
  expect(h.httpGet).toHaveBeenCalledTimes(1);
  expect(await companies()).toHaveLength(1);
  expect(await people()).toHaveLength(2);
  const entriesAfterSecond = await audit();
  expect(entriesAfterSecond).toHaveLength(3);
  expect(
    entriesAfterSecond.filter((e: { action: string }) => e.action === 'update'),
  ).toHaveLength(0);
});

it.each([
  [
    'application provider account',
    async (h: Awaited<ReturnType<typeof createHarness>>) =>
      f.owner.query(
        `UPDATE core."connectedAccount" SET provider='app' WHERE id=$1`,
        [h.accountId],
      ),
    'Contact creation excludes application accounts',
  ],
  [
    'APP messageChannel',
    async (h: Awaited<ReturnType<typeof createHarness>>) =>
      f.owner.query(`UPDATE core."messageChannel" SET type='APP' WHERE id=$1`, [
        h.channelId,
      ]),
    'Contact creation excludes application channels',
  ],
])(
  'refuses and rolls back when %s is present',
  async (_label, mutateAuthority, expectedMessage) => {
    const h = await createHarness();
    await mutateAuthority(h);
    await expect(
      h.service.createCompaniesAndPeople(
        h.connectedAccount as never,
        [{ handle: 'jane@partner.io', displayName: 'Jane Doe' }],
        f.workspaceId,
        FieldActorSource.EMAIL,
      ),
    ).rejects.toThrow(expectedMessage);
    expect(await companies()).toHaveLength(0);
    expect(await people()).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  },
);
