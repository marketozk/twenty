import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type ConnectedAccountProvider } from 'twenty-shared/types';
import { EntityManager, Repository } from 'typeorm';

import {
  ordinaryConnectedAccountWriteWhere,
  assertConnectedAccountWriteApplied,
} from 'src/engine/metadata-modules/connected-account/utils/ordinary-connected-account-write.util';
import { PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { ConnectedAccountTokenEncryptionService } from 'src/engine/metadata-modules/connected-account/services/connected-account-token-encryption.service';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { resolveRolePermissionConfig } from 'src/engine/twenty-orm/utils/resolve-role-permission-config.util';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

export type CreateConnectedAccountInput = {
  workspaceId: string;
  connectedAccountId: string;
  handle: string;
  provider: ConnectedAccountProvider;
  accessToken: PlaintextString;
  refreshToken: PlaintextString;
  accountOwnerId: string;
  scopes: string[];
  transactionManager: EntityManager;
  isReconnect: boolean;
};

@Injectable()
export class CreateConnectedAccountService {
  constructor(
    private readonly workspaceOrmManager: WorkspaceOrmManager,
    private readonly connectedAccountTokenEncryptionService: ConnectedAccountTokenEncryptionService,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
  ) {}

  async createConnectedAccount(
    input: CreateConnectedAccountInput,
  ): Promise<void> {
    const {
      workspaceId,
      connectedAccountId,
      handle,
      provider,
      accessToken,
      refreshToken,
      accountOwnerId,
      scopes,
    } = input;

    const authContext = buildSystemAuthContext(workspaceId);

    await this.workspaceOrmManager.executeInWorkspaceContext(async () => {
      const workspaceContext = getWorkspaceContext();
      const rolePermissionConfig = resolveRolePermissionConfig({
        authContext,
        userWorkspaceRoleMap: workspaceContext.userWorkspaceRoleMap,
        apiKeyRoleMap: workspaceContext.apiKeyRoleMap,
        flatRoleTargetByAgentIdMaps:
          workspaceContext.flatRoleTargetByAgentIdMaps,
      });

      const workspaceMemberRepo =
        this.workspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
          'workspaceMember',
          rolePermissionConfig ?? undefined,
        );

      const member = await workspaceMemberRepo.findOne({
        where: { id: accountOwnerId },
      });

      if (!member) {
        throw new Error(
          `Workspace member not found for accountOwnerId ${accountOwnerId}`,
        );
      }

      const userWorkspace = await this.userWorkspaceRepository.findOne({
        where: { userId: member.userId, workspaceId },
      });

      if (!userWorkspace) {
        throw new Error(
          `User workspace not found for user ${member.userId} in workspace ${workspaceId}`,
        );
      }

      const userWorkspaceId = userWorkspace.id;

      // Boundary: tokens entering here were just issued by the external
      // OAuth provider (Google / Microsoft / app), so we brand them as
      // plaintext before handing them to the encryption service.
      const { encryptedAccessToken, encryptedRefreshToken } =
        this.connectedAccountTokenEncryptionService.encryptTokenPair({
          accessToken,
          refreshToken,
          workspaceId,
        });

      const repository = input.transactionManager.getRepository(
        ConnectedAccountEntity,
      );
      const identity = {
        id: connectedAccountId,
        workspaceId,
        provider,
        userWorkspaceId,
        applicationId: null,
        connectionProviderId: null,
      };
      const where = ordinaryConnectedAccountWriteWhere(identity);
      const data = {
        ...identity,
        handle,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        scopes,
      };
      if (input.isReconnect) {
        assertConnectedAccountWriteApplied(
          await repository.update(where, data),
        );
      } else {
        // INSERT refuses an unexpected existing id instead of converting it.
        await repository.insert(data);
      }
    }, authContext);
  }
}
