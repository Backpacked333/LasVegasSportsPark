import { errors } from '@sportspark/contracts';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../config';
import type { IdentityProviderPort, VerifiedIdentity } from './identity-provider.port';

/** How long a fetched key set is reused before it is fetched again (technical value). */
const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
/** The least time between two fetches triggered by an unknown key id (key rotation). */
const JWKS_COOLDOWN_MS = 30_000;
/** The longest a key set fetch may take before the request is answered as unavailable. */
const JWKS_TIMEOUT_MS = 5_000;

/**
 * jose failures that mean the provider's key set could not be read, as opposed to a token that
 * fails verification. They answer 503 INTEGRATION_UNAVAILABLE (retry later), never 401, so an
 * outage at the identity provider does not sign every user out (§4.10, §4.12).
 */
const KEY_SET_UNAVAILABLE = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID']);

/**
 * Managed identity behind `IdentityProviderPort` (§5.2, DEC-018; SPK-IAM-002): verifies bearer
 * tokens an OpenID Connect provider signed, against the provider's published JSON Web Key Set.
 * It checks the signature (asymmetric algorithms from `AUTH_ALLOWED_ALGS` only), the issuer, the
 * audience and the token times with `AUTH_CLOCK_SKEW_SECONDS` of tolerance. It names no vendor:
 * which provider issues the tokens is the decision recorded for the identity gate, and the
 * integration register admits this adapter only when `PROVIDER_DECISIONS` names that decision.
 * Accounts are matched on `(issuer, subject)` by the identity module (`PrincipalResolverPort`).
 */
export class OidcJwksIdentityProvider implements IdentityProviderPort {
  readonly name = 'oidc-jwks';
  private readonly keys: JWTVerifyGetKey;

  /** `keys` replaces the remote key set (tests and an in-process key set). */
  constructor(
    private readonly config: AppConfig,
    keys?: JWTVerifyGetKey,
  ) {
    if (keys) {
      this.keys = keys;
      return;
    }
    if (!config.AUTH_JWKS_URL) throw new Error('AUTH_JWKS_URL is required when AUTH_MODE=oidc');
    this.keys = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL), {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      timeoutDuration: JWKS_TIMEOUT_MS,
    });
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.AUTH_ISSUER,
        audience: this.config.AUTH_AUDIENCE,
        algorithms: [...this.config.AUTH_ALLOWED_ALGS],
        clockTolerance: this.config.AUTH_CLOCK_SKEW_SECONDS,
        requiredClaims: ['sub', 'iat', 'exp'],
      }));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && code.startsWith('ERR_') && !KEY_SET_UNAVAILABLE.has(code)) {
        throw errors.authenticationRequired('Token is invalid or expired.');
      }
      // A transport failure reading the key set (no jose code) or a key set timeout.
      throw errors.integrationUnavailable('Identity provider');
    }
    const { sub, iat, exp, iss: _iss, aud: _aud, sid, session_id: sessionId, ...rest } = payload;
    if (!sub || typeof iat !== 'number' || typeof exp !== 'number') {
      throw errors.authenticationRequired('Token is missing required claims.');
    }
    // Providers name the session `sid` (OpenID Connect) or `session_id`.
    const session =
      typeof sid === 'string' ? sid : typeof sessionId === 'string' ? sessionId : null;
    return {
      issuer: this.config.AUTH_ISSUER,
      subject: sub,
      sessionId: session,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
      claims: rest,
    };
  }
}
