/**
 * Customer-visible status phrases for registration, holds, quotes, payment, enrollment and
 * waitlists, from docs/package-a/journeys.md section 3 (SPK-UX-004, SPK-UX-010). Every status is a
 * StatusBadge: a distinct glyph and the full phrase, never colour alone (SPK-UX-009). "Payment
 * processing" (pending), "Confirmed in <offering>. Awaiting placement." (info) and "Confirmed"
 * (success) never share a tone, glyph or wording.
 *
 * Nothing here is shown as success before the API says so: "Confirmed" requires an enrollment the
 * API reports `confirmed`, and a payment whose outcome is unknown is never "Payment failed"
 * (SPK-PAY-007).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { formatDateOnly, formatInstant, hasPassed } from './format';

type PublicOffering = Schema<'PublicOffering'>;
type Basket = Schema<'Basket'>;
type BasketLine = Schema<'BasketLine'>;
type Quote = Schema<'Quote'>;
type Checkout = Schema<'Checkout'>;
/** The component is registered nullable in the OpenAPI document; a present attempt is not. */
type PaymentAttempt = NonNullable<Schema<'PaymentAttempt'>>;
type Enrollment = Schema<'Enrollment'>;
type PlacementRequest = Schema<'PlacementRequest'>;
type WaitlistEntry = Schema<'WaitlistEntry'>;
type WaitlistOffer = Schema<'WaitlistOffer'>;
type Operation = Schema<'Operation'>;

/**
 * Registration window (SPK-CAT-004): paused is never shown as closed. The opening time is shown
 * in the offering's facility time zone when the API gives it (SPK-SCHED-008).
 */
export function registrationWindowStatus(
  offering: Pick<PublicOffering, 'publicationState' | 'registrationOpensAt'> & {
    facility?: { timezone: string } | null;
  },
): StatusBadgeProps {
  switch (offering.publicationState) {
    case 'registration_open':
      return { tone: 'success', label: 'Registration open' };
    case 'registration_paused':
      return { tone: 'warning', label: 'Registration paused' };
    case 'published':
      return offering.registrationOpensAt
        ? {
            tone: 'info',
            label: `Registration opens ${formatInstant(
              offering.registrationOpensAt,
              offering.facility?.timezone,
            )}`,
          }
        : { tone: 'info', label: 'Registration not open yet' };
    default:
      return { tone: 'neutral', label: 'Registration closed' };
  }
}

/** "Place held until <server time>": a hold is never a confirmation (SPK-REG-006). */
export function holdStatus(expiresAt: string, now: Date): StatusBadgeProps {
  if (hasPassed(expiresAt, now)) {
    return {
      tone: 'warning',
      label: 'Hold time is up. Checking whether your place is still held.',
    };
  }
  return { tone: 'pending', label: `Place held until ${formatInstant(expiresAt)}` };
}

export function basketStatus(basket: Basket, now: Date): StatusBadgeProps {
  switch (basket.status) {
    case 'open':
      return basket.approvalPending
        ? { tone: 'pending', label: 'Awaiting approval' }
        : { tone: 'neutral', label: 'In your basket. No place is held yet.' };
    case 'held':
      return basket.holdExpiresAt
        ? holdStatus(basket.holdExpiresAt, now)
        : { tone: 'pending', label: 'Place held' };
    case 'checking_out':
      return { tone: 'pending', label: 'Payment processing' };
    case 'fulfilled':
      return { tone: 'success', label: 'Registration complete' };
    case 'partially_fulfilled':
      return { tone: 'warning', label: 'Some registrations completed. See each line.' };
    case 'expired':
    case 'released':
      return { tone: 'warning', label: 'Your held place was released' };
    case 'abandoned':
      return { tone: 'neutral', label: 'This basket is no longer active' };
  }
}

export function basketLineStatus(line: BasketLine): StatusBadgeProps {
  if (line.requiresApproval && line.applicationStatus !== 'accepted') {
    if (line.applicationStatus === 'declined') return { tone: 'danger', label: 'Not approved' };
    return { tone: 'pending', label: 'Awaiting approval' };
  }
  switch (line.outcome) {
    case 'pending':
      return line.eligibility && !line.eligibility.eligible
        ? { tone: 'danger', label: 'Not eligible as entered' }
        : { tone: 'neutral', label: 'Not held yet' };
    case 'held':
      return { tone: 'pending', label: 'Place held' };
    case 'confirmed':
      return { tone: 'success', label: 'Confirmed' };
    case 'failed':
      return { tone: 'danger', label: 'Could not be held' };
    case 'released':
      return { tone: 'neutral', label: 'Released' };
  }
}

/** "Price valid until <time>" or "Price expired. Get a new price." (SPK-PAY-002, POL-013). */
export function quoteStatus(quote: Pick<Quote, 'status' | 'expiresAt'>, now: Date) {
  if (quote.status === 'consumed') {
    return { tone: 'neutral', label: 'This price was used for a checkout' } as StatusBadgeProps;
  }
  if (quote.status === 'expired' || hasPassed(quote.expiresAt, now)) {
    return { tone: 'warning', label: 'Price expired. Get a new price.' } as StatusBadgeProps;
  }
  return {
    tone: 'info',
    label: `Price valid until ${formatInstant(quote.expiresAt)}`,
  } as StatusBadgeProps;
}

/** Payment attempt (SPK-PAY-007): unknown is "being confirmed", never failed. */
export function paymentStatus(payment: PaymentAttempt): StatusBadgeProps {
  switch (payment.status) {
    case 'action_required':
      return { tone: 'warning', label: 'Payment needs your action' };
    case 'created':
    case 'processing':
      // `created` is answered with nextAction `await_payment_confirmation`: nothing to do yet.
      return { tone: 'pending', label: 'Payment processing' };
    case 'unknown':
      return { tone: 'warning', label: 'Payment outcome being confirmed. Do not pay again.' };
    case 'succeeded':
      return { tone: 'success', label: 'Payment received' };
    case 'failed':
      return { tone: 'danger', label: 'Payment failed' };
    case 'canceled':
      return { tone: 'neutral', label: 'Payment canceled' };
  }
}

/** The checkout as a whole (§4.11 Checkout machine). */
export function checkoutStatus(checkout: Checkout): StatusBadgeProps {
  switch (checkout.status) {
    case 'completed':
      return { tone: 'success', label: 'Registration complete' };
    case 'recovery_required':
      return {
        tone: 'warning',
        label: 'Payment received. We are completing your registration.',
      };
    case 'compensated':
      return { tone: 'neutral', label: 'Payment returned. Registration was not completed.' };
    case 'aborted':
      return { tone: 'neutral', label: 'Checkout canceled' };
    case 'finalizing':
      return { tone: 'pending', label: 'Payment processing' };
    case 'prepared':
    case 'awaiting_payment':
      if (checkout.payment) return paymentStatus(checkout.payment);
      return { tone: 'pending', label: 'Payment processing' };
  }
}

/** True while the checkout can still change without the customer doing anything. */
export function checkoutInFlight(checkout: Checkout): boolean {
  if (checkout.status === 'finalizing') return true;
  if (checkout.status === 'prepared' || checkout.status === 'awaiting_payment') {
    const payment = checkout.payment?.status;
    return (
      payment === 'created' ||
      payment === 'processing' ||
      payment === 'unknown' ||
      payment === 'action_required'
    );
  }
  return false;
}

/**
 * journeys.md section 3: "Registration pending: <reason>", the outstanding requirement named
 * from the API's `pendingReason` (ENR-02, SPK-UX-004); without one, plain "Registration pending".
 */
export const PENDING_REASON_LABELS: Record<Schema<'EnrollmentPendingReason'>, string> = {
  approval: 'Registration pending: awaiting approval',
  payment: 'Registration pending: payment not finished',
  forms: 'Registration pending: a required form is not signed',
  placement: 'Registration pending: awaiting placement',
};

export function pendingLabel(reason: Schema<'EnrollmentPendingReason'> | null | undefined): string {
  return reason ? PENDING_REASON_LABELS[reason] : 'Registration pending';
}

/** Enrollment per line (SPK-REG-003, SPK-PLACE-002); placement is its own record. */
export function enrollmentStatus(
  enrollment: Pick<Enrollment, 'status'> & Partial<Pick<Enrollment, 'pendingReason'>>,
  offeringName: string,
  placement:
    (Pick<PlacementRequest, 'status'> & Partial<Pick<PlacementRequest, 'assignedTeamName'>>) | null,
): StatusBadgeProps {
  switch (enrollment.status) {
    case 'pending':
      return { tone: 'pending', label: pendingLabel(enrollment.pendingReason) };
    case 'confirmed':
      if (placement && (placement.status === 'unassigned' || placement.status === 'proposed')) {
        return { tone: 'info', label: `Confirmed in ${offeringName}. Awaiting placement.` };
      }
      if (placement?.status === 'assigned') {
        // journeys.md: "Confirmed: <team or group>", with the team the API names (ENR-02).
        return placement.assignedTeamName
          ? { tone: 'success', label: `Confirmed: ${placement.assignedTeamName}` }
          : { tone: 'success', label: `Confirmed in ${offeringName}. Placed on a team.` };
      }
      return { tone: 'success', label: `Confirmed in ${offeringName}` };
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
    case 'transferred':
      return { tone: 'neutral', label: 'Transferred' };
    case 'completed':
      return { tone: 'neutral', label: 'Completed' };
  }
}

export function operationLabel(operation: Pick<Operation, 'status'>): StatusBadgeProps {
  switch (operation.status) {
    case 'pending':
    case 'running':
      return { tone: 'pending', label: 'Processing' };
    case 'succeeded':
      return { tone: 'success', label: 'Done' };
    case 'failed':
      return { tone: 'danger', label: 'Failed' };
    case 'recovery_required':
    case 'compensated':
      return { tone: 'warning', label: 'Needs attention' };
  }
}

/** The open offer of an entry, if any (status `offered`). */
export function openOffer(entry: WaitlistEntry): WaitlistOffer | null {
  return entry.offers.find((o) => o.status === 'offered') ?? null;
}

/**
 * "Place offered. Accept by <server time>." in the facility time zone when known
 * (SPK-SCHED-008); once the device clock passes it, the record is read again, never decided here.
 */
export function offerDeadlineStatus(
  expiresAt: string,
  now: Date,
  timeZone?: string,
): StatusBadgeProps {
  return hasPassed(expiresAt, now)
    ? { tone: 'neutral', label: 'Offer time is up. Checking the offer.' }
    : { tone: 'warning', label: `Place offered. Accept by ${formatInstant(expiresAt, timeZone)}.` };
}

/** SPK-REG-008: "Waitlisted for <offering>", "Place offered. Accept by <server time>." */
export function waitlistEntryStatus(
  entry: WaitlistEntry,
  offeringName: string,
  now: Date,
  timeZone?: string,
): StatusBadgeProps {
  const offer = openOffer(entry);
  if (offer) return waitlistOfferStatus(offer, now, timeZone);
  switch (entry.status) {
    case 'waiting':
      return {
        tone: 'neutral',
        label:
          entry.position !== null
            ? `Waitlisted for ${offeringName}. Position ${entry.position}.`
            : `Waitlisted for ${offeringName}`,
      };
    case 'offered':
      return { tone: 'warning', label: 'Place offered' };
    case 'accepted':
      return { tone: 'success', label: 'Offer accepted' };
    case 'expired':
      return { tone: 'neutral', label: 'Offer expired' };
    case 'withdrawn':
      return { tone: 'neutral', label: 'You left this waitlist' };
    case 'removed':
      return { tone: 'neutral', label: 'Removed from this waitlist' };
  }
}

export function waitlistOfferStatus(
  offer: WaitlistOffer,
  now: Date,
  timeZone?: string,
): StatusBadgeProps {
  switch (offer.status) {
    case 'offered':
      return offerDeadlineStatus(offer.expiresAt, now, timeZone);
    case 'accepted':
      return { tone: 'success', label: 'Offer accepted' };
    case 'expired':
      return { tone: 'neutral', label: 'Offer expired' };
    case 'declined':
      return { tone: 'neutral', label: 'Offer declined' };
  }
}

export function offeringDates(offering: Pick<PublicOffering, 'startsOn' | 'endsOn'>): string {
  return offering.startsOn === offering.endsOn
    ? formatDateOnly(offering.startsOn)
    : `${formatDateOnly(offering.startsOn)} to ${formatDateOnly(offering.endsOn)}`;
}
