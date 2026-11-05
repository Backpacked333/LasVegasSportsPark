import type { Principal } from '@sportspark/contracts';
import type { VerifiedIdentity } from './identity-provider.port';

/**
 * Maps a verified identity to the principal used for authorization: account, person,
 * organization, staff roles and facility scope. Implemented by the identity module.
 * Returns null when no active account matches (the request is then unauthenticated).
 */
export interface PrincipalResolverPort {
  resolve(identity: VerifiedIdentity): Promise<Principal | null>;
}
