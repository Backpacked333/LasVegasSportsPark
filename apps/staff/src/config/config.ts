/**
 * Runtime configuration (spec §4.13). Nothing here is a policy value: the stale-data threshold is
 * pending DEC-032/DEC-033 and stays `null` until configured.
 */
export interface StaffConfig {
  apiBaseUrl: string;
  appVersion: string;
  staleDataThresholdMs: number | null;
}

export function readConfig(env: ImportMetaEnv = import.meta.env): StaffConfig {
  const minutes = Number(env.VITE_STALE_DATA_THRESHOLD_MINUTES);
  return {
    apiBaseUrl: env.VITE_API_BASE_URL || '/v1',
    appVersion: __APP_VERSION__,
    staleDataThresholdMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null,
  };
}
