/**
 * Runtime configuration (spec §4.13). Nothing here is a policy value: the stale-data threshold is
 * pending DEC-032/DEC-033 and stays `null` until configured.
 */
/**
 * Managed sign-in (§4.13, §4.14; DEC-018): the identity provider this build signs in at. The
 * values are public identifiers, not secrets; the provider must have this site's
 * `/sign-in/callback` address registered. Which provider it is stays a recorded decision.
 */
export interface StaffAuthConfig {
  issuer: string;
  clientId: string;
  audience?: string;
  scope?: string;
  bearer?: 'access_token' | 'id_token';
}

export interface StaffConfig {
  apiBaseUrl: string;
  appVersion: string;
  staleDataThresholdMs: number | null;
  /**
   * Maximum age of a roster that offline observations may be queued against (§4.15 proposes two
   * hours, pending DEC-033). Unset (`null`) means not configured: the age is shown and the API
   * flags stale snapshots for review.
   */
  offlineRosterMaxAgeMs?: number | null;
  /** Unset (`null`): no managed sign-in in this build; the sign-in page says so. */
  auth?: StaffAuthConfig | null;
  /**
   * The organization a person who signs in for the first time registers a login account in
   * (`POST /v1/accounts/register`). Unset: only people who already have an account can sign in.
   */
  organizationSlug?: string | null;
}

export function readConfig(env: ImportMetaEnv = import.meta.env): StaffConfig {
  const minutes = Number(env.VITE_STALE_DATA_THRESHOLD_MINUTES);
  const rosterMinutes = Number(env.VITE_OFFLINE_ROSTER_MAX_AGE_MINUTES);
  const issuer = env.VITE_AUTH_ISSUER?.trim();
  const clientId = env.VITE_AUTH_CLIENT_ID?.trim();
  const audience = env.VITE_AUTH_AUDIENCE?.trim();
  const scope = env.VITE_AUTH_SCOPE?.trim();
  return {
    auth:
      issuer && clientId
        ? {
            issuer,
            clientId,
            ...(audience ? { audience } : {}),
            ...(scope ? { scope } : {}),
            ...(env.VITE_AUTH_BEARER === 'id_token' ? { bearer: 'id_token' as const } : {}),
          }
        : null,
    organizationSlug: env.VITE_ORGANIZATION_SLUG?.trim() || null,
    apiBaseUrl: env.VITE_API_BASE_URL || '/v1',
    appVersion: __APP_VERSION__,
    staleDataThresholdMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null,
    offlineRosterMaxAgeMs:
      Number.isFinite(rosterMinutes) && rosterMinutes > 0 ? rosterMinutes * 60_000 : null,
  };
}
