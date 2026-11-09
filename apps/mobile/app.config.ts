/**
 * Expo app configuration (spec §4.1, §4.13). Values that are operator decisions are not invented
 * here: bundle identifiers, supported OS versions, the minimum supported app version and the API
 * compatibility window are DEC-061 (Technical lead/operator; privacy declarations Operator/privacy
 * owner) and stay unset until decided.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

/** The build's app version; sent to the API in the client identification header. */
export const APP_VERSION = '0.1.0';

/** Build environments (eas.json profiles set SPORTSPARK_ENV). */
export const BUILD_ENVIRONMENTS = ['development', 'preview', 'production'] as const;
export type BuildEnvironment = (typeof BUILD_ENVIRONMENTS)[number];

const list = (value: string | undefined): string[] =>
  value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

/**
 * What a production build may not be made without (§4.13, DEC-061): store identifiers and an
 * https API. Expo evaluates this file for every build and export, so a production build with a
 * placeholder fails here instead of shipping. Returns the problems; empty means buildable.
 */
export function productionBuildProblems(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const problems: string[] = [];
  if (!env.SPORTSPARK_IOS_BUNDLE_ID) problems.push('SPORTSPARK_IOS_BUNDLE_ID is not set (DEC-061)');
  if (!env.SPORTSPARK_ANDROID_PACKAGE) {
    problems.push('SPORTSPARK_ANDROID_PACKAGE is not set (DEC-061)');
  }
  const api = env.SPORTSPARK_API_BASE_URL ?? '';
  if (!/^https:\/\/[^/]+\/v1$/.test(api)) {
    problems.push('SPORTSPARK_API_BASE_URL must be the production https API ending in /v1');
  }
  return problems;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const environment = (process.env.SPORTSPARK_ENV ?? 'development') as BuildEnvironment;
  if (!BUILD_ENVIRONMENTS.includes(environment)) {
    throw new Error(`SPORTSPARK_ENV must be one of ${BUILD_ENVIRONMENTS.join(', ')}`);
  }
  if (environment === 'production') {
    const problems = productionBuildProblems(process.env);
    if (problems.length > 0) {
      throw new Error(`Production build refused:\n  ${problems.join('\n  ')}`);
    }
  }
  const verifiedLinkHosts = list(process.env.SPORTSPARK_VERIFIED_LINK_HOSTS);
  return {
    ...config,
    name: 'Sportspark',
    slug: 'sportspark',
    version: APP_VERSION,
    scheme: 'sportspark',
    userInterfaceStyle: 'automatic',
    plugins: ['expo-router'],
    // Over-the-air updates, when added (expo-updates, DEC-061 update behavior), apply only to
    // builds of the same app version.
    runtimeVersion: { policy: 'appVersion' },
    // Store identifiers and build numbers are DEC-061 values: unset until decided, and a
    // production build refuses to be made without them (productionBuildProblems).
    ios: {
      bundleIdentifier: process.env.SPORTSPARK_IOS_BUNDLE_ID,
      buildNumber: process.env.SPORTSPARK_IOS_BUILD_NUMBER,
      // Verified links (SCR-C-39): only the decided hosts open the app.
      ...(verifiedLinkHosts.length > 0
        ? { associatedDomains: verifiedLinkHosts.map((host) => `applinks:${host}`) }
        : {}),
    },
    android: {
      package: process.env.SPORTSPARK_ANDROID_PACKAGE,
      ...(process.env.SPORTSPARK_ANDROID_VERSION_CODE
        ? { versionCode: Number(process.env.SPORTSPARK_ANDROID_VERSION_CODE) }
        : {}),
      ...(verifiedLinkHosts.length > 0
        ? {
            intentFilters: [
              {
                action: 'VIEW',
                autoVerify: true,
                data: verifiedLinkHosts.map((host) => ({ scheme: 'https', host })),
                category: ['BROWSABLE', 'DEFAULT'],
              },
            ],
          }
        : {}),
    },
    extra: {
      environment,
      // Development default; Android emulators reach the host at http://10.0.2.2:3000/v1.
      apiBaseUrl: process.env.SPORTSPARK_API_BASE_URL ?? 'http://localhost:3000/v1',
      // Age after which shown data counts as stale (SCR-C-40). Pending DEC-032/DEC-033: unset means
      // the app shows the age of data but does not call it stale.
      staleDataThresholdMinutes: process.env.SPORTSPARK_STALE_DATA_THRESHOLD_MINUTES
        ? Number(process.env.SPORTSPARK_STALE_DATA_THRESHOLD_MINUTES)
        : null,
      // Organization whose public catalog signed-out visitors browse (deployment setting, SCR-C-07).
      organizationSlug: process.env.SPORTSPARK_ORGANIZATION_SLUG ?? null,
      // Approved placement fields (SCR-C-10). Pending DEC-051: unset until the operator approves them.
      placementFields: process.env.SPORTSPARK_PLACEMENT_FIELDS
        ? process.env.SPORTSPARK_PLACEMENT_FIELDS.split(',').map((f: string) => f.trim())
        : null,
      // Managed sign-in (§4.13, DEC-018): the identity provider's issuer and this app's public
      // client id there. Unset: the sign-in screen says sign-in is pending. No secret belongs here.
      auth: process.env.SPORTSPARK_AUTH_ISSUER
        ? {
            issuer: process.env.SPORTSPARK_AUTH_ISSUER,
            clientId: process.env.SPORTSPARK_AUTH_CLIENT_ID ?? null,
            audience: process.env.SPORTSPARK_AUTH_AUDIENCE ?? null,
            scope: process.env.SPORTSPARK_AUTH_SCOPE ?? null,
            bearer: process.env.SPORTSPARK_AUTH_BEARER ?? null,
          }
        : null,
      // Verified-link domains (SCR-C-39). Pending DEC-061: unset, so release builds open no https link.
      verifiedLinkHosts,
      // Whether supervised pickup is used. Pending DEC-075 (and DEC-005): unset, so pickup shows as pending.
      supervisedPickup:
        process.env.SPORTSPARK_SUPERVISED_PICKUP === 'true'
          ? true
          : process.env.SPORTSPARK_SUPERVISED_PICKUP === 'false'
            ? false
            : null,
      // How customers reach the facility for help (SCR-C-38): facility facts, unset until the
      // operator provides them (support coverage is DEC-015).
      supportContact: {
        phone: process.env.SPORTSPARK_SUPPORT_PHONE ?? null,
        email: process.env.SPORTSPARK_SUPPORT_EMAIL ?? null,
        hours: process.env.SPORTSPARK_SUPPORT_HOURS ?? null,
      },
    },
  };
};
