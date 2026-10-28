import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[^\uD800-\uDFFF]*$/u)
    .regex(/^[^\u0000-\u001f\u007f]+$/u)
    .refine((value) => value.trim() === value);
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);

export const omniBindingConfigurationPrincipalSchema = z
  .strictObject({
    workspaceId: uuid,
    actor: z.discriminatedUnion('kind', [
      z
        .strictObject({ kind: z.literal('workspaceMember'), id: uuid })
        .readonly(),
      z.strictObject({ kind: z.literal('system'), id: text(256) }).readonly(),
    ]),
  })
  .readonly();

const common = { bindingId: uuid, idempotencyKey: text(256) };
export const omniBindingConfigurationCommandSchema = z.discriminatedUnion(
  'action',
  [
    z
      .strictObject({
        ...common,
        action: z.literal('queue.create'),
        expectedRevision: z.literal('0'),
        name: text(256),
      })
      .readonly(),
    z
      .strictObject({
        ...common,
        action: z.literal('queue.update'),
        queueId: uuid,
        expectedRevision: revision,
        name: text(256).optional(),
        active: z.boolean().optional(),
      })
      .refine((value) => value.name !== undefined || value.active !== undefined)
      .readonly(),
    z
      .strictObject({
        ...common,
        action: z.literal('binding.defaults.update'),
        expectedRevision: revision,
        defaultQueueId: uuid,
        defaultConversationMode: z.literal('human'),
        autoCreatePersonEnabled: z.boolean().optional(),
      })
      .readonly(),
  ],
);

export const omniBindingConfigurationResourceSchema = z
  .strictObject({
    resourceKind: z.enum(['omniQueue', 'omniAccountBinding']),
    resourceId: uuid,
    bindingId: uuid,
  })
  .readonly();

export const omniBindingConfigurationResultSchema = z
  .strictObject({
    operationId: uuid,
    resourceKind: z.enum(['omniQueue', 'omniAccountBinding']),
    resourceId: uuid,
    revision,
    bindingId: uuid,
    bindingRevision: revision,
    policyEpoch: revision,
    eventId: uuid.nullable(),
    changed: z.boolean(),
  })
  .refine((value) => value.changed === (value.eventId !== null))
  .refine(
    (value) =>
      value.resourceKind !== 'omniAccountBinding' ||
      (value.resourceId === value.bindingId &&
        value.revision === value.bindingRevision),
  )
  .readonly();

export type OmniBindingConfigurationPrincipal = z.infer<
  typeof omniBindingConfigurationPrincipalSchema
>;
export type OmniBindingConfigurationCommand = z.infer<
  typeof omniBindingConfigurationCommandSchema
>;
export type OmniBindingConfigurationResource = z.infer<
  typeof omniBindingConfigurationResourceSchema
>;
export type OmniBindingConfigurationResult = z.infer<
  typeof omniBindingConfigurationResultSchema
>;
