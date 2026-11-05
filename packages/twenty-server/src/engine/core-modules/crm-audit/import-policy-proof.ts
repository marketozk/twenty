import { isNonEmptyArray, isNonEmptyString } from '@sniptt/guards';
import { isUUID } from 'class-validator';
import psl, { type ParsedDomain } from 'psl';
import {
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER,
} from 'twenty-shared/application-runtime';

import { canonicalAuditJson } from 'src/engine/core-modules/crm-audit/crm-audit-canonical-json';
import {
  readNativeCrmAuditRows,
  type NativeCrmAuditTableShape,
} from 'src/engine/core-modules/crm-audit/native-crm-audit-record';
import { getIssuedNativeCleanupMetadata } from 'src/engine/twenty-orm/repository/omni-native-write-capability';
import { getIncomingRecordForeignKeys } from 'src/engine/twenty-orm/utils/has-referencing-records';
import { isEmailBlocklisted } from 'src/modules/blocklist/utils/is-email-blocklisted.util';
import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import { AUTO_GENERATED_BODY_MARKER } from 'src/modules/messaging/message-import-manager/constants/auto-generated-body-marker.constant';
import { UNSUBSCRIBE_COMMAND_SUBJECT } from 'src/modules/messaging/message-import-manager/constants/unsubscribe-command-subject.constant';
import { UNSUBSCRIBE_KEYWORD_PATTERN } from 'src/modules/messaging/message-import-manager/constants/unsubscribe-keyword-pattern.constant';
import { UPSTREAM_SPAM_VERDICT_HEADERS } from 'src/modules/messaging/message-import-manager/constants/upstream-spam-verdict-headers.constant';
import { isGroupEmail } from 'src/modules/messaging/message-import-manager/utils/is-group-email';
import { getDomainFromEmail } from 'src/utils/get-domain-from-email';
import { isWorkEmail } from 'src/utils/is-work-email';

type PolicyProofScope = {
  workspaceId: string;
  executeRawQuery: (
    text: string,
    values?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

export type PolicyCandidateMessage = {
  subject?: string | null;
  text?: string | null;
  direction?: string | null;
  attachments?: { filename: string }[];
  messageHeaders?: { name: string; value: string }[];
  participants?: {
    role: string;
    handle?: string | null;
  }[];
};

const BULK_LIST_HEADER_NAMES = ['list-unsubscribe', 'list-id'];
const BULK_PRECEDENCE_VALUES = ['bulk', 'list', 'junk'];
const RECIPIENT_ROLES = ['to', 'cc', 'bcc'];

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const tableSql = (shape: NativeCrmAuditTableShape) =>
  `${quote(shape.schemaName)}.${quote(shape.tableName)}`;

const decodeSnapshot = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key === 'id' ? value : JSON.parse(String(value)),
    ]),
  );

const isBulkMailHeaders = (
  headers: readonly { name: string; value: string }[],
): boolean =>
  headers.some(({ name, value }) => {
    const headerName = name.toLowerCase();
    const headerValue = value.trim().toLowerCase();

    if (BULK_LIST_HEADER_NAMES.includes(headerName)) {
      return isNonEmptyString(headerValue);
    }

    if (headerName === 'precedence') {
      return BULK_PRECEDENCE_VALUES.includes(headerValue);
    }

    if (headerName === 'auto-submitted') {
      return isNonEmptyString(headerValue) && headerValue !== 'no';
    }

    return false;
  });

const isUpstreamSpamHeaders = (
  headers: readonly { name: string; value: string }[],
): boolean =>
  Object.entries(UPSTREAM_SPAM_VERDICT_HEADERS).some(
    ([headerName, spamVerdicts]) => {
      const topmostHeader = headers.find(
        ({ name }) => name.toLowerCase() === headerName,
      );

      if (!topmostHeader) {
        return false;
      }

      return topmostHeader.value
        .split(';')
        .some((token) => spamVerdicts.includes(token.trim().toLowerCase()));
    },
  );

const isSenderMatchingHandles = (
  message: PolicyCandidateMessage,
  userHandles: readonly string[],
): boolean => {
  const senderHandle = message.participants
    ?.find((participant) => participant.role.toLowerCase() === 'from')
    ?.handle?.toLowerCase();

  if (!isNonEmptyString(senderHandle)) {
    return false;
  }

  return userHandles.some(
    (userHandle) =>
      isNonEmptyString(userHandle) && userHandle.toLowerCase() === senderHandle,
  );
};

const isExcludedGroupEmailCandidate = (
  message: PolicyCandidateMessage,
  userHandles: readonly string[],
): boolean => {
  if (isSenderMatchingHandles(message, userHandles)) {
    return false;
  }

  if (isBulkMailHeaders(message.messageHeaders ?? [])) {
    return true;
  }

  const senderHandle = message.participants?.find(
    (participant) => participant.role.toLowerCase() === 'from',
  )?.handle;

  if (!isNonEmptyString(senderHandle)) {
    return false;
  }

  return isGroupEmail(senderHandle);
};

const isUnsubscribeEmailCandidate = (email: string): boolean => {
  const normalizedEmail = email.toLowerCase();
  const atIndex = normalizedEmail.lastIndexOf('@');
  const localPart =
    atIndex === -1 ? normalizedEmail : normalizedEmail.slice(0, atIndex);

  if (UNSUBSCRIBE_KEYWORD_PATTERN.test(localPart)) {
    return true;
  }

  if (atIndex === -1) {
    return false;
  }

  const parsedDomain = psl.parse(normalizedEmail.slice(atIndex + 1));

  if (
    'error' in parsedDomain ||
    !Object.prototype.hasOwnProperty.call(parsedDomain, 'sld')
  ) {
    return false;
  }

  const subdomain = (parsedDomain as ParsedDomain).subdomain;

  return (
    isNonEmptyString(subdomain) &&
    subdomain
      .split('.')
      .some((label) => UNSUBSCRIBE_KEYWORD_PATTERN.test(label))
  );
};

const isUnsubscribeRequestCandidate = (
  ownHandlesLower: readonly string[],
  message: PolicyCandidateMessage,
): boolean => {
  if (!message.participants) {
    return false;
  }

  const counterpartyHandles = message.participants
    .map((participant) => participant.handle?.toLowerCase())
    .filter(isNonEmptyString)
    .filter((handle) => !ownHandlesLower.includes(handle));

  if (!isNonEmptyArray(counterpartyHandles)) {
    return false;
  }

  if (counterpartyHandles.every(isUnsubscribeEmailCandidate)) {
    return true;
  }

  const counterpartyRecipients = message.participants.filter(
    (participant) =>
      RECIPIENT_ROLES.includes(participant.role.toLowerCase()) &&
      isNonEmptyString(participant.handle) &&
      !ownHandlesLower.includes(participant.handle.toLowerCase()),
  );

  const counterpartyRecipientHandles = new Set(
    counterpartyRecipients
      .map((participant) => participant.handle?.toLowerCase())
      .filter(isNonEmptyString),
  );

  const messageText = message.text?.trim().toLowerCase() ?? '';

  const isAutomatedMessage =
    isBulkMailHeaders(message.messageHeaders ?? []) ||
    messageText === '' ||
    messageText === UNSUBSCRIBE_COMMAND_SUBJECT ||
    messageText.includes(AUTO_GENERATED_BODY_MARKER);

  return (
    message.direction === MessageDirection.OUTGOING &&
    counterpartyRecipientHandles.size === 1 &&
    isAutomatedMessage &&
    message.subject?.trim().toLowerCase() === UNSUBSCRIBE_COMMAND_SUBJECT
  );
};

const isInternalEmailCandidate = (
  primaryChannelHandle: string,
  message: PolicyCandidateMessage,
): boolean => {
  if (!message.participants || message.participants.length === 0) {
    return false;
  }

  try {
    const primaryDomain = getDomainFromEmail(primaryChannelHandle);

    return message.participants.every((participant) => {
      if (!isNonEmptyString(participant.handle)) {
        return false;
      }

      try {
        return getDomainFromEmail(participant.handle) === primaryDomain;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

export const captureLockedBlocklistPolicyProof = async ({
  scope,
  userWorkspaceId,
}: {
  scope: PolicyProofScope;
  userWorkspaceId: string | null | undefined;
}): Promise<{
  applicableBlocklistHandles: string[];
  verify: () => Promise<void>;
}> => {
  const context = getIssuedNativeCleanupMetadata(
    scope as Parameters<typeof getIssuedNativeCleanupMetadata>[0],
  );
  const findStandardShape = (
    name: 'blocklist' | 'workspaceMember',
  ): NativeCrmAuditTableShape | undefined => {
    const candidates = context.objects.filter(
      ({ metadata }) =>
        metadata.nameSingular === name &&
        metadata.universalIdentifier ===
          STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS[name] &&
        metadata.applicationUniversalIdentifier ===
          TWENTY_STANDARD_APPLICATION_UNIVERSAL_IDENTIFIER &&
        metadata.workspaceId === scope.workspaceId &&
        !metadata.isRemote,
    );
    if (candidates.length === 0) return undefined;
    if (candidates.length !== 1)
      throw new Error('Import blocklist policy metadata mismatch');
    const { metadata, shape } = candidates[0];
    if (
      shape.objectMetadataId !== metadata.id ||
      shape.nameSingular !== name ||
      shape.tableName !== name
    )
      throw new Error('Import blocklist policy table shape mismatch');
    return shape;
  };

  const blocklistShape = findStandardShape('blocklist');
  if (!blocklistShape) {
    return {
      applicableBlocklistHandles: [],
      verify: async () => undefined,
    };
  }
  const memberShape = findStandardShape('workspaceMember');
  if (memberShape && memberShape.schemaName !== blocklistShape.schemaName) {
    throw new Error('Import blocklist policy schema mismatch');
  }
  const [tableRegs] = await scope.executeRawQuery(
    `SELECT to_regclass($1)::text AS "blocklistReg", to_regclass($2)::text AS "memberReg", to_regclass('core."userWorkspace"')::text AS "userWorkspaceReg"`,
    [tableSql(blocklistShape), memberShape ? tableSql(memberShape) : null],
  );
  if (
    typeof tableRegs?.blocklistReg !== 'string' ||
    tableRegs.blocklistReg.length === 0
  ) {
    return {
      applicableBlocklistHandles: [],
      verify: async () => undefined,
    };
  }
  const hasMemberTable =
    Boolean(memberShape) &&
    typeof tableRegs?.memberReg === 'string' &&
    tableRegs.memberReg.length > 0;
  const hasUserWorkspaceTable =
    typeof tableRegs?.userWorkspaceReg === 'string' &&
    tableRegs.userWorkspaceReg.length > 0;
  if (hasMemberTable && memberShape) {
    const references = await getIncomingRecordForeignKeys(
      scope as Parameters<typeof getIncomingRecordForeignKeys>[0],
      memberShape.schemaName,
      'workspaceMember',
    );
    if (
      !references.some(
        (reference) =>
          reference.schemaName === blocklistShape.schemaName &&
          reference.tableName === 'blocklist' &&
          canonicalAuditJson(reference.parentColumns) === '["id"]' &&
          canonicalAuditJson(reference.childColumns) ===
            '["workspaceMemberId"]',
      )
    )
      throw new Error(
        'Import blocklist policy requires workspaceMember foreign key',
      );
  }

  const lockTables = [
    tableSql(blocklistShape),
    ...(hasMemberTable && memberShape ? [tableSql(memberShape)] : []),
  ].sort();
  await scope.executeRawQuery(
    `LOCK TABLE ${lockTables.join(',')} IN SHARE MODE`,
  );

  const sql = {
    execute: ({ text, values }: { text: string; values: unknown[] }) =>
      scope.executeRawQuery(text, values),
  };

  const readAllBlocklistRows = async (lock = false) => {
    const idRows = await scope.executeRawQuery(
      `SELECT id FROM ${tableSql(blocklistShape)} ORDER BY id${lock ? ' FOR SHARE' : ''}`,
    );
    const ids = idRows.map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Import blocklist policy invalid rule identity');
      return row.id.toLowerCase();
    });
    const rows = await readNativeCrmAuditRows(sql, blocklistShape, ids);
    if (rows.length !== ids.length)
      throw new Error('Import blocklist policy rules changed while reading');
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  };

  const rules = await readAllBlocklistRows(true);
  const memberIds = [
    ...new Set(
      rules.flatMap((row) => {
        const decoded = decodeSnapshot(row);
        if (decoded.scope === 'WORKSPACE') return [];
        const memberId = decoded.workspaceMemberId;
        if (memberId === null || memberId === undefined) return [];
        if (typeof memberId !== 'string' || !isUUID(memberId))
          throw new Error('Import blocklist policy invalid member reference');
        return [memberId.toLowerCase()];
      }),
    ),
  ].sort();

  if (memberIds.length > 0 && (!hasMemberTable || !memberShape)) {
    throw new Error(
      'Import blocklist policy requires workspaceMember metadata',
    );
  }

  const readMembers = async (lock = false) => {
    if (!hasMemberTable || !memberShape || memberIds.length === 0) return [];
    const idRows = await scope.executeRawQuery(
      `SELECT id FROM ${tableSql(memberShape)} WHERE id=ANY($1::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
      [memberIds],
    );
    const ids = idRows.map((row) => {
      if (typeof row.id !== 'string' || !isUUID(row.id))
        throw new Error('Import blocklist policy invalid member identity');
      return row.id.toLowerCase();
    });
    const rows = await readNativeCrmAuditRows(sql, memberShape, ids);
    if (rows.length !== ids.length)
      throw new Error('Import blocklist policy members changed while reading');
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  };

  const members = await readMembers(true);
  const userIds = [
    ...new Set(
      members.flatMap((row) => {
        const userId = decodeSnapshot(row).userId;
        if (userId === null || userId === undefined) return [];
        if (typeof userId !== 'string' || !isUUID(userId))
          throw new Error('Import blocklist policy invalid user reference');
        return [userId.toLowerCase()];
      }),
    ),
  ].sort();
  const normalizedUserWorkspaceId =
    typeof userWorkspaceId === 'string' && isUUID(userWorkspaceId)
      ? userWorkspaceId.toLowerCase()
      : null;

  const readMemberships = async (lock = false) => {
    if (
      !hasUserWorkspaceTable ||
      (userIds.length === 0 && normalizedUserWorkspaceId === null)
    )
      return [];
    return scope.executeRawQuery(
      `SELECT id,"userId","workspaceId",to_jsonb("deletedAt")::text AS "deletedAt" FROM core."userWorkspace" WHERE "workspaceId"=$1 AND ("userId"=ANY($2::uuid[]) OR id=ANY($3::uuid[])) ORDER BY id${lock ? ' FOR SHARE' : ''}`,
      [
        scope.workspaceId,
        userIds,
        normalizedUserWorkspaceId ? [normalizedUserWorkspaceId] : [],
      ],
    );
  };

  const memberships = await readMemberships(true);

  const verify = async () => {
    const currentRules = await readAllBlocklistRows(false);
    const currentMembers = await readMembers(false);
    const currentMemberships = await readMemberships(false);
    if (
      canonicalAuditJson(currentRules) !== canonicalAuditJson(rules) ||
      canonicalAuditJson(currentMembers) !== canonicalAuditJson(members) ||
      canonicalAuditJson(currentMemberships) !== canonicalAuditJson(memberships)
    )
      throw new Error('Import blocklist policy sources changed before commit');
  };

  await verify();

  const applicableBlocklistHandles: string[] = [];
  for (const snapshot of rules) {
    const rule = decodeSnapshot(snapshot);
    if (rule.deletedAt !== null || rule.handle === null || rule.handle === '')
      continue;
    if (typeof rule.handle !== 'string')
      throw new Error('Import blocklist policy invalid rule handle');
    if (rule.scope === 'WORKSPACE') {
      applicableBlocklistHandles.push(rule.handle);
      continue;
    }
    if (typeof rule.workspaceMemberId !== 'string') continue;
    const member = members.find(
      (row) => row.id === rule.workspaceMemberId.toLowerCase(),
    );
    if (!member) continue;
    const decodedMember = decodeSnapshot(member);
    if (decodedMember.deletedAt !== null) continue;
    const memberUserId = decodedMember.userId;
    if (typeof memberUserId !== 'string' || !isUUID(memberUserId)) continue;
    if (!hasUserWorkspaceTable) continue;
    const activeMemberships = memberships.filter(
      (row) =>
        typeof row.userId === 'string' &&
        row.userId.toLowerCase() === memberUserId.toLowerCase() &&
        row.deletedAt === null,
    );
    if (activeMemberships.length > 1)
      throw new Error('Import blocklist policy ambiguous member policy source');
    if (
      activeMemberships.length === 1 &&
      normalizedUserWorkspaceId !== null &&
      typeof activeMemberships[0].id === 'string' &&
      activeMemberships[0].id.toLowerCase() === normalizedUserWorkspaceId
    )
      applicableBlocklistHandles.push(rule.handle);
  }

  return {
    applicableBlocklistHandles,
    verify,
  };
};

export const captureLockedMessageImportPolicyProof = async <
  TChannel extends {
    id: string;
    handle: string;
    isContactAutoCreationEnabled: boolean;
    contactAutoCreationPolicy: string;
    excludeNonProfessionalEmails: boolean;
    excludeGroupEmails: boolean;
  },
  TAccount extends {
    id: string;
    handle: string;
    handleAliases: string[] | null;
  },
>({
  scope,
  workspaceId,
  connectedAccountId,
  channelId,
  fallbackChannel,
  fallbackAccount,
}: {
  scope: PolicyProofScope;
  workspaceId: string;
  connectedAccountId: string;
  channelId: string;
  fallbackChannel: TChannel;
  fallbackAccount: TAccount;
}): Promise<{
  channel: TChannel;
  account: TAccount;
  areMessagesAdmitted: (
    authorityKind: string,
    messages: readonly PolicyCandidateMessage[],
  ) => boolean;
  verify: () => Promise<void>;
}> => {
  const readPolicyProjection = async () => {
    const [workspaceRow] = await scope.executeRawQuery(
      `SELECT to_jsonb(w) AS row FROM core.workspace w WHERE w.id=$1`,
      [workspaceId],
    );
    const [accountRow] = await scope.executeRawQuery(
      `SELECT to_jsonb(a) AS row FROM core."connectedAccount" a WHERE a.id=$1 AND a."workspaceId"=$2`,
      [connectedAccountId, workspaceId],
    );
    const [channelRow] = await scope.executeRawQuery(
      `SELECT to_jsonb(c) AS row FROM core."messageChannel" c WHERE c.id=$1 AND c."workspaceId"=$2`,
      [channelId, workspaceId],
    );
    if (!workspaceRow?.row || !accountRow?.row || !channelRow?.row) {
      throw new Error('Message save import policy source missing');
    }
    const workspaceJson = workspaceRow.row as Record<string, unknown>;
    const accountJson = accountRow.row as Record<string, unknown>;
    const channelJson = channelRow.row as Record<string, unknown>;
    return {
      workspace: {
        id: workspaceJson.id ?? null,
        deletedAt: workspaceJson.deletedAt ?? null,
        isInternalMessagesImportEnabled:
          workspaceJson.isInternalMessagesImportEnabled ?? null,
      },
      account: {
        id: accountJson.id ?? null,
        workspaceId: accountJson.workspaceId ?? null,
        userWorkspaceId: accountJson.userWorkspaceId ?? null,
        handle: accountJson.handle ?? null,
        handleAliases: accountJson.handleAliases ?? null,
      },
      channel: {
        id: channelJson.id ?? null,
        workspaceId: channelJson.workspaceId ?? null,
        connectedAccountId: channelJson.connectedAccountId ?? null,
        handle: channelJson.handle ?? null,
        isContactAutoCreationEnabled:
          channelJson.isContactAutoCreationEnabled ?? null,
        contactAutoCreationPolicy:
          channelJson.contactAutoCreationPolicy ?? null,
        excludeNonProfessionalEmails:
          channelJson.excludeNonProfessionalEmails ?? null,
        excludeGroupEmails: channelJson.excludeGroupEmails ?? null,
      },
    };
  };

  const beforeProjection = await readPolicyProjection();
  if (
    beforeProjection.account.handleAliases !== null &&
    (!Array.isArray(beforeProjection.account.handleAliases) ||
      beforeProjection.account.handleAliases.some(
        (alias) => typeof alias !== 'string',
      ))
  ) {
    throw new Error('Message save invalid account handleAliases policy');
  }

  const blocklistProof = await captureLockedBlocklistPolicyProof({
    scope,
    userWorkspaceId:
      typeof beforeProjection.account.userWorkspaceId === 'string'
        ? beforeProjection.account.userWorkspaceId
        : null,
  });

  const refreshedChannel: TChannel = {
    ...fallbackChannel,
    handle:
      typeof beforeProjection.channel.handle === 'string' &&
      beforeProjection.channel.handle.length > 0
        ? beforeProjection.channel.handle
        : fallbackChannel.handle,
    isContactAutoCreationEnabled:
      typeof beforeProjection.channel.isContactAutoCreationEnabled === 'boolean'
        ? beforeProjection.channel.isContactAutoCreationEnabled
        : Boolean(fallbackChannel.isContactAutoCreationEnabled),
    contactAutoCreationPolicy:
      typeof beforeProjection.channel.contactAutoCreationPolicy === 'string' &&
      beforeProjection.channel.contactAutoCreationPolicy.length > 0
        ? (beforeProjection.channel
            .contactAutoCreationPolicy as TChannel['contactAutoCreationPolicy'])
        : fallbackChannel.contactAutoCreationPolicy,
    excludeNonProfessionalEmails:
      typeof beforeProjection.channel.excludeNonProfessionalEmails === 'boolean'
        ? beforeProjection.channel.excludeNonProfessionalEmails
        : Boolean(fallbackChannel.excludeNonProfessionalEmails),
    excludeGroupEmails:
      typeof beforeProjection.channel.excludeGroupEmails === 'boolean'
        ? beforeProjection.channel.excludeGroupEmails
        : Boolean(fallbackChannel.excludeGroupEmails),
  };

  const refreshedAccount: TAccount = {
    ...fallbackAccount,
    handle:
      typeof beforeProjection.account.handle === 'string' &&
      beforeProjection.account.handle.length > 0
        ? beforeProjection.account.handle
        : fallbackAccount.handle,
    handleAliases: Array.isArray(beforeProjection.account.handleAliases)
      ? (beforeProjection.account.handleAliases as string[])
      : [...(fallbackAccount.handleAliases ?? [])],
  };

  const isInternalMessagesImportEnabled =
    typeof beforeProjection.workspace.isInternalMessagesImportEnabled ===
    'boolean'
      ? beforeProjection.workspace.isInternalMessagesImportEnabled
      : undefined;

  const verify = async () => {
    const currentProjection = await readPolicyProjection();
    if (
      canonicalAuditJson(currentProjection) !==
      canonicalAuditJson(beforeProjection)
    ) {
      throw new Error('Message save import policy changed before commit');
    }
    await blocklistProof.verify();
  };

  const areMessagesAdmitted = (
    authorityKind: string,
    messages: readonly PolicyCandidateMessage[],
  ): boolean => {
    if (authorityKind === 'provider') {
      const ownHandles = [
        refreshedChannel.handle,
        ...(refreshedAccount.handleAliases ?? []),
      ].filter(isNonEmptyString);
      const ownHandlesLower = ownHandles.map((handle) => handle.toLowerCase());
      const checkInternals =
        isInternalMessagesImportEnabled === false &&
        isNonEmptyString(refreshedChannel.handle) &&
        isWorkEmail(refreshedChannel.handle);

      for (const message of messages) {
        if (
          message.attachments?.some((attachment) =>
            attachment.filename.endsWith('.ics'),
          )
        ) {
          return false;
        }
        if (isUnsubscribeRequestCandidate(ownHandlesLower, message)) {
          return false;
        }
        if (
          message.participants?.some((participant) =>
            isEmailBlocklisted(
              ownHandles,
              participant.handle,
              blocklistProof.applicableBlocklistHandles,
            ),
          )
        ) {
          return false;
        }
        if (
          refreshedChannel.excludeGroupEmails &&
          isExcludedGroupEmailCandidate(message, ownHandles)
        ) {
          return false;
        }
        if (
          checkInternals &&
          isInternalEmailCandidate(refreshedChannel.handle, message)
        ) {
          return false;
        }
      }
      return true;
    }

    if (authorityKind === 'inbound') {
      const inboundHandles = [
        refreshedAccount.handle,
        ...(refreshedAccount.handleAliases ?? []),
      ].filter(isNonEmptyString);

      for (const message of messages) {
        if (isUpstreamSpamHeaders(message.messageHeaders ?? [])) {
          return false;
        }
        if (
          refreshedChannel.excludeGroupEmails &&
          isExcludedGroupEmailCandidate(message, inboundHandles)
        ) {
          return false;
        }
      }
      return true;
    }

    return true;
  };

  return {
    channel: refreshedChannel,
    account: refreshedAccount,
    areMessagesAdmitted,
    verify,
  };
};
