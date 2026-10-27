import { z } from 'zod';

import {
  omniHumanCommandLeasePrincipalSchema,
  type OmniHumanCommandLeasePrincipal,
} from 'src/modules/omnichannel/contracts/omni-human-command-lease';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const timestamp = z.iso.datetime({ precision: 6 });

export const omniHumanCommandDeferInputSchema = z
  .strictObject({
    commandId: uuid,
    leaseToken: uuid,
    leaseUntil: timestamp,
    capturedRestoreIncarnation: uuid,
    retryAfterMilliseconds: z.number().int().min(1000).max(86400000),
  })
  .readonly();

export const omniHumanCommandDiscoveryCursorSchema = z
  .strictObject({
    nextAttemptAt: timestamp,
    commandId: uuid,
  })
  .readonly();

export const omniHumanCommandDiscoveryInputSchema = z
  .strictObject({
    limit: z.number().int().min(1).max(100),
    cursor: omniHumanCommandDiscoveryCursorSchema.nullable(),
  })
  .readonly();

export const omniHumanCommandRecoveryPrincipalSchema =
  omniHumanCommandLeasePrincipalSchema;
export type OmniHumanCommandRecoveryPrincipal = OmniHumanCommandLeasePrincipal;
export type OmniHumanCommandDeferInput = z.infer<
  typeof omniHumanCommandDeferInputSchema
>;
export type OmniHumanCommandDiscoveryInput = z.infer<
  typeof omniHumanCommandDiscoveryInputSchema
>;
export type OmniHumanCommandDiscoveryCursor = z.infer<
  typeof omniHumanCommandDiscoveryCursorSchema
>;
export type OmniHumanCommandDeferResult =
  | Readonly<{
      deferred: true;
      commandId: string;
      state: 'outcome_unknown';
      statusRevision: string;
      nextAttemptAt: string;
    }>
  | Readonly<{
      deferred: false;
      reason:
        | 'terminal'
        | 'pending'
        | 'lease_superseded'
        | 'lease_expired'
        | 'restore_changed';
    }>;

// These are hints, not leases or dispatch permissions. Each scan must eventually restart.
export type OmniHumanCommandDiscoveryResult = Readonly<{
  candidates: ReadonlyArray<OmniHumanCommandDiscoveryCursor>;
  nextCursor: OmniHumanCommandDiscoveryCursor | null;
}>;
