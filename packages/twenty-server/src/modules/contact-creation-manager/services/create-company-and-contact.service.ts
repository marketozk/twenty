import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isNonEmptyString, isNull } from '@sniptt/guards';
import { isUUID } from 'class-validator';
import chunk from 'lodash.chunk';
import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';
import {
  ConnectedAccountProvider,
  FieldActorSource,
  type FullNameMetadata,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type DeepPartial, type Repository } from 'typeorm';
import { v4 } from 'uuid';

import { castCalendarProofImage } from 'src/engine/core-modules/crm-audit/calendar-target-proof';
import {
  CONTACT_CREATION_TABLES,
  CONTACT_CREATION_WRITE_TABLES,
  contactCreationActualIds,
  contactCreationColumns,
  contactCreationTableSql,
  quoteContactCreationIdentifier,
  type ContactCreationSnapshot,
  type ContactCreationTable,
  type ContactCreationWriteTable,
} from 'src/engine/core-modules/crm-audit/contact-creation-proof';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  captureCrmAuditOperation,
  CrmAuditTransactionContext,
} from 'src/engine/core-modules/crm-audit/crm-audit-transaction-context';
import { createCrmAuditWorkspaceExecutor } from 'src/engine/core-modules/crm-audit/crm-audit-transaction-executor';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import {
  assertNativeCrmDeleteFilesEmpty,
  captureNativeCrmAuditSnapshot,
  captureNativeCrmAuditWriteData,
  readNativeCrmAuditRows,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { isTransactionUnsafeToRetry } from 'src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { assertNoReferentialUpdateEffects } from 'src/engine/twenty-orm/utils/assert-no-referential-update-effects';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { isDuplicateEntryError } from 'src/engine/twenty-orm/utils/is-duplicate-entry-error.util';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { CONTACTS_CREATION_BATCH_SIZE } from 'src/modules/contact-creation-manager/constants/contacts-creation-batch-size.constant';
import { CreateCompanyService } from 'src/modules/contact-creation-manager/services/create-company.service';
import { CreatePersonService } from 'src/modules/contact-creation-manager/services/create-person.service';
import { type Contact } from 'src/modules/contact-creation-manager/types/contact.type';
import { filterOutContactsThatBelongToSelfOrWorkspaceMembers } from 'src/modules/contact-creation-manager/utils/filter-out-contacts-that-belong-to-self-or-workspace-members.util';
import { getDomainNameFromHandle } from 'src/modules/contact-creation-manager/utils/get-domain-name-from-handle.util';
import { getFirstNameAndLastNameFromHandleAndDisplayName } from 'src/modules/contact-creation-manager/utils/get-first-name-and-last-name-from-handle-and-display-name.util';
import { getUniqueContactsAndHandles } from 'src/modules/contact-creation-manager/utils/get-unique-contacts-and-handles.util';
import { addPersonEmailFiltersToQueryBuilder } from 'src/modules/match-participant/utils/add-person-email-filters-to-query-builder';
import {
  findOmniOwnedConnectedAccountIds,
  findOmniOwnedMessageChannelIds,
} from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';
import { computeDisplayName } from 'src/utils/compute-display-name';
import { isWorkDomain, isWorkEmail } from 'src/utils/is-work-email';

type ContactCreationScope = Parameters<
  Parameters<WorkspaceOrmManager['runInWorkspaceTransaction']>[0]
>[0];

type ContactCreationAuditState = {
  scope: ContactCreationScope;
  audit: CrmAuditTransactionContext;
  shapes: Map<ContactCreationTable, NativeCrmAuditTableShape>;
  before: Map<ContactCreationTable, ContactCreationSnapshot[]>;
  expected: Map<ContactCreationTable, ContactCreationSnapshot[]>;
  originalIds: Map<ContactCreationTable, string[]>;
  isInternalMessagesImportEnabled: boolean;
  validators: (() => Promise<void>)[];
};

@Injectable()
export class CreateCompanyAndPersonService {
  private readonly logger = new Logger(CreateCompanyAndPersonService.name);

  constructor(
    private readonly createPersonService: CreatePersonService,
    private readonly createCompaniesService: CreateCompanyService,
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly exceptionHandlerService: ExceptionHandlerService,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
  ) {}

  async createCompaniesAndPeople(
    connectedAccount: ConnectedAccountEntity,
    contactsToCreate: Contact[],
    workspaceId: string,
    source: FieldActorSource,
    accountOwner: WorkspaceMemberWorkspaceEntity | null = null,
    operation?: CrmAuditOperation,
  ): Promise<DeepPartial<PersonWorkspaceEntity>[]> {
    if (
      typeof workspaceId !== 'string' ||
      !isUUID(workspaceId) ||
      !connectedAccount ||
      typeof connectedAccount !== 'object' ||
      typeof connectedAccount.id !== 'string' ||
      !isUUID(connectedAccount.id) ||
      !Array.isArray(contactsToCreate) ||
      (source !== FieldActorSource.EMAIL &&
        source !== FieldActorSource.CALENDAR)
    )
      throw new Error('Contact creation requires valid scoped input');
    const canonicalWorkspaceId = workspaceId.toLowerCase();
    const resolvedOperation = operation
      ? captureCrmAuditOperation(operation)
      : membershipCleanupOperation(
          canonicalWorkspaceId,
          systemMembershipCleanupIdentity(
            canonicalWorkspaceId,
            CreateCompanyAndPersonService.name,
          ),
        )!;
    if (resolvedOperation.workspaceId !== canonicalWorkspaceId)
      throw new Error('Contact creation workspace mismatch');
    const capturedAccount: ConnectedAccountEntity = {
      ...connectedAccount,
      id: connectedAccount.id.toLowerCase(),
      handleAliases: Array.isArray(connectedAccount.handleAliases)
        ? [...connectedAccount.handleAliases]
        : [],
    };
    const capturedContacts: Contact[] = contactsToCreate.map((contact) => {
      if (
        !contact ||
        typeof contact !== 'object' ||
        typeof contact.handle !== 'string' ||
        typeof contact.displayName !== 'string'
      )
        throw new Error('Contact creation requires valid contact entries');
      return {
        handle: contact.handle,
        displayName: contact.displayName,
      };
    });
    const capturedOwner = accountOwner
      ? ({
          ...accountOwner,
          id: accountOwner.id?.toLowerCase(),
          name: accountOwner.name
            ? { ...accountOwner.name }
            : accountOwner.name,
        } as WorkspaceMemberWorkspaceEntity)
      : null;

    if (capturedContacts.length === 0) {
      return [];
    }

    const candidateDomains = [
      ...new Set(
        capturedContacts.flatMap((contact) => {
          if (!contact.handle.includes('@') || !isWorkEmail(contact.handle))
            return [];
          const domainName = getDomainNameFromHandle(contact.handle);
          return isDefined(domainName) && isWorkDomain(domainName)
            ? [domainName]
            : [];
        }),
      ),
    ];
    const prefetchedInfoByDomain =
      await this.createCompaniesService.prefetchCompanyInfoByDomainNames(
        candidateDomains,
        canonicalWorkspaceId,
      );

    const authContext = buildSystemAuthContext(canonicalWorkspaceId);
    const batchOperation: CrmAuditOperation = {
      ...resolvedOperation,
      operationId: randomUUID(),
      actor: { ...resolvedOperation.actor },
      ...(resolvedOperation.initiator
        ? { initiator: { ...resolvedOperation.initiator } }
        : {}),
    };

    return this.workspaceOrmManager.executeInWorkspaceContext(
      async () =>
        this.workspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            const state = await this.prepareContactCreationAudit(
              transactionScope,
              batchOperation,
            );
            const authority = await this.lockContactCreationAuthority(
              state,
              capturedAccount,
              source,
            );
            if (!authority.active) {
              return [];
            }

            const memberIds = (
              await transactionScope.executeRawQuery(
                `SELECT id FROM ${contactCreationTableSql(state.shapes.get('workspaceMember')!)} WHERE "deletedAt" IS NULL ORDER BY id FOR SHARE`,
              )
            ).map((row) => String(row.id).toLowerCase());
            state.originalIds.set('workspaceMember', memberIds);
            const memberSnapshots = await this.readContactCreationGraph(
              state,
              'workspaceMember',
              false,
            );
            state.before.set('workspaceMember', memberSnapshots);
            state.expected.set('workspaceMember', memberSnapshots);

            const workspaceMemberRepository =
              transactionScope.getRepository<WorkspaceMemberWorkspaceEntity>(
                'workspaceMember',
                { shouldBypassPermissionChecks: true },
              );
            const workspaceMembers = await workspaceMemberRepository.find();
            if (
              canonicalAuditJson(
                workspaceMembers
                  .map((member) => member.id.toLowerCase())
                  .sort(),
              ) !== canonicalAuditJson(memberIds)
            )
              throw new Error(
                'Contact creation workspace member source changed before read',
              );

            const resolvedAccountOwner =
              workspaceMembers.find(
                (member) =>
                  typeof member.userId === 'string' &&
                  member.userId.toLowerCase() === authority.userId,
              ) ??
              capturedOwner ??
              null;

            const peopleToCreateFromOtherCompanies =
              filterOutContactsThatBelongToSelfOrWorkspaceMembers(
                capturedContacts,
                authority.connectedAccount,
                workspaceMembers,
                state.isInternalMessagesImportEnabled,
              );

            const { uniqueContacts, uniqueHandles } =
              getUniqueContactsAndHandles(peopleToCreateFromOtherCompanies);

            if (uniqueHandles.length === 0) {
              return [];
            }

            const personRepository =
              transactionScope.getRepository<PersonWorkspaceEntity>('person', {
                shouldBypassPermissionChecks: true,
              });
            const queryBuilder = addPersonEmailFiltersToQueryBuilder({
              queryBuilder: personRepository.createQueryBuilder('person'),
              emails: uniqueHandles,
            });
            const alreadyCreatedPeople = await queryBuilder
              .orderBy('person.createdAt', 'ASC')
              .addOrderBy('person.id', 'ASC')
              .withDeleted()
              .getMany<PersonWorkspaceEntity>();

            const {
              contactsThatNeedPersonCreate,
              contactsThatNeedPersonRestore,
              peopleToEnrichNames,
              workDomainNamesToCreate,
              shouldCreateOrRestorePeopleByHandleMap,
            } =
              this.computeContactsThatNeedPersonCreateAndRestoreAndWorkDomainNamesToCreate(
                uniqueContacts,
                alreadyCreatedPeople,
                source,
                authority.connectedAccount,
                resolvedAccountOwner,
              );

            const companyPlan =
              await this.createCompaniesService.prepareCompaniesWithinTransaction(
                {
                  companies: workDomainNamesToCreate,
                  workspaceId: canonicalWorkspaceId,
                  transactionScope,
                  prefetchedInfoByDomain,
                },
              );

            const referencedCompanyIds = alreadyCreatedPeople.flatMap(
              (person) =>
                typeof person.companyId === 'string' && isUUID(person.companyId)
                  ? [person.companyId.toLowerCase()]
                  : [],
            );
            state.originalIds.set(
              'company',
              [
                ...new Set([
                  ...companyPlan.discoveredCompanyIds,
                  ...referencedCompanyIds,
                  ...companyPlan.companiesToCreate.map((row) =>
                    row.id.toLowerCase(),
                  ),
                ]),
              ].sort(),
            );
            state.originalIds.set(
              'person',
              [
                ...new Set(
                  alreadyCreatedPeople.map((person) => person.id.toLowerCase()),
                ),
              ].sort(),
            );

            for (const name of ['company', 'person'] as const) {
              const rows = await this.readContactCreationGraph(
                state,
                name,
                true,
              );
              state.before.set(name, rows);
              state.expected.set(name, rows);
            }
            const lockedPersonIds = new Set(
              state.before.get('person')!.map((row) => row.id),
            );
            if (
              alreadyCreatedPeople.some(
                (person) => !lockedPersonIds.has(person.id.toLowerCase()),
              )
            )
              throw new Error(
                'Contact creation person discovery changed while locking',
              );
            const lockedCompanyIds = new Set(
              state.before.get('company')!.map((row) => row.id),
            );
            if (
              companyPlan.discoveredCompanyIds.some(
                (id) => !lockedCompanyIds.has(id),
              )
            )
              throw new Error(
                'Contact creation company discovery changed while locking',
              );

            await this.verifyContactCreationGraph(state);

            const insertedCompanyIds = await this.insertContactCreationRecords(
              state,
              'company',
              companyPlan.companiesToCreate.map((row) => ({
                ...row,
                id: row.id.toLowerCase(),
              })),
            );
            if (
              insertedCompanyIds.length !== companyPlan.companiesToCreate.length
            )
              throw new Error(
                'Contact creation skipped company required by plan',
              );

            if (companyPlan.companiesToRestore.length > 0) {
              const restoredCompanyIds =
                await this.updateContactCreationRecords(
                  state,
                  'company',
                  companyPlan.companiesToRestore.map((row) => ({
                    criteria: row.id.toLowerCase(),
                    partialEntity: { deletedAt: null },
                  })),
                  'restore',
                );
              if (
                restoredCompanyIds.length !==
                companyPlan.companiesToRestore.length
              )
                throw new Error(
                  'Contact creation skipped company restore required by plan',
                );
            }

            const companiesMap =
              this.createCompaniesService.createCompanyMapFromSnapshots(
                state.expected.get('company')!,
              );

            const formattedPeopleToCreate =
              this.formatPeopleToCreateFromContacts({
                contactsToCreate: contactsThatNeedPersonCreate,
                createdBy: {
                  source,
                  workspaceMember: resolvedAccountOwner,
                  context: {
                    provider: authority.connectedAccount.provider,
                  },
                },
                companiesMap,
              });
            const lastPersonPosition =
              formattedPeopleToCreate.length > 0
                ? await this.createPersonService.getLastPersonPositionWithinTransaction(
                    canonicalWorkspaceId,
                    transactionScope,
                  )
                : 0;
            const plannedPeople = formattedPeopleToCreate.map(
              (person, index) => ({
                ...person,
                id: (person.id ?? randomUUID()).toLowerCase(),
                ...(typeof person.companyId === 'string' &&
                isUUID(person.companyId)
                  ? { companyId: person.companyId.toLowerCase() }
                  : {}),
                position: lastPersonPosition + index,
              }),
            );
            state.originalIds.set(
              'person',
              [
                ...new Set([
                  ...(state.originalIds.get('person') ?? []),
                  ...plannedPeople.map((row) => row.id),
                ]),
              ].sort(),
            );
            const insertedPersonIds = await this.insertContactCreationRecords(
              state,
              'person',
              plannedPeople,
            );
            if (insertedPersonIds.length !== plannedPeople.length)
              throw new Error(
                'Contact creation skipped person required by plan',
              );

            const peopleToRestore = this.formatPeopleToRestoreFromContacts({
              contactsToRestore: contactsThatNeedPersonRestore,
              companiesMap,
              shouldCreateOrRestorePeopleByHandleMap,
            });
            const restoredPersonIds =
              peopleToRestore.length > 0
                ? await this.updateContactCreationRecords(
                    state,
                    'person',
                    peopleToRestore.map(({ personId, companyId }) => ({
                      criteria: personId.toLowerCase(),
                      partialEntity: {
                        deletedAt: null,
                        ...(companyId !== undefined
                          ? { companyId: companyId.toLowerCase() }
                          : {}),
                      },
                    })),
                    'restore',
                  )
                : [];

            if (peopleToEnrichNames.length > 0) {
              await this.updateContactCreationRecords(
                state,
                'person',
                peopleToEnrichNames.map(({ personId, name }) => ({
                  criteria: personId.toLowerCase(),
                  partialEntity: { name },
                })),
                'update',
              );
            }

            await this.finishContactCreationAudit(state);

            const returnedIds = new Set([
              ...insertedPersonIds,
              ...restoredPersonIds,
            ]);
            return state.expected
              .get('person')!
              .filter((row) => returnedIds.has(row.id))
              .map((row) => ({ id: row.id }));
          },
          { commitOutcome: 'strict', nativeOwnershipLock: 'exclusive' },
        ),
      authContext,
      { lite: true },
    );
  }

  async createCompaniesAndPeopleAndUpdateParticipants(
    connectedAccount: ConnectedAccountEntity,
    contactsToCreate: Contact[],
    workspaceId: string,
    source: FieldActorSource,
    operation?: CrmAuditOperation,
  ) {
    if (
      typeof workspaceId !== 'string' ||
      !isUUID(workspaceId) ||
      !connectedAccount ||
      typeof connectedAccount !== 'object' ||
      typeof connectedAccount.id !== 'string' ||
      !isUUID(connectedAccount.id) ||
      !Array.isArray(contactsToCreate) ||
      (source !== FieldActorSource.EMAIL &&
        source !== FieldActorSource.CALENDAR)
    )
      throw new Error('Contact creation requires valid scoped input');

    const canonicalWorkspaceId = workspaceId.toLowerCase();
    const rootOperation = operation
      ? captureCrmAuditOperation(operation)
      : membershipCleanupOperation(
          canonicalWorkspaceId,
          systemMembershipCleanupIdentity(
            canonicalWorkspaceId,
            CreateCompanyAndPersonService.name,
          ),
        )!;
    if (rootOperation.workspaceId !== canonicalWorkspaceId)
      throw new Error('Contact creation workspace mismatch');

    const capturedAccount: ConnectedAccountEntity = {
      ...connectedAccount,
      id: connectedAccount.id.toLowerCase(),
      handleAliases: Array.isArray(connectedAccount.handleAliases)
        ? [...connectedAccount.handleAliases]
        : [],
    };
    const capturedContacts: Contact[] = contactsToCreate.map((contact) => {
      if (
        !contact ||
        typeof contact !== 'object' ||
        typeof contact.handle !== 'string' ||
        typeof contact.displayName !== 'string'
      )
        throw new Error('Contact creation requires valid contact entries');
      return {
        handle: contact.handle,
        displayName: contact.displayName,
      };
    });

    if (capturedContacts.length === 0) {
      return;
    }

    const contactsBatches = chunk(
      capturedContacts,
      CONTACTS_CREATION_BATCH_SIZE,
    );

    for (const contactsBatch of contactsBatches) {
      try {
        await this.createCompaniesAndPeople(
          capturedAccount,
          contactsBatch,
          canonicalWorkspaceId,
          source,
          null,
          {
            ...rootOperation,
            operationId: randomUUID(),
          },
        );
      } catch (error) {
        if (isTransactionUnsafeToRetry(error)) {
          throw error;
        }
        // Concurrent imports can race on a unique company domain or person email; the record exists either way
        if (isDuplicateEntryError(error)) {
          continue;
        }

        this.exceptionHandlerService.captureExceptions([error], {
          workspace: {
            id: canonicalWorkspaceId,
          },
        });
      }
    }
  }

  computeContactsThatNeedPersonCreateAndRestoreAndWorkDomainNamesToCreate(
    uniqueContacts: Contact[],
    alreadyCreatedPeople: PersonWorkspaceEntity[],
    source: FieldActorSource,
    connectedAccount: ConnectedAccountEntity,
    accountOwner: WorkspaceMemberWorkspaceEntity | null,
  ) {
    const shouldCreateOrRestorePeopleByHandleMap = new Map<
      string,
      { existingPerson: PersonWorkspaceEntity }
    >();

    for (const contact of uniqueContacts) {
      if (!contact.handle.includes('@')) {
        continue;
      }

      const existingPersonOnPrimaryEmail = alreadyCreatedPeople.find(
        (person) => {
          return (
            isNonEmptyString(person.emails?.primaryEmail) &&
            person.emails.primaryEmail.toLowerCase() ===
              contact.handle.toLowerCase()
          );
        },
      );

      if (isDefined(existingPersonOnPrimaryEmail)) {
        shouldCreateOrRestorePeopleByHandleMap.set(
          contact.handle.toLowerCase(),
          {
            existingPerson: existingPersonOnPrimaryEmail,
          },
        );
        continue;
      }

      const existingPersonOnAdditionalEmails = alreadyCreatedPeople.find(
        (person) => {
          return (
            Array.isArray(person.emails?.additionalEmails) &&
            person.emails.additionalEmails.some(
              (email) => email.toLowerCase() === contact.handle.toLowerCase(),
            )
          );
        },
      );

      if (!isDefined(existingPersonOnAdditionalEmails)) continue;

      shouldCreateOrRestorePeopleByHandleMap.set(contact.handle.toLowerCase(), {
        existingPerson: existingPersonOnAdditionalEmails,
      });
    }

    const contactsThatNeedPersonCreate = uniqueContacts.filter(
      (contact) =>
        !shouldCreateOrRestorePeopleByHandleMap.has(
          contact.handle.toLowerCase(),
        ),
    );

    const contactsThatNeedPersonRestore = uniqueContacts.filter((contact) => {
      const existingPerson = shouldCreateOrRestorePeopleByHandleMap.get(
        contact.handle.toLowerCase(),
      )?.existingPerson;

      if (!isDefined(existingPerson)) {
        return false;
      }

      return !isNull(existingPerson.deletedAt);
    });

    const peopleToEnrichNames = this.computePeopleToEnrichNames(
      uniqueContacts,
      shouldCreateOrRestorePeopleByHandleMap,
    );

    const workDomainNamesToCreate = [
      ...contactsThatNeedPersonCreate,
      ...contactsThatNeedPersonRestore,
    ]
      .map((contact) => {
        const companyDomainName = isWorkEmail(contact.handle)
          ? getDomainNameFromHandle(contact.handle)
          : undefined;

        if (!isDefined(companyDomainName) || !isWorkDomain(companyDomainName))
          return undefined;

        return {
          domainName: companyDomainName,
          createdBySource: source,
          createdByWorkspaceMember: accountOwner,
          createdByContext: {
            provider: connectedAccount.provider,
          },
        };
      })
      .filter(isDefined);

    return {
      contactsThatNeedPersonCreate,
      contactsThatNeedPersonRestore,
      peopleToEnrichNames,
      workDomainNamesToCreate,
      shouldCreateOrRestorePeopleByHandleMap,
    };
  }

  private computePeopleToEnrichNames(
    uniqueContacts: Contact[],
    shouldCreateOrRestorePeopleByHandleMap: Map<
      string,
      { existingPerson: PersonWorkspaceEntity }
    >,
  ): { personId: string; name: FullNameMetadata }[] {
    const enrichmentByPersonId = new Map<
      string,
      { firstName: string; lastName: string }
    >();

    for (const contact of uniqueContacts) {
      const existingPerson = shouldCreateOrRestorePeopleByHandleMap.get(
        contact.handle.toLowerCase(),
      )?.existingPerson;

      if (!isDefined(existingPerson)) {
        continue;
      }

      // Soft-deleted matches were already restored earlier in this job
      const existingSource = existingPerson.createdBy?.source;

      if (
        existingSource !== FieldActorSource.CALENDAR &&
        existingSource !== FieldActorSource.EMAIL
      ) {
        continue;
      }

      const staged = enrichmentByPersonId.get(existingPerson.id);
      const currentFirstName =
        staged?.firstName ?? existingPerson.name?.firstName ?? '';
      const currentLastName =
        staged?.lastName ?? existingPerson.name?.lastName ?? '';
      const firstNameIsEmpty = !isNonEmptyString(currentFirstName);
      const lastNameIsEmpty = !isNonEmptyString(currentLastName);

      if (!firstNameIsEmpty && !lastNameIsEmpty) {
        continue;
      }

      const { firstName: parsedFirstName, lastName: parsedLastName } =
        getFirstNameAndLastNameFromHandleAndDisplayName(
          contact.handle,
          contact.displayName,
        );

      const enrichedFirstName =
        firstNameIsEmpty && isNonEmptyString(parsedFirstName)
          ? parsedFirstName
          : currentFirstName;
      const enrichedLastName =
        lastNameIsEmpty && isNonEmptyString(parsedLastName)
          ? parsedLastName
          : currentLastName;

      if (
        enrichedFirstName === currentFirstName &&
        enrichedLastName === currentLastName
      ) {
        continue;
      }

      enrichmentByPersonId.set(existingPerson.id, {
        firstName: enrichedFirstName,
        lastName: enrichedLastName,
      });
    }

    return Array.from(enrichmentByPersonId.entries()).map(
      ([personId, name]) => ({ personId, name }),
    );
  }

  formatPeopleToCreateFromContacts({
    contactsToCreate,
    createdBy,
    companiesMap,
  }: {
    contactsToCreate: {
      handle: string;
      displayName: string;
    }[];
    createdBy: {
      source: FieldActorSource;
      workspaceMember?: WorkspaceMemberWorkspaceEntity | null;
      context: {
        provider: ConnectedAccountProvider;
      };
    };
    companiesMap: Record<string, string>;
  }): Partial<PersonWorkspaceEntity>[] {
    return contactsToCreate.map((contact) => {
      const id = v4();

      const { handle, displayName } = contact;

      const { firstName, lastName } =
        getFirstNameAndLastNameFromHandleAndDisplayName(handle, displayName);
      const createdByName = computeDisplayName(createdBy.workspaceMember?.name);

      const companyId = companiesMap[getDomainNameFromHandle(handle)];

      return {
        id,
        emails: {
          primaryEmail: handle.toLowerCase(),
          additionalEmails: null,
        },
        name: {
          firstName,
          lastName,
        },
        companyId,
        createdBy: {
          source: createdBy.source,
          workspaceMemberId: createdBy.workspaceMember?.id ?? null,
          name: createdByName,
          context: createdBy.context,
        },
      };
    });
  }

  formatPeopleToRestoreFromContacts({
    contactsToRestore,
    companiesMap,
    shouldCreateOrRestorePeopleByHandleMap,
  }: {
    contactsToRestore: {
      handle: string;
      displayName: string;
    }[];
    companiesMap: Record<string, string>;
    shouldCreateOrRestorePeopleByHandleMap: Map<
      string,
      { existingPerson: PersonWorkspaceEntity | undefined }
    >;
  }): { personId: string; companyId: string | undefined }[] {
    const peopleToRestore = new Map<
      string,
      { personId: string; companyId: string | undefined }
    >();

    for (const contact of contactsToRestore) {
      const { handle } = contact;

      const existingPerson = shouldCreateOrRestorePeopleByHandleMap.get(
        handle.toLowerCase(),
      )?.existingPerson;

      if (!isDefined(existingPerson) || isNull(existingPerson.deletedAt))
        continue;

      const companyId = companiesMap[getDomainNameFromHandle(handle)];
      const existingEntry = peopleToRestore.get(existingPerson.id);
      if (
        !existingEntry ||
        (existingEntry.companyId === undefined && companyId !== undefined)
      ) {
        peopleToRestore.set(existingPerson.id, {
          personId: existingPerson.id,
          companyId,
        });
      }
    }

    return [...peopleToRestore.values()];
  }

  private async prepareContactCreationAudit(
    scope: ContactCreationScope,
    operation: CrmAuditOperation,
  ): Promise<ContactCreationAuditState> {
    const context = getIssuedNativeCleanupMetadata(scope);
    if (
      context.authType !== 'system' ||
      context.authWorkspaceId !== scope.workspaceId ||
      operation.workspaceId !== scope.workspaceId
    )
      throw new Error(
        'Contact creation requires issued scoped system authority',
      );
    const shapes = new Map<ContactCreationTable, NativeCrmAuditTableShape>();
    for (const name of CONTACT_CREATION_TABLES) {
      const matches = context.objects.filter(
        ({ metadata }) => metadata.nameSingular === name,
      );
      const entry = matches[0];
      if (
        matches.length !== 1 ||
        !entry ||
        entry.metadata.universalIdentifier !==
          STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name] ||
        entry.metadata.applicationUniversalIdentifier !==
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER ||
        entry.metadata.isSystem !== (name === 'workspaceMember') ||
        entry.metadata.isRemote !== false ||
        entry.shape.nameSingular !== name ||
        entry.shape.objectMetadataId !== entry.metadata.id ||
        !entry.shape.columnShapeByColumnName.id ||
        !entry.shape.columnShapeByColumnName.deletedAt
      )
        throw new Error('Contact creation requires exact standard metadata');
      shapes.set(name, entry.shape);
    }
    const schemas = new Set(
      [...shapes.values()].map((shape) => shape.schemaName),
    );
    if (schemas.size !== 1)
      throw new Error('Contact creation requires a single workspace schema');

    const companyShape = shapes.get('company')!;
    const personShape = shapes.get('person')!;
    const references = await getIncomingRecordForeignKeys(
      scope,
      companyShape.schemaName,
      companyShape.tableName,
    );
    if (
      !references.some(
        (ref) =>
          ref.schemaName === personShape.schemaName &&
          ref.tableName === personShape.tableName &&
          canonicalAuditJson(ref.parentColumns) === '["id"]' &&
          canonicalAuditJson(ref.childColumns) === '["companyId"]' &&
          ref.deleteAction === 'n',
      )
    )
      throw new Error(
        'Contact creation requires expected person-company foreign key',
      );

    await scope.executeRawQuery("SET LOCAL lock_timeout = '8000ms'");
    const [workspace] = await scope.executeRawQuery(
      'SELECT id,"deletedAt",to_jsonb(workspace) AS snapshot FROM core.workspace workspace WHERE id=$1 FOR NO KEY UPDATE',
      [scope.workspaceId],
    );
    if (
      !workspace ||
      workspace.id !== scope.workspaceId ||
      workspace.deletedAt !== null
    )
      throw new Error('Contact creation requires an active workspace');
    const workspaceSnapshot = (workspace.snapshot ?? {}) as Record<
      string,
      unknown
    >;

    const writeTablesSql = CONTACT_CREATION_WRITE_TABLES.map((name) =>
      contactCreationTableSql(shapes.get(name)!),
    )
      .sort()
      .join(',');
    const memberTableSql = contactCreationTableSql(
      shapes.get('workspaceMember')!,
    );
    await scope.executeRawQuery(
      `LOCK TABLE ${writeTablesSql} IN SHARE ROW EXCLUSIVE MODE`,
    );
    await scope.executeRawQuery(`LOCK TABLE ${memberTableSql} IN SHARE MODE`);

    return {
      scope,
      audit: new CrmAuditTransactionContext(
        createCrmAuditWorkspaceExecutor(scope),
        operation,
      ),
      shapes,
      before: new Map(),
      expected: new Map(),
      originalIds: new Map(),
      isInternalMessagesImportEnabled: Boolean(
        workspaceSnapshot.isInternalMessagesImportEnabled,
      ),
      validators: [
        async () => {
          const [currentWorkspace] = await scope.executeRawQuery(
            'SELECT id,"deletedAt",to_jsonb(workspace) AS snapshot FROM core.workspace workspace WHERE id=$1',
            [scope.workspaceId],
          );
          if (
            !currentWorkspace ||
            currentWorkspace.id !== workspace.id ||
            currentWorkspace.deletedAt !== null ||
            canonicalAuditJson(currentWorkspace.snapshot) !==
              canonicalAuditJson(workspace.snapshot)
          )
            throw new Error('Contact creation workspace changed before commit');
        },
      ],
    };
  }

  private async lockContactCreationAuthority(
    state: ContactCreationAuditState,
    capturedAccount: ConnectedAccountEntity,
    source: FieldActorSource,
  ): Promise<
    | { active: false }
    | {
        active: true;
        userId: string;
        connectedAccount: ConnectedAccountEntity;
      }
  > {
    const { scope } = state;
    const [accountRow] = await scope.executeRawQuery(
      'SELECT id,to_jsonb(account) AS snapshot FROM core."connectedAccount" account WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
      [capturedAccount.id, scope.workspaceId],
    );
    if (!accountRow) {
      return { active: false };
    }
    const accountSnapshot = (accountRow.snapshot ?? {}) as Record<
      string,
      unknown
    >;
    if (
      accountSnapshot.archivedAt !== undefined &&
      accountSnapshot.archivedAt !== null
    ) {
      return { active: false };
    }
    const provider = (
      typeof accountSnapshot.provider === 'string'
        ? accountSnapshot.provider
        : capturedAccount.provider
    ) as ConnectedAccountProvider;
    if (String(provider) === 'app') {
      throw new Error('Contact creation excludes application accounts');
    }
    const accountScope =
      typeof accountSnapshot.scope === 'string'
        ? accountSnapshot.scope
        : capturedAccount.scope;
    if (
      accountScope !== undefined &&
      accountScope !== null &&
      !['USER', 'WORKSPACE'].includes(String(accountScope))
    ) {
      throw new Error('Contact creation requires valid account scope');
    }
    const ownedAccounts = await findOmniOwnedConnectedAccountIds(
      scope,
      scope.workspaceId,
      [capturedAccount.id],
    );
    if (ownedAccounts.size > 0) {
      throw new Error('Contact creation excludes omnichannel accounts');
    }
    const userWorkspaceId =
      typeof accountSnapshot.userWorkspaceId === 'string'
        ? accountSnapshot.userWorkspaceId.toLowerCase()
        : typeof capturedAccount.userWorkspaceId === 'string'
          ? capturedAccount.userWorkspaceId.toLowerCase()
          : '';
    if (!isUUID(userWorkspaceId)) {
      this.logger.warn(
        `Skipping contact creation for connected account ${capturedAccount.id} in workspace ${scope.workspaceId}: userWorkspace ${userWorkspaceId} not found`,
      );
      return { active: false };
    }

    const [memberRow] = await scope.executeRawQuery(
      'SELECT id,"workspaceId","userId","deletedAt",to_jsonb(member) AS snapshot FROM core."userWorkspace" member WHERE id=$1 AND "workspaceId"=$2 FOR SHARE',
      [userWorkspaceId, scope.workspaceId],
    );
    if (
      !memberRow ||
      memberRow.deletedAt !== null ||
      typeof memberRow.userId !== 'string' ||
      !isUUID(memberRow.userId)
    ) {
      this.logger.warn(
        `Skipping contact creation for connected account ${capturedAccount.id} in workspace ${scope.workspaceId}: userWorkspace ${userWorkspaceId} not found`,
      );
      return { active: false };
    }
    const userId = memberRow.userId.toLowerCase();
    const [userRow] = await scope.executeRawQuery(
      'SELECT id,disabled,"deletedAt",to_jsonb(u) AS snapshot FROM core."user" u WHERE id=$1 FOR SHARE',
      [userId],
    );
    if (!userRow || userRow.deletedAt !== null || userRow.disabled !== false) {
      return { active: false };
    }

    const handle =
      typeof accountSnapshot.handle === 'string'
        ? accountSnapshot.handle
        : capturedAccount.handle;
    if (typeof handle !== 'string' || !handle.length) {
      throw new Error('Connected account handle is missing');
    }
    const handleAliases = Array.isArray(accountSnapshot.handleAliases)
      ? accountSnapshot.handleAliases.filter(
          (alias): alias is string => typeof alias === 'string',
        )
      : (capturedAccount.handleAliases ?? []);

    let messageChannels: Record<string, unknown>[] = [];
    let calendarChannels: Record<string, unknown>[] = [];
    if (source === FieldActorSource.EMAIL) {
      const [msgReg] = await scope.executeRawQuery(
        'SELECT to_regclass(\'core."messageChannel"\')::text AS reg',
      );
      if (msgReg?.reg) {
        const [accountCol] = await scope.executeRawQuery(
          `SELECT 1 FROM pg_attribute WHERE attrelid='core."messageChannel"'::regclass AND attname='connectedAccountId' AND NOT attisdropped`,
        );
        if (accountCol) {
          messageChannels = await scope.executeRawQuery(
            'SELECT id,type,to_jsonb(channel) AS snapshot FROM core."messageChannel" channel WHERE "workspaceId"=$1 AND "connectedAccountId"=$2 ORDER BY id FOR SHARE',
            [scope.workspaceId, capturedAccount.id],
          );
          if (messageChannels.some((row) => row.type === 'APP')) {
            throw new Error('Contact creation excludes application channels');
          }
          if (messageChannels.length > 0) {
            const channelIds = messageChannels.map((row) => String(row.id));
            const ownedChannels = await findOmniOwnedMessageChannelIds(
              scope,
              scope.workspaceId,
              channelIds,
            );
            if (ownedChannels.size > 0) {
              throw new Error('Contact creation excludes omnichannel channels');
            }
            if (
              messageChannels.some((row) =>
                Object.prototype.hasOwnProperty.call(
                  (row.snapshot ?? {}) as Record<string, unknown>,
                  'isContactAutoCreationEnabled',
                ),
              ) &&
              messageChannels.every(
                (row) =>
                  ((row.snapshot ?? {}) as Record<string, unknown>)
                    .isContactAutoCreationEnabled === false,
              )
            ) {
              return { active: false };
            }
          }
        }
      }
    } else if (source === FieldActorSource.CALENDAR) {
      const [calReg] = await scope.executeRawQuery(
        'SELECT to_regclass(\'core."calendarChannel"\')::text AS reg',
      );
      if (calReg?.reg) {
        const [accountCol] = await scope.executeRawQuery(
          `SELECT 1 FROM pg_attribute WHERE attrelid='core."calendarChannel"'::regclass AND attname='connectedAccountId' AND NOT attisdropped`,
        );
        if (accountCol) {
          calendarChannels = await scope.executeRawQuery(
            'SELECT id,to_jsonb(channel) AS snapshot FROM core."calendarChannel" channel WHERE "workspaceId"=$1 AND "connectedAccountId"=$2 ORDER BY id FOR SHARE',
            [scope.workspaceId, capturedAccount.id],
          );
          if (
            calendarChannels.length > 0 &&
            calendarChannels.some((row) =>
              Object.prototype.hasOwnProperty.call(
                (row.snapshot ?? {}) as Record<string, unknown>,
                'isContactAutoCreationEnabled',
              ),
            ) &&
            calendarChannels.every(
              (row) =>
                ((row.snapshot ?? {}) as Record<string, unknown>)
                  .isContactAutoCreationEnabled === false,
            )
          ) {
            return { active: false };
          }
        }
      }
    }

    state.validators.push(async () => {
      const [currentAccount] = await scope.executeRawQuery(
        'SELECT id,to_jsonb(account) AS snapshot FROM core."connectedAccount" account WHERE id=$1 AND "workspaceId"=$2',
        [capturedAccount.id, scope.workspaceId],
      );
      const [currentMember] = await scope.executeRawQuery(
        'SELECT id,"workspaceId","userId","deletedAt",to_jsonb(member) AS snapshot FROM core."userWorkspace" member WHERE id=$1 AND "workspaceId"=$2',
        [userWorkspaceId, scope.workspaceId],
      );
      const [currentUser] = await scope.executeRawQuery(
        'SELECT id,disabled,"deletedAt",to_jsonb(u) AS snapshot FROM core."user" u WHERE id=$1',
        [userId],
      );
      if (
        !currentAccount ||
        !currentMember ||
        !currentUser ||
        canonicalAuditJson(currentAccount.snapshot) !==
          canonicalAuditJson(accountRow.snapshot) ||
        canonicalAuditJson(currentMember.snapshot) !==
          canonicalAuditJson(memberRow.snapshot) ||
        canonicalAuditJson(currentUser.snapshot) !==
          canonicalAuditJson(userRow.snapshot)
      ) {
        throw new Error('Contact creation authority changed before commit');
      }
      const currentOwnedAccounts = await findOmniOwnedConnectedAccountIds(
        scope,
        scope.workspaceId,
        [capturedAccount.id],
      );
      if (currentOwnedAccounts.size > 0) {
        throw new Error(
          'Contact creation account ownership changed before commit',
        );
      }
      if (messageChannels.length > 0) {
        const currentChannels = await scope.executeRawQuery(
          'SELECT id,type,to_jsonb(channel) AS snapshot FROM core."messageChannel" channel WHERE "workspaceId"=$1 AND "connectedAccountId"=$2 ORDER BY id',
          [scope.workspaceId, capturedAccount.id],
        );
        const currentOwnedChannels = await findOmniOwnedMessageChannelIds(
          scope,
          scope.workspaceId,
          messageChannels.map((row) => String(row.id)),
        );
        if (
          currentOwnedChannels.size > 0 ||
          canonicalAuditJson(currentChannels) !==
            canonicalAuditJson(messageChannels)
        ) {
          throw new Error(
            'Contact creation channel authority changed before commit',
          );
        }
      }
      if (calendarChannels.length > 0) {
        const currentCalendarChannels = await scope.executeRawQuery(
          'SELECT id,to_jsonb(channel) AS snapshot FROM core."calendarChannel" channel WHERE "workspaceId"=$1 AND "connectedAccountId"=$2 ORDER BY id',
          [scope.workspaceId, capturedAccount.id],
        );
        if (
          canonicalAuditJson(currentCalendarChannels) !==
          canonicalAuditJson(calendarChannels)
        ) {
          throw new Error(
            'Contact creation calendar channel authority changed before commit',
          );
        }
      }
    });

    return {
      active: true,
      userId,
      connectedAccount: {
        ...capturedAccount,
        userWorkspaceId,
        provider,
        handle,
        handleAliases,
      },
    };
  }

  private async readContactCreationGraph(
    state: ContactCreationAuditState,
    name: ContactCreationTable,
    lock = false,
  ): Promise<ContactCreationSnapshot[]> {
    const shape = state.shapes.get(name)!;
    const originalIds = state.originalIds.get(name) ?? [];
    if (originalIds.length === 0) {
      return [];
    }
    const ids = (
      await state.scope.executeRawQuery(
        `SELECT id FROM ${contactCreationTableSql(shape)} WHERE id=ANY($1::uuid[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
        [originalIds],
      )
    ).map((row) => String(row.id).toLowerCase());
    const rows = await readNativeCrmAuditRows(
      {
        execute: ({ text, values }) =>
          state.scope.executeRawQuery(text, values),
      },
      shape,
      [...new Set(ids)],
    );
    if (rows.length !== new Set(ids).size) {
      throw new Error('Contact creation graph row disappeared');
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async verifyContactCreationGraph(
    state: ContactCreationAuditState,
  ): Promise<void> {
    for (const verify of state.validators) {
      await verify();
    }
    const currentMemberIds = (
      await state.scope.executeRawQuery(
        `SELECT id FROM ${contactCreationTableSql(state.shapes.get('workspaceMember')!)} WHERE "deletedAt" IS NULL ORDER BY id`,
      )
    ).map((row) => String(row.id).toLowerCase());
    if (
      canonicalAuditJson(currentMemberIds) !==
      canonicalAuditJson(state.originalIds.get('workspaceMember') ?? [])
    ) {
      throw new Error('Contact creation workspace member set changed');
    }
    for (const name of CONTACT_CREATION_TABLES) {
      const current = await this.readContactCreationGraph(state, name, false);
      if (
        canonicalAuditJson(current) !==
        canonicalAuditJson(state.expected.get(name) ?? [])
      ) {
        throw new Error(`Contact creation ${name} state changed`);
      }
    }
  }

  private async insertContactCreationRecords(
    state: ContactCreationAuditState,
    name: ContactCreationWriteTable,
    records: Record<string, unknown>[],
  ): Promise<string[]> {
    if (records.length === 0) {
      return [];
    }
    await this.verifyContactCreationGraph(state);
    const shape = state.shapes.get(name)!;
    const captured = records.map((row) => captureNativeCrmAuditWriteData(row));
    const planned = new Map<string, ContactCreationSnapshot>();
    const requestedIds: string[] = [];
    for (const row of captured) {
      if (
        typeof row.id !== 'string' ||
        !isUUID(row.id) ||
        planned.has(row.id) ||
        state.expected.get(name)!.some((existing) => existing.id === row.id)
      ) {
        throw new Error('Contact creation invalid insert identity');
      }
      requestedIds.push(row.id);
      planned.set(
        row.id,
        await castCalendarProofImage(
          state.scope,
          shape,
          contactCreationColumns(shape, row),
        ),
      );
    }
    const result = await state.scope
      .getRepository(name, { shouldBypassPermissionChecks: true })
      .insert(captured);
    const actualIds = new Set(contactCreationActualIds(result, requestedIds));
    const actualRows = await readNativeCrmAuditRows(
      {
        execute: ({ text, values }) =>
          state.scope.executeRawQuery(text, values),
      },
      shape,
      [...actualIds],
    );
    if (actualRows.length !== actualIds.size) {
      throw new Error(`Contact creation inserted ${name} row disappeared`);
    }
    for (const row of actualRows) {
      const expectedImage = planned.get(row.id)!;
      if (
        row.deletedAt !== 'null' ||
        Object.keys(expectedImage).some(
          (column) =>
            column !== 'createdAt' &&
            column !== 'updatedAt' &&
            row[column] !== expectedImage[column],
        )
      ) {
        throw new Error(`Contact creation ${name} insert effects mismatch`);
      }
    }
    assertNativeCrmDeleteFilesEmpty(shape, actualRows);
    state.expected.set(
      name,
      [...state.expected.get(name)!, ...actualRows].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    await this.verifyContactCreationGraph(state);
    for (const row of actualRows) {
      state.audit.record({
        resourceKind: 'crmRecord',
        resourceId: row.id,
        action: 'create',
        before: null,
        after: captureNativeCrmAuditSnapshot(shape, row),
        securityDescriptor: {
          resourceKind: 'crmRecord',
          resourceId: row.id,
          objectMetadataId: shape.objectMetadataId,
        },
      });
    }
    return [...actualIds];
  }

  private async updateContactCreationRecords(
    state: ContactCreationAuditState,
    name: ContactCreationWriteTable,
    updates: { criteria: string; partialEntity: Record<string, unknown> }[],
    mode: 'restore' | 'update',
  ): Promise<string[]> {
    if (updates.length === 0) {
      return [];
    }
    await this.verifyContactCreationGraph(state);
    const shape = state.shapes.get(name)!;
    const beforeMap = new Map(
      state.expected.get(name)!.map((row) => [row.id, row]),
    );
    const captured = updates.map(({ criteria, partialEntity }) => {
      if (typeof criteria !== 'string' || !isUUID(criteria)) {
        throw new Error('Contact creation invalid update identity');
      }
      return {
        criteria: criteria.toLowerCase(),
        partialEntity: captureNativeCrmAuditWriteData(partialEntity),
      };
    });
    const planned = new Map<string, ContactCreationSnapshot>();
    const requestedIds: string[] = [];
    for (const { criteria, partialEntity } of captured) {
      const before = beforeMap.get(criteria);
      if (
        !before ||
        planned.has(criteria) ||
        (mode === 'restore'
          ? before.deletedAt === 'null'
          : before.deletedAt !== 'null')
      ) {
        throw new Error('Contact creation missing locked update target');
      }
      requestedIds.push(criteria);
      const columns = contactCreationColumns(shape, partialEntity);
      const after = await castCalendarProofImage(
        state.scope,
        shape,
        { ...columns, id: criteria },
        before,
      );
      if (after.deletedAt !== 'null') {
        throw new Error('Contact creation update postcondition failed');
      }
      const changedColumns = Object.keys(after).filter(
        (column) => column !== 'id' && after[column] !== before[column],
      );
      const patch =
        '{' +
        changedColumns
          .map((column) => JSON.stringify(column) + ':' + String(after[column]))
          .join(',') +
        '}';
      await assertNoReferentialUpdateEffects(
        {
          execute: ({ text, values }) =>
            state.scope.executeRawQuery(text, values),
        },
        {
          kind: 'update',
          alias: 'contact_creation_parent',
          tableShape: shape,
          setClauses: changedColumns.map((columnName) => ({
            columnName,
            valueExpression: `(jsonb_populate_record(NULL::${contactCreationTableSql(shape)},$2::jsonb)).${quoteContactCreationIdentifier(columnName)}`,
          })),
        },
        {},
        '"contact_creation_parent".id=$1::uuid AND $2::jsonb IS NOT NULL',
        (text) => ({
          text,
          values: [criteria, patch],
        }),
      );
      planned.set(criteria, after);
    }
    const result = await state.scope
      .getRepository(name, { shouldBypassPermissionChecks: true })
      .updateMany(captured);
    const actualIds = new Set(contactCreationActualIds(result, requestedIds));
    const updatedRows = await readNativeCrmAuditRows(
      {
        execute: ({ text, values }) =>
          state.scope.executeRawQuery(text, values),
      },
      shape,
      [...actualIds],
    );
    if (updatedRows.length !== actualIds.size) {
      throw new Error(`Contact creation updated ${name} row disappeared`);
    }
    const updatedById = new Map(updatedRows.map((row) => [row.id, row]));
    for (const [id, row] of updatedById.entries()) {
      const expectedImage = planned.get(id)!;
      if (
        row.deletedAt !== 'null' ||
        Object.keys(expectedImage).some(
          (column) =>
            column !== 'updatedAt' && row[column] !== expectedImage[column],
        )
      ) {
        throw new Error(`Contact creation ${name} update effects mismatch`);
      }
    }
    assertNativeCrmDeleteFilesEmpty(shape, updatedRows);
    state.expected.set(
      name,
      state.expected
        .get(name)!
        .map((row) => (actualIds.has(row.id) ? updatedById.get(row.id)! : row)),
    );
    await this.verifyContactCreationGraph(state);
    for (const id of actualIds) {
      const before = beforeMap.get(id)!;
      const after = updatedById.get(id)!;
      state.audit.record({
        resourceKind: 'crmRecord',
        resourceId: id,
        action: 'update',
        before: captureNativeCrmAuditSnapshot(shape, before),
        after: captureNativeCrmAuditSnapshot(shape, after),
        ...(shape.columnShapeByColumnName.updatedAt
          ? {
              implicitUpdatedAtFieldId:
                shape.columnShapeByColumnName.updatedAt.fieldMetadataId,
            }
          : {}),
        securityDescriptor: {
          resourceKind: 'crmRecord',
          resourceId: id,
          objectMetadataId: shape.objectMetadataId,
        },
      });
    }
    return [...actualIds];
  }

  private async finishContactCreationAudit(
    state: ContactCreationAuditState,
  ): Promise<void> {
    await this.verifyContactCreationGraph(state);
    await state.audit.flush();
    await state.scope.executeRawQuery('SET CONSTRAINTS ALL IMMEDIATE');
    await this.verifyContactCreationGraph(state);
  }
}
