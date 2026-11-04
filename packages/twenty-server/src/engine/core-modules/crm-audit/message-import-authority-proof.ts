import { isConnectionHiddenFromRequestUser } from 'src/engine/core-modules/application/connection-provider/connections/utils/is-connection-hidden-from-request-user.util';
import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';
import { type MessageImportMatchingAuthority } from 'src/engine/core-modules/crm-audit/message-import-matching-context';
import { isConnectedAccountUsableByCaller } from 'src/engine/metadata-modules/connected-account/utils/is-connected-account-usable-by-caller.util';
import { findOmniOwnedMessageChannelIds } from 'src/modules/omnichannel/services/find-omni-owned-metadata-ids';
import { lockOrdinaryNativeSyncRun } from 'src/modules/omnichannel/services/lock-ordinary-native-sync-run';

type AuthorityProofScope = {
  workspaceId: string;
  executeRawQuery: (
    text: string,
    values?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

export const captureMessageImportAuthorityProof = async ({
  scope,
  operation,
  authority,
}: {
  scope: AuthorityProofScope;
  operation: CrmAuditOperation;
  authority: MessageImportMatchingAuthority;
}): Promise<
  { applied: false } | { applied: true; verify: () => Promise<void> }
> => {
  if (authority.workspaceId !== scope.workspaceId)
    throw new Error('Native message import workspace mismatch');
  if (
    authority.kind === 'provider' &&
    !(await lockOrdinaryNativeSyncRun(scope, authority.run))
  )
    return { applied: false };
  const read =
    (table: string, columns: string, id: string, workspaceScoped = false) =>
    async (lock = false) => {
      const rows = await scope.executeRawQuery(
        `SELECT ${columns} FROM core.${quote(table)} WHERE id=$1${workspaceScoped ? ' AND "workspaceId"=$2' : ''}${lock ? ' FOR SHARE' : ''}`,
        workspaceScoped ? [id, scope.workspaceId] : [id],
      );
      return rows[0];
    };
  const proofs: {
    read: (lock?: boolean) => Promise<Record<string, unknown> | undefined>;
    before: Record<string, unknown>;
  }[] = [];
  const capture = async (
    reader: (lock?: boolean) => Promise<Record<string, unknown> | undefined>,
  ) => {
    const before = await reader(true);
    if (!before) throw new Error('Native message import authority changed');
    proofs.push({ read: reader, before });
    return before;
  };
  const sentAuthority =
    authority.kind === 'sent' || authority.kind === 'sent-tool'
      ? authority
      : undefined;
  if (sentAuthority?.effectiveUserId) {
    const user = await capture(
      read('user', 'id,"deletedAt",disabled', sentAuthority.effectiveUserId),
    );
    if (user.deletedAt !== null || user.disabled !== false)
      throw new Error('Native message import caller unavailable');
  }
  const memberId = sentAuthority
    ? sentAuthority.userWorkspaceId
    : authority.kind === 'application'
      ? authority.requestUserWorkspaceId
      : null;
  if (memberId) {
    const member = await capture(
      read(
        'userWorkspace',
        'id,"workspaceId","userId","deletedAt"',
        memberId,
        true,
      ),
    );
    if (
      member.deletedAt !== null ||
      (sentAuthority?.effectiveUserId &&
        member.userId !== sentAuthority.effectiveUserId)
    )
      throw new Error('Native message import caller unavailable');
  }
  const attributedApplicationId =
    operation.actor.kind === 'application'
      ? operation.actor.id
      : operation.actor.kind === 'agent' &&
          operation.initiator?.kind === 'application'
        ? operation.initiator.id
        : undefined;
  let applicationId =
    authority.kind === 'application' || authority.kind === 'sent-tool'
      ? authority.applicationId
      : attributedApplicationId;
  if (
    applicationId !== undefined &&
    attributedApplicationId !== undefined &&
    applicationId !== attributedApplicationId
  )
    throw new Error('Native message import application attribution changed');
  const readAgent =
    operation.actor.kind === 'agent'
      ? read(
          'agent',
          'id,"workspaceId","applicationId","deletedAt"',
          operation.actor.id,
          true,
        )
      : undefined;
  if (readAgent) {
    const agent = await readAgent();
    if (
      !agent ||
      typeof agent.applicationId !== 'string' ||
      (applicationId !== undefined && agent.applicationId !== applicationId)
    )
      throw new Error('Native message import agent application changed');
    applicationId = agent.applicationId;
  }
  if (applicationId) {
    const application = await capture(
      read('application', 'id,"workspaceId","deletedAt"', applicationId, true),
    );
    if (application.deletedAt !== null)
      throw new Error('Native message import application unavailable');
  }
  if (readAgent) {
    const agent = await capture(readAgent);
    if (agent.deletedAt !== null || agent.applicationId !== applicationId)
      throw new Error('Native message import agent application changed');
  }
  const account = await capture(
    read(
      'connectedAccount',
      'id,"workspaceId",scope,"userWorkspaceId",provider,"applicationId","connectionProviderId","archivedAt"::text AS "archivedAt"',
      authority.connectedAccountId,
      true,
    ),
  );
  if (sentAuthority && account.archivedAt !== null)
    throw new Error('Native message import account archived');
  const channel = await capture(
    read(
      'messageChannel',
      'id,"workspaceId","connectedAccountId",type,handle,"isSyncEnabled","syncStage","syncStageStartedAt"::text AS "syncStageStartedAt"',
      authority.channelId,
      true,
    ),
  );
  if (
    channel.connectedAccountId !== account.id ||
    channel.type !== authority.channelType ||
    !['USER', 'WORKSPACE'].includes(String(account.scope))
  )
    throw new Error('Native message import channel changed');
  if (
    authority.kind === 'inbound' &&
    (channel.type !== 'EMAIL_GROUP' || channel.handle !== authority.recipient)
  )
    throw new Error('Native message import inbound channel changed');
  if (
    authority.kind === 'sent' &&
    !isConnectedAccountUsableByCaller({
      connectedAccount: {
        scope: account.scope as 'USER' | 'WORKSPACE',
        userWorkspaceId: String(account.userWorkspaceId),
      },
      userWorkspaceId: authority.userWorkspaceId,
    })
  )
    throw new Error('Native message import account unavailable');
  if (
    authority.kind === 'application' &&
    (account.provider !== 'app' ||
      account.applicationId !== authority.applicationId ||
      channel.type !== 'APP' ||
      channel.isSyncEnabled !== true ||
      isConnectionHiddenFromRequestUser({
        account: {
          scope: String(account.scope),
          userWorkspaceId: String(account.userWorkspaceId),
        },
        requestUserWorkspaceId: authority.requestUserWorkspaceId,
      }))
  )
    throw new Error('Native message import application channel unavailable');
  const verify = async () => {
    for (const proof of proofs) {
      const current = await proof.read();
      if (
        !current ||
        canonicalAuditJson(current) !== canonicalAuditJson(proof.before)
      )
        throw new Error('Native message import authority changed');
    }
    const owned = await findOmniOwnedMessageChannelIds(
      scope,
      scope.workspaceId,
      [authority.channelId],
    );
    if (owned.size)
      throw new Error('Native message import channel ownership changed');
  };
  await verify();
  return { applied: true, verify };
};
