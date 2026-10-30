/**
 * One rental or party for staff (SCR-S-51, SCR-S-52; ENR-13, SPK-COND-003): `GET /v1/bookings/{id}`
 * (the booker or staff in facility scope; anyone else NOT_FOUND, shown as "not available" without
 * implying the booking exists, §4.10).
 *
 * Shows the state in the machine's words and what is outstanding (approval, payment, staff
 * acceptance), every occurrence with its resources in the booking's facility zone (SPK-SCHED-008),
 * guests and equipment, the terms the booking was made under (confirmation mode, access
 * conditions, host responsibilities, and the approved version's deposit and buffers), the payment
 * (held basket, continued in assisted registration; "paid" only for the states that follow a
 * payment, `awaiting_staff`, `confirmed` and `completed`, never for an expired, declined or
 * canceled booking whose enrollment was created at hold time; an unknown outcome is never shown as
 * paid), the staffing (a party is `awaiting_staff` until its host accepts) with each occurrence's
 * staff requirements, uncovered slots and accepted assignees from the workforce coverage reads
 * (`GET /v1/assignment-requirements` and `GET /v1/assignments`, target the occurrence's event;
 * SPK-STAFF-002: proposed and offered never count as covered), and the commands the state allows:
 * approve or decline a request, cancel with its bound consequence.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { CommandSuccess } from '../../../ui/CommandFeedback';
import { Facts } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { isUuid } from '../../../ui/RecordRef';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { DefinitionView } from '../participation/DefinitionView';
import { formatInstant, formatRange, plural, shortRef, zoneOf } from '../participation/format';
import { AssetName, JoinedList, PersonNameView } from '../participation/names';
import { ApproveBooking, DeclineBooking } from './BookingDecision';
import { BookingTermsView, CONFIRMATION_WORDS } from './BookingTermsView';
import { CancelBooking } from './CancelBooking';
import { StaffCoverage } from './StaffCoverage';
import {
  BOOKING_STATUS,
  CAN,
  KIND_PATH,
  KIND_WORDS,
  OUTSTANDING,
  type Booking,
  type BookingKind,
} from './labels';

function Occurrences({ booking }: { booking: Booking }) {
  return (
    <ol className="pg-inline-list" aria-label="Occurrences">
      {booking.occurrences.map((o) => (
        <li key={o.start}>
          {formatRange(o.start, o.end, booking.timezone)}:{' '}
          {o.resources.map((r) => r.name ?? `Resource ${shortRef(r.id)}`).join(', ')}
          {o.eventId ? '' : ' (not reserved)'}
        </li>
      ))}
    </ol>
  );
}

function StaffingState({ booking }: { booking: Booking }) {
  const waitingForStaff = booking.outstanding.includes('staffing');
  const coverage = <StaffCoverage booking={booking} />;
  if (booking.status === 'awaiting_staff') {
    return (
      <div role="group" aria-label="Staffing">
        <StatusBadge tone="warning" label="Waiting for staff" />
        <p>
          Paid, but not confirmed: it becomes confirmed when every required staff assignment
          {booking.kind === 'party' ? ', including the host,' : ''} is accepted. If it starts
          unstaffed, the scheduler is alerted.
        </p>
        {coverage}
      </div>
    );
  }
  if (waitingForStaff) {
    return (
      <div role="group" aria-label="Staffing">
        <StatusBadge tone="pending" label="Staff not yet accepted" />
        <p>Required staff have not all accepted yet; payment alone will not confirm it.</p>
        {coverage}
      </div>
    );
  }
  if (booking.status === 'confirmed') {
    return (
      <div role="group" aria-label="Staffing">
        <StatusBadge tone="success" label="Staffed" />
        {coverage}
      </div>
    );
  }
  return null;
}

/** BookingMachine states reached only through a payment (pay_covered, pay_uncovered). */
const PAID_STATES: ReadonlySet<Booking['status']> = new Set([
  'awaiting_staff',
  'confirmed',
  'completed',
]);

function Payment({ booking }: { booking: Booking }) {
  if (booking.status === 'held' && booking.basketId) {
    return (
      <div role="group" aria-label="Payment">
        <StatusBadge tone="warning" label="Waiting for payment" />
        <p>
          Held for the customer to pay. Payment and any deposit are taken at checkout; until the
          checkout confirms it, it is not paid.
        </p>
        <Link to={`/registrations/assisted/${booking.basketId}`}>
          Continue to checkout in assisted registration
        </Link>
      </div>
    );
  }
  if (!booking.enrollmentId) return null;
  const enrollment = (
    <Link to={`/registrations/enrollments/${booking.enrollmentId}`}>
      enrollment {shortRef(booking.enrollmentId)}
    </Link>
  );
  // The enrollment is created when the booking is held, before any payment, and kept when the
  // hold expires or the booking ends: only the states after payment say "paid" (SPK-PAY-007).
  if (PAID_STATES.has(booking.status)) {
    return (
      <div role="group" aria-label="Payment">
        <p>Paid through its enrollment: {enrollment}.</p>
      </div>
    );
  }
  return (
    <div role="group" aria-label="Payment">
      <p>
        {booking.status === 'expired'
          ? 'The hold ended before it was paid; nothing was charged.'
          : 'Whether anything was paid or refunded is shown on its registration.'}{' '}
        Its registration: {enrollment}.
      </p>
    </div>
  );
}

function Detail({ booking }: { booking: Booking }) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const status = BOOKING_STATUS[booking.status];
  const words = KIND_WORDS[booking.kind];
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: booking.offeringId } },
    staleTime: 5 * 60_000,
  });
  const zone = zoneOf(booking.timezone);
  return (
    <article aria-labelledby="booking-title">
      <h4 id="booking-title">
        {booking.offeringName ?? `${words.title} booking`}:{' '}
        <PersonNameView id={booking.bookerPersonId} fallback="Booker" />
      </h4>
      <CommandSuccess message={outcome} />
      <p className="pg-badges">
        <StatusBadge tone={status.tone} label={status.label} />
        {booking.outstanding.map((o) => (
          <StatusBadge key={o} tone="pending" label={`Waiting for ${OUTSTANDING[o]}`} />
        ))}
      </p>
      <p>{status.meaning}</p>
      <Facts
        label={`${words.title} booking`}
        items={[
          ['Booker', <PersonNameView key="booker" id={booking.bookerPersonId} fallback="Booker" />],
          [
            'When',
            booking.occurrences.length > 1
              ? `Weekly, ${plural(booking.occurrences.length, 'occurrence')} from ${formatInstant(booking.firstStart, booking.timezone)}`
              : formatRange(booking.firstStart, booking.lastEnd, booking.timezone),
          ],
          ['Time zone', zone.known ? zone.zone : 'Not known: times are shown in UTC'],
          ...(booking.kind === 'party'
            ? ([
                ['Guests', booking.guestCount === null ? 'Not stated' : String(booking.guestCount)],
              ] as [string, string][])
            : []),
          [
            'Equipment',
            booking.equipmentAssetIds.length === 0 ? (
              'None'
            ) : (
              <JoinedList key="eq">
                {booking.equipmentAssetIds.map((id) => (
                  <AssetName key={id} id={id} />
                ))}
              </JoinedList>
            ),
          ],
          ['Confirmation', CONFIRMATION_WORDS[booking.terms.confirmationMode]],
          ['Access conditions', booking.terms.accessConditions ?? 'None stated'],
          ['Host responsibilities', booking.terms.hostResponsibilities ?? 'None stated'],
          ...(booking.decisionReason
            ? ([['Decision reason', booking.decisionReason]] as [string, string][])
            : []),
          ...(booking.endReason ? ([['End reason', booking.endReason]] as [string, string][]) : []),
          ['Requested', formatInstant(booking.createdAt, booking.timezone)],
          ['Revision', String(booking.revision)],
        ]}
      />
      <section className="pg-panel" aria-labelledby="booking-occurrences">
        <h5 id="booking-occurrences">Occurrences and resources</h5>
        <Occurrences booking={booking} />
      </section>
      <StaffingState booking={booking} />
      <Payment booking={booking} />
      {booking.status === 'requested' && booking.terms.confirmationMode === 'request' ? (
        <StateView
          variant="pending-decision"
          subject="Reserving the time or taking a deposit before approval"
          decisions={['DEC-029', 'DEC-030']}
          owner="Product and operations; Finance for refund rules"
        />
      ) : null}
      {CAN.decide(booking.status) ? (
        <section className="pg-panel" aria-labelledby="booking-decision">
          <h5 id="booking-decision">Decide the request</h5>
          <ApproveBooking booking={booking} onDone={setOutcome} />
          <DeclineBooking booking={booking} onDone={setOutcome} />
        </section>
      ) : null}
      {CAN.cancel(booking.status) ? (
        <section className="pg-panel" aria-labelledby="booking-cancel">
          <h5 id="booking-cancel">Cancel</h5>
          <CancelBooking booking={booking} onDone={setOutcome} />
        </section>
      ) : null}
      <section className="pg-panel" aria-labelledby="booking-terms">
        <h5 id="booking-terms">Terms the booking was made under</h5>
        <BookingTermsView
          policyVersionId={booking.terms.policyVersionId}
          timeZone={booking.timezone}
        />
      </section>
      <section className="pg-panel" aria-labelledby="booking-offering">
        <h5 id="booking-offering">What the offering reserves</h5>
        <QueryBoundary query={offering} label="the offering" empty={{ title: '', description: '' }}>
          {(data) => <DefinitionView definitionId={data.entitlementDefinitionId} />}
        </QueryBoundary>
      </section>
    </article>
  );
}

export function BookingDetail({ kind }: { kind: BookingKind }) {
  const { bookingId = '' } = useParams();
  const valid = isUuid(bookingId);
  const booking = useApiQuery({
    path: '/bookings/{id}',
    request: { path: { id: bookingId } },
    enabled: valid,
  });
  const words = KIND_WORDS[kind];
  const back = <Link to={KIND_PATH[kind]}>All {words.many}</Link>;
  if (!valid) {
    return (
      <>
        {back}
        <StateView variant="unavailable" title="Link not available" />
      </>
    );
  }
  return (
    <>
      {back}
      <QueryBoundary
        query={booking}
        label={`the ${words.one}`}
        empty={{ title: '', description: '' }}
        unavailableOffline={['approving', 'declining', 'canceling']}
      >
        {(data) =>
          data.kind === kind ? (
            <Detail booking={data} />
          ) : (
            <p>
              This booking is a {KIND_WORDS[data.kind].one}:{' '}
              <Link to={`${KIND_PATH[data.kind]}/${data.id}`}>
                open it under {KIND_WORDS[data.kind].many}
              </Link>
              .
            </p>
          )
        }
      </QueryBoundary>
    </>
  );
}
