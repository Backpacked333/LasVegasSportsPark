import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The drift test reads ErrorCodes from source; contracts' package entry is its build output.
      '@sportspark/contracts': path.resolve(import.meta.dirname, '../contracts/src/index.ts'),
    },
  },
  test: {
    name: 'api-client',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
