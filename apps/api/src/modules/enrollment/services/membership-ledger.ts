import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, type Trx } from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { covers, type AppliesTo } from '../package-g/scopes';

/**
 * Who holds a membership at an instant (ENR-12, SPK-COND-001): a confirmed membership enrollment
 * whose term covers the instant and that no active suspension covers. Used by member-only
 * eligibility (a policy's `membershipRequired`) and by membership bookings. It reads enrollment's
 * own tables and the catalog offering port only, so the registration evaluator can depend on it.
 */
@Injectable()
export class MembershipLedger {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
  ) {}

  /** Whether an active suspension of the membership covers `at`. */
  async suspendedAt(
    trx: Trx | undefined,
    organizationId: string,
    enrollmentId: string,
    at: Date,
  ): Promise<boolean> {
    const row = await (trx ?? this.db)
      .selectFrom('membership_suspensions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .where('status', '=', 'active')
      .where('suspended_from', '<=', at)
      .where((eb) => eb.or([eb('suspended_until', 'is', null), eb('suspended_until', '>', at)]))
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Whether one of `personIds` holds a confirmed, unsuspended membership in the offerings or
   * programs of `requirement` whose term covers `at`. Unknown terms never satisfy it.
   */
  async holds(
    trx: Trx | undefined,
    organizationId: string,
    personIds: readonly string[],
    requirement: AppliesTo,
    at: Date,
  ): Promise<boolean> {
    if (personIds.length === 0) return false;
    const rows = await (trx ?? this.db)
      .selectFrom('enrollments')
      .select(['id', 'offering_id'])
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', [...personIds])
      .where('intent', '=', 'membership')
      .where('status', '=', 'confirmed')
      .where('membership_starts_at', '<=', at)
      .where('membership_ends_at', '>', at)
      .orderBy('id')
      .execute();
    for (const row of rows) {
      const snapshot = await this.offerings.getOffering(organizationId, row.offering_id, at, trx);
      if (!snapshot || !covers(requirement, snapshot.offering)) continue;
      if (await this.suspendedAt(trx, organizationId, row.id, at)) continue;
      return true;
    }
    return false;
  }
}
