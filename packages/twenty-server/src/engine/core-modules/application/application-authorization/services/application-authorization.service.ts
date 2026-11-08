import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { DataSource, Repository } from 'typeorm';

import { ApplicationAuthorizationEntity } from 'src/engine/core-modules/application/application-authorization/application-authorization.entity';
import {
  captureApplicationAuthorizationAudit,
  runAuditedApplicationAuthorizationRevoke,
  runAuditedApplicationAuthorizationUpsert,
  type ApplicationAuthorizationAuditIdentity,
} from 'src/engine/core-modules/crm-audit/application-authorization-and-variable-audit';

@Injectable()
export class ApplicationAuthorizationService {
  constructor(
    @InjectRepository(ApplicationAuthorizationEntity)
    private readonly applicationAuthorizationRepository: Repository<ApplicationAuthorizationEntity>,
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  private getDataSource(): DataSource | undefined {
    return (
      this.coreDataSource ??
      this.applicationAuthorizationRepository?.manager?.connection
    );
  }

  async recordAuthorization({
    userId,
    workspaceId,
    userWorkspaceId,
    applicationId,
    scopes,
    auditIdentity,
  }: {
    userId: string;
    workspaceId: string;
    userWorkspaceId: string;
    applicationId: string;
    scopes: string[];
    auditIdentity?: ApplicationAuthorizationAuditIdentity;
  }): Promise<void> {
    const request = captureApplicationAuthorizationAudit({
      workspaceId,
      auditIdentity,
    });

    await runAuditedApplicationAuthorizationUpsert(
      this.getDataSource(),
      request,
      {
        userId,
        userWorkspaceId,
        applicationId,
        scopes,
        mode: 'record',
      },
    );
  }

  // Scopes and consent time stay null: pre-table refresh tokens carry neither, and today's declared scopes prove nothing.
  // Insert-only, so it never overwrites a row written by a real consent.
  async backfillAuthorizationFromRefreshToken({
    userId,
    workspaceId,
    userWorkspaceId,
    applicationId,
    auditIdentity,
  }: {
    userId: string;
    workspaceId: string;
    userWorkspaceId: string;
    applicationId: string;
    auditIdentity?: ApplicationAuthorizationAuditIdentity;
  }): Promise<void> {
    const request = captureApplicationAuthorizationAudit({
      workspaceId,
      auditIdentity,
    });

    await runAuditedApplicationAuthorizationUpsert(
      this.getDataSource(),
      request,
      {
        userId,
        userWorkspaceId,
        applicationId,
        scopes: null,
        mode: 'backfill',
      },
    );
  }

  // Includes revoked rows: callers must tell "never authorized" from "revoked"
  async findByUserAndApplication({
    userId,
    applicationId,
  }: {
    userId: string;
    applicationId: string;
  }): Promise<ApplicationAuthorizationEntity | null> {
    return await this.applicationAuthorizationRepository.findOneBy({
      userId,
      applicationId,
    });
  }

  // Inner join drops authorizations of soft-deleted applications
  async findActiveAuthorizationsForUserWorkspace({
    userId,
    workspaceId,
  }: {
    userId: string;
    workspaceId: string;
  }): Promise<ApplicationAuthorizationEntity[]> {
    return await this.applicationAuthorizationRepository
      .createQueryBuilder('applicationAuthorization')
      .innerJoinAndSelect('applicationAuthorization.application', 'application')
      .where('applicationAuthorization.userId = :userId', { userId })
      .andWhere('applicationAuthorization.workspaceId = :workspaceId', {
        workspaceId,
      })
      .andWhere('applicationAuthorization.revokedAt IS NULL')
      .orderBy('applicationAuthorization.lastUsedAt', 'DESC')
      .getMany();
  }

  async touchLastUsedAt(authorizationId: string): Promise<void> {
    await this.applicationAuthorizationRepository.update(
      { id: authorizationId },
      { lastUsedAt: new Date() },
    );
  }

  // Scoped in the UPDATE itself so a guessed id cannot revoke someone else's authorization
  async revokeAuthorizationByIdForUserWorkspace({
    authorizationId,
    userId,
    workspaceId,
    auditIdentity,
  }: {
    authorizationId: string;
    userId: string;
    workspaceId: string;
    auditIdentity?: ApplicationAuthorizationAuditIdentity;
  }): Promise<boolean> {
    const request = captureApplicationAuthorizationAudit({
      workspaceId,
      auditIdentity,
    });

    return await runAuditedApplicationAuthorizationRevoke(
      this.getDataSource(),
      request,
      {
        id: authorizationId,
        userId,
      },
    );
  }

  async revokeAuthorizationForApplication({
    userId,
    applicationId,
    workspaceId,
    auditIdentity,
  }: {
    userId: string;
    applicationId: string;
    workspaceId?: string;
    auditIdentity?: ApplicationAuthorizationAuditIdentity;
  }): Promise<boolean> {
    const request = captureApplicationAuthorizationAudit({
      workspaceId,
      auditIdentity,
    });

    return await runAuditedApplicationAuthorizationRevoke(
      this.getDataSource(),
      request,
      {
        userId,
        applicationId,
      },
    );
  }
}
