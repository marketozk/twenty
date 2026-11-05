import { randomUUID } from 'node:crypto';
import {
  FieldActorSource,
  ConnectedAccountProvider,
} from 'twenty-shared/types';
import {
  contactCreationActualIds,
  contactCreationColumns,
} from 'src/engine/core-modules/crm-audit/contact-creation-proof';
import { CoreAuditPostCommitError } from 'src/engine/core-modules/crm-audit/core-audit-post-commit.error';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { CreateCompanyAndContactJob } from 'src/modules/contact-creation-manager/jobs/create-company-and-contact.job';
import { CreateCompanyAndPersonService } from 'src/modules/contact-creation-manager/services/create-company-and-contact.service';

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

it('job captures immutable payload and passes a named system audit operation before awaiting service', async () => {
  const workspaceId = randomUUID();
  const accountId = randomUUID();
  let observedCall: unknown[];
  const createCompaniesAndPeopleAndUpdateParticipants = jest
    .fn()
    .mockImplementation(async (...args: unknown[]) => {
      observedCall = args;
    });
  const job = new CreateCompanyAndContactJob({
    createCompaniesAndPeopleAndUpdateParticipants,
  } as never);
  const payload = {
    workspaceId: workspaceId.toUpperCase(),
    connectedAccount: {
      id: accountId.toUpperCase(),
      handle: 'owner@acme.com',
      handleAliases: ['alias@acme.com'],
      provider: ConnectedAccountProvider.GOOGLE,
    },
    contactsToCreate: [
      { handle: 'client@partner.io', displayName: 'Jane Partner' },
    ],
    source: FieldActorSource.EMAIL,
  };
  const promise = job.handle(payload as never);
  payload.connectedAccount.handleAliases.push('mutated@acme.com');
  payload.contactsToCreate[0].displayName = 'Mutated';
  await promise;

  expect(createCompaniesAndPeopleAndUpdateParticipants).toHaveBeenCalledTimes(
    1,
  );
  const [accountArg, contactsArg, wsArg, sourceArg, operationArg] =
    observedCall!;
  expect(accountArg).toMatchObject({
    id: accountId.toLowerCase(),
    handleAliases: ['alias@acme.com'],
  });
  expect(contactsArg).toEqual([
    { handle: 'client@partner.io', displayName: 'Jane Partner' },
  ]);
  expect(wsArg).toBe(workspaceId.toUpperCase());
  expect(sourceArg).toBe(FieldActorSource.EMAIL);
  expect(operationArg).toMatchObject({
    workspaceId: workspaceId.toLowerCase(),
    actor: { kind: 'system', id: 'CreateCompanyAndContactJob' },
  });
});

it.each([
  new NativeTransactionOutcomeUnknownError('commit', new Error('ACK lost')),
  new CoreAuditPostCommitError('post-commit failed'),
])(
  'service rethrows unsafe transaction outcomes without swallowing or continuing later batches',
  async (unsafeError) => {
    const captureExceptions = jest.fn();
    const service = new CreateCompanyAndPersonService(
      {} as never,
      {} as never,
      {} as never,
      { captureExceptions } as never,
      {} as never,
      {} as never,
    );
    const spy = jest
      .spyOn(service, 'createCompaniesAndPeople')
      .mockRejectedValueOnce(unsafeError);
    const contacts = Array.from({ length: 105 }, (_, index) => ({
      handle: `contact-${index}@partner.io`,
      displayName: `Contact ${index}`,
    }));
    await expect(
      service.createCompaniesAndPeopleAndUpdateParticipants(
        {
          id: randomUUID(),
          handle: 'owner@acme.com',
          handleAliases: [],
          provider: ConnectedAccountProvider.GOOGLE,
        } as never,
        contacts,
        randomUUID(),
        FieldActorSource.EMAIL,
      ),
    ).rejects.toBe(unsafeError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(captureExceptions).not.toHaveBeenCalled();
  },
);

it('validates contactCreationColumns and contactCreationActualIds strictly', () => {
  const personShape = {
    objectMetadataId: randomUUID(),
    nameSingular: 'person',
    schemaName: 'workspace_test',
    tableName: 'person',
    columnShapeByColumnName: {
      id: {
        columnName: 'id',
        fieldMetadataId: randomUUID(),
        fieldMetadataType: 'UUID',
      },
      companyId: {
        columnName: 'companyId',
        fieldMetadataId: randomUUID(),
        fieldMetadataType: 'UUID',
      },
      emailsPrimaryEmail: {
        columnName: 'emailsPrimaryEmail',
        fieldMetadataId: randomUUID(),
        fieldMetadataType: 'TEXT',
        compositeParentFieldName: 'emails',
      },
      nameFirstName: {
        columnName: 'nameFirstName',
        fieldMetadataId: randomUUID(),
        fieldMetadataType: 'TEXT',
        compositeParentFieldName: 'name',
      },
    },
  };
  const id = randomUUID();
  expect(
    contactCreationColumns(personShape, {
      id,
      emails: { primaryEmail: 'a@b.io' },
      name: { firstName: 'Alice' },
    }),
  ).toEqual({
    id,
    emailsPrimaryEmail: 'a@b.io',
    nameFirstName: 'Alice',
  });
  expect(() =>
    contactCreationColumns(personShape, { unknownField: 'x' }),
  ).toThrow('outside plan');
  expect(
    contactCreationActualIds({ raw: [{ id }], affected: 1 }, [id]),
  ).toEqual([id]);
  expect(() =>
    contactCreationActualIds({ raw: [], affected: 0 }, [id]),
  ).toThrow('count mismatch');
});
