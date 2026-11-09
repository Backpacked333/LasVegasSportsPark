/**
 * §4.13, DEC-061: the Expo app config follows the build environment, wires verified links only for
 * decided hosts, and refuses a production build made with placeholders.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig, { productionBuildProblems } from '../../../app.config';

const ENV_KEYS = [
  'SPORTSPARK_ENV',
  'SPORTSPARK_IOS_BUNDLE_ID',
  'SPORTSPARK_ANDROID_PACKAGE',
  'SPORTSPARK_API_BASE_URL',
  'SPORTSPARK_VERIFIED_LINK_HOSTS',
] as const;

function build(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): ExpoConfig {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return appConfig({ config: {} } as ConfigContext);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('app config per build environment (§4.13, DEC-061)', () => {
  it('development by default, with no store identifiers and no verified links', () => {
    const config = build({});
    expect(config.extra?.environment).toBe('development');
    expect(config.extra?.apiBaseUrl).toBe('http://localhost:3000/v1');
    expect(config.ios?.bundleIdentifier).toBeUndefined();
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
    expect(config.runtimeVersion).toEqual({ policy: 'appVersion' });
  });

  it('SCR-C-39: decided verified-link hosts become associated domains and verified intent filters', () => {
    const config = build({ SPORTSPARK_VERIFIED_LINK_HOSTS: 'app.example.org, links.example.org' });
    expect(config.ios?.associatedDomains).toEqual([
      'applinks:app.example.org',
      'applinks:links.example.org',
    ]);
    expect(config.android?.intentFilters?.[0]).toMatchObject({
      autoVerify: true,
      data: [
        { scheme: 'https', host: 'app.example.org' },
        { scheme: 'https', host: 'links.example.org' },
      ],
    });
  });

  it('§4.13: a production build without store identifiers or an https API is refused', () => {
    expect(() => build({ SPORTSPARK_ENV: 'production' })).toThrow(/Production build refused/);
    expect(
      productionBuildProblems({
        SPORTSPARK_IOS_BUNDLE_ID: 'org.example.app',
        SPORTSPARK_API_BASE_URL: 'http://api.example.org/v1',
      }),
    ).toEqual([
      'SPORTSPARK_ANDROID_PACKAGE is not set (DEC-061)',
      'SPORTSPARK_API_BASE_URL must be the production https API ending in /v1',
    ]);
    const production = build({
      SPORTSPARK_ENV: 'production',
      SPORTSPARK_IOS_BUNDLE_ID: 'org.example.app',
      SPORTSPARK_ANDROID_PACKAGE: 'org.example.app',
      SPORTSPARK_API_BASE_URL: 'https://api.example.org/v1',
    });
    expect(production.extra?.environment).toBe('production');
    expect(production.ios?.bundleIdentifier).toBe('org.example.app');
    expect(production.android?.package).toBe('org.example.app');
  });

  it('an unknown build environment is refused', () => {
    expect(() => build({ SPORTSPARK_ENV: 'staging' })).toThrow(/SPORTSPARK_ENV must be one of/);
  });
});
