import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type ConnectedAccountProvider } from 'twenty-shared/types';
import { Repository } from 'typeorm';
import { withOmniMetadataMutation } from 'src/modules/omnichannel/services/omni-metadata-transaction';
import { lockOrdinaryProviderAccount } from 'src/modules/omnichannel/services/lock-ordinary-provider-account';

import {
  ordinaryConnectedAccountWriteWhere,
  assertConnectedAccountWriteApplied,
} from 'src/engine/metadata-modules/connected-account/utils/ordinary-connected-account-write.util';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';

type CreateSsoConnectedAccountParams = {
  workspaceId: string;
  userId: string;
  handle: string;
  provider: ConnectedAccountProvider;
  scopes: string[];
  oidcTokenClaims?: Record<string, unknown>;
};

@Injectable()
export class CreateSsoConnectedAccountService {
  private readonly logger = new Logger(CreateSsoConnectedAccountService.name);

  constructor(
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
  ) {}

  async createOrUpdateSsoConnectedAccount(
    params: CreateSsoConnectedAccountParams,
  ): Promise<void> {
    const { workspaceId, userId, handle, provider, scopes, oidcTokenClaims } =
      params;
    const capturedScopes = [...scopes];
    const capturedClaims =
      oidcTokenClaims === undefined
        ? undefined
        : structuredClone(oidcTokenClaims);

    const userWorkspace = await this.userWorkspaceRepository.findOneBy({
      userId,
      workspaceId,
    });

    if (!userWorkspace) {
      this.logger.warn(
        `Could not find userWorkspace for userId=${userId} workspaceId=${workspaceId}, skipping SSO connected account creation`,
      );

      return;
    }

    const existing = await this.connectedAccountRepository.findOneBy({
      handle,
      provider,
      userWorkspaceId: userWorkspace.id,
      workspaceId,
    });

    if (existing) {
      return withOmniMetadataMutation(
        this.connectedAccountRepository.manager,
        workspaceId,
        async (manager) => {
          await lockOrdinaryProviderAccount(manager, workspaceId, existing.id);
          const repository = manager.getRepository(ConnectedAccountEntity);
          const current = await repository.findOneByOrFail({
            id: existing.id,
            workspaceId,
          });
          const mergedScopes = Array.from(
            new Set([...(current.scopes ?? []), ...capturedScopes]),
          );

          const result = await repository.update(
            ordinaryConnectedAccountWriteWhere(existing),
            {
              lastSignedInAt: new Date(),
              provider,
              scopes: mergedScopes,
              ...(capturedClaims !== undefined
                ? { oidcTokenClaims: capturedClaims as object }
                : {}),
            },
          );

          assertConnectedAccountWriteApplied(result);
        },
      );
    }

    await withOmniMetadataMutation(
      this.connectedAccountRepository.manager,
      workspaceId,
      async (manager) => {
        await manager.getRepository(ConnectedAccountEntity).insert({
          handle,
          provider,
          scopes: capturedScopes,
          accessToken: null,
          refreshToken: null,
          lastSignedInAt: new Date(),
          userWorkspaceId: userWorkspace.id,
          workspaceId,
          ...(capturedClaims
            ? { oidcTokenClaims: capturedClaims as object }
            : {}),
        });
      },
    );
  }
}
