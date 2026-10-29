/**
 * Customer-visible status phrases for the today screens, from docs/package-a/journeys.md section 3
 * (SPK-UX-010 consistent terminology). Every phrase is paired with a StatusBadge tone whose glyph
 * differs from its look-alikes, so "Payment processing", "Awaiting placement" and "Confirmed" are
 * different in words, glyph and colour (SPK-UX-004, SPK-UX-009: never colour alone).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';

type Enrollment = Schema<'Enrollment'>;
type Operation = Schema<'Operation'>;
type PlacementRequest = Schema<'PlacementRequest'>;
type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;
type FixtureStatus = Schema<'FixtureStatus'>;
type ReadinessStatus = Schema<'ReadinessStatus'>;
type ResultRevision = Schema<'ResultRevision'>;
type InboxItem = Schema<'InboxItem'>;

export type RsvpState = 'available' | 'unavailable' | 'tentative' | 'no_response';

/** The operation kind of a registration checkout (finance module, §4.11). */
export const CHECKOUT_OPERATION_KIND = 'finance.registration_checkout';

/** Journeys §3: Checkout `recovery_required`. Pinned above everything on Home (SCR-C-03). */
export const RECOVERY_PHRASE = 'Payment received. We are completing your registration.';
/** Journeys §3: Checkout `compensated`. */
export const COMPENSATED_PHRASE = 'Payment returned. Registration was not completed.';

/** Whether a pending registration's last operation needs the recovery treatment (§4.11). */
export function needsRecovery(operation: Operation | null | undefined): boolean {
  return operation?.status === 'recovery_required';
}

/**
 * Where a pending registration's checkout stands, from the records the API links to it: the
 * enrollment's basket (`checking_out` while the payment runs) and the basket's order
 * (`fulfillmentStatus`). The enrollment's `lastOperationId` stays null while a checkout runs, so it
 * cannot tell (reported API gap). `unknown` means the basket or order could not be read.
 */
export type CheckoutState = 'recovery_required' | 'compensated' | 'processing' | 'unknown' | null;

export function checkoutStateOf(
  basket: { status: string; orderRef: string | null } | null | undefined,
  order: { fulfillmentStatus: string } | null | undefined,
  readFailed: boolean,
): CheckoutState {
  if (order?.fulfillmentStatus === 'recovery_required') return 'recovery_required';
  if (order?.fulfillmentStatus === 'compensated') return 'compensated';
  if (basket?.status === 'checking_out') return 'processing';
  if (readFailed) return 'unknown';
  return null;
}

type PendingReason = NonNullable<Enrollment['pendingReason']>;

/**
 * What a pending registration still waits for, in journeys §3 words ("Registration pending:
 * <reason>", approval, payment or form outstanding, named), from the API's `pendingReason` (ENR-02).
 */
export const PENDING_REASON_PHRASES: Readonly<Record<PendingReason, string>> = {
  approval: 'Registration pending: awaiting approval',
  payment: 'Registration pending: payment outstanding',
  forms: 'Registration pending: a form to complete',
  placement: 'Registration pending: awaiting placement',
};

/**
 * Enrollment state as the customer sees it (journeys §3). The operation is the enrollment's
 * `lastOperationId` when it could be read; the placement is its placement request when it could
 * be read; `teamName` is the assigned team when known.
 */
export function enrollmentStatus(
  enrollment: Pick<Enrollment, 'status'> & { pendingReason?: Enrollment['pendingReason'] },
  options: {
    offeringName?: string | null;
    operation?: Operation | null;
    /** From the enrollment's basket and order (see `checkoutStateOf`). */
    checkout?: CheckoutState;
    placement?: Pick<PlacementRequest, 'status'> | null;
    teamName?: string | null;
  } = {},
): StatusBadgeProps {
  const { operation, placement, checkout } = options;
  switch (enrollment.status) {
    case 'pending': {
      if (operation?.status === 'recovery_required' || checkout === 'recovery_required') {
        return { tone: 'warning', label: RECOVERY_PHRASE };
      }
      if (operation?.status === 'compensated' || checkout === 'compensated') {
        return { tone: 'danger', label: COMPENSATED_PHRASE };
      }
      if (
        checkout === 'processing' ||
        (operation?.kind === CHECKOUT_OPERATION_KIND &&
          (operation.status === 'pending' || operation.status === 'running'))
      ) {
        return { tone: 'pending', label: 'Payment processing' };
      }
      // ENR-02: the API names what is outstanding; without a reason the phrase stays general.
      const reason = enrollment.pendingReason ?? null;
      if (reason && reason in PENDING_REASON_PHRASES) {
        return { tone: 'warning', label: PENDING_REASON_PHRASES[reason] };
      }
      return { tone: 'warning', label: 'Registration pending' };
    }
    case 'confirmed': {
      if (placement && (placement.status === 'unassigned' || placement.status === 'proposed')) {
        return {
          tone: 'info',
          label: options.offeringName
            ? `Confirmed in ${options.offeringName}. Awaiting placement.`
            : 'Confirmed. Awaiting placement.',
        };
      }
      if (placement?.status === 'assigned' && options.teamName) {
        return { tone: 'success', label: `Confirmed: ${options.teamName}` };
      }
      return { tone: 'success', label: 'Confirmed' };
    }
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
    case 'transferred':
      return { tone: 'neutral', label: 'Transferred' };
    case 'completed':
      return { tone: 'neutral', label: 'Completed' };
  }
}

/** Session booking states (journeys §3): "Booking pending", "Booked", "Canceled", "Expired". */
export function bookingStatus(status: string): StatusBadgeProps {
  switch (status) {
    case 'pending':
      return { tone: 'warning', label: 'Booking pending' };
    case 'confirmed':
      return { tone: 'success', label: 'Booked' };
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/**
 * A family calendar item's status from what the calendar carries: the enrollment's or the
 * booking's own state. Placement and payment detail need the enrollment (see enrollmentStatus).
 */
export function calendarItemStatus(item: Pick<FamilyCalendarItem, 'kind' | 'status'>) {
  if (item.kind === 'session_booking') return bookingStatus(item.status);
  if (item.status === 'pending' || item.status === 'confirmed') {
    return enrollmentStatus({ status: item.status });
  }
  return { tone: 'neutral', label: item.status } satisfies StatusBadgeProps;
}

/** Fixture states (journeys §3): a scheduled fixture shows its time and field elsewhere. */
export function fixtureStatus(status: FixtureStatus): StatusBadgeProps {
  switch (status) {
    case 'unscheduled':
      return { tone: 'neutral', label: 'Not yet scheduled' };
    case 'scheduled':
      return { tone: 'success', label: 'Scheduled' };
    case 'postponed':
      return { tone: 'warning', label: 'Postponed' };
    case 'played':
      return { tone: 'neutral', label: 'Final' };
    case 'forfeit':
      return { tone: 'neutral', label: 'Forfeit' };
    case 'canceled':
      return { tone: 'danger', label: 'Canceled' };
    case 'abandoned':
      return { tone: 'danger', label: 'Abandoned' };
  }
}

/** Whether the API accepts an RSVP in this fixture state (fixtures.service: unscheduled, scheduled, postponed). */
export function fixtureAcceptsRsvp(status: FixtureStatus): boolean {
  return status === 'unscheduled' || status === 'scheduled' || status === 'postponed';
}

/** RSVP (SPK-CAP-003): never attendance, never eligibility. */
export function rsvpStatus(state: RsvpState | null | undefined): StatusBadgeProps {
  switch (state) {
    case 'available':
      return { tone: 'success', label: 'Available' };
    case 'unavailable':
      return { tone: 'danger', label: 'Unavailable' };
    case 'tentative':
      return { tone: 'pending', label: 'Tentative' };
    default:
      return { tone: 'neutral', label: 'No response' };
  }
}

/**
 * Match readiness as a customer sees it (SPK-READY-002). Readiness is an assessment the API
 * computes, never an editable "ready" flag (SPK-READY-004).
 */
export function readinessStatus(status: ReadinessStatus): StatusBadgeProps {
  switch (status) {
    case 'ready':
      return { tone: 'success', label: 'Match readiness: ready' };
    case 'warning':
      return { tone: 'warning', label: 'Match readiness: needs attention' };
    case 'unknown':
      return { tone: 'pending', label: 'Match readiness: not yet known' };
    case 'blocked':
      return { tone: 'danger', label: 'Match readiness: blocked' };
  }
}

/** Readiness issue severity in words (SPK-READY-002). */
export function severityStatus(severity: string): StatusBadgeProps {
  switch (severity) {
    case 'blocking':
      return { tone: 'danger', label: 'Blocking' };
    case 'warning':
      return { tone: 'warning', label: 'Warning' };
    case 'unknown':
      return { tone: 'pending', label: 'Evidence unknown' };
    default:
      return { tone: 'info', label: 'Information' };
  }
}

/** Role names as written for customers ("captain" rather than an internal id). */
export function roleLabel(role: string): string {
  const words = role.replace(/_/g, ' ').trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : role;
}

/**
 * The result to show for a fixture (SPK-RESULT-001): the current official revision, else the
 * latest submitted one as "Provisional". Drafts and returned revisions are never shown.
 */
export function currentResult(results: readonly ResultRevision[]): ResultRevision | null {
  const official = results.filter((r) => r.status === 'official');
  if (official.length > 0) {
    return official.reduce((a, b) => (b.revisionNo > a.revisionNo ? b : a));
  }
  const submitted = results.filter((r) => r.status === 'submitted');
  if (submitted.length > 0) {
    return submitted.reduce((a, b) => (b.revisionNo > a.revisionNo ? b : a));
  }
  return null;
}

/** "Official", "Provisional", or "Official. Corrected on <date>" (journeys §3). */
export function resultStatus(
  result: ResultRevision,
  formatDate: (iso: string) => string,
): StatusBadgeProps {
  if (result.status === 'official') {
    if (result.supersedesRevisionId && result.publishedAt) {
      return { tone: 'success', label: `Official. Corrected on ${formatDate(result.publishedAt)}` };
    }
    return { tone: 'success', label: 'Official' };
  }
  return { tone: 'pending', label: 'Provisional' };
}

/** Inbox states (journeys §3): "Unread", "Read", "Acknowledged", "Replaced by a newer update". */
export function noticeStatus(item: InboxItem): StatusBadgeProps {
  if (item.supersededByNotificationId) {
    return { tone: 'neutral', label: 'Replaced by a newer update' };
  }
  if (item.acknowledgedAt) return { tone: 'success', label: 'Acknowledged' };
  if (item.readAt) return { tone: 'neutral', label: 'Read' };
  return { tone: 'info', label: 'Unread' };
}
