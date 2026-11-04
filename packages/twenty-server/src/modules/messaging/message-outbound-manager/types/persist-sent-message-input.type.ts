import { type SendMessageResult } from 'src/modules/messaging/message-outbound-manager/types/send-message-result.type';
import { type CrmAuditOperation } from 'src/engine/core-modules/crm-audit/crm-audit.types';

export type SentMessageMatchingCaller =
  | { kind: 'sent'; userWorkspaceId: string; effectiveUserId?: string }
  | {
      kind: 'sent-tool';
      userWorkspaceId: string | null;
      effectiveUserId?: string;
      applicationId?: string;
    };

export type SentMessageAuditContext = Readonly<
  {
    operation: CrmAuditOperation;
    connectedAccountId: string;
    messageChannelId?: string;
  } & SentMessageMatchingCaller
>;

export type PersistSentMessageInput = {
  sendResult: SendMessageResult;
  subject: string;
  body: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  connectedAccount: { id: string; handle: string };
  messageChannelId: string;
  inReplyTo?: string;
  parentThreadExternalId?: string;
  workspaceId: string;
  auditOperation: CrmAuditOperation;
  matchingCaller: SentMessageMatchingCaller;
};
