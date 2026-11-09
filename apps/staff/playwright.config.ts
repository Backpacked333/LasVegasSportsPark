/**
 * Browser smoke tests for the staff dashboard (spec §4.1, SPK-UX-006): the built API with its
 * worker loops on an in-memory database and the development seed (`dev:all`), and the Vite dev
 * server proxying `/v1` to it. A smoke run in a real browser, not staff acceptance on the actual
 * workstations (§6.3).
 *
 *   pnpm build                                   # the API's dist/ (dev:all runs it)
 *   pnpm --filter @sportspark/staff e2e
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = 3190;
const WEB_PORT = 5190;
export const SEED_SUMMARY = path.join(tmpdir(), `sportspark-e2e-seed-${API_PORT}.json`);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'off',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: `node dist/dev-all.js --seed --seed-summary ${SEED_SUMMARY}`,
      cwd: path.join(here, '../api'),
      url: `http://localhost:${API_PORT}/v1/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'development',
        AUTH_MODE: 'local',
        AUTH_LOCAL_SECRET: 'sportspark-e2e-local-secret-for-tests-only-0123',
        PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { SPORTSPARK_API_ORIGIN: `http://localhost:${API_PORT}` },
    },
  ],
});
