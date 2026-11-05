/// <reference types="vite/client" />

/** The build's version from package.json (vite `define`), sent in the client header (§4.13). */
declare const __APP_VERSION__: string;

/** True only in `--mode demo` builds (vite.config.ts); see src/demo/mode.ts. */
declare const __DEMO__: boolean;

interface ImportMetaEnv {
  /** API origin plus `/v1`; defaults to the same-origin `/v1` proxy. */
  readonly VITE_API_BASE_URL?: string;
  /** Pending DEC-032/DEC-033: unset means data age is shown but never called stale. */
  readonly VITE_STALE_DATA_THRESHOLD_MINUTES?: string;
  /** Pending DEC-033: maximum roster age for queuing offline observations; unset = not configured. */
  readonly VITE_OFFLINE_ROSTER_MAX_AGE_MINUTES?: string;
  /**
   * Demo mode only: the seeded demo accounts as JSON, `{"dev-desk": "<account uuid>", ...}`.
   * Written by `pnpm demo` from the seed's output; ignored by real builds.
   */
  readonly VITE_DEMO_ACCOUNTS?: string;
}
