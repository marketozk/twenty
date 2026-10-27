import { createHash } from 'node:crypto';

import { z } from 'zod';

const identifier = z
  .string()
  .regex(/^[^\uD800-\uDFFF]*$/u)
  .regex(/^[^\u0000-\u001f\u007f]{1,512}$/u);

const referenceInput = z.strictObject({
  bindingId: z.uuid().transform((value) => value.toLowerCase()),
  providerChatId: identifier,
  nativeMessageKeyVersion: z.literal(1),
  nativeMessageKey: identifier,
});

// The transport adapter must qualify the canonical key; raw IDs are not identities.
export const buildOmniNativeMessageReferences = (
  input: z.input<typeof referenceInput>,
) => {
  const references = referenceInput.parse(input);
  const components = [
    references.bindingId,
    references.providerChatId,
    String(references.nativeMessageKeyVersion),
    references.nativeMessageKey,
  ];
  const encoded = components
    .map((component) => `${Buffer.byteLength(component, 'utf8')}:${component}`)
    .join('');

  return Object.freeze({
    headerMessageId: `omni:v1:${createHash('sha256').update(encoded).digest('hex')}`,
    messageExternalId: references.nativeMessageKey,
    messageThreadExternalId: references.providerChatId,
  });
};
