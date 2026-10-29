import { DataSource } from 'typeorm';
import {
  CoreAuditPostCommitError,
  runInCoreAuditTransaction,
} from 'src/engine/core-modules/crm-audit/run-in-core-audit-transaction';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BullMQDriver } from 'src/engine/core-modules/message-queue/drivers/bullmq.driver';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import {
  isTransactionOutcomeUnknown,
  isTransactionUnsafeToRetry,
} from 'src/engine/twenty-orm/error-handling/is-transaction-outcome-unknown';
import { NativeTransactionOutcomeUnknownError } from 'src/engine/twenty-orm/error-handling/native-transaction-outcome-unknown.error';
import { OmniCoreTransactionOutcomeUnknownError } from 'src/modules/omnichannel/services/omni-core-transaction';
import { isApplicationTransactionOutcomeUnknown } from 'src/engine/core-modules/application/utils/is-application-transaction-outcome-unknown';

jest.mock(
  'src/engine/core-modules/twenty-config/twenty-config.service',
  () => ({ TwentyConfigService: class {} }),
);
jest.mock(
  'src/engine/core-modules/message-queue/services/event-loop-stall-monitor.service',
  () => ({ EventLoopStallMonitorService: class {} }),
);
import { MessageQueueExplorer } from 'src/engine/core-modules/message-queue/message-queue.explorer';

const errorFor = (kind: string) =>
  kind === 'committed'
    ? new CoreAuditPostCommitError(new Error('fixture post-commit failure'))
    : kind === 'native'
      ? new NativeTransactionOutcomeUnknownError(
          'commit',
          new Error('fixture lost ACK'),
        )
      : new OmniCoreTransactionOutcomeUnknownError(
          new Error('fixture lost ACK'),
        );
const explorer = (report: jest.Mock) =>
  Object.assign(Object.create(MessageQueueExplorer.prototype), {
    exceptionHandlerService: { captureExceptions: report },
    logger: { warn: jest.fn() },
  });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async <T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> => {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(20);
  }
  throw new Error('Isolated queue did not reach the expected state');
};
beforeEach(() => {
  jest.restoreAllMocks();
  for (const method of ['log', 'warn', 'error'] as const)
    jest.spyOn(Logger.prototype, method).mockImplementation(() => {});
});

it('shares one classifier and never treats a matching message/name as proof of unknown outcome', () => {
  expect(isApplicationTransactionOutcomeUnknown).toBe(
    isTransactionOutcomeUnknown,
  );
  expect(isTransactionOutcomeUnknown(errorFor('native'))).toBe(true);
  expect(isTransactionOutcomeUnknown(errorFor('omni'))).toBe(true);
  expect(isTransactionOutcomeUnknown(errorFor('committed'))).toBe(false);
  expect(isTransactionUnsafeToRetry(errorFor('committed'))).toBe(true);
  expect(isTransactionUnsafeToRetry({ commitConfirmed: true })).toBe(false);
  expect(
    isTransactionOutcomeUnknown(
      new Error('OMNI_CORE_TRANSACTION_OUTCOME_UNKNOWN'),
    ),
  ).toBe(false);
  expect(
    isTransactionOutcomeUnknown({
      name: 'NativeTransactionOutcomeUnknownError',
    }),
  ).toBe(false);
});

it.each(['native', 'omni', 'committed'])(
  'explorer preserves the same %s error if reporting throws',
  async (kind) => {
    const error = errorFor(kind),
      report = jest.fn(() => {
        throw new Error('reporter failed');
      }),
      e = explorer(report);
    await expect(
      e.invokeProcessMethods(
        {
          handle: async () => {
            throw error;
          },
        },
        ['handle'],
        { data: {} },
      ),
    ).rejects.toBe(error);
    expect(report).toHaveBeenCalledWith([error]);
    expect(e.logger.warn).toHaveBeenCalledTimes(1);
  },
);

it('ordinary explorer failure retains the existing reporting behavior', async () => {
  const original = new Error('ordinary failure'),
    report = jest.fn().mockReturnValue([]),
    e = explorer(report);
  await expect(
    e.invokeProcessMethods(
      {
        handle: async () => {
          throw original;
        },
      },
      ['handle'],
      { data: {} },
    ),
  ).rejects.toBe(original);
  expect(report).toHaveBeenCalledWith([original]);
  expect(e.logger.warn).not.toHaveBeenCalled();
});

const setup = async () => {
  const url = process.env.FORK_MIGRATION_TEST_REDIS_URL;
  if (!url)
    throw new Error(
      'FORK_MIGRATION_TEST_REDIS_URL required for isolated queue test',
    );
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const prefix = 'log126-' + randomUUID();
  const options = { connection, prefix };
  const metrics = {
    recordHistogram: jest.fn(),
    incrementCounterForEvent: jest.fn().mockResolvedValue(undefined),
  };
  const newDriver = () =>
    new BullMQDriver(
      options,
      metrics as never,
      {} as never,
      new EventEmitter2(),
    );
  const driver = newDriver();
  driver.register(MessageQueue.applicationUpgradeQueue);
  const queue = new Queue(MessageQueue.applicationUpgradeQueue, options);
  return { driver, queue, newDriver, connection };
};

it('a real PG commit followed by a failing hook persists once through the Redis worker', async () => {
  const f = await setup();
  const db = new DataSource({
    type: 'postgres',
    url: process.env.FORK_MIGRATION_TEST_URL,
  });
  await db.initialize();
  const table = 'log126_' + randomUUID().replaceAll('-', '');
  const calls = jest.fn();
  const hook = {
    afterTransactionCommit() {
      throw new Error('fixture hook failure');
    },
  };
  try {
    await db.query('CREATE TABLE public."' + table + '" (id int PRIMARY KEY)');
    db.subscribers.push(hook);
    f.driver.work(MessageQueue.applicationUpgradeQueue, async () => {
      calls();
      await runInCoreAuditTransaction(db, async (runner) => {
        await runner.query('INSERT INTO public."' + table + '" VALUES(1)');
      });
    });
    const id = await f.driver.add(
      MessageQueue.applicationUpgradeQueue,
      'committed-fixture',
      {},
      {
        retryLimit: 2,
        backoff: { strategy: 'fixed', initialDelayMilliseconds: 20 },
      },
    );
    const job = await f.queue.getJob(id!);
    await until(
      () => job!.getState(),
      (state) => state === 'failed',
    );
    await delay(100);
    const stored = await f.queue.getJob(id!);
    expect(stored?.attemptsMade).toBe(1);
    expect(stored?.failedReason).toBe(
      new CoreAuditPostCommitError(undefined).message,
    );
    expect(calls).toHaveBeenCalledTimes(1);
    expect(await db.query('SELECT * FROM public."' + table + '"')).toEqual([
      { id: 1 },
    ]);
  } finally {
    await f.driver.onModuleDestroy();
    db.subscribers.splice(db.subscribers.indexOf(hook), 1);
    await db.query('DROP TABLE IF EXISTS public."' + table + '"');
    await db.destroy();
    await f.queue.obliterate({ force: true });
    await f.queue.close();
    await f.connection.quit();
  }
});

it.each(['native', 'omni', 'committed'])(
  'Redis persists %s unknown as failed once despite retries and worker restart',
  async (kind) => {
    const f = await setup(),
      error = errorFor(kind),
      attempts = jest.fn(),
      report = jest.fn(() => {
        throw new Error('reporter failed');
      }),
      e = explorer(report);
    let restarted: BullMQDriver | undefined;
    try {
      f.driver.work(MessageQueue.applicationUpgradeQueue, async (job) => {
        attempts();
        await e.invokeProcessMethods(
          {
            handle: async () => {
              throw error;
            },
          },
          ['handle'],
          job,
        );
      });
      const id = await f.driver.add(
        MessageQueue.applicationUpgradeQueue,
        'unknown-fixture',
        {},
        {
          retryLimit: 2,
          backoff: { strategy: 'fixed', initialDelayMilliseconds: 20 },
        },
      );
      const job = await f.queue.getJob(id!);
      expect(job).toBeDefined();
      await until(
        () => job!.getState(),
        (state) => state === 'failed',
      );
      await delay(100);
      const stored = await f.queue.getJob(id!);
      expect(attempts).toHaveBeenCalledTimes(1);
      expect(stored?.attemptsMade).toBe(1);
      expect(stored?.failedReason).toBe(error.message);
      expect(stored?.opts.attempts).toBe(3);
      expect(
        await f.queue.getJobCounts('waiting', 'delayed', 'active'),
      ).toMatchObject({ waiting: 0, delayed: 0, active: 0 });
      await f.driver.onModuleDestroy();
      restarted = f.newDriver();
      restarted.register(MessageQueue.applicationUpgradeQueue);
      restarted.work(MessageQueue.applicationUpgradeQueue, async () => {
        attempts();
      });
      // A later healthy job proves the replacement worker is processing this queue.
      const marker = await restarted.add(
        MessageQueue.applicationUpgradeQueue,
        'healthy-marker',
        {},
      );
      const markerJob = await f.queue.getJob(marker!);
      await until(
        () => markerJob!.getState(),
        (state) => state === 'completed',
      );
      expect(await stored!.getState()).toBe('failed');
      expect(attempts).toHaveBeenCalledTimes(2);
    } finally {
      if (restarted) await restarted.onModuleDestroy();
      else await f.driver.onModuleDestroy();
      await f.queue.obliterate({ force: true });
      await f.queue.close();
      await f.connection.quit();
    }
  },
);

it('Redis still retries a known failure and then records success', async () => {
  const f = await setup(),
    attempts = jest.fn();
  try {
    f.driver.work(MessageQueue.applicationUpgradeQueue, async () => {
      attempts();
      if (attempts.mock.calls.length === 1)
        throw new Error('retryable fixture');
    });
    const id = await f.driver.add(
      MessageQueue.applicationUpgradeQueue,
      'ordinary-fixture',
      {},
      {
        retryLimit: 2,
        backoff: { strategy: 'fixed', initialDelayMilliseconds: 20 },
      },
    );
    const job = await f.queue.getJob(id!);
    await until(
      () => job!.getState(),
      (state) => state === 'completed',
    );
    const stored = await f.queue.getJob(id!);
    expect(attempts).toHaveBeenCalledTimes(2);
    expect(stored?.attemptsMade).toBe(2);
  } finally {
    await f.driver.onModuleDestroy();
    await f.queue.obliterate({ force: true });
    await f.queue.close();
    await f.connection.quit();
  }
});
