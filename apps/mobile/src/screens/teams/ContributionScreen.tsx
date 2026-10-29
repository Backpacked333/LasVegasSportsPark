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
 * Do not pay again." on this line only; a timeout is retried under the same key, never paid twice).
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
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
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { useContributionPayments } from './MyContributionsScreen';

type ContributionRequest = Schema<'ContributionRequest'>;
/** The published component is nullable (reported); an outcome without an attempt shows nothing. */
type PaymentAttempt = NonNullable<Schema<'PaymentAttempt'>>;

const UNSETTLED: ReadonlySet<PaymentAttempt['status']> = new Set([
  'created',
  'action_required',
  'processing',
  'unknown',
]);

function PaymentProgress({
  current,
  checking,
  onCheck,
}: {
  current: PaymentAttempt;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <View style={styles.group} testID="payment-progress">
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
    </View>
  );
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
    invalidate: [
      ['api', '/contribution-requests/{id}'],
      ['api', '/me/contribution-requests'],
      ['api', '/me/payments'],
      ['api', '/me/receipts'],
    ],
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
  const submit = () => {
    if (!token) return;
    void pay
      .submit({ path: { id: request.id }, body: { paymentMethodToken: token } })
      .catch(() => undefined);
  };
  // What the API knows of a payment on its way for this line, shown in every build (SPK-PAY-007).
  const knownState = (
    <>
      {elsewhere && !current ? (
        <View style={styles.group} testID="contribution-live-attempt">
          <Body>
            {`A payment of ${formatMoney(elsewhere.amountMinor, elsewhere.currency)} toward this contribution is on its way. Do not pay again.`}
          </Body>
          <PaymentProgress
            current={elsewhere}
            checking={known.payments.fetchStatus === 'fetching'}
            onCheck={() => void known.payments.refetch()}
          />
        </View>
      ) : null}
      {knownFailed && !current ? (
        <View style={styles.group} testID="contribution-payments-unchecked">
          <Body muted>
            We could not check for a payment already on its way. If you paid recently, check again
            before paying: a second payment is refused while one is being confirmed.
          </Body>
          <CommandFailure error={knownFailed} onRetry={() => void known.payments.refetch()} />
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
  const locked =
    elsewhere !== null ||
    pay.error?.outcomeUnknown === true ||
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
      {pay.error ? <CommandFailure error={pay.error} onRetry={submit} /> : null}
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
