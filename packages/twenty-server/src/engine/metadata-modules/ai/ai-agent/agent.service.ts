import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { withAgentMetadataRoleTargetAudit } from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
  hasConflictingMetadataAuditScope,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import { type CreateAgentInput } from 'src/engine/metadata-modules/ai/ai-agent/dtos/create-agent.input';
import { type UpdateAgentInput } from 'src/engine/metadata-modules/ai/ai-agent/dtos/update-agent.input';
import { fromCreateAgentInputToFlatAgent } from 'src/engine/metadata-modules/ai/ai-agent/utils/from-create-agent-input-to-flat-agent.util';
import { fromUpdateAgentInputToFlatAgentToUpdate } from 'src/engine/metadata-modules/ai/ai-agent/utils/from-update-agent-input-to-flat-agent-to-update.util';
import { FlatAgentWithRoleId } from 'src/engine/metadata-modules/flat-agent/types/flat-agent.type';
import { findFlatEntityByIdInFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps-or-throw.util';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

import {
  AiException,
  AiExceptionCode,
} from 'src/engine/metadata-modules/ai/ai.exception';

import { AgentEntity } from './entities/agent.entity';

@Injectable()
export class AgentService {
  constructor(
    @InjectWorkspaceScopedRepository(AgentEntity)
    private readonly agentRepository: WorkspaceScopedRepository<AgentEntity>,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
    private readonly applicationService: ApplicationService,
    private readonly workspaceCacheService: WorkspaceCacheService,
  ) {}

  async findManyAgents(workspaceId: string): Promise<FlatAgentWithRoleId[]> {
    const { flatAgentMaps, flatRoleTargetByAgentIdMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatAgentMaps',
        'flatRoleTargetByAgentIdMaps',
      ]);

    return Object.values(flatAgentMaps.byUniversalIdentifier)
      .filter(isDefined)
      .map((flatAgent) => {
        const roleId = flatRoleTargetByAgentIdMaps[flatAgent.id]?.roleId;

        return {
          ...flatAgent,
          roleId: roleId ?? null,
        };
      });
  }

  async findOneAgentById({
    id,
    workspaceId,
  }: {
    workspaceId: string;
    id: string;
  }): Promise<FlatAgentWithRoleId> {
    const { flatAgentMaps, flatRoleTargetByAgentIdMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatAgentMaps',
        'flatRoleTargetByAgentIdMaps',
      ]);

    const flatAgent = findFlatEntityByIdInFlatEntityMaps({
      flatEntityId: id,
      flatEntityMaps: flatAgentMaps,
    });

    if (!isDefined(flatAgent)) {
      throw new AiException(`Agent not found`, AiExceptionCode.AGENT_NOT_FOUND);
    }

    const roleId = flatRoleTargetByAgentIdMaps[flatAgent.id]?.roleId;

    return { ...flatAgent, roleId: roleId ?? null };
  }

  // Captured before the first await and required for any roleId input and any
  // delete (deleting an agent cascades its roleTarget). Other agent edits
  // stay open to callers that cannot write audit entries.
  private captureAgentRoleAuditIdentity(
    workspaceId: string,
    auditIdentity: RoleUpdateAuditIdentity | undefined,
  ): () => RoleUpdateAuditIdentity {
    if (hasConflictingMetadataAuditScope(workspaceId)) {
      throw new Error('Nested role assignment audit unsupported');
    }

    try {
      const capturedIdentity = captureRoleAuditIdentity(
        auditIdentity as RoleUpdateAuditIdentity,
      );

      captureRoleAuditOperation(workspaceId, capturedIdentity);

      return () => capturedIdentity;
    } catch (error) {
      return () => {
        throw error;
      };
    }
  }

  async createOneAgent(
    { isSystem = false, ...input }: CreateAgentInput & { isSystem?: boolean },
    workspaceId: string,
    auditIdentity?: RoleUpdateAuditIdentity,
  ): Promise<FlatAgentWithRoleId> {
    const requireAuditIdentity = this.captureAgentRoleAuditIdentity(
      workspaceId,
      auditIdentity,
    );

    if (isDefined(input.roleId)) {
      requireAuditIdentity();
    }

    const { flatApplicationMaps, flatRoleMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatApplicationMaps',
        'flatRoleMaps',
      ]);

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        {
          workspaceId,
        },
      );

    const flatApplication = isDefined(input.applicationId)
      ? flatApplicationMaps.byId[input.applicationId]
      : undefined;

    const resolvedFlatApplication =
      flatApplication ?? workspaceCustomFlatApplication;

    const { flatAgentToCreate, flatRoleTargetToCreate } =
      fromCreateAgentInputToFlatAgent({
        createAgentInput: input,
        isSystem,
        workspaceId,
        flatApplication: resolvedFlatApplication,
        flatRoleMaps,
      });

    const runCreateMigration = () =>
      this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName: {
            agent: {
              flatEntityToCreate: [flatAgentToCreate],
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
            roleTarget: {
              flatEntityToCreate: isDefined(flatRoleTargetToCreate)
                ? [flatRoleTargetToCreate]
                : [],
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
          },
          workspaceId,
          isSystemBuild: false,
          applicationUniversalIdentifier:
            workspaceCustomFlatApplication.universalIdentifier,
        },
      );

    const validateAndBuildResult = isDefined(flatRoleTargetToCreate)
      ? await withAgentMetadataRoleTargetAudit(
          {
            agentMode: 'create',
            workspaceId,
            agentId: flatAgentToCreate.id,
            agentUniversalIdentifier: flatAgentToCreate.universalIdentifier,
            roleId: flatRoleTargetToCreate.roleId,
          },
          requireAuditIdentity(),
          runCreateMigration,
        )
      : await runCreateMigration();

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while creating agent',
      );
    }

    const { flatAgentMaps: recomputedFlatAgentMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatAgentMaps',
      ]);

    const createdAgent = findFlatEntityByIdInFlatEntityMapsOrThrow({
      flatEntityId: flatAgentToCreate.id,
      flatEntityMaps: recomputedFlatAgentMaps,
    });

    return {
      ...createdAgent,
      roleId: flatRoleTargetToCreate?.roleId ?? null,
    };
  }

  async updateOneAgent({
    input,
    workspaceId,
    auditIdentity,
  }: {
    input: UpdateAgentInput;
    workspaceId: string;
    auditIdentity?: RoleUpdateAuditIdentity;
  }): Promise<FlatAgentWithRoleId> {
    const requireAuditIdentity = this.captureAgentRoleAuditIdentity(
      workspaceId,
      auditIdentity,
    );

    if (input.roleId !== undefined) {
      requireAuditIdentity();
    }

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        {
          workspaceId,
        },
      );

    const { flatRoleTargetByAgentIdMaps, flatAgentMaps, flatRoleMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatRoleTargetByAgentIdMaps',
        'flatAgentMaps',
        'flatRoleMaps',
      ]);

    const {
      flatAgentToUpdate,
      flatRoleTargetToCreate,
      flatRoleTargetToDelete,
    } = fromUpdateAgentInputToFlatAgentToUpdate({
      updateAgentInput: input,
      flatAgentMaps,
      flatRoleTargetByAgentIdMaps,
      flatRoleMaps,
      roleTargetApplication: {
        applicationId: workspaceCustomFlatApplication.id,
        applicationUniversalIdentifier:
          workspaceCustomFlatApplication.universalIdentifier,
      },
    });

    const runUpdateMigration = () =>
      this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName: {
            agent: {
              flatEntityToCreate: [],
              flatEntityToDelete: [],
              flatEntityToUpdate: [flatAgentToUpdate],
            },
            roleTarget: {
              flatEntityToCreate: isDefined(flatRoleTargetToCreate)
                ? [flatRoleTargetToCreate]
                : [],
              flatEntityToDelete: isDefined(flatRoleTargetToDelete)
                ? [flatRoleTargetToDelete]
                : [],
              flatEntityToUpdate: [],
            },
          },
          workspaceId,
          isSystemBuild: false,
          applicationUniversalIdentifier:
            workspaceCustomFlatApplication.universalIdentifier,
        },
      );

    const validateAndBuildResult =
      isDefined(flatRoleTargetToCreate) || isDefined(flatRoleTargetToDelete)
        ? await withAgentMetadataRoleTargetAudit(
            {
              agentMode: 'update',
              workspaceId,
              agentId: flatAgentToUpdate.id,
              agentUniversalIdentifier: flatAgentToUpdate.universalIdentifier,
              roleId: flatRoleTargetToCreate?.roleId ?? null,
              expectedDeletedRoleTargetId: flatRoleTargetToDelete?.id ?? null,
            },
            requireAuditIdentity(),
            runUpdateMigration,
          )
        : await runUpdateMigration();

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        'Multiple validation errors occurred while updating agent',
      );
    }

    const {
      flatAgentMaps: recomputedFlatAgentMaps,
      flatRoleTargetByAgentIdMaps: recomputedFlatRoleTargetByAgentIdMaps,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      'flatAgentMaps',
      'flatRoleTargetByAgentIdMaps',
    ]);

    const updatedAgent = findFlatEntityByIdInFlatEntityMapsOrThrow({
      flatEntityId: input.id,
      flatEntityMaps: recomputedFlatAgentMaps,
    });

    const existingRoleTarget =
      recomputedFlatRoleTargetByAgentIdMaps[flatAgentToUpdate.id];

    return {
      ...updatedAgent,
      roleId: existingRoleTarget?.roleId ?? null,
    };
  }

  async deleteOneAgent(
    id: string,
    workspaceId: string,
    auditIdentity?: RoleUpdateAuditIdentity,
  ): Promise<FlatAgentWithRoleId> {
    const deletedAgents = await this.deleteManyAgents({
      ids: [id],
      workspaceId,
      auditIdentity,
    });

    if (deletedAgents.length !== 1) {
      throw new AiException(
        'Could not retrieve deleted agent',
        AiExceptionCode.AGENT_NOT_FOUND,
      );
    }

    const [deletedAgent] = deletedAgents;

    return deletedAgent;
  }

  async deleteManyAgents({
    ids,
    workspaceId,
    isSystemBuild = false,
    auditIdentity,
  }: {
    ids: string[];
    workspaceId: string;
    isSystemBuild?: boolean;
    auditIdentity?: RoleUpdateAuditIdentity;
  }): Promise<FlatAgentWithRoleId[]> {
    const requireAuditIdentity = this.captureAgentRoleAuditIdentity(
      workspaceId,
      auditIdentity,
    );

    if (ids.length === 0) {
      return [];
    }

    const deleteAuditIdentity = requireAuditIdentity();

    const { workspaceCustomFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        {
          workspaceId,
        },
      );

    const { flatAgentMaps, flatRoleTargetByAgentIdMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatAgentMaps',
        'flatRoleTargetByAgentIdMaps',
      ]);

    const agentsToDelete = ids
      .map((id) =>
        findFlatEntityByIdInFlatEntityMaps({
          flatEntityId: id,
          flatEntityMaps: flatAgentMaps,
        }),
      )
      .filter(isDefined);

    if (agentsToDelete.length === 0) {
      return [];
    }

    const roleTargetsToDelete = agentsToDelete
      .map((agent) => flatRoleTargetByAgentIdMaps[agent.id])
      .filter(isDefined);

    const runDeleteMigration = () =>
      this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunWorkspaceMigration(
        {
          allFlatEntityOperationByMetadataName: {
            agent: {
              flatEntityToCreate: [],
              flatEntityToDelete: agentsToDelete,
              flatEntityToUpdate: [],
            },
            roleTarget: {
              flatEntityToCreate: [],
              flatEntityToDelete: roleTargetsToDelete,
              flatEntityToUpdate: [],
            },
          },
          workspaceId,
          isSystemBuild,
          applicationUniversalIdentifier:
            workspaceCustomFlatApplication.universalIdentifier,
        },
      );

    const validateAndBuildResult = await withAgentMetadataRoleTargetAudit(
      {
        agentMode: 'delete',
        workspaceId,
        targets: agentsToDelete.flatMap((agent) => {
          const roleTarget = flatRoleTargetByAgentIdMaps[agent.id];

          return isDefined(roleTarget)
            ? [{ agentId: agent.id, roleTargetId: roleTarget.id }]
            : [];
        }),
      },
      deleteAuditIdentity,
      runDeleteMigration,
    );

    if (validateAndBuildResult.status === 'fail') {
      throw new WorkspaceMigrationBuilderException(
        validateAndBuildResult,
        `Multiple validation errors occurred while deleting agent${ids.length > 1 ? 's' : ''}`,
      );
    }

    return agentsToDelete.map((agent) => ({
      ...agent,
      roleId: flatRoleTargetByAgentIdMaps[agent.id]?.roleId ?? null,
    }));
  }
}
