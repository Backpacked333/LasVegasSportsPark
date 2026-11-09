/// <reference types="vite/client" />

/** The build's version from package.json (vite `define`), sent in the client header (§4.13). */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** API origin plus `/v1`; defaults to the same-origin `/v1` proxy. */
  readonly VITE_API_BASE_URL?: string;
  /** `true` in a protected staging build: keeps the development sign-in (passcode on the API). */
  readonly VITE_STAGING?: string;
  /** Pending DEC-032/DEC-033: unset means data age is shown but never called stale. */
  readonly VITE_STALE_DATA_THRESHOLD_MINUTES?: string;
  /** Pending DEC-033: maximum roster age for queuing offline observations; unset = not configured. */
  readonly VITE_OFFLINE_ROSTER_MAX_AGE_MINUTES?: string;
  /** Managed sign-in (DEC-018): the identity provider's issuer, as the API's `AUTH_ISSUER`. */
  readonly VITE_AUTH_ISSUER?: string;
  /** This site's public client id at the identity provider (no secret exists). */
  readonly VITE_AUTH_CLIENT_ID?: string;
  /** The API audience, for providers that issue an API access token only when asked. */
  readonly VITE_AUTH_AUDIENCE?: string;
  /** Scopes to ask for; defaults to `openid email profile offline_access`. */
  readonly VITE_AUTH_SCOPE?: string;
  /** `id_token` when the API accepts the ID token as its bearer token; default the access token. */
  readonly VITE_AUTH_BEARER?: string;
  /** The organization a first-time sign-in registers its login account in. */
  readonly VITE_ORGANIZATION_SLUG?: string;
}
