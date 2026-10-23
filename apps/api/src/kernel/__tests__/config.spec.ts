import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

describe('configuration security boundaries', () => {
  it('refuses the local identity provider in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'local',
        AUTH_LOCAL_SECRET: 'x'.repeat(40),
        DATABASE_URL: 'postgres://x',
      }),
    ).toThrow(/cannot run in production/);
  });

  it('requires a long local secret', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'local', AUTH_LOCAL_SECRET: 'short' }),
    ).toThrow(/AUTH_LOCAL_SECRET/);
  });

  it('requires DATABASE_URL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'oidc' })).toThrow(/DATABASE_URL/);
  });

  it('accepts a development configuration with defaults', () => {
    const cfg = loadConfig({ AUTH_LOCAL_SECRET: 'x'.repeat(40) });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.AUTH_MODE).toBe('local');
    expect(cfg.DB_AUTO_MIGRATE).toBe(true);
  });
});
