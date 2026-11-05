import { errors } from '@sportspark/contracts';
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '../config';
import type { IdentityProviderPort, VerifiedIdentity } from './identity-provider.port';

export interface LocalTokenClaims {
  subject: string;
  sessionId?: string | null;
  ttlSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * HS256 JWT provider for development and automated tests only. Refuses to exist in production
 * (see ConfigSchema). Mints and verifies tokens with issuer/audience checks.
 */
export class LocalJwtIdentityProvider implements IdentityProviderPort {
  readonly name = 'local-hs256';
  private readonly key: Uint8Array;

  constructor(private readonly config: AppConfig) {
    if (!config.AUTH_LOCAL_SECRET) throw new Error('AUTH_LOCAL_SECRET is required');
    this.key = new TextEncoder().encode(config.AUTH_LOCAL_SECRET);
  }

  async mint(claims: LocalTokenClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = claims.ttlSeconds ?? this.config.AUTH_TOKEN_TTL_SECONDS;
    return new SignJWT({ ...(claims.extra ?? {}), sid: claims.sessionId ?? null })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.config.AUTH_ISSUER)
      .setAudience(this.config.AUTH_AUDIENCE)
      .setSubject(claims.subject)
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .sign(this.key);
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.config.AUTH_ISSUER,
        audience: this.config.AUTH_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (!payload.sub || !payload.iat || !payload.exp) {
        throw errors.authenticationRequired('Token is missing required claims.');
      }
      const { sub: _sub, iat: _iat, exp: _exp, iss: _iss, aud: _aud, sid, ...rest } = payload;
      return {
        issuer: this.config.AUTH_ISSUER,
        subject: payload.sub,
        sessionId: typeof sid === 'string' ? sid : null,
        issuedAt: new Date(payload.iat * 1000),
        expiresAt: new Date(payload.exp * 1000),
        claims: rest,
      };
    } catch (error) {
      if (errors.authenticationRequired().constructor === (error as object)?.constructor)
        throw error;
      throw errors.authenticationRequired('Token is invalid or expired.');
    }
  }
}
