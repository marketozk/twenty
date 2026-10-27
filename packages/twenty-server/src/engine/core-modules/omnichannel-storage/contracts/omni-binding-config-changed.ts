import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);

export const omniBindingConfigChangedPayloadSchema = z
  .strictObject({
    bindingId: uuid,
    bindingRevision: revision,
    resourceKind: z.enum(['omniQueue', 'omniAccountBinding']),
    resourceId: uuid,
    resourceRevision: revision,
    policyEpoch: revision,
  })
  .refine(
    (payload) =>
      payload.resourceKind !== 'omniAccountBinding' ||
      (payload.resourceId === payload.bindingId &&
        payload.resourceRevision === payload.bindingRevision),
    'Binding configuration event must reference the same binding revision',
  )
  .readonly();

export const omniBindingConfigChangedEventSchema = z
  .strictObject({
    kind: z.literal('binding.config_changed'),
    origin: z.literal('configuration_change'),
    payloadVersion: z.literal(1),
    conversationId: z.null(),
    conversationSequence: z.null(),
    rootExecutionId: z.null(),
    causationId: z.null(),
    payload: omniBindingConfigChangedPayloadSchema,
  })
  .readonly();

export type OmniBindingConfigChangedEvent = z.infer<
  typeof omniBindingConfigChangedEventSchema
>;
