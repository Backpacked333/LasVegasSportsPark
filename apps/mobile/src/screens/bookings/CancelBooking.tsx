/**
 * Cancel a rental or party, with its consequence shown before anything is sent (Package G;
 * ENR-13, SPK-COND-003, SPK-REG-010, §4.9; cancellations are never gated by a capability switch,
 * DEC-016). `POST /v1/bookings/{id}/cancel` with a reason, `expectedRevision` and one idempotency
 * key per intent (a retry after no answer reuses it and cannot cancel twice).
 *
 * The consequence depends on what the booking holds:
 * - a request holds nothing: it is withdrawn, nothing was reserved or charged;
 * - a held booking holds time and an unpaid basket: both are released. While its basket is in
 *   checkout a payment may be on its way, so cancelling is not offered until the payment outcome
 *   is known (the basket shows it); the hold's basket (`GET /v1/baskets/{id}`) is read for that;
 * - a paid booking ends through its enrollment's cancellation: the money consequence is the API's
 *   `GET /v1/enrollments/{id}/cancellation-preview`, acknowledged by the customer and sent as
 *   `acceptedConsequence`. It is read again at confirm time; if it changed, nothing is sent and the
 *   new one must be acknowledged (also when the API answers CONSEQUENCE_CHANGED).
 *
 * States: ready (consequence); validation failure (reason missing: field message, input kept);
 * permission restriction (not available); stale (STALE_REVISION or INVALID_TRANSITION: reload);
 * offline (confirm disabled); processing (busy); no answer ("Check again", same key); success
 * ("Booking canceled" with what was accepted). A refund's progress is the facility's (DEC-009
 * executes cancellation money); nothing here claims money was paid back.
 */
import type { ApiError } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import {
  consequenceSummary,
  sameConsequence,
  type CancellationPreview,
  type FinancialConsequence,
} from '../../features/money/status';
import { Body, ButtonRow, Caption, ChoiceRow, Section, TextField } from '../../features/money/ui';
import {
  bookingStatus,
  cancelBasis,
  detailCode,
  type Booking,
} from '../../features/package-g/booking-model';
import { registrationRoutes } from '../../features/registration/routes';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

const CONSEQUENCE_CODES = new Set(['CONSEQUENCE_CHANGED', 'CONSEQUENCE_ACCEPTANCE_REQUIRED']);

type AcceptedConsequence = Pick<FinancialConsequence, 'kind' | 'amountMinor' | 'currency'>;

function Canceled({
  booking,
  accepted,
}: {
  booking: Booking;
  accepted: FinancialConsequence | null;
}) {
  const summary = accepted ? consequenceSummary(accepted) : null;
  return (
    <Section title="Booking canceled" testID="booking-canceled">
      <StatusBadge {...bookingStatus(booking)} testID="cancel-success" />
      {summary ? (
        <>
          <Body>{`What you accepted: ${summary.headline}.`}</Body>
          <Caption>
            Refunds and credits are carried out by the facility. This app cannot show their progress
            yet; ask the front desk if you have a question.
          </Caption>
        </>
      ) : (
        <Body>Everything this booking held has been released.</Body>
      )}
    </Section>
  );
}

export function CancelBooking({ booking, onReload }: { booking: Booking; onReload: () => void }) {
  const router = useRouter();
  const basis = cancelBasis(booking);
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<FinancialConsequence | null>(null);
  const [changed, setChanged] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{
    booking: Booking;
    accepted: FinancialConsequence | null;
  } | null>(null);
  const preview = useApiQuery({
    path: '/enrollments/{id}/cancellation-preview',
    request: { path: { id: booking.enrollmentId ?? '' } },
    enabled: open && basis === 'paid' && booking.enrollmentId !== null,
    staleTime: 0,
  });
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: booking.basketId ?? '' } },
    enabled: open && basis === 'hold' && booking.basketId !== null,
    staleTime: 0,
  });
  const cancel = useApiCommand('post', '/bookings/{id}/cancel', {
    invalidate: [
      ['api', '/bookings/{id}'],
      ['api', '/me/bookings'],
    ],
  });

  if (done) return <Canceled booking={done.booking} accepted={done.accepted} />;
  if (basis === null) return null;

  if (!open) {
    return (
      <Section title="Cancel" testID="booking-cancel">
        <ButtonRow>
          <Button
            label="Cancel this booking"
            variant="secondary"
            onPress={() => setOpen(true)}
            accessibilityHint="Shows what canceling releases and any money consequence before anything is sent"
          />
        </ButtonRow>
      </Section>
    );
  }

  const bodyFor = (trimmed: string, accepted: AcceptedConsequence | null) => ({
    reason: trimmed,
    expectedRevision: booking.revision,
    ...(accepted
      ? {
          acceptedConsequence: {
            kind: accepted.kind,
            amountMinor: accepted.amountMinor,
            currency: accepted.currency,
          },
        }
      : {}),
  });

  const send = async (body: ReturnType<typeof bodyFor>) => {
    setFailure(null);
    try {
      const result = await cancel.submit({ path: { id: booking.id }, body });
      setDone({ booking: result, accepted: basis === 'paid' ? acknowledged : null });
    } catch (error) {
      const e = error as ApiError;
      if (e.code === 'RESOURCE_CONFLICT' && CONSEQUENCE_CODES.has(detailCode(e.details) ?? '')) {
        // The consequence changed since it was shown: show the current one, acknowledged anew.
        setChanged(true);
        setAcknowledged(null);
        cancel.reset();
        void preview.refetch();
        return;
      }
      setFailure(e);
    }
  };

  const confirm = async () => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonError('Enter a reason for canceling.');
      return;
    }
    if (basis === 'paid') {
      if (!acknowledged) return;
      setChecking(true);
      // Stale version: the consequence is read again; nothing is sent unless it is unchanged.
      const reread = await preview.refetch();
      setChecking(false);
      if (reread.error) {
        setFailure(reread.error);
        return;
      }
      const fresh = reread.data?.data as CancellationPreview | undefined;
      if (!fresh || !sameConsequence(fresh.financialConsequence, acknowledged)) {
        setChanged(fresh !== undefined);
        setAcknowledged(null);
        return;
      }
    }
    await send(bodyFor(trimmed, basis === 'paid' ? acknowledged : null));
  };

  let consequence: ReactNode;
  let ready = false;
  if (basis === 'request') {
    ready = true;
    consequence = <Body>Your request is withdrawn. Nothing was reserved or charged.</Body>;
  } else if (basis === 'hold') {
    if (booking.basketId === null) {
      ready = true;
      consequence = (
        <Body>The time held for you is released. Nothing has been charged for this booking.</Body>
      );
    } else if (basket.data === undefined) {
      consequence = basket.error ? (
        <QueryErrorView error={basket.error} onRetry={() => void basket.refetch()} />
      ) : (
        <StateView variant="loading" label="whether a payment is on its way" />
      );
    } else if (basket.data.status === 'checking_out') {
      const basketId = booking.basketId;
      consequence = (
        <View testID="cancel-payment-in-progress">
          <StatusBadge tone="warning" label="A payment for this booking may be on its way" />
          <Body>
            Canceling is not offered while the basket is being paid. Open the basket to see the
            payment outcome first, and do not pay again.
          </Body>
          <ButtonRow>
            <Button
              label="Open the basket"
              variant="secondary"
              onPress={() => router.push(registrationRoutes.basket(basketId))}
            />
          </ButtonRow>
        </View>
      );
    } else {
      ready = true;
      consequence = (
        <Body>
          The time held for you is released and your basket is emptied. Nothing has been charged for
          this booking.
        </Body>
      );
    }
  } else if (booking.enrollmentId === null) {
    consequence = (
      <StateView
        variant="unavailable"
        title="Cannot be canceled in the app"
        description="The money consequence of canceling this booking cannot be shown. Contact the front desk."
      />
    );
  } else if (preview.data === undefined) {
    consequence = preview.error ? (
      <QueryErrorView error={preview.error} onRetry={() => void preview.refetch()} />
    ) : (
      <StateView variant="loading" label="what canceling would change" />
    );
  } else {
    const p = preview.data as CancellationPreview;
    if (!p.permitted) {
      consequence = (
        <StateView
          variant="unavailable"
          title="Cannot be canceled"
          description="This booking can no longer be canceled in the app. Contact the front desk."
        />
      );
    } else {
      ready = acknowledged !== null;
      const summary = consequenceSummary(p.financialConsequence);
      consequence = (
        <View testID="booking-money-consequence">
          {changed ? (
            <StatusBadge
              tone="warning"
              label="The money consequence changed since you reviewed it. Review it again."
              testID="consequence-changed"
            />
          ) : null}
          <StatusBadge tone={summary.tone} label={summary.headline} testID="consequence" />
          <Body>{summary.explanation}</Body>
          {p.requiredApproval ? (
            <Caption>Staff approval is required before the cancellation takes effect.</Caption>
          ) : null}
          <ChoiceRow
            mode="checkbox"
            label={`I understand: ${summary.headline}`}
            checked={acknowledged !== null}
            onPress={() => {
              setChanged(false);
              setAcknowledged(acknowledged ? null : p.financialConsequence);
            }}
          />
        </View>
      );
    }
  }

  return (
    <Section title="Cancel this booking" testID="booking-cancel">
      <View testID="cancel-consequence">{consequence}</View>
      <TextField
        label="Reason for canceling"
        value={reason}
        onChangeText={(text) => {
          setReason(text);
          if (text.trim()) setReasonError(null);
        }}
        error={reasonError}
        multiline
        testID="cancel-reason"
      />
      {offline ? <Caption>Canceling needs a connection.</Caption> : null}
      <ButtonRow>
        <Button
          label="Cancel booking"
          onPress={() => void confirm()}
          disabled={offline || !ready}
          busy={cancel.isProcessing || checking}
          accessibilityHint="Cancels the booking with the consequence shown above"
        />
        <Button
          label="Keep the booking"
          variant="secondary"
          onPress={() => {
            setOpen(false);
            setFailure(null);
            setAcknowledged(null);
            setChanged(false);
          }}
        />
      </ButtonRow>
      {failure ? (
        <CommandFailure
          error={failure}
          what="the cancellation"
          onRetry={() => void confirm()}
          onReload={() => {
            setFailure(null);
            cancel.reset();
            setAcknowledged(null);
            onReload();
          }}
        />
      ) : null}
    </Section>
  );
}
