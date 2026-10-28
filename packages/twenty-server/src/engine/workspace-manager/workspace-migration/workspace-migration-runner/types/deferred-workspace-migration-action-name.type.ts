export type DeferredWorkspaceMigrationActionName =
  | 'build_index'
  | 'validate_foreignKey'
  | 'delete_logicFunctionResources'
  | 'delete_workflowRuns'
  | 'sync_workflowRunShares';
