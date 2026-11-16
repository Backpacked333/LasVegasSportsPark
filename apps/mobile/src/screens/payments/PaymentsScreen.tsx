/**
 * SCR-C-34 Payments (SPK-PAY-002, SPK-PAY-004, SPK-PAY-005, SPK-PAY-006, SPK-PAY-007, SPK-REG-003,
 * SPK-AT-004, SPK-UX-004, SPK-UX-008; DEC-008, DEC-073 and POL-016 govern installments and team
 * billing and are the API's configuration, never the app's). Customer words (PA-11): "Amount due",
 * not "obligation"; "Payment", not "payment attempt". Visual system v2 (ADR-008).
 *
 * One screen, five views chosen with the "Show" chips (only the chosen view is read):
 * - What's due (the first view): what a person owes and has paid,
 *   `GET /v1/obligations?debtorPersonId=` for the chosen person, opening with the person's amount
 *   due as a stat tile (`GET /v1/people/{id}/money-summary`, MoneySummary.tsx; protected family
 *   money, "not available" when the account may not see it), then "What's due" (open balances),
 *   then "History", in cursor pages. Each row shows the amount, what is left to pay and the
 *   status; an overpayment is shown, never hidden (SPK-PAY-005); a balance with a payment on its
 *   way says so (`liveAttempt`, SPK-PAY-007). Opening a row shows the order, installments and
 *   "Pay" (ObligationScreen).
 * - Payments, Receipts, Orders: the account's own lists (`GET /v1/me/payments`, `/me/receipts`,
 *   `/me/orders`; MoneyLists.tsx), covering the people this account pays for.
 * - Your share: the team shares asked of this person or of the people they pay for
 *   (`GET /v1/me/contribution-requests`, SCR-C-25; MyContributionsScreen.tsx).
 * Above the views, "Needs attention" lists a payment whose outcome is unknown and a registration
 * checkout in `recovery_required` (§4.11), whichever view is chosen. Pulling the page down reads
 * everything on it again.
 *
 * States: loading; empty (nothing due or paid: the payments illustration); ready; validation
 * failure: on the detail; permission restriction (a person whose balances this account may not
 * see reads "not available", nothing of another payer is shown); stale version: refreshed on
 * return, on focus and on pull; offline (cached with age, paying needs a connection); processing
 * and recovery required: "Payment processing" and "Payment outcome being confirmed. Do not pay
 * again." on the rows and the detail.
 */
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { illustrations } from '../../artwork/manifest';
import { useApiPages } from '../../api/useApiPages';
import { liveAttemptStatus, obligationAmounts } from '../../features/money/payment-lists';
import { PeopleGate } from '../../features/money/PeopleGate';
import type { AccountPerson } from '../../features/money/people';
import { moneyRoutes } from '../../features/money/routes';
import { obligationStatus, type Obligation } from '../../features/money/status';
import { usePullToRefresh } from '../../features/money/surfaces';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { ChipRow } from '../../ui/Chip';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { makeStyles, spacing } from '../../ui/theme';
import { MyContributionsList } from '../teams/MyContributionsScreen';
import { MoneySummary } from './MoneySummary';
import { MyOrdersList, MyPaymentsList, MyReceiptsList, NeedsAttention } from './MoneyLists';

export { obligationAmounts };

function ObligationRows({ items }: { items: readonly Obligation[] }) {
  const router = useRouter();
  const now = useNow();
  return (
    <View accessibilityRole="list">
      {items.map((obligation) => {
        const live = obligation.liveAttempt ?? null;
        return (
          <ListRow
            key={obligation.id}
            title={obligation.description}
            detail={obligationAmounts(obligation)}
            // A payment on its way is the status that matters: "do not pay again" (SPK-PAY-007).
            status={live ? liveAttemptStatus(live) : obligationStatus(obligation, now)}
            onPress={() => router.push(moneyRoutes.obligation(obligation.id))}
            accessibilityHint="Opens the amount due, its order, installments and payment"
            testID={`obligation-${obligation.id}`}
          />
        );
      })}
    </View>
  );
}

function ObligationList({ person }: { person: AccountPerson }) {
  const obligations = useApiPages({
    path: '/obligations',
    request: { query: { debtorPersonId: person.personId, limit: 50 } },
  });
  return (
    <>
      <QueryBoundary
        query={obligations}
        label="payments"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No payments',
          description: `Anything ${person.self ? 'you owe' : `${person.displayName} owes`} for registrations, and the installments of a plan, will appear here.`,
          source: illustrations['empty-payments'],
          testID: 'payments-empty',
        }}
        unavailableOffline={['paying a balance']}
      >
        {(items) => {
          const open = items.filter((o) => o.status === 'open');
          const closed = items.filter((o) => o.status !== 'open');
          return (
            <View>
              {open.length > 0 ? (
                <Section title="What's due" testID="payments-due">
                  <ObligationRows items={open} />
                </Section>
              ) : null}
              {closed.length > 0 ? (
                <Section title="History" testID="payments-history">
                  <ObligationRows items={closed} />
                </Section>
              ) : null}
            </View>
          );
        }}
      </QueryBoundary>
      <LoadMore pages={obligations} label="balances" />
    </>
  );
}

export type PaymentsView = 'balances' | 'payments' | 'receipts' | 'orders' | 'contributions';

const VIEWS: readonly { value: PaymentsView; label: string }[] = [
  { value: 'balances', label: "What's due" },
  { value: 'payments', label: 'Payments' },
  { value: 'receipts', label: 'Receipts' },
  { value: 'orders', label: 'Orders' },
  { value: 'contributions', label: 'Your share' },
];

export function PaymentsScreen({ initialView = 'balances' }: { initialView?: PaymentsView }) {
  const styles = useStyles();
  const [view, setView] = useState<PaymentsView>(initialView);
  const { refreshing, onRefresh } = usePullToRefresh();
  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <RequireSession what="payments">
        <NeedsAttention />
        <ChipRow
          mode="single"
          label="Show"
          options={VIEWS}
          value={view}
          onChange={(next) => next && setView(next)}
          style={styles.views}
          testID="payments-views"
        />
        {view === 'balances' ? (
          <PeopleGate pickerLabel="Show payments of">
            {(person) => (
              <View key={person.personId}>
                <MoneySummary person={person} />
                <ObligationList person={person} />
              </View>
            )}
          </PeopleGate>
        ) : null}
        {view === 'payments' ? <MyPaymentsList /> : null}
        {view === 'receipts' ? <MyReceiptsList /> : null}
        {view === 'orders' ? <MyOrdersList /> : null}
        {view === 'contributions' ? <MyContributionsList /> : null}
      </RequireSession>
    </Screen>
  );
}

const useStyles = makeStyles(() => ({
  views: { marginTop: spacing.sm },
}));

/** Route component for app/payments/index.tsx. */
export function PaymentsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Payments' }} />
      <PaymentsScreen />
    </>
  );
}
