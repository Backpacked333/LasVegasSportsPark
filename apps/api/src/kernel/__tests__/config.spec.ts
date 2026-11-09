import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, PUBLISHED_EXAMPLE_SECRET } from '../config';

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
    const cfg = loadConfig({ NODE_ENV: 'development', AUTH_LOCAL_SECRET: 'x'.repeat(40) });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.AUTH_MODE).toBe('local');
    expect(cfg.DB_AUTO_MIGRATE).toBe(true);
    expect(cfg.IDEMPOTENCY_LEASE_SECONDS).toBe(120);
  });

  it('§4.14: refuses to boot when NODE_ENV is unset, instead of falling back to development', () => {
    // Every production guard (local identity, /v1/dev/tokens, automatic migration, PGlite) keys on
    // NODE_ENV, so a host that forgot it must fail closed.
    expect(() => loadConfig({ AUTH_LOCAL_SECRET: 'x'.repeat(40) })).toThrow(
      /NODE_ENV must be set explicitly/,
    );
    expect(() =>
      loadConfig({
        AUTH_MODE: 'local',
        AUTH_LOCAL_SECRET: 'x'.repeat(40),
        DATABASE_URL: 'postgres://prod-host/prod',
      }),
    ).toThrow(/NODE_ENV/);
  });

  it('§4.14: the shipped .env.example carries no usable identity secret', () => {
    const example = readFileSync(path.resolve(__dirname, '../../../../../.env.example'), 'utf8');
    const line = example.split('\n').find((l) => l.startsWith('AUTH_LOCAL_SECRET='));
    expect(line).toBe('AUTH_LOCAL_SECRET=');
    expect(example).toMatch(/^NODE_ENV=development$/m);
  });

  it('§4.14: rejects the published example secret for the local identity provider', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(() =>
        loadConfig({ NODE_ENV, AUTH_MODE: 'local', AUTH_LOCAL_SECRET: PUBLISHED_EXAMPLE_SECRET }),
      ).toThrow(/published example value/);
    }
  });

  it("§5.2, DEC-018: AUTH_MODE=oidc needs the key set URL and the provider's own issuer", () => {
    const base = { NODE_ENV: 'development', AUTH_MODE: 'oidc' };
    expect(() => loadConfig(base)).toThrow(/AUTH_JWKS_URL is required/);
    expect(() =>
      loadConfig({ ...base, AUTH_JWKS_URL: 'https://idp.example.test/jwks.json' }),
    ).toThrow(/AUTH_ISSUER must name the managed identity provider/);
    const cfg = loadConfig({
      ...base,
      AUTH_JWKS_URL: 'https://idp.example.test/jwks.json',
      AUTH_ISSUER: 'https://idp.example.test',
    });
    expect(cfg.AUTH_ALLOWED_ALGS).toEqual(['RS256', 'ES256']);
    expect(cfg.AUTH_CLOCK_SKEW_SECONDS).toBe(30);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x',
        AUTH_JWKS_URL: 'http://idp.example.test/jwks.json',
        AUTH_ISSUER: 'https://idp.example.test',
      }),
    ).toThrow(/AUTH_JWKS_URL must be an https URL in production/);
  });

  it('§5.2: PROVIDER_DECISIONS names one decision record per gate', () => {
    const env = { NODE_ENV: 'test', AUTH_LOCAL_SECRET: 'x'.repeat(40) };
    expect(loadConfig(env).PROVIDER_DECISIONS).toEqual({});
    expect(
      loadConfig({ ...env, PROVIDER_DECISIONS: 'identity=DEC-018, payments=DEC-019' })
        .PROVIDER_DECISIONS,
    ).toEqual({ identity: 'DEC-018', payments: 'DEC-019' });
    expect(() => loadConfig({ ...env, PROVIDER_DECISIONS: 'billing=DEC-019' })).toThrow(
      /PROVIDER_DECISIONS entry "billing=DEC-019"/,
    );
    expect(() => loadConfig({ ...env, PROVIDER_DECISIONS: 'payments=yes' })).toThrow(
      /PROVIDER_DECISIONS/,
    );
  });
});
