import { isUUID } from 'class-validator';
import { FieldActorSource } from 'twenty-shared/types';

import {
  membershipCleanupOperation,
  systemMembershipCleanupIdentity,
} from 'src/engine/core-modules/crm-audit/membership-cleanup-identity';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { CreateCompanyAndPersonService } from 'src/modules/contact-creation-manager/services/create-company-and-contact.service';

export type CreateCompanyAndContactJobData = {
  workspaceId: string;
  connectedAccount: ConnectedAccountEntity;
  contactsToCreate: {
    displayName: string;
    handle: string;
  }[];
  source: FieldActorSource;
};

@Processor(MessageQueue.contactCreationQueue)
export class CreateCompanyAndContactJob {
  constructor(
    private readonly createCompanyAndPersonService: CreateCompanyAndPersonService,
  ) {}

  @Process(CreateCompanyAndContactJob.name)
  async handle(data: CreateCompanyAndContactJobData): Promise<void> {
    const workspaceId = data?.workspaceId;
    const source = data?.source;
    if (
      typeof workspaceId !== 'string' ||
      !isUUID(workspaceId) ||
      !data?.connectedAccount ||
      typeof data.connectedAccount !== 'object' ||
      typeof data.connectedAccount.id !== 'string' ||
      !isUUID(data.connectedAccount.id) ||
      !Array.isArray(data?.contactsToCreate) ||
      (source !== FieldActorSource.EMAIL &&
        source !== FieldActorSource.CALENDAR)
    )
      throw new Error('Contact creation job requires valid scoped input');

    const connectedAccount: ConnectedAccountEntity = {
      ...data.connectedAccount,
      id: data.connectedAccount.id.toLowerCase(),
      handleAliases: Array.isArray(data.connectedAccount.handleAliases)
        ? [...data.connectedAccount.handleAliases]
        : [],
    };
    const contactsToCreate = data.contactsToCreate.map((contact) => {
      if (
        !contact ||
        typeof contact !== 'object' ||
        typeof contact.handle !== 'string' ||
        typeof contact.displayName !== 'string'
      )
        throw new Error('Contact creation job requires valid contact entries');
      return {
        handle: contact.handle,
        displayName: contact.displayName,
      };
    });
    const identity = systemMembershipCleanupIdentity(
      workspaceId,
      CreateCompanyAndContactJob.name,
    );
    const operation = membershipCleanupOperation(workspaceId, identity)!;

    await this.createCompanyAndPersonService.createCompaniesAndPeopleAndUpdateParticipants(
      connectedAccount,
      contactsToCreate,
      workspaceId,
      source,
      operation,
    );
  }
}
