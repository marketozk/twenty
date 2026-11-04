// Background executions carry no request user, so nothing is hidden from them.
export const isConnectionHiddenFromRequestUser = ({
  account,
  requestUserWorkspaceId,
}: {
  account: { scope: string; userWorkspaceId: string };
  requestUserWorkspaceId: string | null;
}): boolean =>
  requestUserWorkspaceId !== null &&
  requestUserWorkspaceId !== undefined &&
  account.scope === 'USER' &&
  account.userWorkspaceId !== requestUserWorkspaceId;
