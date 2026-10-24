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
  /**
   * How customers reach the facility for help (SCR-C-38). Facility facts, not app defaults:
   * unset until the operator configures them (support coverage is DEC-015).
   */
  supportContact?: SupportContact | null;
}

export interface SupportContact {
  phone: string | null;
  email: string | null;
  /** Free text, e.g. the desk's opening hours, exactly as configured. */
  hours: string | null;
}

interface Extra {
  apiBaseUrl?: unknown;
  staleDataThresholdMinutes?: unknown;
  organizationSlug?: unknown;
  placementFields?: unknown;
  supportContact?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** The configured support contact, or null when nothing is configured. */
export function readSupportContact(value: unknown): SupportContact | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const contact = { phone: text(v.phone), email: text(v.email), hours: text(v.hours) };
  return contact.phone || contact.email ? contact : null;
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
    supportContact: readSupportContact(extra.supportContact),
  };
}
