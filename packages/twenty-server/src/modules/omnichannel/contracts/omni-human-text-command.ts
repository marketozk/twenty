import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);

export const omniHumanTextCommandPrincipalSchema = z
  .strictObject({
    workspaceId: uuid,
    userId: uuid,
    workspaceMemberId: uuid,
  })
  .readonly();

export const omniHumanTextCommandInputSchema = z
  .strictObject({
    conversationId: uuid,
    text: z
      .string()
      .min(1)
      .max(16000)
      .regex(/^[^\uD800-\uDFFF]*$/u)
      .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u)
      .refine((value) => value.trim().length > 0)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 64000),
    idempotencyKey: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\u0000-\u0020\u007f\uD800-\uDFFF]+$/u),
    expectedControlEpoch: revision,
    observedReplyRevision: revision,
  })
  .readonly();

export type OmniHumanTextCommandPrincipal = z.infer<
  typeof omniHumanTextCommandPrincipalSchema
>;
export type OmniHumanTextCommandInput = z.infer<
  typeof omniHumanTextCommandInputSchema
>;
export type OmniHumanTextCommandResult = Readonly<{
  commandId: string;
  state:
    | 'pending'
    | 'dispatching'
    | 'accepted'
    | 'outcome_unknown'
    | 'sent'
    | 'failed'
    | 'cancelled';
  replyRevision: string;
  controlEpoch: string;
  mode: 'human' | 'assist' | 'auto';
  created: boolean;
}>;
