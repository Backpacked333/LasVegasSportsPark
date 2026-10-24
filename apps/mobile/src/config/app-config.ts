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
  /**
   * Organization slug whose public catalog Discover shows to a signed-out visitor (deployment
   * setting, SCR-C-07). Signed-in customers browse their own organization; unset means signed-out
   * discovery asks the visitor to sign in.
   */
  organizationSlug?: string | null;
  /**
   * Placement fields approved for collection (SCR-C-10, SPK-PLACE-001). Pending DEC-051 (Product
   * and operations; Operator/privacy owner): `null` until configured, and the screen then shows
   * the pending state instead of inventing a field list.
   */
  placementFields?: readonly string[] | null;
}

interface Extra {
  apiBaseUrl?: unknown;
  staleDataThresholdMinutes?: unknown;
  organizationSlug?: unknown;
  placementFields?: unknown;
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
    organizationSlug:
      typeof extra.organizationSlug === 'string' && extra.organizationSlug.length > 0
        ? extra.organizationSlug
        : null,
    placementFields: Array.isArray(extra.placementFields)
      ? extra.placementFields.filter((f): f is string => typeof f === 'string')
      : null,
  };
}
