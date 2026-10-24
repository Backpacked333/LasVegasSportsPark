/**
 * Expo app configuration (spec §4.1, §4.13). Values that are operator decisions are not invented
 * here: bundle identifiers, supported OS versions, the minimum supported app version and the API
 * compatibility window are DEC-061 (Technical lead/operator; privacy declarations Operator/privacy
 * owner) and stay unset until decided.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

/** The build's app version; sent to the API in the client identification header. */
export const APP_VERSION = '0.1.0';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Sportspark',
  slug: 'sportspark',
  version: APP_VERSION,
  scheme: 'sportspark',
  userInterfaceStyle: 'automatic',
  plugins: ['expo-router'],
  extra: {
    // Development default; Android emulators reach the host at http://10.0.2.2:3000/v1.
    apiBaseUrl: process.env.SPORTSPARK_API_BASE_URL ?? 'http://localhost:3000/v1',
    // Age after which shown data counts as stale (SCR-C-40). Pending DEC-032/DEC-033: unset means
    // the app shows the age of data but does not call it stale.
    staleDataThresholdMinutes: process.env.SPORTSPARK_STALE_DATA_THRESHOLD_MINUTES
      ? Number(process.env.SPORTSPARK_STALE_DATA_THRESHOLD_MINUTES)
      : null,
  },
});
