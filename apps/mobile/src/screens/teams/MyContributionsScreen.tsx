/**
 * SCR-C-25 Team contributions, the player's own list (SPK-PAY-004, SPK-PAY-007, SPK-CAP-002,
 * SPK-AT-022; DEC-008, POL-014 and POL-015 are the API's configuration). Reads
 * `GET /v1/me/contribution-requests`: the contributions a captain asked of this person, or of
 * someone this account pays for, newest first in cursor pages. Each player sees only their own
 * lines: the API scopes the list from the account's own authority (`finance.pay_contribution`),
 * and each line carries the player's amount and status with the team's totals only, never other
 * players' payments. Opening a line shows it and pays it (ContributionScreen).
 *
 * A payment on its way for a line is found with `GET /v1/me/payments?purpose=contribution`
 * (the contribution request carries no `liveAttempt`; reported): "Payment processing" or
 * "Payment outcome being confirmed. Do not pay again." is shown on that line only.
 *
 * States: loading; empty (nothing asked of you: the team is billed another way, or nothing was
 * requested yet); ready; error with code and "Try again"; permission restriction: not applicable
 * (the list is the API's own scope; another person's request reads "not available" on its line);
 * stale (refetched on focus and after paying); offline (cached with its age; paying needs a
 * connection); processing and recovery required on the line.
 *
 * Route: `/team/contributions` (app/team/contributions.tsx), from the team workspace's player view
 * and from Payments ("Team contributions").
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { useNameOf } from '../../features/money/people';
import { paymentIsUnresolved, type PaymentAttempt } from '../../features/money/status';
import { formatMoney } from '../../features/teams/format';
import { teamRoutes } from '../../features/teams/routes';
import { contributionStatus, paymentStatus } from '../../features/teams/status';
import { Section } from '../../features/teams/ui';
import { useApp } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';

type ContributionRequest = Schema<'ContributionRequest'>;

/** The contribution payments read: the newest 50 are enough to find one still on its way. */
export const CONTRIBUTION_PAYMENTS_QUERY = { purpose: 'contribution', limit: 50 } as const;

/**
 * The unresolved payment of each contribution request, from the account's contribution payments
 * (newest first: an unresolved attempt blocks newer ones, so the first found is the live one).
 */
export function useContributionPayments(enabled = true) {
  const { session } = useApp();
  const payments = useApiQuery({
    path: '/me/payments',
    request: { query: CONTRIBUTION_PAYMENTS_QUERY },
    enabled: enabled && session.status === 'signed_in',
  });
  const live = new Map<string, PaymentAttempt>();
  for (const attempt of payments.data?.items ?? []) {
    const requestId = attempt.contributionRequestId;
    if (!requestId || live.has(requestId) || !paymentIsUnresolved(attempt.status)) continue;
    live.set(requestId, attempt);
  }
  return { payments, live };
}

function ContributionRows({ items }: { items: readonly ContributionRequest[] }) {
  const router = useRouter();
  const nameOf = useNameOf();
  const { live } = useContributionPayments();
  return (
    <View accessibilityRole="list">
      {items.map((request) => {
        const name = nameOf(request.requestedPersonId);
        const whose = name === 'You' ? 'Your contribution' : `Contribution for ${name}`;
        const attempt = request.status === 'requested' ? live.get(request.id) : undefined;
        return (
          <ListRow
            key={request.id}
            title={request.obligation.description}
            detail={`${whose}: ${formatMoney(request.amountMinor, request.currency)}`}
            status={attempt ? paymentStatus(attempt.status) : contributionStatus(request)}
            onPress={() => router.push(teamRoutes.contribution(request.id))}
            accessibilityHint="Opens the contribution with the team's totals and payment"
            testID={`my-contribution-${request.id}`}
          />
        );
      })}
    </View>
  );
}

/** The list itself, also shown by Payments (SCR-C-34 "Team contributions"). */
export function MyContributionsList() {
  const requests = useApiPages({
    path: '/me/contribution-requests',
    request: { query: { limit: 20 } },
  });
  return (
    <Section title="Team contributions asked of you" testID="my-contributions">
      <QueryBoundary
        query={requests}
        label="your team contributions"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No contributions asked of you',
          description:
            'When a team captain asks you, or someone you pay for, to pay part of a team fee, it appears here to pay.',
        }}
        unavailableOffline={['paying a contribution']}
      >
        {(items) => <ContributionRows items={items} />}
      </QueryBoundary>
      <LoadMore pages={requests} label="contributions" />
    </Section>
  );
}

export function MyContributionsScreen() {
  return (
    <Screen>
      <RequireSession what="your team contributions">
        <MyContributionsList />
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/team/contributions.tsx. */
export function MyContributionsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Your team contributions' }} />
      <MyContributionsScreen />
    </>
  );
}
