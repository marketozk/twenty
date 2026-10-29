import { Injectable } from '@nestjs/common';

import { WorkspaceMigrationRunnerActionHandler } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/interfaces/workspace-migration-runner-action-handler-service.interface';

import { ConnectionProviderEntity } from 'src/engine/core-modules/application/connection-provider/connection-provider.entity';
import {
  FlatDeleteConnectionProviderAction,
  UniversalDeleteConnectionProviderAction,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/builders/connection-provider/types/workspace-migration-connection-provider-action.type';
import {
  WorkspaceMigrationActionRunnerArgs,
  WorkspaceMigrationActionRunnerContext,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/workspace-migration-action-runner-args.type';

@Injectable()
export class DeleteConnectionProviderActionHandlerService extends WorkspaceMigrationRunnerActionHandler(
  'delete',
  'connectionProvider',
) {
  constructor() {
    super();
  }

  override async transpileUniversalActionToFlatAction(
    context: WorkspaceMigrationActionRunnerArgs<UniversalDeleteConnectionProviderAction>,
  ): Promise<FlatDeleteConnectionProviderAction> {
    return this.transpileUniversalDeleteActionToFlatDeleteAction(context);
  }

  async executeForMetadata(
    context: WorkspaceMigrationActionRunnerContext<FlatDeleteConnectionProviderAction>,
  ): Promise<void> {
    const { flatAction, queryRunner, workspaceId } = context;
    const providerId = flatAction.entityId;

    if (!queryRunner.isTransactionActive)
      throw new Error(
        'Connection provider deletion requires an active transaction',
      );
    const providers: { id: string }[] = await queryRunner.query(
      'SELECT id FROM core."connectionProvider" WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE',
      [providerId, workspaceId],
    );
    if (providers.length === 0) return;
    if (
      (
        await queryRunner.query(
          'SELECT id FROM core."connectedAccount" WHERE "connectionProviderId"=$1 LIMIT 1',
          [providerId],
        )
      ).length
    )
      throw new Error(
        'Connection provider still has connected accounts; audited cleanup must run first',
      );

    const connectionProviderRepository =
      queryRunner.manager.getRepository<ConnectionProviderEntity>(
        ConnectionProviderEntity,
      );

    await connectionProviderRepository.delete({
      id: providerId,
      workspaceId,
    });
  }

  async executeForWorkspaceSchema(
    _context: WorkspaceMigrationActionRunnerContext<FlatDeleteConnectionProviderAction>,
  ): Promise<void> {
    return;
  }
}
