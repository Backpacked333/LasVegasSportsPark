import { Inject, Injectable } from '@nestjs/common';
import type { ArrivalIssue } from '@sportspark/contracts';
import { CLOCK, type Clock, type Trx } from '../../../kernel';
import { POLICY_PORT, type PolicyPort } from '../../catalog';
import { FIXTURE_PORT, ROSTER_PORT, type FixturePort, type RosterPort } from '../../competition';
import { ENROLLMENT_PORT, type EnrollmentPort } from '../../enrollment';
import type { EntryPolicy } from '../entry.policy';
import { FINANCIAL_STANDING_PORT, type FinancialStandingPort } from '../entry.ports';
import type { ResolvedActivity } from './activity-resolver';

export type ParticipationBasis =
  | { kind: 'enrollment'; enrollmentId: string; status: string }
  | { kind: 'session_booking'; bookingId: string; status: string }
  | { kind: 'event_commitment' }
  | { kind: 'roster_membership'; membershipId: string };

export interface ArrivalEvaluation {
  basis: ParticipationBasis | null;
  issues: ArrivalIssue[];
}

const issue = (
  code: ArrivalIssue['code'],
  severity: ArrivalIssue['severity'],
  message: string,
  nextAction: string,
  reference: ArrivalIssue['reference'] = null,
): ArrivalIssue => ({ code, severity, message, nextAction, reference });

export function hasBlocking(issues: readonly ArrivalIssue[]): boolean {
  return issues.some((i) => i.severity === 'blocking');
}

/**
 * Arrival checks for a session check-in (SPK-ENTRY-004). Every check produces an actionable issue
 * with a next action rather than a bare refusal:
 *   - participation basis (SPK-ENTRY-006): a confirmed enrollment or session booking from the
 *     enrollment module, a person commitment on the scheduling event, or an effective roster
 *     membership of the fixture's teams (competition). Nothing is ever created to make one exist.
 *     A pending one is `enrollment_not_confirmed`; none at all is `no_participation`.
 *   - required forms: each required policy version needs an active acknowledgment (catalog
 *     POLICY_PORT); a missing one blocks (MISSING_ACKNOWLEDGMENT category, §4.10).
 *   - balance: read from finance's FINANCIAL_STANDING_PORT. An unrelated balance is informational
 *     unless the approved policy expressly requires blocking (DEC-056); a related one is a warning
 *     (the enrollment state already expresses payment); an unknown standing never blocks.
 *   - activity state, and whether the person has a recorded facility arrival (warning only).
 * All reads go through the caller's transaction.
 */
@Injectable()
export class ArrivalChecks {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENROLLMENT_PORT) private readonly enrollments: EnrollmentPort,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    @Inject(FIXTURE_PORT) private readonly fixtures: FixturePort,
    @Inject(ROSTER_PORT) private readonly rosters: RosterPort,
    @Inject(FINANCIAL_STANDING_PORT) private readonly finance: FinancialStandingPort,
  ) {}

  async evaluate(
    trx: Trx,
    organizationId: string,
    personId: string,
    activity: ResolvedActivity,
    policy: EntryPolicy,
    onSite: boolean,
  ): Promise<ArrivalEvaluation> {
    const now = this.clock.now();
    const issues: ArrivalIssue[] = [];
    const basis =
      activity.detail.type === 'session'
        ? await this.sessionBasis(trx, organizationId, personId, activity, issues)
        : await this.eventBasis(trx, organizationId, personId, activity, issues);

    for (const formId of activity.requiredFormPolicyVersionIds) {
      const acknowledged = await this.policies.hasAcknowledgment(
        organizationId,
        personId,
        formId,
        trx,
      );
      if (!acknowledged) {
        issues.push(
          issue(
            'missing_acknowledgment',
            'blocking',
            'A required form has not been acknowledged for this participant.',
            'complete_acknowledgment',
            { type: 'policy_version', id: formId },
          ),
        );
      }
    }

    const standing = await this.finance.standingOf(
      organizationId,
      personId,
      { offeringId: activity.offeringId, at: now },
      trx,
    );
    if (standing.status === 'outstanding') {
      if (standing.related) {
        issues.push(
          issue(
            'outstanding_balance',
            'warning',
            'An amount for this activity is outstanding.',
            'review_balance',
            standing.reference ? { type: 'obligation', id: standing.reference } : null,
          ),
        );
      } else {
        issues.push(
          issue(
            'outstanding_balance',
            policy.blockOnUnrelatedBalance ? 'blocking' : 'info',
            policy.blockOnUnrelatedBalance
              ? 'An unrelated balance is outstanding and the approved policy requires it to be settled first.'
              : 'An unrelated balance is outstanding; it does not block participation.',
            'review_balance',
            standing.reference ? { type: 'obligation', id: standing.reference } : null,
          ),
        );
      }
    } else if (standing.status === 'unknown') {
      issues.push(
        issue(
          'balance_unknown',
          'info',
          'The financial standing is not available; it does not block participation.',
          'none',
        ),
      );
    }

    if (activity.canceled) {
      issues.push(
        issue(
          'activity_canceled',
          'blocking',
          'This activity is canceled.',
          'choose_another_activity',
        ),
      );
    } else if (now.getTime() >= activity.end.getTime()) {
      issues.push(
        issue('activity_ended', 'warning', 'This activity has already ended.', 'confirm_activity'),
      );
    }
    if (!onSite) {
      issues.push(
        issue(
          'not_on_site',
          'warning',
          'No facility arrival is recorded for this person.',
          'record_arrival',
        ),
      );
    }
    return { basis, issues };
  }

  /**
   * The person's participation basis for the activity (confirmed or pending), or null when they
   * take no part in it. Used to scope what an assigned coach may act on (SPK-ENTRY-007, §4.14);
   * reads the same facts as `evaluate`, without forms or finance.
   */
  async participationBasis(
    trx: Trx,
    organizationId: string,
    personId: string,
    activity: ResolvedActivity,
  ): Promise<ParticipationBasis | null> {
    const scratch: ArrivalIssue[] = [];
    return activity.detail.type === 'session'
      ? this.sessionBasis(trx, organizationId, personId, activity, scratch)
      : this.eventBasis(trx, organizationId, personId, activity, scratch);
  }

  private async sessionBasis(
    trx: Trx,
    organizationId: string,
    personId: string,
    activity: ResolvedActivity,
    issues: ArrivalIssue[],
  ): Promise<ParticipationBasis | null> {
    const [summary] = await this.enrollments.participationsOf(
      organizationId,
      [personId],
      { from: activity.start, to: activity.end },
      trx,
    );
    const bookings = (summary?.sessionBookings ?? []).filter(
      (b) => b.sessionId === activity.detail.sessionId,
    );
    const enrollments = (summary?.enrollments ?? []).filter(
      (e) => e.offeringId === activity.offeringId,
    );
    const confirmedBooking = bookings.find((b) => b.status === 'confirmed');
    if (confirmedBooking) {
      return { kind: 'session_booking', bookingId: confirmedBooking.id, status: 'confirmed' };
    }
    const confirmedEnrollment = enrollments.find((e) => e.status === 'confirmed');
    if (confirmedEnrollment) {
      return { kind: 'enrollment', enrollmentId: confirmedEnrollment.id, status: 'confirmed' };
    }
    const pendingBooking = bookings.find((b) => b.status === 'pending');
    const pendingEnrollment = enrollments.find((e) => e.status === 'pending');
    const pending: ParticipationBasis | null = pendingBooking
      ? { kind: 'session_booking', bookingId: pendingBooking.id, status: 'pending' }
      : pendingEnrollment
        ? { kind: 'enrollment', enrollmentId: pendingEnrollment.id, status: 'pending' }
        : null;
    if (pending) {
      issues.push(
        issue(
          'enrollment_not_confirmed',
          'blocking',
          'The participation for this session is not confirmed yet.',
          'complete_payment_or_confirmation',
          pending.kind === 'session_booking'
            ? { type: 'session_booking', id: pending.bookingId }
            : pending.kind === 'enrollment'
              ? { type: 'enrollment', id: pending.enrollmentId }
              : null,
        ),
      );
      return pending;
    }
    issues.push(
      issue(
        'no_participation',
        'blocking',
        'This person has no enrollment or booking for this session.',
        'register_or_book',
      ),
    );
    return null;
  }

  private async eventBasis(
    trx: Trx,
    organizationId: string,
    personId: string,
    activity: ResolvedActivity,
    issues: ArrivalIssue[],
  ): Promise<ParticipationBasis | null> {
    if (activity.personCommitments.includes(personId)) return { kind: 'event_commitment' };
    if (activity.fixtureId) {
      const fixture = await this.fixtures.findFixture(organizationId, activity.fixtureId, trx);
      const entries = fixture ? [fixture.homeEntryId, fixture.awayEntryId] : [];
      for (const entryId of entries) {
        if (!entryId) continue;
        const roster = await this.rosters.effectiveRoster(
          organizationId,
          entryId,
          activity.start,
          trx,
        );
        const member = roster.find((m) => m.personId === personId);
        if (member) return { kind: 'roster_membership', membershipId: member.membershipId };
      }
    }
    issues.push(
      issue(
        'no_participation',
        'blocking',
        'This person is not committed to this event or on a roster playing in it.',
        'verify_participation',
      ),
    );
    return null;
  }
}
