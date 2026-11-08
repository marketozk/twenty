import { Injectable } from '@nestjs/common';

import { isDefined, removeUndefinedFields } from 'twenty-shared/utils';
import { v4 } from 'uuid';

import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import {
  captureNavigationMenuItemAudit,
  withNavigationMenuItemAudit,
  type NavigationMenuItemAuditIdentity,
} from 'src/engine/core-modules/crm-audit/navigation-menu-item-audit';
import { addRoleIdsToFlatAgentChatChannel } from 'src/engine/metadata-modules/agent-chat-channel/utils/add-role-ids-to-flat-agent-chat-channel.util';
import { buildAgentChatChannelRolesToCreate } from 'src/engine/metadata-modules/agent-chat-channel/utils/build-agent-chat-channel-roles-to-create.util';
import { findAgentChatChannelRoleUniversalIdentifiersOrThrow } from 'src/engine/metadata-modules/agent-chat-channel/utils/find-agent-chat-channel-role-universal-identifiers-or-throw.util';
import { findFlatAgentChatChannelOrThrow } from 'src/engine/metadata-modules/agent-chat-channel/utils/find-flat-agent-chat-channel-or-throw.util';
import { validateAgentChatChannelNameOrThrow } from 'src/engine/metadata-modules/agent-chat-channel/utils/validate-agent-chat-channel-name-or-throw.util';
import { type FlatAgentChatChannelWithRoleIds } from 'src/engine/metadata-modules/agent-chat-channel/types/flat-agent-chat-channel-with-role-ids.type';
import { type FlatAgentChatChannelRole } from 'src/engine/metadata-modules/flat-agent-chat-channel-role/types/flat-agent-chat-channel-role.type';
import { type FlatAgentChatChannel } from 'src/engine/metadata-modules/flat-agent-chat-channel/types/flat-agent-chat-channel.type';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { type AllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-maps.type';
import { type FlatEntityToCreateDeleteUpdate } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-to-create-delete-update.type';
import { findManyFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-many-flat-entity-by-id-in-flat-entity-maps.util';
import { type FlatNavigationMenuItem } from 'src/engine/metadata-modules/flat-navigation-menu-item/types/flat-navigation-menu-item.type';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

type ChannelChanges = Partial<
  Pick<FlatAgentChatChannel, 'name' | 'icon' | 'color' | 'position'>
>;

type ChannelMaps = Pick<
  AllFlatEntityMaps,
  'flatAgentChatChannelMaps' | 'flatAgentChatChannelRoleMaps' | 'flatRoleMaps'
>;

@Injectable()
export class AgentChatChannelMetadataService {
  constructor(
    private readonly applicationService: ApplicationService,
    private readonly flatEntityMapsCacheService: WorkspaceManyOrAllFlatEntityMapsCacheService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
  ) {}

  async findChannels(
    workspaceId: string,
  ): Promise<FlatAgentChatChannelWithRoleIds[]> {
    const { flatAgentChatChannelMaps, flatAgentChatChannelRoleMaps } =
      await this.getChannelMaps(workspaceId);

    return Object.values(flatAgentChatChannelMaps.byUniversalIdentifier)
      .filter(isDefined)
      .map((channel) =>
        addRoleIdsToFlatAgentChatChannel({
          channel,
          flatAgentChatChannelRoleMaps,
        }),
      )
      .sort(
        (left, right) =>
          left.position - right.position ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      );
  }

  async findChannelOrThrow({
    workspaceId,
    channelId,
  }: {
    workspaceId: string;
    channelId: string;
  }): Promise<FlatAgentChatChannelWithRoleIds> {
    const { flatAgentChatChannelMaps, flatAgentChatChannelRoleMaps } =
      await this.getChannelMaps(workspaceId);

    return addRoleIdsToFlatAgentChatChannel({
      channel: findFlatAgentChatChannelOrThrow({
        flatAgentChatChannelMaps,
        channelId,
      }),
      flatAgentChatChannelRoleMaps,
    });
  }

  async createChannel({
    workspaceId,
    name,
    icon,
    color,
    roleIds,
    auditIdentity,
    authUserWorkspaceId,
    capturedAudit,
  }: {
    workspaceId: string;
    name: string;
    icon: string | null;
    color: string | null;
    roleIds: string[];
    auditIdentity?: NavigationMenuItemAuditIdentity;
    authUserWorkspaceId?: string;
    capturedAudit?: ReturnType<typeof captureNavigationMenuItemAudit>;
  }): Promise<FlatAgentChatChannelWithRoleIds> {
    const getChannelAudit =
      capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'channel',
        auditIdentity,
        authUserWorkspaceId,
        defaultSystemActorId: 'agent-chat-channel:create',
      });

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const channelMaps = await this.getChannelMaps(workspaceId);
    const now = new Date().toISOString();
    const channelId = v4();
    const channelUniversalIdentifier = v4();

    const lastPosition = Math.max(
      -1,
      ...Object.values(
        channelMaps.flatAgentChatChannelMaps.byUniversalIdentifier,
      )
        .filter(isDefined)
        .map(({ position }) => position),
    );

    const channelRolesToCreate = buildAgentChatChannelRolesToCreate({
      channelUniversalIdentifier,
      roleUniversalIdentifiers:
        findAgentChatChannelRoleUniversalIdentifiersOrThrow({
          flatRoleMaps: channelMaps.flatRoleMaps,
          roleIds,
        }),
      applicationUniversalIdentifier:
        workspaceCustomFlatApplication.universalIdentifier,
      now,
    });

    await withNavigationMenuItemAudit(
      getChannelAudit({
        expectedChannelCreateIds: [channelId],
        expectedChannelRoleCreateKeys: channelRolesToCreate.map(
          ({ roleUniversalIdentifier }) =>
            `${channelUniversalIdentifier}:${roleUniversalIdentifier}`,
        ),
      }),
      () =>
        this.runMigration({
          workspaceId,
          applicationUniversalIdentifier:
            workspaceCustomFlatApplication.universalIdentifier,
          channelsToCreate: [
            {
              id: channelId,
              universalIdentifier: channelUniversalIdentifier,
              name: validateAgentChatChannelNameOrThrow(name),
              icon,
              color,
              position: lastPosition + 1,
              isCustom: true,
              channelRoleUniversalIdentifiers: [],
              navigationMenuItemUniversalIdentifiers: [],
              applicationUniversalIdentifier:
                workspaceCustomFlatApplication.universalIdentifier,
              createdAt: now,
              updatedAt: now,
            },
          ],
          channelRolesToCreate,
        }),
    );

    return this.findChannelOrThrow({ workspaceId, channelId });
  }

  // Name, icon, color, position and access stay the workspace's own on a
  // channel an application ships, so they are edited the same way
  async updateChannel({
    workspaceId,
    channelId,
    changes,
    roleIds,
    auditIdentity,
    authUserWorkspaceId,
    capturedAudit,
  }: {
    workspaceId: string;
    channelId: string;
    changes: ChannelChanges;
    roleIds?: string[];
    auditIdentity?: NavigationMenuItemAuditIdentity;
    authUserWorkspaceId?: string;
    capturedAudit?: ReturnType<typeof captureNavigationMenuItemAudit>;
  }): Promise<FlatAgentChatChannelWithRoleIds> {
    const getChannelAudit =
      capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'channel',
        auditIdentity,
        authUserWorkspaceId,
        defaultSystemActorId: 'agent-chat-channel:update',
      });

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const channelMaps = await this.getChannelMaps(workspaceId);
    const channel = findFlatAgentChatChannelOrThrow({
      flatAgentChatChannelMaps: channelMaps.flatAgentChatChannelMaps,
      channelId,
    });
    const now = new Date().toISOString();

    const definedChanges = removeUndefinedFields({
      ...changes,
      ...(isDefined(changes.name)
        ? { name: validateAgentChatChannelNameOrThrow(changes.name) }
        : {}),
    });

    const currentChannelRoles = findManyFlatEntityByIdInFlatEntityMaps({
      flatEntityIds: channel.channelRoleIds,
      flatEntityMaps: channelMaps.flatAgentChatChannelRoleMaps,
    });

    const requestedRoleUniversalIdentifiers = isDefined(roleIds)
      ? findAgentChatChannelRoleUniversalIdentifiersOrThrow({
          flatRoleMaps: channelMaps.flatRoleMaps,
          roleIds,
        })
      : undefined;

    const channelRolesToDelete = isDefined(requestedRoleUniversalIdentifiers)
      ? currentChannelRoles.filter(
          ({ roleUniversalIdentifier }) =>
            !requestedRoleUniversalIdentifiers.includes(
              roleUniversalIdentifier,
            ),
        )
      : [];

    const channelRolesToCreate = buildAgentChatChannelRolesToCreate({
      channelUniversalIdentifier: channel.universalIdentifier,
      roleUniversalIdentifiers: (
        requestedRoleUniversalIdentifiers ?? []
      ).filter(
        (roleUniversalIdentifier) =>
          !currentChannelRoles.some(
            (channelRole) =>
              channelRole.roleUniversalIdentifier === roleUniversalIdentifier,
          ),
      ),
      applicationUniversalIdentifier:
        workspaceCustomFlatApplication.universalIdentifier,
      now,
    });

    const isChannelChanged = (
      ['name', 'icon', 'color', 'position'] as const
    ).some(
      (key) => key in definedChanges && definedChanges[key] !== channel[key],
    );

    if (
      !isChannelChanged &&
      channelRolesToCreate.length === 0 &&
      channelRolesToDelete.length === 0
    ) {
      return addRoleIdsToFlatAgentChatChannel({
        channel,
        flatAgentChatChannelRoleMaps: channelMaps.flatAgentChatChannelRoleMaps,
      });
    }

    await withNavigationMenuItemAudit(
      getChannelAudit({
        expectedChannelUpdateIds: isChannelChanged ? [channel.id] : [],
        expectedChannelRoleCreateKeys: channelRolesToCreate.map(
          ({ channelUniversalIdentifier, roleUniversalIdentifier }) =>
            `${channelUniversalIdentifier}:${roleUniversalIdentifier}`,
        ),
        expectedChannelRoleDeleteIds: channelRolesToDelete.map(
          (item) => item.id,
        ),
      }),
      () =>
        this.runMigration({
          workspaceId,
          applicationUniversalIdentifier:
            workspaceCustomFlatApplication.universalIdentifier,
          channelsToUpdate: isChannelChanged
            ? [{ ...channel, ...definedChanges, updatedAt: now }]
            : [],
          channelRolesToCreate,
          channelRolesToDelete,
        }),
    );

    return this.findChannelOrThrow({ workspaceId, channelId });
  }

  async deleteChannel({
    workspaceId,
    channelId,
    auditIdentity,
    authUserWorkspaceId,
    capturedAudit,
  }: {
    workspaceId: string;
    channelId: string;
    auditIdentity?: NavigationMenuItemAuditIdentity;
    authUserWorkspaceId?: string;
    capturedAudit?: ReturnType<typeof captureNavigationMenuItemAudit>;
  }): Promise<FlatAgentChatChannelWithRoleIds> {
    const getCascadeAudit =
      capturedAudit ??
      captureNavigationMenuItemAudit({
        workspaceId,
        mode: 'channel',
        auditIdentity,
        authUserWorkspaceId,
        defaultSystemActorId: 'agent-chat-channel:delete',
      });

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const { flatAgentChatChannelMaps, flatAgentChatChannelRoleMaps } =
      await this.getChannelMaps(workspaceId);
    const { flatNavigationMenuItemMaps } =
      await this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
        { workspaceId, flatMapsKeys: ['flatNavigationMenuItemMaps'] },
      );
    const channel = findFlatAgentChatChannelOrThrow({
      flatAgentChatChannelMaps,
      channelId,
    });

    const channelRolesToDelete = findManyFlatEntityByIdInFlatEntityMaps({
      flatEntityIds: channel.channelRoleIds,
      flatEntityMaps: flatAgentChatChannelRoleMaps,
    });
    const navigationMenuItemsToDelete = findManyFlatEntityByIdInFlatEntityMaps({
      flatEntityIds: channel.navigationMenuItemIds,
      flatEntityMaps: flatNavigationMenuItemMaps,
    });

    await withNavigationMenuItemAudit(
      getCascadeAudit({
        expectedParentChannelDeleteIds: [channel.id],
        expectedChannelRoleDeleteIds: channelRolesToDelete.map(
          (item) => item.id,
        ),
        expectedDeletedIds: navigationMenuItemsToDelete.map((item) => item.id),
      }),
      () =>
        this.runMigration({
          workspaceId,
          applicationUniversalIdentifier:
            workspaceCustomFlatApplication.universalIdentifier,
          channelsToDelete: [channel],
          channelRolesToDelete,
          navigationMenuItemsToDelete,
        }),
    );

    return addRoleIdsToFlatAgentChatChannel({
      channel,
      flatAgentChatChannelRoleMaps,
    });
  }

  private async getChannelMaps(workspaceId: string): Promise<ChannelMaps> {
    return this.flatEntityMapsCacheService.getOrRecomputeManyOrAllFlatEntityMaps(
      {
        workspaceId,
        flatMapsKeys: [
          'flatAgentChatChannelMaps',
          'flatAgentChatChannelRoleMaps',
          'flatRoleMaps',
        ],
      },
    );
  }

  private async runMigration({
    workspaceId,
    applicationUniversalIdentifier,
    channelsToCreate = [],
    channelsToUpdate = [],
    channelsToDelete = [],
    channelRolesToCreate = [],
    channelRolesToDelete = [],
    navigationMenuItemsToDelete = [],
  }: {
    workspaceId: string;
    applicationUniversalIdentifier: string;
    channelsToCreate?: FlatEntityToCreateDeleteUpdate<'agentChatChannel'>['flatEntityToCreate'];
    channelsToUpdate?: FlatAgentChatChannel[];
    channelsToDelete?: FlatAgentChatChannel[];
    channelRolesToCreate?: FlatEntityToCreateDeleteUpdate<'agentChatChannelRole'>['flatEntityToCreate'];
    channelRolesToDelete?: FlatAgentChatChannelRole[];
    navigationMenuItemsToDelete?: FlatNavigationMenuItem[];
  }): Promise<void> {
    const result =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName: {
            agentChatChannel: {
              flatEntityToCreate: channelsToCreate,
              flatEntityToUpdate: channelsToUpdate,
              flatEntityToDelete: channelsToDelete,
            },
            agentChatChannelRole: {
              flatEntityToCreate: channelRolesToCreate,
              flatEntityToUpdate: [],
              flatEntityToDelete: channelRolesToDelete,
            },
            navigationMenuItem: {
              flatEntityToCreate: [],
              flatEntityToUpdate: [],
              flatEntityToDelete: navigationMenuItemsToDelete,
            },
          },
          workspaceId,
          isSystemBuild: false,
          applicationUniversalIdentifier,
        },
      );

    if (result.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        result,
        'Multiple validation errors occurred while saving the channel',
      );
    }
  }
}
