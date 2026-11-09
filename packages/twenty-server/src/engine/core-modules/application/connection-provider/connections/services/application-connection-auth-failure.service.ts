import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';

import { DataSource, IsNull, Repository } from 'typeorm';

import { ConnectedAccountProvider } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { ConnectionProviderExceptionCode } from 'src/engine/core-modules/application/connection-provider/connection-provider-exception-code.enum';
import { ConnectionProviderException } from 'src/engine/core-modules/application/connection-provider/connection-provider.exception';
import { isConnectionHiddenFromRequestUser } from 'src/engine/core-modules/application/connection-provider/connections/utils/is-connection-hidden-from-request-user.util';
import {
  captureAppConnectionAuthFailureAudit,
  runAuditedAppConnectionAuthFailureReport,
  type ApplicationAuthorizationAuditIdentity,
} from 'src/engine/core-modules/crm-audit/application-authorization-and-variable-audit';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';

type ReportAuthFailureArgs = {
  applicationId: string;
  workspaceId: string;
  requestUserWorkspaceId: string | null;
  id: string;
  reason: string | null;
  auditIdentity?: ApplicationAuthorizationAuditIdentity;
};

@Injectable()
export class ApplicationConnectionAuthFailureService {
  constructor(
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @Optional()
    @InjectDataSource()
    private readonly coreDataSource?: DataSource,
  ) {}

  private getDataSource(): DataSource | undefined {
    return (
      this.coreDataSource ??
      this.connectedAccountRepository?.manager?.connection
    );
  }

  async reportAuthFailureOrThrow({
    applicationId,
    workspaceId,
    requestUserWorkspaceId,
    id,
    reason,
    auditIdentity,
  }: ReportAuthFailureArgs): Promise<void> {
    const capturedApplicationId = applicationId;
    const capturedWorkspaceId = workspaceId;
    const capturedRequestUserWorkspaceId = requestUserWorkspaceId;
    const capturedId = id;
    const capturedReason = reason;
    const auditRequest = captureAppConnectionAuthFailureAudit({
      workspaceId: capturedWorkspaceId,
      applicationId: capturedApplicationId,
      auditIdentity,
    });

    const scopedWhere = {
      id: capturedId,
      applicationId: capturedApplicationId,
      workspaceId: capturedWorkspaceId,
      provider: (ConnectedAccountProvider.APP ??
        'app') as ConnectedAccountProvider,
      archivedAt: IsNull(),
    };

    const account = await this.connectedAccountRepository.findOne({
      where: scopedWhere,
    });

    if (
      !isDefined(account) ||
      isConnectionHiddenFromRequestUser({
        account,
        requestUserWorkspaceId: capturedRequestUserWorkspaceId,
      })
    ) {
      throw new ConnectionProviderException(
        `Connection ${capturedId} not found`,
        ConnectionProviderExceptionCode.CONNECTION_NOT_FOUND,
      );
    }

    const outcome = await runAuditedAppConnectionAuthFailureReport(
      this.getDataSource(),
      auditRequest,
      {
        id: capturedId,
        applicationId: capturedApplicationId,
        requestUserWorkspaceId: capturedRequestUserWorkspaceId,
        reason: capturedReason,
        expectedLastCredentialsRefreshedAt:
          account.lastCredentialsRefreshedAt ?? null,
      },
    );

    if (outcome.status === 'not_found') {
      throw new ConnectionProviderException(
        `Connection ${capturedId} not found`,
        ConnectionProviderExceptionCode.CONNECTION_NOT_FOUND,
      );
    }
  }
}
