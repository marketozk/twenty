import { Injectable } from '@nestjs/common';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';

import { isDefined } from 'twenty-shared/utils';

import { type UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { ConnectedAccountMetadataService } from 'src/engine/metadata-modules/connected-account/connected-account-metadata.service';
import { UserRoleService } from 'src/engine/metadata-modules/user-role/user-role.service';

@Injectable()
export class ConnectedAccountOwnershipTransferService {
  constructor(
    private readonly userRoleService: UserRoleService,
    private readonly connectedAccountMetadataService: ConnectedAccountMetadataService,
  ) {}

  // Reassigns app connections owned by a departing member to another member
  // instead of leaving them orphaned against a userWorkspaceId that's about
  // to be deleted. Every path that removes a member from a workspace while
  // it stays active must call this before deleting the userWorkspace.
  async transferConnectedAccountsOwnershipToCustodian({
    removedUserWorkspace,
    actingUserWorkspaceId,
    auditOperation,
  }: {
    removedUserWorkspace: UserWorkspaceEntity;
    actingUserWorkspaceId?: string;
    auditOperation?: CrmAuditOperation;
  }) {
    const fromUserWorkspaceId = removedUserWorkspace.id;
    const workspaceId = removedUserWorkspace.workspaceId;
    const capturedOperation = auditOperation
      ? {
          ...auditOperation,
          actor: { ...auditOperation.actor },
          ...(auditOperation.initiator
            ? { initiator: { ...auditOperation.initiator } }
            : {}),
        }
      : undefined;
    const custodianUserWorkspace =
      await this.userRoleService.resolveCustodianUserWorkspace({
        removedUserWorkspace,
        actingUserWorkspaceId,
      });

    if (isDefined(custodianUserWorkspace)) {
      await this.connectedAccountMetadataService.transferOwnership({
        fromUserWorkspaceId,
        toUserWorkspaceId: custodianUserWorkspace.id,
        workspaceId,
        auditOperation: capturedOperation,
      });
    }
  }
}
