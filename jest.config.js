/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  // Only the TypeScript suites under src/. Jest's default testMatch otherwise
  // picks up test.js (a manual CLI probe) and the compiled copies in build/.
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  // These suites spawn the built server and drive it over a real transport, so
  // they need more than the 5s default. Set here rather than via
  // jest.setTimeout, which is not in scope under ESM without an explicit import.
  testTimeout: 30000,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
}; 