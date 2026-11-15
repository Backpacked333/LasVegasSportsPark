import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_CONFIG_ENV } from '../../testing';
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

  it('§4.14: production refuses a plaintext connection to a database on another host', () => {
    const { DATABASE_SSL: _ssl, ...withoutSsl } = PRODUCTION_CONFIG_ENV;
    const remote = { ...withoutSsl, DATABASE_URL: 'postgres://db.example.test/sportspark' };
    expect(() => loadConfig(remote)).toThrow(/DATABASE_SSL must be require or verify-full/);
    // TLS named by DATABASE_SSL or by the URL is accepted.
    expect(loadConfig({ ...remote, DATABASE_SSL: 'require' }).DATABASE_SSL).toBe('require');
    expect(() =>
      loadConfig({
        ...remote,
        DATABASE_URL: 'postgres://db.example.test/sportspark?sslmode=require',
      }),
    ).not.toThrow();
    // A database on this host crosses no network (the container image check uses localhost).
    for (const DATABASE_URL of [
      'postgres://localhost:5432/sportspark',
      'postgres://127.0.0.1/sportspark',
      'postgres://user@/sportspark?host=/var/run/postgresql',
    ]) {
      expect(() => loadConfig({ ...withoutSsl, DATABASE_URL })).not.toThrow();
    }
    // A URL asking for no TLS, or prefer (which falls back to plaintext), is refused.
    expect(() =>
      loadConfig({ ...remote, DATABASE_URL: 'postgres://db.example.test/x?sslmode=prefer' }),
    ).toThrow(/DATABASE_SSL/);
  });

  it('R3-OPERATIONS-10: the API shutdown delay must leave part of the stop budget to close', () => {
    expect(() => loadConfig({ ...PRODUCTION_CONFIG_ENV, API_SHUTDOWN_DELAY_MS: '20000' })).toThrow(
      /API_SHUTDOWN_DELAY_MS must be less than API_SHUTDOWN_TIMEOUT_MS/,
    );
    expect(() =>
      loadConfig({
        ...PRODUCTION_CONFIG_ENV,
        API_SHUTDOWN_DELAY_MS: '15000',
        API_SHUTDOWN_TIMEOUT_MS: '15000',
      }),
    ).toThrow(/API_SHUTDOWN_DELAY_MS/);
    expect(
      loadConfig({
        ...PRODUCTION_CONFIG_ENV,
        API_SHUTDOWN_DELAY_MS: '5000',
        API_SHUTDOWN_TIMEOUT_MS: '15000',
      }).API_SHUTDOWN_DELAY_MS,
    ).toBe(5000);
  });

  it('§4.14 (security review M-3): production refuses to boot without an explicit proxy trust setting, and refuses one that believes every sender', () => {
    const { TRUST_PROXY: _trust, ...unset } = PRODUCTION_CONFIG_ENV;
    // Unset: behind a proxy every visitor would share the proxy's address and one bucket.
    expect(() => loadConfig(unset)).toThrow(/TRUST_PROXY must be set explicitly in production/);
    expect(() => loadConfig({ ...unset, TRUST_PROXY: '' })).toThrow(
      /TRUST_PROXY must be set explicitly in production/,
    );
    // The message says what to set.
    expect(() => loadConfig(unset)).toThrow(
      /the number of proxies in front of the API .* the addresses or subnets of those proxies .* or false when the API is reached directly/,
    );
    // "Trust everything": a caller would choose its own rate-limit key.
    for (const everything of ['true', '0.0.0.0/0', '::/0', '10.0.0.0/8, 0.0.0.0/0']) {
      expect(() => loadConfig({ ...unset, TRUST_PROXY: everything }), everything).toThrow(
        /believes X-Forwarded-For from any sender.*refused in production/,
      );
    }
    // A hop count, the proxies' own addresses, or an explicit "no proxy" are accepted.
    expect(loadConfig({ ...unset, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...unset, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(loadConfig({ ...unset, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...unset, TRUST_PROXY: 'none' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...unset, TRUST_PROXY: '10.0.0.0/8' }).TRUST_PROXY).toBe('10.0.0.0/8');
    expect(
      loadConfig({ ...unset, TRUST_PROXY: ' loopback , 192.0.2.10,2001:db8::/32 ' }).TRUST_PROXY,
    ).toBe('loopback,192.0.2.10,2001:db8::/32');
  });

  it('§4.14: the proxy trust setting is a hop count, addresses or subnets, or a plain yes or no; anything else is refused in every environment', () => {
    const env = { NODE_ENV: 'development', AUTH_LOCAL_SECRET: 'x'.repeat(40) };
    // Outside production it may stay unset (forwarded headers are ignored) or be `true`.
    expect(loadConfig(env).TRUST_PROXY).toBeUndefined();
    expect(loadConfig({ ...env, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ ...env, TRUST_PROXY: 'uniquelocal' }).TRUST_PROXY).toBe('uniquelocal');
    for (const [value, message] of [
      ['yes', /"yes" is not an address, a subnet or one of loopback, linklocal, uniquelocal/],
      ['0', /0 is not a hop count; use false/],
      ['99', /not a plausible hop count/],
      ['10.0.0.0/33', /"10\.0\.0\.0\/33" is not an address/],
      ['10.0.0.0/8,', /"" is not an address/],
      ['proxy.internal', /"proxy\.internal" is not an address/],
      ['-1', /"-1" is not an address/],
    ] as const) {
      expect(() => loadConfig({ ...env, TRUST_PROXY: value }), value).toThrow(message);
    }
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
