import { Logger } from '@nestjs/common';
import { UpgradeHealthEnum } from 'twenty-shared/types';

import { UpgradeStatusCommand } from 'src/engine/core-modules/upgrade/commands/upgrade-status.command';

jest.mock(
  'src/engine/core-modules/upgrade/services/upgrade-status.service',
  () => ({
    UpgradeStatusService: jest.fn(),
  }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({
    TwentyConfigService: jest.fn(),
  }),
);

describe('UpgradeStatusCommand strict startup gate', () => {
  const getInstanceStatus = jest.fn();
  const getWorkspaceStatuses = jest.fn();
  let command: UpgradeStatusCommand;
  const status = (health: UpgradeHealthEnum) => ({
    health,
    latestCommand: null,
    inferredVersion: null,
  });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    getInstanceStatus
      .mockReset()
      .mockResolvedValue(status(UpgradeHealthEnum.UP_TO_DATE));
    getWorkspaceStatuses.mockReset().mockResolvedValue([]);
    command = new UpgradeStatusCommand(
      {
        getInstanceStatus,
        getWorkspaceStatuses,
      } as unknown as ConstructorParameters<typeof UpgradeStatusCommand>[0],
      { get: () => '2.52' } as unknown as ConstructorParameters<
        typeof UpgradeStatusCommand
      >[1],
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([UpgradeHealthEnum.BEHIND, UpgradeHealthEnum.FAILED])(
    'rejects an instance with health %s',
    async (health) => {
      getInstanceStatus.mockResolvedValue(status(health));
      await expect(command.run([], { strict: true })).rejects.toThrow(
        'not up to date',
      );
    },
  );

  it.each([UpgradeHealthEnum.BEHIND, UpgradeHealthEnum.FAILED])(
    'rejects a workspace with health %s',
    async (health) => {
      getWorkspaceStatuses.mockResolvedValue([
        {
          ...status(health),
          workspaceId: 'test-workspace',
          displayName: 'Test',
        },
      ]);
      await expect(command.run([], { strict: true })).rejects.toThrow(
        'not up to date',
      );
    },
  );

  it('does not turn display-only failed status into a default command failure', async () => {
    getInstanceStatus.mockResolvedValue(status(UpgradeHealthEnum.FAILED));
    await expect(command.run([], {})).resolves.toBeUndefined();
  });

  it('propagates status read errors only in strict mode', async () => {
    const failure = new Error('database unavailable');
    getWorkspaceStatuses.mockRejectedValue(failure);
    await expect(command.run([], {})).resolves.toBeUndefined();
    await expect(command.run([], { strict: true })).rejects.toBe(failure);
  });

  it('allows an up-to-date instance with no provisioned workspaces', async () => {
    await expect(command.run([], { strict: true })).resolves.toBeUndefined();
    expect(getWorkspaceStatuses).toHaveBeenCalledWith(undefined);
    expect(command.parseStrict()).toBe(true);
  });
});
