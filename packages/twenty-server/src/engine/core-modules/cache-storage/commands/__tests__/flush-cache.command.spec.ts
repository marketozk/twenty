import { Logger } from '@nestjs/common';

import { FlushCacheCommand } from 'src/engine/core-modules/cache-storage/commands/flush-cache.command';
import { CacheStorageService } from 'src/engine/core-modules/cache-storage/services/cache-storage.service';

jest.mock(
  'src/engine/core-modules/cache-storage/services/cache-storage.service',
  () => ({
    CacheStorageService: class {
      async flushByPattern() {}
    },
  }),
);
jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({
    TwentyConfigService: jest.fn(),
  }),
);

describe('FlushCacheCommand strict startup gate', () => {
  let command: FlushCacheCommand;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    command = new FlushCacheCommand(
      {} as ConstructorParameters<typeof FlushCacheCommand>[0],
      { get: () => 'test:' } as unknown as ConstructorParameters<
        typeof FlushCacheCommand
      >[1],
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('retains best-effort behavior without the switch', async () => {
    jest
      .spyOn(CacheStorageService.prototype, 'flushByPattern')
      .mockRejectedValue(new Error('Redis unavailable'));
    await expect(command.run([])).resolves.toBeUndefined();
  });

  it('propagates the original cache error in strict mode', async () => {
    const failure = new Error('Redis unavailable');
    jest
      .spyOn(CacheStorageService.prototype, 'flushByPattern')
      .mockRejectedValue(failure);
    await expect(command.run([], { strict: true })).rejects.toBe(failure);
  });

  it('rejects an invalid namespace in strict mode', async () => {
    await expect(
      command.run([], { strict: true, namespace: 'invalid' }),
    ).rejects.toThrow('Invalid --namespace');
  });

  it('allows a successful strict flush', async () => {
    const flush = jest
      .spyOn(CacheStorageService.prototype, 'flushByPattern')
      .mockResolvedValue(undefined);
    await expect(
      command.run([], {
        strict: true,
        namespace: 'module:messaging',
        pattern: 'test:*',
      }),
    ).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledWith('test:*');
    expect(command.parseStrict()).toBe(true);
  });
});
