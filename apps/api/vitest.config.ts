import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  resolve: {
    alias: {
      '@sportspark/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      '@sportspark/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
    },
  },
  test: {
    name: 'api',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['src/testing/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 90_000,
    pool: 'forks',
  },
});
