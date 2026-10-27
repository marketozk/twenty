import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
export const omniHumanCommandLeasePrincipalSchema = z
  .strictObject({
    workspaceId: uuid,
    bindingId: uuid,
    actor: z
      .strictObject({
        kind: z.literal('system'),
        id: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^\u0000-\u001f\u007f\uD800-\uDFFF]+$/u)
          .refine((value) => value.trim() === value),
      })
      .readonly(),
  })
  .readonly();

export const omniHumanCommandLeaseInputSchema = z
  .strictObject({
    commandId: uuid,
    leaseMilliseconds: z.number().int().min(1000).max(300000),
  })
  .readonly();

export type OmniHumanCommandLeasePrincipal = z.infer<
  typeof omniHumanCommandLeasePrincipalSchema
>;
export type OmniHumanCommandLeaseInput = z.infer<
  typeof omniHumanCommandLeaseInputSchema
>;
export type OmniHumanCommandLeasePurpose = 'first_attempt' | 'reconcile_only';

// A database lease is not permission to call a provider or reconstruct a lost dispatch context.
export type OmniHumanCommandLeaseProof = Readonly<{
  commandId: string;
  leaseToken: string;
  leaseUntil: string;
  capturedRestoreIncarnation: string;
  purpose: OmniHumanCommandLeasePurpose;
}>;

export type OmniHumanCommandLeaseResult =
  | Readonly<{ claimed: true; proof: OmniHumanCommandLeaseProof }>
  | Readonly<{
      claimed: false;
      reason:
        | 'lease_live'
        | 'not_due'
        | 'waiting_predecessor'
        | 'terminal'
        | 'non_virgin_pending'
        | 'predecessor_scan_limit';
    }>;
