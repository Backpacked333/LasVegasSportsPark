import { Inject, Injectable } from '@nestjs/common';
import type {
  Enrollment,
  EnrollmentOffering,
  EnrollmentPendingReason,
  Principal,
} from '@sportspark/contracts';
import { CLOCK, FacilityDirectory, type Clock, type Trx } from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  POLICY_PORT,
  type OfferingLookupPort,
  type PolicyPort,
} from '../../catalog';
import {
  redactEnrollment,
  toEnrollment,
  toPolicyReferences,
  type Reader,
} from '../enrollment.shared';
import type { EnrollmentRow } from './enrollments.service';

/**
 * Enrollment as a person reads it (ENR-02; SPK-UX-004, SPK-SCHED-008). The record itself never
 * changes here: its offering (read through catalog's offering port, also once closed or archived)
 * and facility time zone (the kernel's facility directory) are added, and a pending enrollment
 * states what it waits for, derived from enrollment's own records — its application, basket and
 * placement request — and the required forms its policy references name (acknowledgments are
 * catalog's records, read through its policy port). Ports hand other modules the bare record.
 */
@Injectable()
export class EnrollmentViews {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    private readonly facilities: FacilityDirectory,
  ) {}

  /** Offering summaries with the facility zone, keyed by offering id (unknown ids omitted). */
  async offeringSummaries(
    organizationId: string,
    offeringIds: ReadonlyArray<string>,
    trx?: Trx,
  ): Promise<Map<string, EnrollmentOffering>> {
    const now = this.clock.now();
    const snapshots = new Map<
      string,
      {
        name: string;
        kind: EnrollmentOffering['kind'];
        startsOn: string;
        endsOn: string;
        facilityId: string;
      }
    >();
    for (const offeringId of new Set(offeringIds)) {
      const snapshot = await this.offerings.getOffering(organizationId, offeringId, now, trx);
      if (!snapshot) continue;
      snapshots.set(offeringId, {
        name: snapshot.offering.name,
        kind: snapshot.offering.kind,
        startsOn: snapshot.offering.startsOn,
        endsOn: snapshot.offering.endsOn,
        facilityId: snapshot.offering.facilityId,
      });
    }
    const facilities = await this.facilities.describe(
      organizationId,
      [...snapshots.values()].map((s) => s.facilityId),
      trx,
    );
    const out = new Map<string, EnrollmentOffering>();
    for (const [id, snapshot] of snapshots) {
      const facility = facilities.get(snapshot.facilityId);
      if (!facility) continue;
      out.set(id, { id, ...snapshot, timezone: facility.timezone });
    }
    return out;
  }

  /**
   * SPK-UX-004: what each pending enrollment still waits for, in the order it must happen:
   * approval before payment capture (SPK-REG-007), forms before the place is kept (SPK-REG-009),
   * payment of a held basket, then the placement of an individual registrant (SPK-PLACE-003).
   */
  async pendingReasons(
    db: Reader,
    organizationId: string,
    rows: readonly EnrollmentRow[],
  ): Promise<Map<string, EnrollmentPendingReason>> {
    const out = new Map<string, EnrollmentPendingReason>();
    const pending = rows.filter((r) => r.status === 'pending');
    if (pending.length === 0) return out;
    const applicationIds = pending
      .map((r) => r.source_application_id)
      .filter((id): id is string => !!id);
    const applications = new Map(
      (applicationIds.length > 0
        ? await db
            .selectFrom('applications')
            .select(['id', 'status'])
            .where('organization_id', '=', organizationId)
            .where('id', 'in', applicationIds)
            .execute()
        : []
      ).map((a) => [a.id, a.status] as const),
    );
    const basketIds = pending.map((r) => r.basket_id).filter((id): id is string => !!id);
    const baskets = new Map(
      (basketIds.length > 0
        ? await db
            .selectFrom('baskets')
            .select(['id', 'status'])
            .where('organization_id', '=', organizationId)
            .where('id', 'in', basketIds)
            .execute()
        : []
      ).map((b) => [b.id, b.status] as const),
    );
    const placementIds = pending
      .map((r) => r.placement_request_id)
      .filter((id): id is string => !!id);
    const placements = await db
      .selectFrom('placement_requests')
      .select(['id', 'enrollment_id', 'status'])
      .where('organization_id', '=', organizationId)
      .where((eb) =>
        placementIds.length > 0
          ? eb.or([
              eb(
                'enrollment_id',
                'in',
                pending.map((r) => r.id),
              ),
              eb('id', 'in', placementIds),
            ])
          : eb(
              'enrollment_id',
              'in',
              pending.map((r) => r.id),
            ),
      )
      .execute();
    for (const row of pending) {
      const application = row.source_application_id
        ? applications.get(row.source_application_id)
        : undefined;
      if (application === 'submitted' || application === 'awaiting_review') {
        out.set(row.id, 'approval');
        continue;
      }
      const forms = toPolicyReferences(row.policy_references).requiredFormPolicyVersionIds;
      let unsigned = false;
      for (const formId of forms) {
        if (
          !(await this.policies.hasAcknowledgment(
            organizationId,
            row.participant_person_id,
            formId,
            db as Trx,
          ))
        ) {
          unsigned = true;
          break;
        }
      }
      if (unsigned) {
        out.set(row.id, 'forms');
        continue;
      }
      const basket = row.basket_id ? baskets.get(row.basket_id) : undefined;
      if (basket === 'held' || basket === 'checking_out') {
        out.set(row.id, 'payment');
        continue;
      }
      const placement = placements.find(
        (p) => p.enrollment_id === row.id || p.id === row.placement_request_id,
      );
      if (placement && (placement.status === 'unassigned' || placement.status === 'proposed')) {
        out.set(row.id, 'placement');
      }
    }
    return out;
  }

  /** The person-facing view of enrollment rows: redacted, with offering and pending reason. */
  async views(
    db: Reader,
    organizationId: string,
    principal: Principal,
    rows: readonly EnrollmentRow[],
  ): Promise<Enrollment[]> {
    const trx = db as Trx;
    const offerings = await this.offeringSummaries(
      organizationId,
      rows.map((r) => r.offering_id),
      trx,
    );
    const reasons = await this.pendingReasons(db, organizationId, rows);
    return rows.map((row) => ({
      ...redactEnrollment(principal, toEnrollment(row)),
      offering: offerings.get(row.offering_id) ?? null,
      pendingReason: reasons.get(row.id) ?? null,
    }));
  }

  async view(
    db: Reader,
    organizationId: string,
    principal: Principal,
    row: EnrollmentRow,
  ): Promise<Enrollment> {
    const [view] = await this.views(db, organizationId, principal, [row]);
    return view as Enrollment;
  }
}
