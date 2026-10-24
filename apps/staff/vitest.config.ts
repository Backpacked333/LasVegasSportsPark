import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('0.1.0') },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    name: 'staff',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/testing/setup.ts'],
    testTimeout: 20_000,
  },
});
