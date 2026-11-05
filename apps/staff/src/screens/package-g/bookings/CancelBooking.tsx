/**
 * Cancel a rental or party with its consequence shown first (SCR-S-51, SCR-S-52; ENR-13, ENR-03,
 * SPK-REG-010, SPK-COND-003, §4.9): `POST /v1/bookings/{id}/cancel` with a reason, the booking's
 * `expectedRevision` and one idempotency key per intent. Cancellation is never gated by the
 * capability switch (DEC-016).
 *
 * - requested: nothing is reserved or paid, so nothing is released or charged.
 * - held: canceling releases the reservation, its hold and the basket, and is offered only while
 *   the basket shows nothing was paid (`open`, `held`, or ended unpaid: `expired`, `released`,
 *   `abandoned`). The basket (`GET /v1/baskets/{id}`) is read again right before the cancel is
 *   sent. While it is `checking_out` a payment may be on its way; once it is `fulfilled` or
 *   `partially_fulfilled` the payment completed and the booking moves on asynchronously (the
 *   enrollment's confirmation), so in both cases cancellation is not offered and "Reload the
 *   booking" reads it again. A basket the viewer cannot read leaves the checkout state unknown,
 *   so cancellation is not offered either (the outcome is never assumed). The API refuses the
 *   first two itself (README API issue 3, fixed): 409 RESOURCE_CONFLICT `CHECKOUT_IN_PROGRESS`
 *   while the basket is `checking_out` and `BOOKING_CONFIRMATION_PENDING` once it is `fulfilled`;
 *   both answers are shown in words with "Reload the booking". A `partially_fulfilled` basket is
 *   not refused by the API, so for it the basket re-read here is the only guard.
 * - awaiting_staff or confirmed (paid): the enrollment's cancellation preview
 *   (`GET /v1/enrollments/{id}/cancellation-preview`) shows the refund, credit or charge as the API
 *   computed it; a consequence other than "none" needs the customer's acceptance, and the previewed
 *   consequence is sent as `acceptedConsequence`. If it changed meanwhile the API answers
 *   RESOURCE_CONFLICT `CONSEQUENCE_CHANGED` (or `CONSEQUENCE_ACCEPTANCE_REQUIRED`) and "Preview
 *   again" reads it again. Refund and deposit rules are pending DEC-009 and DEC-030 (Finance); the
 *   amount is the API's, never recomputed here.
 */
import type { Schema } from '@sportspark/api-client';
import { presentationForError } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { useApp } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { Facts, TextAreaField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { CommandProblem, detailCode } from '../participation/CommandProblem';
import { formatMoney, shortRef } from '../participation/format';
import { ACTIONS, NotAvailableToYou, useActionAllowed } from '../participation/permission';
import { BOOKING_KEYS, useReloadBooking } from './BookingDecision';
import { BOOKING_STATUS, KIND_WORDS, type Booking } from './labels';

type Consequence = Schema<'FinancialConsequence'>;
type AcceptedConsequence = Schema<'AcceptedConsequence'>;
type BasketStatus = Schema<'BasketStatus'>;

const BASKET_KEY = ['api', '/baskets/{id}'] as const;

/** Basket states in which nothing was paid, so a held booking may be canceled (SPK-PAY-007). */
const UNPAID_BASKET: ReadonlySet<BasketStatus> = new Set([
  'open',
  'held',
  'expired',
  'released',
  'abandoned',
]);

/**
 * Checked right before the cancel is sent: null to send, or why nothing was sent (the caller's
 * view also re-renders from the fresh read).
 */
type BeforeSend = () => Promise<string | null>;

export const CONSEQUENCE_KIND: Record<
  Consequence['kind'],
  { tone: 'neutral' | 'info' | 'warning' | 'pending'; label: string }
> = {
  none: { tone: 'neutral', label: 'No financial change' },
  refund: { tone: 'info', label: 'Refund' },
  credit: { tone: 'info', label: 'Credit' },
  charge: { tone: 'warning', label: 'Additional charge' },
  review_required: { tone: 'pending', label: 'Finance review required' },
};

export function ConsequenceView({ consequence }: { consequence: Consequence }) {
  const kind = CONSEQUENCE_KIND[consequence.kind];
  return (
    <div className="row-text" role="group" aria-label="Financial consequence">
      <span>
        <StatusBadge tone={kind.tone} label={kind.label} />{' '}
        {consequence.amountMinor !== null
          ? formatMoney(consequence.amountMinor, consequence.currency)
          : null}
      </span>
      <span>{consequence.explanation}</span>
      <span className="caption">
        Cancellation policy{' '}
        {consequence.policyVersionId ? shortRef(consequence.policyVersionId) : 'none stated'}.
        Refund, credit and deposit rules are pending DEC-009 and DEC-030 (owner: Finance); the
        amount is the API&apos;s.
      </span>
    </div>
  );
}

function CancelForm({
  booking,
  accepted,
  needsAcceptance,
  onDone,
  onPreviewAgain,
  reasonState,
  beforeSend,
}: {
  booking: Booking;
  /** The consequence the customer accepted, as previewed; sent with a paid booking. */
  accepted?: AcceptedConsequence;
  needsAcceptance?: boolean;
  onDone: (message: string) => void;
  onPreviewAgain?: () => void;
  /** Kept by the caller when the form remounts for a new preview (the typed reason stays). */
  reasonState?: [string, (value: string) => void];
  beforeSend?: BeforeSend;
}) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const reloadBooking = useReloadBooking();
  const reload = () => {
    reloadBooking();
    void queryClient.invalidateQueries({ queryKey: BASKET_KEY });
  };
  const cancel = useApiCommand('post', '/bookings/{id}/cancel', {
    invalidate: [...BOOKING_KEYS, BASKET_KEY, ['api', '/enrollments/{id}/cancellation-preview']],
  });
  const [checking, setChecking] = useState(false);
  const [notSent, setNotSent] = useState<string | null>(null);
  const ownReason = useState('');
  const [reason, setReason] = reasonState ?? ownReason;
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [acceptedByCustomer, setAcceptedByCustomer] = useState(false);
  const words = KIND_WORDS[booking.kind];
  const send = async () => {
    if (beforeSend) {
      setChecking(true);
      const problem = await beforeSend();
      setChecking(false);
      setNotSent(problem);
      if (problem) return;
    }
    await cancel
      .submit({
        path: { id: booking.id },
        body: {
          reason: reason.trim(),
          expectedRevision: booking.revision,
          ...(accepted ? { acceptedConsequence: accepted } : {}),
        },
      })
      .then((done) => onDone(`Canceled: now ${BOOKING_STATUS[done.status].label}`))
      .catch(() => undefined);
  };
  const code = detailCode(cancel.error);
  const consequenceChanged =
    code === 'CONSEQUENCE_CHANGED' || code === 'CONSEQUENCE_ACCEPTANCE_REQUIRED';
  return (
    <form
      className="pg-form"
      noValidate
      aria-label={`Cancel the ${words.one}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setReasonError('A reason is required; it is audited.');
          return;
        }
        setReasonError(null);
        void send();
      }}
    >
      <TextAreaField
        label="Reason for canceling"
        required
        value={reason}
        onChange={setReason}
        error={reasonError}
        maxLength={2000}
      />
      {needsAcceptance ? (
        <label className="choice">
          <input
            type="checkbox"
            checked={acceptedByCustomer}
            onChange={(event) => setAcceptedByCustomer(event.target.checked)}
          />
          The customer accepted the financial consequence shown
        </label>
      ) : null}
      <div className="pg-actions">
        <Button
          type="submit"
          busy={cancel.isProcessing || checking}
          disabled={!online || (needsAcceptance === true && !acceptedByCustomer)}
        >
          Cancel the {words.one}
        </Button>
      </div>
      {!online ? <p className="caption">Canceling needs a connection.</p> : null}
      {notSent ? (
        <p className="error-text" role="alert">
          {notSent}
        </p>
      ) : null}
      <CommandProblem
        error={cancel.error}
        onRetry={() => void send()}
        onReload={() => {
          cancel.reset();
          reload();
        }}
        reloadLabel="Reload the booking"
      />
      {consequenceChanged && onPreviewAgain ? (
        <div className="pg-actions">
          <Button
            variant="secondary"
            onClick={() => {
              cancel.reset();
              setAcceptedByCustomer(false);
              onPreviewAgain();
            }}
          >
            Preview again
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function CancelPaid({
  booking,
  enrollmentId,
  onDone,
}: {
  booking: Booking;
  enrollmentId: string;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const reasonState = useState('');
  const preview = useApiQuery({
    path: '/enrollments/{id}/cancellation-preview',
    request: { path: { id: enrollmentId } },
  });
  return (
    <QueryBoundary
      query={preview}
      label="the cancellation consequence"
      empty={{ title: '', description: '' }}
      unavailableOffline={['canceling']}
    >
      {(data) => {
        const c = data.financialConsequence;
        return (
          <>
            <p>
              The booking is paid, so canceling goes through its enrollment&apos;s cancellation.
            </p>
            <ConsequenceView consequence={c} />
            <Facts
              label="Cancellation preview"
              items={[
                ['Permitted by the cancellation policy', data.permitted ? 'Yes' : 'No'],
                ['Approval required', data.requiredApproval ? 'Yes' : 'No'],
              ]}
            />
            {data.permitted ? (
              <CancelForm
                // A new preview is a new decision: the acceptance and the intent start again.
                key={`${c.kind}:${c.amountMinor}:${c.currency}`}
                booking={booking}
                accepted={{ kind: c.kind, amountMinor: c.amountMinor, currency: c.currency }}
                needsAcceptance={c.kind !== 'none'}
                reasonState={reasonState}
                onDone={onDone}
                onPreviewAgain={() =>
                  void queryClient.invalidateQueries({
                    queryKey: ['api', '/enrollments/{id}/cancellation-preview'],
                  })
                }
              />
            ) : (
              <p>The cancellation policy does not permit canceling this booking now.</p>
            )}
          </>
        );
      }}
    </QueryBoundary>
  );
}

function ReloadBookingButton() {
  const queryClient = useQueryClient();
  const reload = useReloadBooking();
  return (
    <Button
      variant="secondary"
      onClick={() => {
        reload();
        void queryClient.invalidateQueries({ queryKey: BASKET_KEY });
      }}
    >
      Reload the booking
    </Button>
  );
}

function CancelHeld({
  booking,
  basketId,
  onDone,
}: {
  booking: Booking;
  basketId: string;
  onDone: (message: string) => void;
}) {
  const basket = useApiQuery({ path: '/baskets/{id}', request: { path: { id: basketId } } });
  const checkout = `/registrations/assisted/${basketId}`;
  const status = basket.data?.status;
  // The basket is read again right before sending: a checkout that started since the last read
  // stops the cancel, and this view re-renders from the fresh state.
  const beforeSend: BeforeSend = async () => {
    const fresh = await basket.refetch();
    // A failed re-read keeps the old data: the checkout state is then unknown, so nothing is sent.
    if (fresh.error) {
      return `Whether a checkout is in progress could not be checked (${fresh.error.code}), so nothing was canceled.`;
    }
    // `refetch` resolves with the cached ApiResponse; the basket is its `data`.
    const freshStatus = fresh.data?.data.status;
    if (freshStatus && UNPAID_BASKET.has(freshStatus)) return null;
    return 'The checkout state changed since it was read, so nothing was canceled.';
  };
  if (status === 'checking_out') {
    return (
      <div role="group" aria-label="Checkout in progress">
        <StatusBadge tone="warning" label="Checkout in progress" />
        <p>
          A payment may be on its way, so canceling is not offered until the checkout settles. Its
          outcome is not assumed.
        </p>
        <Link to={checkout}>Open the checkout in assisted registration</Link>
        <div className="pg-actions">
          <ReloadBookingButton />
        </div>
      </div>
    );
  }
  if (status === 'fulfilled' || status === 'partially_fulfilled') {
    return (
      <div role="group" aria-label="Checkout finished">
        <StatusBadge tone="info" label={`Checkout finished (basket ${status})`} />
        <p>
          The checkout finished, so the payment may have completed; the booking is updated from the
          checkout&apos;s outcome. Canceling is not offered until the booking shows its new state; a
          paid booking is then canceled with its refund or charge shown first.
        </p>
        <Link to={checkout}>Open the checkout in assisted registration</Link>
        <div className="pg-actions">
          <ReloadBookingButton />
        </div>
      </div>
    );
  }
  if (basket.data && status && UNPAID_BASKET.has(status)) {
    return (
      <>
        <p>
          Nothing has been paid. Canceling releases the reservation, its hold and the basket (basket{' '}
          {status}).
        </p>
        <CancelForm booking={booking} onDone={onDone} beforeSend={beforeSend} />
      </>
    );
  }
  if (basket.error) {
    const presentation = presentationForError(basket.error);
    return (
      <div role="group" aria-label="Checkout state unknown">
        {presentation === 'unavailable' ? (
          <p>
            The basket is not available to you, so whether a checkout is in progress cannot be
            checked here. A payment may be on its way, so canceling is not offered; the checkout is
            handled in assisted registration.
          </p>
        ) : (
          <>
            <p>
              Whether a checkout is in progress cannot be checked until the basket is read, so
              canceling is not offered yet.
            </p>
            <StateView variant="error" error={basket.error} onRetry={() => void basket.refetch()} />
          </>
        )}
        <Link to={checkout}>Open the checkout in assisted registration</Link>
      </div>
    );
  }
  return <StateView variant="loading" label="the payment state" />;
}

export function CancelBooking({
  booking,
  onDone,
}: {
  booking: Booking;
  onDone: (message: string) => void;
}) {
  const allowed = useActionAllowed(ACTIONS.requestBooking, booking.facilityId);
  const words = KIND_WORDS[booking.kind];
  if (!allowed) {
    return <NotAvailableToYou what={`Canceling ${words.many}`} action={ACTIONS.requestBooking} />;
  }
  const paid = booking.status === 'awaiting_staff' || booking.status === 'confirmed';
  if (paid && booking.enrollmentId) {
    return <CancelPaid booking={booking} enrollmentId={booking.enrollmentId} onDone={onDone} />;
  }
  if (booking.status === 'held' && booking.basketId) {
    return <CancelHeld booking={booking} basketId={booking.basketId} onDone={onDone} />;
  }
  return (
    <>
      <p>
        {booking.status === 'requested'
          ? 'Nothing is reserved or paid for a request, so nothing is released or charged.'
          : 'Canceling releases what the booking holds.'}
      </p>
      <CancelForm booking={booking} onDone={onDone} />
    </>
  );
}
