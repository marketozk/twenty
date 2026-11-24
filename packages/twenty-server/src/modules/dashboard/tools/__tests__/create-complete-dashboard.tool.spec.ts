import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { createCreateCompleteDashboardTool } from 'src/modules/dashboard/tools/create-complete-dashboard.tool';
import { type DashboardToolDependencies } from 'src/modules/dashboard/tools/types/dashboard-tool-dependencies.type';

const WORKSPACE_ID = '20202020-aaaa-4d02-bf25-6aeccf7ea419';
const ROLE_ID = '20202020-bbbb-4d02-bf25-6aeccf7ea419';
const PAGE_LAYOUT_ID = '20202020-cccc-4d02-bf25-6aeccf7ea419';
const WORKSPACE_MEMBER_ID = '20202020-dddd-4d02-bf25-6aeccf7ea419';
const AGENT_ID = '20202020-eeee-4d02-bf25-6aeccf7ea419';

const buildDeps = ({
  insert,
  runInWorkspaceTransaction,
}: {
  insert: jest.Mock;
  runInWorkspaceTransaction?: jest.Mock;
}) => {
  const create = jest.fn().mockResolvedValue({ id: PAGE_LAYOUT_ID });
  const destroy = jest.fn().mockResolvedValue(true);
  const txGetRepository = jest.fn().mockReturnValue({ insert });
  const txMock =
    runInWorkspaceTransaction ??
    jest
      .fn()
      .mockImplementation(async (work) =>
        work({ getRepository: txGetRepository }),
      );

  return {
    create,
    destroy,
    txMock,
    txGetRepository,
    deps: {
      pageLayoutService: {
        create,
        destroy,
      },
      pageLayoutTabService: {
        create: jest.fn().mockResolvedValue({ id: 'tab-id' }),
      },
      recordPositionService: {
        buildRecordPosition: jest.fn().mockResolvedValue(1),
      },
      workspaceOrmManager: {
        executeInWorkspaceContext: jest
          .fn()
          .mockImplementation(async (fn) => fn()),
        runInWorkspaceTransaction: txMock,
        getRepository: jest.fn().mockReturnValue({ insert }),
        getObjectMetadataId: jest.fn().mockReturnValue(undefined),
      },
    } as unknown as DashboardToolDependencies,
  };
};

describe('createCreateCompleteDashboardTool', () => {
  it('destroys the page layout when the permission-checked dashboard insert fails', async () => {
    const insert = jest.fn().mockRejectedValue(new Error('Permission denied'));
    const { deps, destroy, txMock } = buildDeps({ insert });

    const tool = createCreateCompleteDashboardTool(deps, {
      workspaceId: WORKSPACE_ID,
      rolePermissionConfig: {
        intersectionOf: { userWorkspaceRoleId: ROLE_ID },
      },
    });

    const result = await tool.execute({ title: 'Revenue' });

    expect(result.success).toBe(false);
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(txMock.mock.calls[0][1].nativeAuditBinding.operation.actor).toEqual({
      kind: 'system',
      id: 'dashboard-tool:create-complete-dashboard',
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith({
      id: PAGE_LAYOUT_ID,
      workspaceId: WORKSPACE_ID,
      isLinkedDashboardAlreadyDestroyed: true,
    });
  });

  it('leaves the page layout in place when the dashboard insert succeeds with agent audit identity', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const { deps, destroy, txMock } = buildDeps({ insert });

    const tool = createCreateCompleteDashboardTool(deps, {
      workspaceId: WORKSPACE_ID,
      rolePermissionConfig: {
        intersectionOf: { userWorkspaceRoleId: ROLE_ID },
      },
      auditIdentity: {
        workspaceMemberId: WORKSPACE_MEMBER_ID,
        agentId: AGENT_ID,
      },
    });

    const result = await tool.execute({ title: 'Revenue' });

    expect(result.success).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
    expect(txMock.mock.calls[0][1].nativeAuditBinding.operation.actor).toEqual({
      kind: 'agent',
      id: AGENT_ID,
    });
    expect(
      txMock.mock.calls[0][1].nativeAuditBinding.operation.initiator,
    ).toEqual({
      kind: 'workspaceMember',
      id: WORKSPACE_MEMBER_ID,
    });
  });

  it('skips layout compensation when dashboard transaction outcome is unknown', async () => {
    const insert = jest.fn();
    const runInWorkspaceTransaction = jest
      .fn()
      .mockRejectedValue(
        new NativeTransactionOutcomeUnknownError(
          'commit',
          new Error('commit timeout'),
        ),
      );
    const { deps, destroy } = buildDeps({ insert, runInWorkspaceTransaction });

    const tool = createCreateCompleteDashboardTool(deps, {
      workspaceId: WORKSPACE_ID,
      rolePermissionConfig: {
        intersectionOf: { userWorkspaceRoleId: ROLE_ID },
      },
    });

    const result = await tool.execute({ title: 'Revenue' });

    expect(result.success).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('fails closed before creating a page layout when explicit audit identity cannot perform audited writes', async () => {
    const insert = jest.fn();
    const { deps, create, destroy } = buildDeps({ insert });

    const tool = createCreateCompleteDashboardTool(deps, {
      workspaceId: WORKSPACE_ID,
      rolePermissionConfig: {
        intersectionOf: { userWorkspaceRoleId: ROLE_ID },
      },
      auditIdentity: {
        agentId: AGENT_ID,
      },
    });

    const result = await tool.execute({ title: 'Revenue' });

    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
