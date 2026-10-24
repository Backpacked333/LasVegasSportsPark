import { Inject, Injectable } from '@nestjs/common';
import type { Principal, StaffRole } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  CLOCK,
  DATABASE,
  type Clock,
  type PrincipalResolverPort,
  type VerifiedIdentity,
} from '../../../kernel';

/** Throttle for the `last_login_at` touch so the auth path does not write on every request. */
const LAST_LOGIN_TOUCH_MS = 60 * 60_000;

export interface ResolvedAccount {
  id: string;
  organizationId: string;
  personId: string | null;
}

export interface EffectiveStaffMembership {
  roles: readonly string[];
  facilityIds: readonly string[];
}

/**
 * Pure mapping from account + person + staff memberships in effect to a Principal (unit-tested).
 * The actor label never carries names or other child data (§4.14): it is built from ids only.
 */
export function buildPrincipal(
  account: ResolvedAccount,
  memberships: readonly EffectiveStaffMembership[],
  sessionId: string | null,
): Principal {
  const roles = new Set<StaffRole>();
  let allFacilities = false;
  const facilities = new Set<string>();
  for (const membership of memberships) {
    for (const role of membership.roles) roles.add(role as StaffRole);
    if (membership.facilityIds.length === 0) allFacilities = true;
    for (const facility of membership.facilityIds) facilities.add(facility);
  }
  const staffRoles = [...roles].sort();
  const isStaff = staffRoles.length > 0;
  return {
    kind: isStaff ? 'staff' : 'customer',
    organizationId: account.organizationId,
    accountId: account.id,
    personId: account.personId,
    staffRoles,
    facilityIds: isStaff && !allFacilities ? [...facilities].sort() : [],
    sessionId,
    actorLabel: isStaff
      ? `staff:${staffRoles.join('+')}:${account.id.slice(0, 8)}`
      : `customer:${account.id.slice(0, 8)}`,
  };
}

/**
 * PRINCIPAL_RESOLVER_IMPL: verified identity (issuer, subject) → active account → active person →
 * staff memberships in effect at the clock → Principal. Anything missing or disabled resolves to
 * null, which the kernel guard reports as unauthenticated. The organization comes from the account
 * row, never from the token or the request (§4.8).
 */
@Injectable()
export class PrincipalResolver implements PrincipalResolverPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolve(identity: VerifiedIdentity): Promise<Principal | null> {
    const now = this.clock.now();
    const account = await this.db
      .selectFrom('accounts')
      .select(['id', 'organization_id', 'person_id', 'last_login_at'])
      .where('issuer', '=', identity.issuer)
      .where('subject', '=', identity.subject)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!account) return null;

    let memberships: EffectiveStaffMembership[] = [];
    if (account.person_id) {
      const person = await this.db
        .selectFrom('persons')
        .select(['status'])
        .where('organization_id', '=', account.organization_id)
        .where('id', '=', account.person_id)
        .executeTakeFirst();
      // An inactive or merged person cannot act; merges re-point accounts, so this only guards drift.
      if (!person || person.status !== 'active') return null;
      memberships = await this.db
        .selectFrom('staff_memberships')
        .select(['roles', 'facility_ids'])
        .where('organization_id', '=', account.organization_id)
        .where('person_id', '=', account.person_id)
        .where('status', '=', 'active')
        .where('effective_from', '<=', now)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
        .execute()
        .then((rows) => rows.map((r) => ({ roles: r.roles, facilityIds: r.facility_ids })));
    }

    const lastLogin = account.last_login_at ? new Date(account.last_login_at).getTime() : null;
    if (lastLogin === null || now.getTime() - lastLogin >= LAST_LOGIN_TOUCH_MS) {
      await this.db
        .updateTable('accounts')
        .set({ last_login_at: now })
        .where('id', '=', account.id)
        .execute();
    }

    return buildPrincipal(
      { id: account.id, organizationId: account.organization_id, personId: account.person_id },
      memberships,
      identity.sessionId,
    );
  }
}
