import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const sourceKey = z
  .string()
  .regex(/^[^\u0000-\u001f\u007f\uD800-\uDFFF]{1,512}(?![\s\S])/u);

export const omniIncomingApplicationResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('incoming_text_revision'),
    disposition: z.enum(['created', 'advanced', 'duplicate', 'stale']),
    selectedRevisionId: uuid,
    observedHeadRevisionId: uuid.nullable(),
    candidateSourceRevisionKey: sourceKey,
    candidateContentHash: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  })
  .superRefine((value, context) => {
    const observed = value.observedHeadRevisionId;
    if (
      (value.disposition === 'created' && observed !== null) ||
      (value.disposition !== 'created' && observed === null) ||
      (value.disposition === 'advanced' &&
        value.selectedRevisionId === observed) ||
      (value.disposition === 'stale' && value.selectedRevisionId !== observed)
    )
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent application result',
      });
  })
  .readonly();

export type OmniIncomingApplicationResult = z.infer<
  typeof omniIncomingApplicationResultSchema
>;

export const snapshotOmniIncomingApplicationResult = (
  input: unknown,
): OmniIncomingApplicationResult => {
  const parsed = omniIncomingApplicationResultSchema.safeParse(input);
  if (!parsed.success)
    throw new Error('OMNI_INVALID_INCOMING_APPLICATION_RESULT');
  return parsed.data;
};
