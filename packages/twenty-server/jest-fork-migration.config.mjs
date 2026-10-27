export default {
  displayName: 'fork-migration-postgres',
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/fork-migration/*.postgres-spec.ts'],
  testTimeout: 20000,
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': ['@swc/jest', { jsc: { parser: { syntax: 'typescript' } } }],
  },
  moduleNameMapper: { '^src/(.*)': '<rootDir>/src/$1' },
};
