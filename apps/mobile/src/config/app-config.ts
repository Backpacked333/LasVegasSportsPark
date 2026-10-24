/**
 * Runtime configuration read from the Expo app config (`app.config.ts` `extra`), spec §4.13.
 * Nothing here is a policy value: the stale-data threshold is pending DEC-032/DEC-033 and stays
 * `null` until configured.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export interface AppConfig {
  /** API origin plus `/v1`. */
  apiBaseUrl: string;
  /** This build's version, sent in the client identification header. */
  appVersion: string;
  platform: 'ios' | 'android' | 'web';
  /** Age after which shown data counts as stale; `null` while DEC-032/DEC-033 are pending. */
  staleDataThresholdMs: number | null;
}

interface Extra {
  apiBaseUrl?: unknown;
  staleDataThresholdMinutes?: unknown;
}

export function readAppConfig(): AppConfig {
  const expoConfig = Constants.expoConfig;
  const extra = (expoConfig?.extra ?? {}) as Extra;
  const minutes = extra.staleDataThresholdMinutes;
  return {
    apiBaseUrl:
      typeof extra.apiBaseUrl === 'string' ? extra.apiBaseUrl : 'http://localhost:3000/v1',
    appVersion: expoConfig?.version ?? '0.0.0',
    platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
    staleDataThresholdMs:
      typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
        ? minutes * 60_000
        : null,
  };
}
