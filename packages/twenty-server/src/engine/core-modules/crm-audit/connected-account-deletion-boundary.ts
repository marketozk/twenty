import { isUUID } from 'class-validator';
import { type QueryRunner } from 'typeorm';

export type AccountDeletionPermissionRecord = Readonly<{
  id: string;
  userWorkspaceId: string;
  scope: 'USER' | 'WORKSPACE';
  provider: string;
}>;
type AdministrativeBoundary = {
  userWorkspaceId: string;
  applicationId?: string;
  authorize: (account: AccountDeletionPermissionRecord) => Promise<boolean>;
} & (
  | { kind: 'administration' }
  | {
      kind: 'emailGroup';
      channelId: string;
      accountId: string;
      expectedHandle: string;
    }
);
export type ConnectedAccountDeletionBoundary =
  | AdministrativeBoundary
  | {
      kind: 'manifest';
      applicationId: string;
      connectionProviderIds: readonly string[];
    }
  | {
      kind: 'providerScopeRepair';
      providerIdsByAccount: Readonly<Record<string, string>>;
    };

type Row = Record<string, unknown> & { id: string };
const normalizedId = (id: string) => {
  if (!isUUID(id))
    throw new Error('Invalid connected account deletion boundary');
  return id.toLowerCase();
};

export const captureAccountDeletionBoundary = (
  boundary: ConnectedAccountDeletionBoundary,
): ConnectedAccountDeletionBoundary => {
  switch (boundary?.kind) {
    case 'administration':
    case 'emailGroup': {
      if (typeof boundary.authorize !== 'function')
        throw new Error('Connected account deletion requires authorization');
      if (
        boundary.kind === 'emailGroup' &&
        typeof boundary.expectedHandle !== 'string'
      )
        throw new Error('Email group deletion requires a captured handle');
      return Object.freeze({
        kind: boundary.kind,
        userWorkspaceId: normalizedId(boundary.userWorkspaceId),
        ...(boundary.applicationId
          ? { applicationId: normalizedId(boundary.applicationId) }
          : {}),
        authorize: boundary.authorize,
        ...(boundary.kind === 'emailGroup'
          ? {
              channelId: normalizedId(boundary.channelId),
              accountId: normalizedId(boundary.accountId),
              expectedHandle: boundary.expectedHandle,
            }
          : {}),
      }) as AdministrativeBoundary;
    }
    case 'manifest':
      return Object.freeze({
        kind: boundary.kind,
        applicationId: normalizedId(boundary.applicationId),
        connectionProviderIds: Object.freeze(
          [...new Set(boundary.connectionProviderIds.map(normalizedId))].sort(),
        ),
      });
    case 'providerScopeRepair': {
      const captured: Record<string, string> = {};
      for (const [id, providerId] of Object.entries(
        boundary.providerIdsByAccount,
      )) {
        const accountId = normalizedId(id);
        if (
          captured[accountId] &&
          captured[accountId] !== normalizedId(providerId)
        )
          throw new Error('Ambiguous deletion provider scope');
        captured[accountId] = normalizedId(providerId);
      }
      return Object.freeze({
        kind: boundary.kind,
        providerIdsByAccount: Object.freeze(captured),
      });
    }
    default:
      throw new Error('Connected account deletion boundary unavailable');
  }
};

// Locks prerequisites before accounts; the owner keeps these snapshots through audit.
export const prepareAccountDeletionBoundary = async (
  runner: QueryRunner,
  workspaceId: string,
  boundary: ConnectedAccountDeletionBoundary,
) => {
  const administrative =
    boundary.kind === 'administration' || boundary.kind === 'emailGroup';
  const table = administrative ? 'userWorkspace' : 'connectionProvider';
  const ids = administrative
    ? [boundary.userWorkspaceId]
    : boundary.kind === 'manifest'
      ? [...boundary.connectionProviderIds]
      : [...new Set(Object.values(boundary.providerIdsByAccount))].sort();
  const read = (lock: boolean): Promise<{ snapshot: string }[]> =>
    runner.query(
      'SELECT to_jsonb(record)::text AS snapshot FROM core."' +
        table +
        '" record WHERE id=ANY($1::uuid[]) ORDER BY id' +
        (lock ? ' FOR SHARE' : ''),
      [ids],
    );
  const snapshots = await read(true);
  const rows: Row[] = snapshots.map(({ snapshot }) => JSON.parse(snapshot));
  if (
    rows.length !== ids.length ||
    rows.some(
      (row) =>
        row.workspaceId !== workspaceId ||
        (administrative && row.deletedAt !== null) ||
        (boundary.kind === 'manifest' &&
          row.applicationId !== boundary.applicationId),
    )
  )
    throw new Error('Connected account deletion prerequisites changed');
  const providers = new Map(rows.map((row) => [row.id, row]));
  return {
    verify: async () => {
      if (JSON.stringify(await read(false)) !== JSON.stringify(snapshots))
        throw new Error(
          'Connected account deletion prerequisites changed before commit',
        );
    },
    authorize: async (accounts: readonly Row[], channels: readonly Row[]) => {
      if (boundary.kind === 'emailGroup') {
        const channel = channels.find((row) => row.id === boundary.channelId);
        if (
          accounts.length !== 1 ||
          accounts[0].id !== boundary.accountId ||
          accounts[0].handle !== boundary.expectedHandle ||
          !channel ||
          channel.connectedAccountId !== boundary.accountId ||
          channel.type !== 'EMAIL_GROUP'
        )
          throw new Error('Email group deletion target changed');
      }
      for (const account of accounts) {
        if (
          boundary.kind === 'administration' ||
          boundary.kind === 'emailGroup'
        ) {
          if (
            typeof account.userWorkspaceId !== 'string' ||
            !isUUID(account.userWorkspaceId) ||
            !['USER', 'WORKSPACE'].includes(account.scope as string) ||
            typeof account.provider !== 'string'
          )
            throw new Error('Invalid connected account permission record');
          const safe = Object.freeze({
            id: account.id,
            userWorkspaceId: account.userWorkspaceId as string,
            scope: account.scope as 'USER' | 'WORKSPACE',
            provider: account.provider,
          });
          if (!(await boundary.authorize(safe)))
            throw new Error('Connected account deletion permission denied');
        } else {
          const provider = providers.get(
            account.connectionProviderId as string,
          );
          if (
            !provider ||
            (boundary.kind === 'providerScopeRepair' &&
              (boundary.providerIdsByAccount[account.id] !== provider.id ||
                account.scope == null ||
                provider.scope == null ||
                account.scope === provider.scope))
          )
            throw new Error(
              'Connected account deletion provider selection changed',
            );
        }
      }
    },
  };
};
