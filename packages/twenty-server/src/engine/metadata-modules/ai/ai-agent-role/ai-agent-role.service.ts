import { Injectable } from '@nestjs/common';

import { MEMBER_ROLE_UNIVERSAL_IDENTIFIER } from 'twenty-shared/constants';
import { isDefined } from 'twenty-shared/utils';
import { In, IsNull, Not } from 'typeorm';

import {
  withAgentRoleAssignmentAudit,
  withAgentRoleRemovalAudit,
} from 'src/engine/core-modules/crm-audit/role-assignment-audit';
import {
  captureRoleAuditIdentity,
  captureRoleAuditOperation,
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
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
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
    const { workspaceId, agentId, roleId } = args;
    const isAudited =
      Object.hasOwn(args, 'auditIdentity') || args.auditIdentity !== undefined;
    const capturedIdentity = isAudited
      ? captureRoleAuditIdentity(args.auditIdentity!)
      : undefined;
    if (capturedIdentity) {
      captureRoleAuditOperation(workspaceId, capturedIdentity);
    }

    const validationResult = await this.validateAssignRoleInput({
      agentId,
      workspaceId,
      roleId,
    });

    if (validationResult?.roleToAssignIsSameAsCurrentRole) {
      return;
    }

    const executeCreate = () =>
      this.roleTargetService.create({
        createRoleTargetInput: {
          roleId,
          targetId: agentId,
          targetMetadataForeignKey: 'agentId',
        },
        workspaceId,
      });

    if (capturedIdentity) {
      await withAgentRoleAssignmentAudit(
        { workspaceId, agentId, roleId },
        capturedIdentity,
        executeCreate,
      );
      return;
    }

    await executeCreate();
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
  }: {
    roleId: string;
    roleTargetId: string;
    workspaceId: string;
  }): Promise<void> {
    const role = await this.roleRepository.findOne(workspaceId, {
      where: { id: roleId },
    });

    if (
      !isDefined(role) ||
      role.universalIdentifier === MEMBER_ROLE_UNIVERSAL_IDENTIFIER ||
      !role.canBeAssignedToAgents ||
      role.canBeAssignedToUsers ||
      role.canBeAssignedToApiKeys
    ) {
      return;
    }

    const remainingAssignments = await this.roleTargetRepository.count(
      workspaceId,
      {
        where: {
          roleId,
          id: Not(roleTargetId),
        },
      },
    );

    if (remainingAssignments === 0) {
      await this.roleRepository.delete(workspaceId, { id: roleId });
      await this.workspaceCacheService.invalidateAndRecompute(workspaceId, [
        'flatRoleMaps',
        'flatRolePermissionFlagMaps',
      ]);
    }
  }
}
