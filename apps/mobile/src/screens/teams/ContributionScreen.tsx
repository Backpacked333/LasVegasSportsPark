/**
 * SCR-C-25 Team contributions, a player's own line (SPK-PAY-004, SPK-PAY-005, SPK-PAY-007,
 * SPK-PAY-011, SPK-CAP-002, SPK-AT-022). Reads `GET /v1/contribution-requests/{id}`: the player's
 * own requested amount and status with the team obligation's totals, never other players'
 * payments. The player pays their own contribution with `POST /v1/contribution-requests/{id}/pay`
 * from their own account; the outcome is the API's payment attempt, re-read with
 * `GET /v1/payments/{id}` while it is processing or unknown.
 *
 * The payment provider is not selected (DEC-019, Technical lead/account owners): a release build
 * cannot collect a payment method and shows the pending state. Development builds use the API's
 * fake provider (features/teams/dev).
 *
 * A payment toward this line that is still on its way or unknown, started anywhere (another
 * device, an earlier visit), is found with `GET /v1/me/payments?purpose=contribution` (the request
 * itself carries no `liveAttempt`; reported) and locks paying with "Do not pay again" until it
 * settles; "Check again" reads the payments again and never pays.
 *
 * States: loading; ready; permission restriction (another person's request: NOT_FOUND, not
 * available); stale (refetch after paying and on focus); offline (paying disabled); processing
 * ("Payment processing"); success ("Paid"); recovery required ("Payment outcome being confirmed.
 * Do not pay again." on this line only). Without a definite answer to paying (a lost connection or
 * a timeout after sending, IDEMPOTENCY_IN_PROGRESS, INTERNAL_ERROR or another 5xx) the line reads
 * "No answer yet: this may already have been recorded", the payment methods stay hidden and
 * "Check again" repeats the same request under the same key, so it is never paid twice. When that
 * check finds that the first attempt committed but its answer was lost
 * (IDEMPOTENCY_OUTCOME_UNAVAILABLE), the line reads "This may already have been done": the payment
 * methods stay hidden, the payments and the request are read again (so an attempt the API recorded
 * shows "Do not pay again"), and "Reload" reads them again; paying is not offered again on this
 * visit. When that check is refused before running (`refusedAfterNoAnswer`: payments paused while
 * the service recovers from a restore, SPK-AT-028), only the check did not run: the methods stay
 * hidden and it reads "Check not run" with the API's message, that the earlier payment may still
 * have gone through and "Do not pay again", with "Check again" (R4-CLIENTS-A11Y-COPY-01). A refusal
 * of the first attempt is "Not done": nothing ran. Each of these answers, and every change of the
 * payment's state, is announced to screen readers with what to do next (`ui/announce`,
 * SPK-UX-009, NA-A01).
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  mayHaveTakenEffect,
  refusedAfterNoAnswer,
  tookEffectOutcomeLost,
} from '../../api/command-outcome';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { DEV_CONTRIBUTION_PAYMENT_METHODS } from '../../features/teams/dev';
import { formatMoney } from '../../features/teams/format';
import { ObligationTotals } from '../../features/teams/ObligationTotals';
import { useMe, useSignedIn } from '../../features/teams/queries';
import { idParam } from '../../features/teams/routes';
import { contributionStatus, obligationStatus, paymentStatus } from '../../features/teams/status';
import {
  Body,
  CommandFailure,
  Detail,
  OfflineNotice,
  RadioGroup,
  RadioRow,
  Section,
  Title,
} from '../../features/teams/ui';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveRegion, sentences } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { RefusedBeforeRunning } from '../../ui/RefusedBeforeRunning';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { useContributionPayments } from './MyContributionsScreen';

type ContributionRequest = Schema<'ContributionRequest'>;
/** The published component is nullable (reported); an outcome without an attempt shows nothing. */
type PaymentAttempt = NonNullable<Schema<'PaymentAttempt'>>;

/** Reads a payment toward a contribution changes. */
const PAY_EFFECT_KEYS = [
  ['api', '/contribution-requests/{id}'],
  ['api', '/me/contribution-requests'],
  ['api', '/me/payments'],
  ['api', '/me/receipts'],
] as const;

const UNSETTLED: ReadonlySet<PaymentAttempt['status']> = new Set([
  'created',
  'action_required',
  'processing',
  'unknown',
]);

/** What a screen reader hears for a payment's state: the badge, a failure's reason, "Check again". */
function paymentProgressWords(current: PaymentAttempt): string {
  return sentences(
    paymentStatus(current.status).label,
    current.status === 'failed' ? current.failureReason : null,
    UNSETTLED.has(current.status) ? 'Check again' : null,
  );
}

/**
 * The state of a payment toward this line. It is announced when it appears and whenever the state
 * changes (SPK-UX-009, NA-A01), unless it sits inside a view that announces it (`live={false}`).
 */
function PaymentProgress({
  current,
  checking,
  onCheck,
  live = true,
}: {
  current: PaymentAttempt;
  checking: boolean;
  onCheck: () => void;
  live?: boolean;
}) {
  const body = (
    <>
      <StatusBadge {...paymentStatus(current.status)} />
      {current.status === 'failed' && current.failureReason ? (
        <Body>{current.failureReason}</Body>
      ) : null}
      {UNSETTLED.has(current.status) ? (
        <Button
          label="Check again"
          variant="secondary"
          onPress={onCheck}
          busy={checking}
          accessibilityHint="Reads the payment's current state; it never pays again"
        />
      ) : null}
    </>
  );
  // Inside a view that announces it, a second live region would make TalkBack read it twice.
  return live ? (
    <LiveRegion
      style={styles.group}
      testID="payment-progress"
      announcement={paymentProgressWords(current)}
    >
      {body}
    </LiveRegion>
  ) : (
    <View style={styles.group} testID="payment-progress">
      {body}
    </View>
  );
}

function elsewhereText(attempt: PaymentAttempt): string {
  return `A payment of ${formatMoney(attempt.amountMinor, attempt.currency)} toward this contribution is on its way. Do not pay again.`;
}

function PayContribution({
  request,
  payLabel,
}: {
  request: ContributionRequest;
  payLabel: string;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const queryClient = useQueryClient();
  const methods = DEV_CONTRIBUTION_PAYMENT_METHODS;
  const [token, setToken] = useState<string | null>(null);
  const pay = useApiCommand('post', '/contribution-requests/{id}/pay', {
    invalidate: PAY_EFFECT_KEYS,
  });
  const outcome = pay.data;
  const payment = outcome?.payment ?? null;
  // A payment toward this line started elsewhere and not settled yet (SPK-PAY-007).
  const known = useContributionPayments();
  const liveAttempt = known.live.get(request.id) ?? null;
  const elsewhere = liveAttempt !== null && liveAttempt.id !== payment?.id ? liveAttempt : null;
  const knownFailed =
    known.payments.data === undefined &&
    known.payments.error !== null &&
    presentationForError(known.payments.error) === 'error'
      ? known.payments.error
      : null;
  const elsewhereId = elsewhere?.id ?? null;
  const watchedElsewhere = useRef<string | null>(null);
  useEffect(() => {
    // The live attempt this screen showed has settled: the line's status and totals change.
    if (elsewhereId) {
      watchedElsewhere.current = elsewhereId;
    } else if (watchedElsewhere.current) {
      watchedElsewhere.current = null;
      void queryClient.invalidateQueries({ queryKey: ['api', '/contribution-requests/{id}'] });
    }
  }, [elsewhereId, queryClient]);
  // The attempt's latest state is read here, so the form and the request follow it.
  const latest = useApiQuery({
    path: '/payments/{id}',
    request: { path: { id: payment?.id ?? '' } },
    enabled: payment !== null && UNSETTLED.has(payment.status),
  });
  const current: PaymentAttempt | null = latest.data ?? payment;
  const settled = current !== null && !UNSETTLED.has(current.status);
  useEffect(() => {
    // Once the attempt leaves processing or unknown, the request's status and totals change.
    if (settled && latest.data) {
      void queryClient.invalidateQueries({ queryKey: ['api', '/contribution-requests/{id}'] });
    }
  }, [settled, latest.data, queryClient]);
  const rereadPayments = () => {
    for (const queryKey of PAY_EFFECT_KEYS) void queryClient.invalidateQueries({ queryKey });
  };
  const submit = () => {
    if (!token) return;
    void pay
      .submit({ path: { id: request.id }, body: { paymentMethodToken: token } })
      .catch((error: ApiError) => {
        // The payment may have been made (or was, its answer lost, or a check of it could not
        // run): read what the API knows, so an attempt it recorded is shown with "Do not pay
        // again" even before "Check again" (SPK-PAY-007).
        if (
          mayHaveTakenEffect(error) ||
          tookEffectOutcomeLost(error) ||
          refusedAfterNoAnswer(error)
        )
          rereadPayments();
      });
  };
  // What the API knows of a payment on its way for this line, shown in every build (SPK-PAY-007).
  const knownState = (
    <>
      {elsewhere && !current ? (
        <LiveRegion
          style={styles.group}
          testID="contribution-live-attempt"
          announcement={sentences(elsewhereText(elsewhere), paymentProgressWords(elsewhere))}
        >
          <Body>{elsewhereText(elsewhere)}</Body>
          <PaymentProgress
            current={elsewhere}
            checking={known.payments.fetchStatus === 'fetching'}
            onCheck={() => void known.payments.refetch()}
            live={false}
          />
        </LiveRegion>
      ) : null}
      {knownFailed && !current ? (
        <View style={styles.group} testID="contribution-payments-unchecked">
          <Body muted>
            We could not check for a payment already on its way. If you paid recently, check again
            before paying: a second payment is refused while one is being confirmed.
          </Body>
          <CommandFailure error={knownFailed} onRetry={() => void known.payments.refetch()} read />
        </View>
      ) : null}
    </>
  );
  if (!methods) {
    return (
      <View style={styles.group}>
        {knownState}
        <StateView
          variant="pending-decision"
          subject="Paying in the app"
          decisions={['DEC-019']}
          owner="Technical lead/account owners"
        />
      </View>
    );
  }
  // A payment that may have been taken is never offered again (SPK-PAY-007); a failed one is.
  // Without a definite answer (a lost connection or a timeout after sending, the same key still
  // running, a server failure, PAYMENT_OUTCOME_UNKNOWN) the method picker stays hidden: picking
  // another method would change the request and send it under a new key. "Check again" repeats
  // the same request under the same key until the API answers with the attempt. An attempt that
  // committed with its answer lost (IDEMPOTENCY_OUTCOME_UNAVAILABLE) keeps them hidden too, and so
  // does a check of an unanswered attempt refused before running (`refusedAfterNoAnswer`: only the
  // check did not run, SPK-AT-028).
  const checkRefused = pay.error !== null && refusedAfterNoAnswer(pay.error);
  const unanswered =
    pay.error !== null &&
    (mayHaveTakenEffect(pay.error) || tookEffectOutcomeLost(pay.error) || checkRefused);
  const locked =
    elsewhere !== null ||
    unanswered ||
    (outcome !== undefined &&
      (current === null || UNSETTLED.has(current.status) || current.status === 'succeeded'));
  return (
    <View style={styles.group}>
      {knownState}
      {current ? (
        <PaymentProgress
          current={current}
          checking={latest.fetchStatus === 'fetching'}
          onCheck={() => void latest.refetch()}
        />
      ) : null}
      {outcome?.overpaymentCreditId ? (
        <Body>
          More than the team&apos;s remaining balance was received: the excess is kept as a credit
          awaiting approval, and stays visible on the team totals.
        </Body>
      ) : null}
      {!locked ? (
        <>
          <RadioGroup label="Payment method">
            {methods.map((m) => (
              <RadioRow
                key={m.token}
                label={m.label}
                checked={token === m.token}
                onSelect={() => {
                  // Paying again after a failure is a new intent with a new key.
                  if (current?.status === 'failed') pay.reset();
                  setToken(m.token);
                }}
              />
            ))}
          </RadioGroup>
          {offline ? <OfflineNotice what="Paying" /> : null}
          <Button
            label={`${payLabel} ${formatMoney(request.amountMinor, request.currency)}`}
            onPress={submit}
            disabled={offline || !token}
            busy={pay.isProcessing}
          />
        </>
      ) : null}
      {pay.error && checkRefused ? (
        <RefusedBeforeRunning
          error={pay.error}
          onRetry={submit}
          priorUnknown
          payment
          testID="contribution-check-refused"
        />
      ) : pay.error ? (
        <CommandFailure error={pay.error} onRetry={submit} />
      ) : null}
    </View>
  );
}

/**
 * Whose contribution this is: the API lets anyone holding `pay` over the requested person pay it,
 * so a guardian paying a child's line sees the child named (SPK-PAY-004).
 */
function useRequestedName(request: ContributionRequest): { own: boolean; name: string } {
  const me = useMe();
  const selfId = me.data?.person?.id ?? null;
  const own = selfId !== null && selfId === request.requestedPersonId;
  const person = useApiQuery({
    path: '/people/{id}',
    request: { path: { id: request.requestedPersonId } },
    enabled: me.data !== undefined && !own,
  });
  if (own || me.data === undefined) return { own: true, name: 'You' };
  return { own: false, name: person.data?.givenName ?? 'a person you pay for' };
}

export function ContributionContent({ request }: { request: ContributionRequest }) {
  const { own, name } = useRequestedName(request);
  return (
    <View>
      <Title>{own ? 'Your contribution' : `Contribution for ${name}`}</Title>
      <Section title={request.obligation.description}>
        <Detail
          label={own ? 'Your amount' : `Amount for ${name}`}
          value={formatMoney(request.amountMinor, request.currency)}
        />
        <StatusBadge {...contributionStatus(request)} testID="contribution-status" />
        {request.message ? (
          <Detail label="Message with the request" value={request.message} />
        ) : null}
      </Section>
      {request.status === 'requested' && request.obligation.status === 'open' ? (
        <Section title={own ? 'Pay your contribution' : `Pay ${name}'s contribution`}>
          <PayContribution
            request={request}
            payLabel={own ? 'Pay' : `Pay ${name}'s contribution:`}
          />
        </Section>
      ) : null}
      <Section title="Team obligation">
        <StatusBadge {...obligationStatus(request.obligation.status)} />
        <ObligationTotals totals={request.obligation.totals} />
        <Body muted>
          These are the team&apos;s totals. Other players&apos; payments are never shown to you.
        </Body>
      </Section>
    </View>
  );
}

export function ContributionScreen({ requestId }: { requestId: string | null }) {
  const signedIn = useSignedIn();
  const request = useApiQuery({
    path: '/contribution-requests/{id}',
    request: { path: { id: requestId ?? '' } },
    enabled: signedIn && requestId !== null,
  });
  return (
    <Screen>
      <RequireSession what="your contribution">
        {requestId === null ? (
          <StateView variant="unavailable" />
        ) : (
          <QueryBoundary
            query={request}
            label="your contribution"
            empty={{ title: 'No contribution', description: 'Nothing was requested.' }}
            unavailableOffline={['payment']}
          >
            {(data) => <ContributionContent request={data} />}
          </QueryBoundary>
        )}
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/team/contribution/[requestId].tsx. */
export function ContributionRoute() {
  const requestId = idParam(useLocalSearchParams<{ requestId: string }>().requestId);
  return (
    <>
      <Stack.Screen options={{ title: 'Your contribution' }} />
      <ContributionScreen requestId={requestId} />
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
