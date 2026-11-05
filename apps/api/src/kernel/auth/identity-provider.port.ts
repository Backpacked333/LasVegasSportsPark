/**
 * Identity provider port (specification §5.2: managed identity is a provider-selection gate).
 * The kernel verifies a bearer token into a VerifiedIdentity; the identity module maps that
 * identity to an account and principal (PrincipalResolverPort).
 */
export interface VerifiedIdentity {
  issuer: string;
  /** Stable subject identifier at the provider (for the local provider: the account id). */
  subject: string;
  sessionId: string | null;
  issuedAt: Date;
  expiresAt: Date;
  /** Additional verified claims (never trusted for authorization on their own). */
  claims: Record<string, unknown>;
}

export interface IdentityProviderPort {
  readonly name: string;
  verify(token: string): Promise<VerifiedIdentity>;
}
