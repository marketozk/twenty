import { randomUUID } from 'node:crypto';
import {
  withAccountScopeRepairExecution,
  consumeAccountScopeRepairExecution,
} from 'src/engine/core-modules/crm-audit/account-scope-repair-execution';
import { captureCurrentCrmAuditIdentity } from 'src/engine/core-modules/crm-audit/crm-audit-attribution-context';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import {
  WorkspaceCommandRunner,
  type RunOnWorkspaceArgs,
} from 'src/database/commands/command-runners/workspace.command-runner';
import { WorkspaceCommandRunnerService } from 'src/engine/core-modules/upgrade/services/workspace-command-runner.service';

jest.mock('chalk', () => ({
  __esModule: true,
  default: {
    red: (s: string) => s,
    blue: (s: string) => s,
    yellow: (s: string) => s,
  },
}));
jest.mock(
  'src/database/commands/command-runners/workspace-iterator.service',
  () => ({ WorkspaceIteratorService: class {} }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/engine/core-modules/upgrade/services/upgrade-migration.service',
  () => ({ UpgradeMigrationService: class {} }),
);
jest.mock(
  'src/engine/core-modules/upgrade/services/upgrade-status.service',
  () => ({ UpgradeStatusService: class {} }),
);

class RepairCommand {}
RegisteredWorkspaceCommand('2.51.0', 1792675225627)(RepairCommand);
const workspaceId = randomUUID();
const actor = async (workspace: string = workspaceId) =>
  captureCurrentCrmAuditIdentity(workspace, async () => undefined);

describe('scoped historical account repair execution', () => {
  it('uses exact registered metadata and emits named scoped attribution', async () => {
    await withAccountScopeRepairExecution(
      new RepairCommand(),
      workspaceId,
      async () => {
        expect(await actor()).toMatchObject({
          workspaceId,
          actor: {
            kind: 'system',
            id: 'DeleteConnectedAccountsOutsideProviderScopeCommand',
          },
        });
        expect(consumeAccountScopeRepairExecution(workspaceId)).toBe(true);
      },
    );
    expect(consumeAccountScopeRepairExecution(workspaceId)).toBe(false);
    expect(await actor()).toBeUndefined();
  });
  it.each(['version', 'timestamp', 'unregistered'])(
    'does not grant authority for a different %s',
    async (kind) => {
      class OtherCommand {}
      if (kind !== 'unregistered')
        RegisteredWorkspaceCommand(
          kind === 'version' ? '2.52.0' : '2.51.0',
          kind === 'timestamp' ? 1 : 1792675225627,
        )(OtherCommand);
      await withAccountScopeRepairExecution(
        new OtherCommand(),
        workspaceId,
        async () => {
          expect(consumeAccountScopeRepairExecution(workspaceId)).toBe(false);
        },
      );
    },
  );
  it('rejects foreign workspace and repeated consumption from an inherited hook', async () => {
    await withAccountScopeRepairExecution(
      new RepairCommand(),
      workspaceId,
      async () => {
        expect(() => consumeAccountScopeRepairExecution(randomUUID())).toThrow(
          'unavailable',
        );
        expect(consumeAccountScopeRepairExecution(workspaceId)).toBe(true);
        await Promise.resolve();
        expect(() => consumeAccountScopeRepairExecution(workspaceId)).toThrow(
          'unavailable',
        );
      },
    );
  });
  it('masks an outer repair source while another command executes', async () => {
    await withAccountScopeRepairExecution(
      new RepairCommand(),
      workspaceId,
      async () => {
        await withAccountScopeRepairExecution({}, workspaceId, async () => {
          expect(consumeAccountScopeRepairExecution(workspaceId)).toBe(false);
        });
        expect(consumeAccountScopeRepairExecution(workspaceId)).toBe(true);
      },
    );
  });
  it('isolates simultaneous workspaces', async () => {
    const ids = [randomUUID(), randomUUID()];
    await Promise.all(
      ids.map((id) =>
        withAccountScopeRepairExecution(new RepairCommand(), id, async () => {
          await Promise.resolve();
          expect((await actor(id))?.workspaceId).toBe(id);
          expect(consumeAccountScopeRepairExecution(id)).toBe(true);
        }),
      ),
    );
  });
  it('revokes source from detached asynchronous work when execution ends', async () => {
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let detached!: Promise<void>;
    await withAccountScopeRepairExecution(
      new RepairCommand(),
      workspaceId,
      async () => {
        detached = (async () => {
          await wait;
          expect(() => consumeAccountScopeRepairExecution(workspaceId)).toThrow(
            'unavailable',
          );
        })();
      },
    );
    resume();
    await detached;
  });
  it.each(['cli', 'upgrade'] as const)(
    'wraps the actual %s runner entry',
    async (entry) => {
      const work = jest.fn(async ({ workspaceId: id }: RunOnWorkspaceArgs) => {
        expect(consumeAccountScopeRepairExecution(id)).toBe(true);
        expect((await actor(id))?.actor.kind).toBe('system');
      });
      const iterator = {
        listenToShutdownSignals: jest.fn(),
        iterate: jest.fn(async ({ callback }) => {
          await callback({ workspaceId, index: 0, total: 1 });
          return {
            interrupted: false,
            fail: [],
            success: [{ workspaceId }],
            skipped: [],
          };
        }),
      };
      class ActualCommand extends WorkspaceCommandRunner {
        constructor() {
          super(
            iterator as ConstructorParameters<typeof WorkspaceCommandRunner>[0],
            [],
          );
        }
        async runOnWorkspace(args: RunOnWorkspaceArgs) {
          await work(args);
        }
      }
      RegisteredWorkspaceCommand('2.51.0', 1792675225627)(ActualCommand);
      const command = new ActualCommand();
      if (entry === 'cli') await command.run([], {});
      else {
        type Dependencies = ConstructorParameters<
          typeof WorkspaceCommandRunnerService
        >;
        const service = new WorkspaceCommandRunnerService(
          { get: () => '2.52.0' } as unknown as Dependencies[0],
          { recordUpgradeMigration: jest.fn() } as unknown as Dependencies[1],
          {
            invalidateInstanceAndAllWorkspacesStatus: jest.fn(),
          } as unknown as Dependencies[2],
        );
        await service.runWorkspaceCommands({
          iteratorContext: { workspaceId, index: 0, total: 1 } as Parameters<
            typeof service.runWorkspaceCommands
          >[0]['iteratorContext'],
          options: {} as Parameters<
            typeof service.runWorkspaceCommands
          >[0]['options'],
          workspaceCommands: [{ name: 'test-repair', command }],
        });
      }
      expect(work).toHaveBeenCalledTimes(1);
    },
  );
});
