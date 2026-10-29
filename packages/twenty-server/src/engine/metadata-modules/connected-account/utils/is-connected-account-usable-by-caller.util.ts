import { type ConnectedAccountScope } from 'src/engine/metadata-modules/connected-account/types/connected-account-scope';

export const isConnectedAccountUsableByCaller = ({
  connectedAccount,
  userWorkspaceId,
}: {
  connectedAccount: { scope: ConnectedAccountScope; userWorkspaceId: string };
  userWorkspaceId: string;
}): boolean =>
  connectedAccount.scope === 'WORKSPACE' ||
  connectedAccount.userWorkspaceId === userWorkspaceId;
