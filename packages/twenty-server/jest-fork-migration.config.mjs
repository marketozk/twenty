import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default {
  displayName: 'fork-migration-postgres',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/test/fork-migration/*.postgres-spec.ts',
    '<rootDir>/test/fork-migration/*.spec.ts',
    '<rootDir>/src/engine/twenty-orm/datasource/utils/__tests__/run-in-rollback-safe-transaction.util.spec.ts',
    '<rootDir>/src/engine/twenty-orm/datasource/__tests__/workspace-data-source-transaction.spec.ts',
  ],
  testTimeout: 20000,
  maxWorkers: 1,
  transformIgnorePatterns: ['/node_modules/(?!marked/)'],
  transform: {
    '^.+\\.[jt]s$': [
      '@swc/jest',
      {
        swcrc: false,
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { decoratorMetadata: true },
          experimental: {
            plugins: [[require.resolve('@lingui/swc-plugin'), { stripNonEssentialFields: false }]],
          },
        },
      },
    ],
  },
  moduleNameMapper: {
    '^src/(.*)': '<rootDir>/src/$1',
    '^test/(.*)': '<rootDir>/test/$1',
  },
};
