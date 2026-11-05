import { errors, type Principal } from '@sportspark/contracts';

/** The organization a command runs in: always the principal's, never a request field (§4.3). */
export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}
