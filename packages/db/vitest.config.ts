import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@sportspark/contracts': path.resolve(__dirname, '../contracts/src/index.ts'),
    },
  },
  test: {
    name: 'db',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
