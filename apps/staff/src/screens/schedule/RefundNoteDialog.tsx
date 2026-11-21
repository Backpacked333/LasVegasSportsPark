/**
 * Shortening a booked rental (INTERACTIONS 1b row 5): a rental booked through the booking flow
 * (`sourceType` enrollment.booking) cannot be made shorter than its booked length without a note
 * for the refund. The booking is read (`GET /v1/bookings/{id}`): while its payment is still
 * outstanding nothing was paid and no note is needed; once paid, the note is required and travels
 * as the schedule change's reason (kept in the draft, the publication and the audit). The refund
 * itself is requested on the booking's payment (finance owns it; DEC-009 pending), never here.
 */
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { localTimeOf } from '../../features/schedule-facilities/time';
import type { MoveProposal } from './useScheduleMove';

/** A resize that shortens a booked rental (the dialog then decides whether a note is needed). */
export function needsRefundNote(p: MoveProposal): boolean {
  const event = p.block.event;
  return (
    p.mode === 'resize' &&
    !!event &&
    event.kind === 'rental' &&
    event.sourceType === 'enrollment.booking' &&
    !!event.sourceId &&
    p.end - p.start < p.block.end - p.block.start
  );
}

export function RefundNoteDialog({
  proposal,
  timeZone,
  onCancel,
  onConfirm,
}: {
  proposal: MoveProposal;
  timeZone: string;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const bookingId = proposal.block.event?.sourceId ?? '';
  const booking = useApiQuery({ path: '/bookings/{id}', request: { path: { id: bookingId } } });
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const unpaid = booking.data?.outstanding.includes('payment') ?? false;
  const required = !unpaid;
  const minutes = (proposal.end - proposal.start) / 60_000;
  const booked = (proposal.block.end - proposal.block.start) / 60_000;
  const submit = () => {
    setAttempted(true);
    if (required && !note.trim()) return;
    onConfirm(note.trim());
  };
  return (
    <Dialog
      labelledBy="refund-note-title"
      onClose={onCancel}
      header={<h3 id="refund-note-title">Shorten {proposal.block.title}?</h3>}
      footer={
        <>
          <span className="caption" style={{ flex: 1 }}>
            The change is checked and waits for Notify or Undo.
          </span>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={booking.isPending}>
            Shorten to {minutes} min
          </Button>
        </>
      }
    >
      <p>
        Booked for {booked} min; the new time is {localTimeOf(proposal.start, timeZone)}–
        {localTimeOf(proposal.end, timeZone)} ({minutes} min).
      </p>
      {booking.isPending ? (
        <p className="caption">Checking whether the booking is paid…</p>
      ) : unpaid ? (
        <p className="caption">Not paid yet, so no refund is needed. A note is optional.</p>
      ) : (
        <p className="caption">
          This rental is paid. Say what the customer is owed; request the refund on the booking’s
          payment.
        </p>
      )}
      <label htmlFor="refund-note">{required ? 'Refund note (required)' : 'Note (optional)'}</label>
      <textarea
        id="refund-note"
        rows={3}
        value={note}
        maxLength={2000}
        aria-invalid={attempted && required && !note.trim() ? true : undefined}
        onChange={(e) => setNote(e.target.value)}
      />
      {attempted && required && !note.trim() ? (
        <span className="error-text" role="alert">
          A paid rental can’t be shortened without a refund note.
        </span>
      ) : null}
    </Dialog>
  );
}
