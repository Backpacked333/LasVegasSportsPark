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
 * States: loading; ready; permission restriction (another person's request: NOT_FOUND, not
 * available); stale (refetch after paying and on focus); offline (paying disabled); processing
 * ("Payment processing"); success ("Paid"); recovery required ("Payment outcome being confirmed.
 * Do not pay again." on this line only; a timeout is retried under the same key, never paid twice).
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { DEV_CONTRIBUTION_PAYMENT_METHODS } from '../../features/teams/dev';
import { formatMoney } from '../../features/teams/format';
import { ObligationTotals } from '../../features/teams/ObligationTotals';
import { useSignedIn } from '../../features/teams/queries';
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

type ContributionRequest = Schema<'ContributionRequest'>;
/** The published component is nullable (reported); an outcome without an attempt shows nothing. */
type PaymentAttempt = NonNullable<Schema<'PaymentAttempt'>>;

const UNSETTLED: ReadonlySet<PaymentAttempt['status']> = new Set([
  'created',
  'action_required',
  'processing',
  'unknown',
]);

function PaymentProgress({ attempt }: { attempt: PaymentAttempt }) {
  const latest = useApiQuery({
    path: '/payments/{id}',
    request: { path: { id: attempt.id } },
    enabled: UNSETTLED.has(attempt.status),
  });
  const current: PaymentAttempt = latest.data ?? attempt;
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
          onPress={() => void latest.refetch()}
          busy={latest.fetchStatus === 'fetching'}
          accessibilityHint="Reads the payment's current state; it never pays again"
        />
      ) : null}
    </View>
  );
}

function PayContribution({ request }: { request: ContributionRequest }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const methods = DEV_CONTRIBUTION_PAYMENT_METHODS;
  const [token, setToken] = useState<string | null>(null);
  const pay = useApiCommand('post', '/contribution-requests/{id}/pay', {
    invalidate: [['api', '/contribution-requests/{id}']],
  });
  const submit = () => {
    if (!token) return;
    void pay
      .submit({ path: { id: request.id }, body: { paymentMethodToken: token } })
      .catch(() => undefined);
  };
  if (!methods) {
    return (
      <StateView
        variant="pending-decision"
        subject="Paying in the app"
        decisions={['DEC-019']}
        owner="Technical lead/account owners"
      />
    );
  }
  const outcome = pay.data;
  const payment = outcome?.payment ?? null;
  // A payment that may have been taken is never offered again (SPK-PAY-007).
  const locked =
    pay.error?.outcomeUnknown === true ||
    (outcome !== undefined && (payment === null || payment.status !== 'failed'));
  return (
    <View style={styles.group}>
      {payment ? <PaymentProgress attempt={payment} /> : null}
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
                onSelect={() => setToken(m.token)}
              />
            ))}
          </RadioGroup>
          {offline ? <OfflineNotice what="Paying" /> : null}
          <Button
            label={`Pay ${formatMoney(request.amountMinor, request.currency)}`}
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

export function ContributionContent({ request }: { request: ContributionRequest }) {
  return (
    <View>
      <Title>Your contribution</Title>
      <Section title={request.obligation.description}>
        <Detail label="Your amount" value={formatMoney(request.amountMinor, request.currency)} />
        <StatusBadge {...contributionStatus(request)} testID="contribution-status" />
        {request.message ? <Detail label="From your captain" value={request.message} /> : null}
      </Section>
      {request.status === 'requested' && request.obligation.status === 'open' ? (
        <Section title="Pay your contribution">
          <PayContribution request={request} />
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
