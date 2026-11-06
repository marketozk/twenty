import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';

import { MEMBER_ROLE_UNIVERSAL_IDENTIFIER } from 'twenty-shared/constants';
import { isDefined } from 'twenty-shared/utils';
import { DataSource, In, IsNull, Not } from 'typeorm';

import { WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER } from 'src/engine/core-modules/application/constants/workspace-custom-application-role.constant';
import {
  getRoleAssignmentAudit,
  withAgentRoleAssignmentAudit,
  withAgentRoleRemovalAudit,
} from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
  getRoleMutationAudit,
  hasConflictingMetadataAuditScope,
  runAuditedUnusedAgentRoleDelete,
  type RoleUpdateAuditIdentity,
} from 'src/engine/core-modules/crm-audit/role-update-audit';
import {
  AiException,
  AiExceptionCode,
} from 'src/engine/metadata-modules/ai/ai.exception';
import { AgentEntity } from 'src/engine/metadata-modules/ai/ai-agent/entities/agent.entity';
import { RoleTargetEntity } from 'src/engine/metadata-modules/role-target/role-target.entity';
import { RoleTargetService } from 'src/engine/metadata-modules/role-target/services/role-target.service';
import { RoleEntity } from 'src/engine/metadata-modules/role/role.entity';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { STANDARD_ROLE } from 'src/engine/workspace-manager/twenty-standard-application/constants/standard-role.constant';

@Injectable()
export class AiAgentRoleService {
  constructor(
    @InjectWorkspaceScopedRepository(AgentEntity)
    private readonly agentRepository: WorkspaceScopedRepository<AgentEntity>,
    @InjectWorkspaceScopedRepository(RoleEntity)
    private readonly roleRepository: WorkspaceScopedRepository<RoleEntity>,
    @InjectWorkspaceScopedRepository(RoleTargetEntity)
    private readonly roleTargetRepository: WorkspaceScopedRepository<RoleTargetEntity>,
    private readonly roleTargetService: RoleTargetService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  public async findAgentRoleId({
    workspaceId,
    agentId,
  }: {
    workspaceId: string;
    agentId: string;
  }): Promise<string | undefined> {
    const { flatRoleTargetByAgentIdMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatRoleTargetByAgentIdMaps',
      ]);

    return flatRoleTargetByAgentIdMaps[agentId]?.roleId;
  }

  public async assignRoleToAgent(args: {
    workspaceId: string;
    agentId: string;
    roleId: string;
    auditIdentity?: RoleUpdateAuditIdentity;
  }): Promise<void> {
    const capturedWorkspaceId = args.workspaceId;
    const capturedAgentId = args.agentId;
    const capturedRoleId = args.roleId;
    if (
      typeof capturedWorkspaceId !== 'string' ||
      !isUUID(capturedWorkspaceId) ||
      typeof capturedAgentId !== 'string' ||
      !isUUID(capturedAgentId) ||
      typeof capturedRoleId !== 'string' ||
      !isUUID(capturedRoleId)
    ) {
      throw new Error('Role assignment audit identity invalid');
    }
    if (
      getRoleMutationAudit(capturedWorkspaceId) ||
      hasConflictingMetadataAuditScope(
        capturedWorkspaceId,
        getRoleAssignmentAudit,
      ) ||
      getRoleAssignmentAudit(capturedWorkspaceId)
    ) {
      throw new Error('Nested role assignment audit unsupported');
    }
    const capturedIdentity = captureRoleAuditIdentity(
      args.auditIdentity as RoleUpdateAuditIdentity,
    );
    captureRoleAuditOperation(capturedWorkspaceId, capturedIdentity);

    const validationResult = await this.validateAssignRoleInput({
      agentId: capturedAgentId,
      workspaceId: capturedWorkspaceId,
      roleId: capturedRoleId,
    });

    if (validationResult?.roleToAssignIsSameAsCurrentRole) {
      return;
    }

    await withAgentRoleAssignmentAudit(
      {
        workspaceId: capturedWorkspaceId,
        agentId: capturedAgentId,
        roleId: capturedRoleId,
      },
      capturedIdentity,
      () =>
        this.roleTargetService.create({
          createRoleTargetInput: {
            roleId: capturedRoleId,
            targetId: capturedAgentId,
            targetMetadataForeignKey: 'agentId',
          },
          workspaceId: capturedWorkspaceId,
        }),
    );
  }

  public async removeRoleFromAgent({
    workspaceId,
    agentId,
    auditIdentity,
  }: {
    workspaceId: string;
    agentId: string;
    auditIdentity: RoleUpdateAuditIdentity;
  }): Promise<void> {
    const capturedWorkspaceId = workspaceId;
    const capturedAgentId = agentId;
    const capturedIdentity = captureRoleAuditIdentity(auditIdentity);
    captureRoleAuditOperation(capturedWorkspaceId, capturedIdentity);

    const existingRoleTarget = await this.roleTargetRepository.findOne(
      capturedWorkspaceId,
      {
        where: {
          agentId: capturedAgentId,
        },
      },
    );

    if (!isDefined(existingRoleTarget)) {
      throw new AiException(
        `Role target not found for agent ${capturedAgentId}`,
        AiExceptionCode.ROLE_NOT_FOUND,
      );
    }

    await withAgentRoleRemovalAudit(
      {
        workspaceId: capturedWorkspaceId,
        agentId: capturedAgentId,
        roleTargetId: existingRoleTarget.id,
      },
      capturedIdentity,
      () =>
        this.roleTargetService.delete({
          id: existingRoleTarget.id,
          workspaceId: capturedWorkspaceId,
        }),
    );
  }

  public async getAgentsAssignedToRole(
    roleId: string,
    workspaceId: string,
  ): Promise<AgentEntity[]> {
    const roleTargets = await this.roleTargetRepository.find(workspaceId, {
      where: {
        roleId,
        agentId: Not(IsNull()),
      },
    });

    const agentIds = roleTargets
      .map((roleTarget) => roleTarget.agentId)
      .filter((agentId): agentId is string => agentId !== null);

    if (!agentIds.length) {
      return [];
    }

    const agents = await this.agentRepository.find(workspaceId, {
      where: { id: In(agentIds) },
    });

    return agents;
  }

  private async validateAssignRoleInput({
    agentId,
    workspaceId,
    roleId,
  }: {
    agentId: string;
    workspaceId: string;
    roleId: string;
  }) {
    const agent = await this.agentRepository.findOne(workspaceId, {
      where: { id: agentId },
    });

    if (!agent) {
      throw new AiException(
        `Agent with id ${agentId} not found in workspace`,
        AiExceptionCode.AGENT_NOT_FOUND,
      );
    }

    const role = await this.roleRepository.findOne(workspaceId, {
      where: { id: roleId },
    });

    if (!role) {
      throw new AiException(
        `Role with id ${roleId} not found in workspace`,
        AiExceptionCode.ROLE_NOT_FOUND,
      );
    }

    if (!role.canBeAssignedToAgents) {
      throw new AiException(
        `Role "${role.label}" cannot be assigned to agents`,
        AiExceptionCode.ROLE_CANNOT_BE_ASSIGNED_TO_AGENTS,
      );
    }

    const existingRoleTarget = await this.roleTargetRepository.findOne(
      workspaceId,
      {
        where: {
          agentId,
          roleId,
        },
      },
    );

    return {
      roleToAssignIsSameAsCurrentRole: Boolean(existingRoleTarget),
    };
  }

  public async deleteAgentOnlyRoleIfUnused({
    roleId,
    roleTargetId,
    workspaceId,
    auditIdentity,
  }: {
    roleId: string;
    roleTargetId: string;
    workspaceId: string;
    auditIdentity?: RoleUpdateAuditIdentity;
  }): Promise<void> {
    const capturedWorkspaceId = workspaceId;
    const capturedRoleId = roleId;
    const capturedRoleTargetId = roleTargetId;
    if (
      typeof capturedWorkspaceId !== 'string' ||
      !isUUID(capturedWorkspaceId) ||
      typeof capturedRoleId !== 'string' ||
      !isUUID(capturedRoleId) ||
      typeof capturedRoleTargetId !== 'string' ||
      !isUUID(capturedRoleTargetId)
    ) {
      throw new Error('Role audit identity is invalid');
    }
    if (
      getRoleMutationAudit(capturedWorkspaceId) ||
      hasConflictingMetadataAuditScope(
        capturedWorkspaceId,
        getRoleMutationAudit,
      )
    ) {
      throw new Error('Nested role audit is unsupported');
    }
    const capturedIdentity = captureRoleAuditIdentity(
      auditIdentity as RoleUpdateAuditIdentity,
    );
    captureRoleAuditOperation(capturedWorkspaceId, capturedIdentity);

    const role = await this.roleRepository.findOne(capturedWorkspaceId, {
      where: { id: capturedRoleId },
    });

    if (
      !isDefined(role) ||
      role.isEditable === false ||
      role.universalIdentifier === MEMBER_ROLE_UNIVERSAL_IDENTIFIER ||
      role.universalIdentifier === STANDARD_ROLE.admin.universalIdentifier ||
      role.universalIdentifier ===
        WORKSPACE_CUSTOM_APPLICATION_ROLE_UNIVERSAL_IDENTIFIER ||
      !role.canBeAssignedToAgents ||
      role.canBeAssignedToUsers ||
      role.canBeAssignedToApiKeys
    ) {
      return;
    }

    const remainingAssignments = await this.roleTargetRepository.count(
      capturedWorkspaceId,
      {
        where: {
          roleId: capturedRoleId,
          id: Not(capturedRoleTargetId),
        },
      },
    );

    if (remainingAssignments !== 0) {
      return;
    }

    let shouldInvalidateCache = false;
    try {
      const deleted = await runAuditedUnusedAgentRoleDelete(
        this.coreDataSource,
        {
          workspaceId: capturedWorkspaceId,
          roleId: capturedRoleId,
          roleTargetId: capturedRoleTargetId,
        },
        capturedIdentity,
      );
      shouldInvalidateCache = deleted;
    } catch (error) {
      if (error instanceof NativeTransactionOutcomeUnknownError) {
        shouldInvalidateCache = true;
      }
      throw error;
    } finally {
      if (shouldInvalidateCache) {
        await this.workspaceCacheService.invalidateAndRecompute(
          capturedWorkspaceId,
          ['flatRoleMaps', 'flatRolePermissionFlagMaps', 'rolesPermissions'],
        );
      }
    }
  }
}
