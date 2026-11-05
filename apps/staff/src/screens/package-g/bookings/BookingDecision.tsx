/**
 * Request-mode approval and decline (SCR-S-51, SCR-S-52; ENR-13, SPK-COND-003, SPK-REG-007,
 * §4.9): `POST /v1/bookings/{id}/approve` reserves the time now (every occurrence or nothing) and
 * starts the hold for payment; `POST /v1/bookings/{id}/decline` ends the request with a reason.
 * Both send the booking's `expectedRevision` and one idempotency key per intent ("Try again" after
 * no answer reuses it).
 *
 * - A slot taken since the request answers RESOURCE_CONFLICT: nothing was reserved, the booking
 *   stays requested, and "Reload the booking" reads it again.
 * - Approval needs the capability on (DEC-076 rentals, DEC-077 parties); it is not offered while
 *   off, and a CAPABILITY_DISABLED answer shows "turned off". Declining is never gated.
 * - Whether approval should reserve or take a deposit first is pending DEC-029 and DEC-030; the
 *   screen describes what the API does today and invents no deposit.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApp } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { TextAreaField } from '../../../ui/FormFields';
import { CommandProblem } from '../participation/CommandProblem';
import {
  ACTIONS,
  NotAvailableToYou,
  useActionAllowed,
  useCapabilityOn,
} from '../participation/permission';
import { BOOKING_STATUS, KIND_CAPABILITY, KIND_WORDS, type Booking } from './labels';

export const BOOKING_KEYS = [
  ['api', '/bookings/{id}'],
  ['api', '/bookings'],
] as const;

export function useReloadBooking() {
  const queryClient = useQueryClient();
  return () => {
    for (const queryKey of BOOKING_KEYS) void queryClient.invalidateQueries({ queryKey });
  };
}

function resourceLabelOf(booking: Booking) {
  const names = new Map(
    booking.occurrences.flatMap((o) => o.resources).map((r) => [r.id, r.name] as const),
  );
  return (id: string) => names.get(id) ?? `Resource ${id.slice(0, 8)}`;
}

export function ApproveBooking({
  booking,
  onDone,
}: {
  booking: Booking;
  /** Announces the outcome once the booking re-renders in its new state. */
  onDone: (message: string) => void;
}) {
  const { online } = useApp();
  const reload = useReloadBooking();
  const approve = useApiCommand('post', '/bookings/{id}/approve', { invalidate: BOOKING_KEYS });
  const words = KIND_WORDS[booking.kind];
  const allowed = useActionAllowed(ACTIONS.decideBooking, booking.facilityId);
  const capabilityOn = useCapabilityOn(KIND_CAPABILITY[booking.kind]);
  if (!allowed) {
    return <NotAvailableToYou what={`Approving ${words.many}`} action={ACTIONS.decideBooking} />;
  }
  if (!capabilityOn) {
    return (
      <p className="caption">
        Approving needs {words.many} turned on; declining and canceling stay available.
      </p>
    );
  }
  const submit = () =>
    void approve
      .submit({ path: { id: booking.id }, body: { expectedRevision: booking.revision } })
      .then((done) => onDone(`Approved: now ${BOOKING_STATUS[done.status].label}`))
      .catch(() => undefined);
  return (
    <div className="pg-panel" role="group" aria-label={`Approve the ${words.one}`}>
      <p>
        Approving reserves every occurrence now, with its resources, equipment and staff, and holds
        it for the customer to pay. If any time is no longer free, nothing is reserved and the
        request stays as it is.
      </p>
      <div className="pg-actions">
        <Button busy={approve.isProcessing} disabled={!online} onClick={submit}>
          Approve the {words.one}
        </Button>
      </div>
      {!online ? <p className="caption">Approving needs a connection.</p> : null}
      <CommandProblem
        error={approve.error}
        onRetry={submit}
        onReload={() => {
          approve.reset();
          reload();
        }}
        reloadLabel="Reload the booking"
        timeZone={booking.timezone}
        resourceLabel={resourceLabelOf(booking)}
      />
      {approve.error?.code === 'RESOURCE_CONFLICT' ? (
        <p role="status">Nothing was reserved: the booking is still requested.</p>
      ) : null}
    </div>
  );
}

export function DeclineBooking({
  booking,
  onDone,
}: {
  booking: Booking;
  onDone: (message: string) => void;
}) {
  const { online } = useApp();
  const reload = useReloadBooking();
  const decline = useApiCommand('post', '/bookings/{id}/decline', { invalidate: BOOKING_KEYS });
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const words = KIND_WORDS[booking.kind];
  const allowed = useActionAllowed(ACTIONS.decideBooking, booking.facilityId);
  if (!allowed) return null;
  const send = () =>
    void decline
      .submit({
        path: { id: booking.id },
        body: { reason: reason.trim(), expectedRevision: booking.revision },
      })
      .then((done) => onDone(`Declined: now ${BOOKING_STATUS[done.status].label}`))
      .catch(() => undefined);
  if (!open) {
    return (
      <div className="pg-actions">
        <Button variant="secondary" disabled={!online} onClick={() => setOpen(true)}>
          Decline the request…
        </Button>
      </div>
    );
  }
  return (
    <form
      className="pg-form pg-panel"
      noValidate
      aria-label={`Decline the ${words.one} request`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setReasonError('A reason is required; the customer is told and it is audited.');
          return;
        }
        setReasonError(null);
        send();
      }}
    >
      <TextAreaField
        label="Reason for declining"
        required
        value={reason}
        onChange={setReason}
        error={reasonError}
        maxLength={2000}
      />
      <div className="pg-actions">
        <Button type="submit" busy={decline.isProcessing} disabled={!online}>
          Decline the request
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
      <CommandProblem
        error={decline.error}
        onRetry={send}
        onReload={() => {
          decline.reset();
          reload();
        }}
      />
    </form>
  );
}
