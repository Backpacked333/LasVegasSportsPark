// jest-expo preset (Expo's documented unit-test setup) with React Native Testing Library.
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/src/testing/jest.setup.ts'],
  // Tests live under src/: files under app/ are routes (Expo Router).
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts?(x)'],
  clearMocks: true,
  // Above the 5 s async-utility timeout (src/testing/jest.setup.ts), so a failed wait reports its
  // assertion instead of a test timeout.
  testTimeout: 20_000,
};
