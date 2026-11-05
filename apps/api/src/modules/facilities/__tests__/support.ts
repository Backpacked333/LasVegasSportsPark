import type { TestingModuleBuilder } from '@nestjs/testing';
import { PRINCIPAL_RESOLVER_IMPL } from '../../../kernel/kernel.module';
import type { VerifiedIdentity } from '../../../kernel/auth/identity-provider.port';
import type { TestApp } from '../../../testing';

/**
 * FacilitiesModule imports IdentityModule (assigned task owners are checked through the person
 * directory port, SPK-FAC-002), and the identity principal resolver would then answer the tokens
 * that `t.authHeader(staffPrincipal(...))` mints. Facilities API tests keep the fake principals:
 * pass `configure: keepFakePrincipals(() => t)` to `createTestApp`.
 */
export function keepFakePrincipals(
  app: () => TestApp | undefined,
): (builder: TestingModuleBuilder) => TestingModuleBuilder {
  return (builder) =>
    builder.overrideProvider(PRINCIPAL_RESOLVER_IMPL).useValue({
      resolve: async (identity: VerifiedIdentity) => {
        const current = app();
        return current ? current.principals.resolve(identity) : null;
      },
    });
}
