import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import {
  captureWorkspaceDomainAudit,
  consumeWorkspaceDomainAuditRequest,
  runAuditedUnsubscribeTopicCreate,
  runAuditedUnsubscribeTopicDelete,
  runAuditedUnsubscribeTopicUpdate,
  type UnsubscribeTopicVisibilityValue,
  type WorkspaceDomainAuditIdentity,
} from 'src/engine/core-modules/crm-audit/workspace-domain-audit';
import { UnsubscribeTopicEntity } from 'src/engine/core-modules/emailing-domain/unsubscribe-topic.entity';
import { UnsubscribeTopicVisibility } from 'src/engine/core-modules/emailing-domain/types/unsubscribe-topic-visibility.type';
import { InjectWorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/inject-workspace-scoped-repository.decorator';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';

type CreateUnsubscribeTopicArgs = {
  name: string;
  description?: string | null;
  visibility?: UnsubscribeTopicVisibility | null;
};

type UpdateUnsubscribeTopicArgs = {
  id: string;
  name?: string | null;
  description?: string | null;
  visibility?: UnsubscribeTopicVisibility | null;
};

@Injectable()
export class UnsubscribeTopicService {
  constructor(
    @InjectWorkspaceScopedRepository(UnsubscribeTopicEntity)
    private readonly unsubscribeTopicRepository: WorkspaceScopedRepository<UnsubscribeTopicEntity>,
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  private resolveDataSource(): DataSource | undefined {
    return (
      this.dataSource ??
      ((
        this.unsubscribeTopicRepository as unknown as {
          repository?: { manager?: { connection?: DataSource } };
        }
      )?.repository?.manager?.connection as DataSource | undefined)
    );
  }

  async getUnsubscribeTopics(
    workspaceId: string,
  ): Promise<UnsubscribeTopicEntity[]> {
    return this.unsubscribeTopicRepository.find(workspaceId, {
      order: { name: 'ASC' },
    });
  }

  async findPublicTopics(
    workspaceId: string,
  ): Promise<UnsubscribeTopicEntity[]> {
    return this.unsubscribeTopicRepository.find(workspaceId, {
      where: { visibility: UnsubscribeTopicVisibility.PUBLIC },
      order: { name: 'ASC' },
    });
  }

  async createUnsubscribeTopic(
    workspaceId: string,
    { name, description = null, visibility }: CreateUnsubscribeTopicArgs,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ): Promise<UnsubscribeTopicEntity> {
    const resolvedDataSource = this.resolveDataSource();
    const auditRequest =
      resolvedDataSource || options?.auditIdentity !== undefined
        ? captureWorkspaceDomainAudit({
            workspaceId,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    if (!resolvedDataSource && !auditRequest) {
      return this.unsubscribeTopicRepository.insertAndReturnOne(workspaceId, {
        name,
        description,
        visibility: visibility ?? UnsubscribeTopicVisibility.PRIVATE,
      });
    }

    try {
      const created = await runAuditedUnsubscribeTopicCreate(
        resolvedDataSource,
        auditRequest!,
        {
          name,
          description,
          visibility: (visibility ??
            UnsubscribeTopicVisibility.PRIVATE) as UnsubscribeTopicVisibilityValue,
        },
      );

      return Object.assign(new UnsubscribeTopicEntity(), created);
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }

  async updateUnsubscribeTopic(
    workspaceId: string,
    { id, name, description, visibility }: UpdateUnsubscribeTopicArgs,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ): Promise<UnsubscribeTopicEntity> {
    const resolvedDataSource = this.resolveDataSource();
    const auditRequest =
      resolvedDataSource || options?.auditIdentity !== undefined
        ? captureWorkspaceDomainAudit({
            workspaceId,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    if (!resolvedDataSource && !auditRequest) {
      await this.unsubscribeTopicRepository.update(
        workspaceId,
        { id },
        {
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(isDefined(visibility) ? { visibility } : {}),
        },
      );

      return this.unsubscribeTopicRepository.findOneOrFail(workspaceId, {
        where: { id },
      });
    }

    try {
      const updated = await runAuditedUnsubscribeTopicUpdate(
        resolvedDataSource,
        auditRequest!,
        {
          unsubscribeTopicId: id,
          patch: {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(isDefined(visibility)
              ? { visibility: visibility as UnsubscribeTopicVisibilityValue }
              : {}),
          },
          onNotFound: async () => {
            await this.unsubscribeTopicRepository.findOneOrFail(workspaceId, {
              where: { id },
            });
            throw new Error('Unsubscribe topic not found');
          },
        },
      );

      return Object.assign(new UnsubscribeTopicEntity(), updated);
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }

  async deleteUnsubscribeTopic(
    workspaceId: string,
    id: string,
    options?: {
      auditIdentity?: WorkspaceDomainAuditIdentity;
    },
  ): Promise<void> {
    const resolvedDataSource = this.resolveDataSource();
    const auditRequest =
      resolvedDataSource || options?.auditIdentity !== undefined
        ? captureWorkspaceDomainAudit({
            workspaceId,
            auditIdentity: options?.auditIdentity,
          })
        : undefined;

    if (!resolvedDataSource && !auditRequest) {
      await this.unsubscribeTopicRepository.delete(workspaceId, { id });

      return;
    }

    try {
      await runAuditedUnsubscribeTopicDelete(
        resolvedDataSource,
        auditRequest!,
        {
          unsubscribeTopicId: id,
        },
      );
    } finally {
      consumeWorkspaceDomainAuditRequest(auditRequest);
    }
  }
}
