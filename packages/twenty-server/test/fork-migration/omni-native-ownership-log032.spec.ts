import { randomUUID } from 'node:crypto';

import { QUERY_MAX_RECORDS } from 'twenty-shared/constants';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import {
  findOmniOwnedMessageIds,
  findOmniOwnedMessageThreadIds,
} from 'src/modules/omnichannel/services/find-omni-owned-native-record-ids';

describe.each([
  ['messages', findOmniOwnedMessageIds],
  ['threads', findOmniOwnedMessageThreadIds],
] as const)(
  'persisted native ownership query boundary for %s',
  (_kind, findOwned) => {
    it.each([
      '00000000-0000-0000-0000-000000000000',
      '00000000-0000-4000-8000-000000000001',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      'ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF',
      ...Array.from({ length: 8 }, () => randomUUID()),
    ])(
      'uses the same quoted native workspace schema as Twenty for %s',
      async (workspaceId) => {
        const executeRawQuery = jest.fn().mockResolvedValue([]);
        await findOwned({ executeRawQuery }, workspaceId, [randomUUID()]);
        expect(executeRawQuery.mock.calls[0][0]).toContain(
          `"${getWorkspaceSchemaName(workspaceId)}".`,
        );
      },
    );

    it('uses a deduplicated immutable candidate snapshot across asynchronous query batches', async () => {
      const workspaceId = randomUUID();
      const candidates: string[] = Array.from({ length: QUERY_MAX_RECORDS + 1 }, () =>
        randomUUID(),
      );
      const original = [...candidates];
      candidates.push(original[0].toUpperCase());
      const executeRawQuery = jest.fn(
        async (
          _sql: string,
          parameters?: unknown[],
        ): Promise<Record<string, unknown>[]> => {
          expect(parameters?.[0]).toBe(workspaceId);
          const ids = parameters?.[1];
          if (!Array.isArray(ids)) throw new Error('Expected candidate IDs');
          expect(ids.length).toBeLessThanOrEqual(QUERY_MAX_RECORDS);
          await Promise.resolve();
          candidates.splice(0, candidates.length, randomUUID());
          return ids.map((id) => ({ id }));
        },
      );

      expect(
        await findOwned({ executeRawQuery }, workspaceId, candidates),
      ).toEqual(new Set(original));
      expect(executeRawQuery).toHaveBeenCalledTimes(2);
      expect(executeRawQuery.mock.calls[0][1]?.[1]).toEqual(
        original.slice(0, QUERY_MAX_RECORDS),
      );
      expect(executeRawQuery.mock.calls[1][1]?.[1]).toEqual(
        original.slice(QUERY_MAX_RECORDS),
      );
    });

    it('does not query an empty candidate set', async () => {
      const executeRawQuery = jest.fn();
      expect(await findOwned({ executeRawQuery }, randomUUID(), [])).toEqual(
        new Set(),
      );
      expect(executeRawQuery).not.toHaveBeenCalled();
    });

    it.each(['not-a-uuid', 'x"; DROP SCHEMA core;--'])(
      'refuses invalid workspace identifiers before schema interpolation: %s',
      async (workspaceId) => {
        const executeRawQuery = jest.fn();
        await expect(
          findOwned({ executeRawQuery }, workspaceId, [randomUUID()]),
        ).rejects.toThrow('OMNI_INVALID_NATIVE_OWNERSHIP_SCOPE');
        expect(executeRawQuery).not.toHaveBeenCalled();
      },
    );

    it('rejects malformed candidate IDs before executing SQL', async () => {
      const executeRawQuery = jest.fn();
      await expect(
        findOwned({ executeRawQuery }, randomUUID(), ['invalid-message-id']),
      ).rejects.toThrow('OMNI_INVALID_NATIVE_OWNERSHIP_SCOPE');
      expect(executeRawQuery).not.toHaveBeenCalled();
    });

    it.each(
      [
        undefined,
        null,
        {},
        [null],
        [{ id: null }],
        [{ id: 'not-requested' }],
      ].map((result) => [result]),
    )(
      'rejects an invalid ownership result instead of silently preserving a writer: %#',
      async (result) => {
        const executeRawQuery = jest.fn().mockResolvedValue(result);
        await expect(
          findOwned({ executeRawQuery }, randomUUID(), [randomUUID()]),
        ).rejects.toThrow('OMNI_INVALID_NATIVE_OWNERSHIP_RESULT');
      },
    );

    it('does not treat a query failure as absence of ownership', async () => {
      const failure = new Error('fixture ownership lookup unavailable');
      const executeRawQuery = jest.fn().mockRejectedValue(failure);
      await expect(
        findOwned({ executeRawQuery }, randomUUID(), [randomUUID()]),
      ).rejects.toBe(failure);
    });

    it('returns only the requested owned subset', async () => {
      const owned = randomUUID();
      const ordinary = randomUUID();
      const executeRawQuery = jest.fn().mockResolvedValue([{ id: owned }]);
      expect(
        await findOwned({ executeRawQuery }, randomUUID(), [ordinary, owned]),
      ).toEqual(new Set([owned]));
    });
  },
);
