import { createRequire } from 'node:module';
import upstream from '/source/packages/twenty-server/jest.config.mjs';

const require = createRequire(import.meta.url);
const transform = Object.fromEntries(Object.entries(upstream.transform).map(([pattern, [name, options]]) => [pattern, [name, {
  ...options,
  swcrc: false,
  jsc: {
    ...options.jsc,
    experimental: { plugins: [[require.resolve('@lingui/swc-plugin'), { stripNonEssentialFields: false }]] },
  },
}]]));

export default {
  ...upstream,
  rootDir: '/source/packages/twenty-server',
  testRegex: undefined,
  testMatch: [
    '<rootDir>/src/modules/messaging/message-outbound-manager/resolvers/__tests__/send-email.resolver.spec.ts',
    '<rootDir>/src/engine/core-modules/tool/tools/email-tool/__tests__/send-email-tool.spec.ts',
    '<rootDir>/src/modules/workflow/workflow-executor/workflow-actions/mail-sender/__tests__/*.spec.ts',
  ],
  transform,
};
