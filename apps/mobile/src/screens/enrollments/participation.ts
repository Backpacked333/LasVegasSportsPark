/**
 * SCR-C-32 vocabulary for the records shown next to enrollments (SPK-REG-001, SPK-REG-003,
 * SPK-YOUTH-003, SPK-UX-004, SPK-UX-010; docs/package-a/journeys.md section 3): applications,
 * trial participations and session bookings each keep their own state. A trial is never shown as
 * an enrollment; an application awaiting review reads "Awaiting approval"; a declined one reads
 * "Not approved" with the API's reason. Every phrase goes into a StatusBadge (glyph and words,
 * never colour alone).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';

type Application = Schema<'Application'>;
type TrialParticipation = Schema<'TrialParticipation'>;
type Enrollment = Schema<'Enrollment'>;
type Status = Pick<StatusBadgeProps, 'tone' | 'label'>;

export function applicationStatus(
  application: Pick<Application, 'status' | 'decisionReason'>,
): Status {
  switch (application.status) {
    case 'draft':
      return { tone: 'neutral', label: 'Not sent yet' };
    case 'submitted':
    case 'awaiting_review':
      return { tone: 'pending', label: 'Awaiting approval' };
    case 'accepted':
      return { tone: 'success', label: 'Approved' };
    case 'declined':
      return {
        tone: 'danger',
        label: application.decisionReason
          ? `Not approved: ${application.decisionReason}`
          : 'Not approved',
      };
    case 'withdrawn':
      return { tone: 'neutral', label: 'Withdrawn' };
  }
}

/** SPK-YOUTH-003: a trial participation, distinct from an enrollment. */
export function trialStatus(trial: Pick<TrialParticipation, 'status'>): Status {
  switch (trial.status) {
    case 'scheduled':
      return { tone: 'info', label: 'Trial booked' };
    case 'attended':
      return { tone: 'success', label: 'Trial attended' };
    case 'no_show':
      return { tone: 'neutral', label: 'Did not attend the trial' };
    case 'canceled':
      return { tone: 'neutral', label: 'Trial canceled' };
    case 'converted':
      return { tone: 'success', label: 'Registered after the trial' };
  }
}

export const SESSION_BOOKING_KIND_LABELS: Record<Schema<'SessionBookingKind'>, string> = {
  pickup: 'Pickup session',
  trial: 'Trial session',
  makeup: 'Makeup session',
  session: 'Single session',
};

/**
 * The offering an enrollment is for: the API's snapshot (ENR-02, also for closed and archived
 * offerings, with the facility zone), else the public offering when it is still readable.
 */
export function enrollmentOffering(
  enrollment: Pick<Enrollment, 'offering'> | { offering?: Enrollment['offering'] },
  readable:
    { name: string; startsOn: string; endsOn: string; facility?: { timezone: string } } | undefined,
): { name: string; startsOn: string; endsOn: string; timezone: string | null } | null {
  const snapshot = enrollment.offering ?? null;
  if (snapshot) {
    return {
      name: snapshot.name,
      startsOn: snapshot.startsOn,
      endsOn: snapshot.endsOn,
      timezone: snapshot.timezone,
    };
  }
  if (readable) {
    return {
      name: readable.name,
      startsOn: readable.startsOn,
      endsOn: readable.endsOn,
      timezone: readable.facility?.timezone ?? null,
    };
  }
  return null;
}

type FinancialConsequence = NonNullable<Schema<'FinancialConsequence'>>;

/** ENR-03: the consequence as accepted (kind, amount, currency), sent with the commit. */
export function acceptedOf(consequence: FinancialConsequence): Schema<'AcceptedConsequence'> {
  return {
    kind: consequence.kind,
    amountMinor: consequence.amountMinor,
    currency: consequence.currency,
  };
}

/** RESOURCE_CONFLICT sub-codes for a consequence that was not accepted as it now stands. */
export function consequenceConflict(error: ApiError | null): boolean {
  if (error?.code !== 'RESOURCE_CONFLICT') return false;
  const code = (error.details as { code?: unknown } | undefined)?.code;
  return code === 'CONSEQUENCE_CHANGED' || code === 'CONSEQUENCE_ACCEPTANCE_REQUIRED';
}
