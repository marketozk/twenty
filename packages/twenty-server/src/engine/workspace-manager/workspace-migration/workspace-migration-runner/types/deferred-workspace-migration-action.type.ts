import { type FlatLogicFunction } from 'src/engine/metadata-modules/logic-function/types/flat-logic-function.type';
import { type DeferredWorkspaceMigrationActionName } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action-name.type';
export { type DeferredWorkspaceMigrationActionName } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/types/deferred-workspace-migration-action-name.type';

type DeferredWorkspaceMigrationActionPayloadByName = {
  sync_workflowRunShares: { version: 1; coreWorkflowId: string };
  build_index: { indexMetadataId: string };
  validate_foreignKey: { fieldMetadataId: string };
  delete_logicFunctionResources: { flatLogicFunction: FlatLogicFunction };
  delete_workflowRuns: {
    coreWorkflowId: string;
    coreWorkflowVersionId?: string;
  };
};

export type DeferredWorkspaceMigrationActionPayload<
  TName extends DeferredWorkspaceMigrationActionName,
> = DeferredWorkspaceMigrationActionPayloadByName[TName];

export type PersistedDeferredWorkspaceMigrationAction = {
  name: DeferredWorkspaceMigrationActionName;
  payload: DeferredWorkspaceMigrationActionPayloadByName[DeferredWorkspaceMigrationActionName];
};

export type DeferredWorkspaceMigrationAction = {
  [TName in DeferredWorkspaceMigrationActionName]: {
    name: TName;
    payload: DeferredWorkspaceMigrationActionPayloadByName[TName];
  };
}[DeferredWorkspaceMigrationActionName];
