/**
 * SCR-C-34 Payments and obligations (SPK-PAY-002, SPK-PAY-004, SPK-PAY-005, SPK-PAY-006,
 * SPK-PAY-007, SPK-REG-003, SPK-AT-004, SPK-UX-004, SPK-UX-008; DEC-008, DEC-073 and POL-016
 * govern installments and team billing and are the API's configuration, never the app's).
 *
 * One screen, five views chosen with "Show" (only the chosen view is read):
 * - Balances due: what a person owes and has paid, `GET /v1/obligations?debtorPersonId=` for the
 *   chosen person, balances due first, then history, in cursor pages. Each row shows the amount,
 *   what is left to pay and the status; an overpayment is shown, never hidden (SPK-PAY-005); a
 *   balance with a payment on its way says so (`liveAttempt`, SPK-PAY-007). Opening a row shows
 *   the order, installments and "Pay" (ObligationScreen).
 * - Payments, Receipts, Orders: the account's own lists (`GET /v1/me/payments`, `/me/receipts`,
 *   `/me/orders`; MoneyLists.tsx), covering the people this account pays for.
 * - Team contributions: the contributions asked of this person or of the people they pay for
 *   (`GET /v1/me/contribution-requests`, SCR-C-25; MyContributionsScreen.tsx).
 * Above the views, "Needs attention" lists a payment whose outcome is unknown and a registration
 * checkout in `recovery_required` (§4.11), whichever view is chosen.
 *
 * States: loading; empty (no payments); ready; validation failure: on the detail; permission
 * restriction (a person whose balances this account may not see reads "not available", nothing of
 * another payer is shown); stale version: refreshed on return and on focus; offline (cached with
 * age, paying needs a connection); processing and recovery required: "Payment processing" and
 * "Payment outcome being confirmed. Do not pay again." on the rows and the detail.
 */
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { liveAttemptStatus, obligationAmounts } from '../../features/money/payment-lists';
import { PeopleGate } from '../../features/money/PeopleGate';
import type { AccountPerson } from '../../features/money/people';
import { moneyRoutes } from '../../features/money/routes';
import { obligationStatus, type Obligation } from '../../features/money/status';
import { ChoiceRow, Section } from '../../features/money/ui';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { MyContributionsList } from '../teams/MyContributionsScreen';
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
            accessibilityHint="Opens the balance, its order, installments and payment"
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
          description: `Orders, balances due and installments ${person.self ? 'you owe' : `${person.displayName} owes`} will appear here.`,
        }}
        unavailableOffline={['paying a balance']}
      >
        {(items) => {
          const open = items.filter((o) => o.status === 'open');
          const closed = items.filter((o) => o.status !== 'open');
          return (
            <View>
              {open.length > 0 ? (
                <Section title="Balances due">
                  <ObligationRows items={open} />
                </Section>
              ) : null}
              {closed.length > 0 ? (
                <Section title="History">
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

const VIEWS: readonly { id: PaymentsView; label: string }[] = [
  { id: 'balances', label: 'Balances due' },
  { id: 'payments', label: 'Payments' },
  { id: 'receipts', label: 'Receipts' },
  { id: 'orders', label: 'Orders' },
  { id: 'contributions', label: 'Team contributions' },
];

function ViewPicker({
  value,
  onChange,
}: {
  value: PaymentsView;
  onChange: (view: PaymentsView) => void;
}) {
  return (
    <Section title="Show">
      <View accessibilityRole="radiogroup" accessibilityLabel="Show">
        {VIEWS.map((view) => (
          <ChoiceRow
            key={view.id}
            mode="radio"
            label={view.label}
            checked={value === view.id}
            onPress={() => onChange(view.id)}
          />
        ))}
      </View>
    </Section>
  );
}

export function PaymentsScreen({ initialView = 'balances' }: { initialView?: PaymentsView }) {
  const [view, setView] = useState<PaymentsView>(initialView);
  return (
    <Screen>
      <RequireSession what="payments">
        <NeedsAttention />
        <ViewPicker value={view} onChange={setView} />
        {view === 'balances' ? (
          <PeopleGate pickerLabel="Show payments of">
            {(person) => <ObligationList key={person.personId} person={person} />}
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

/** Route component for app/payments/index.tsx. */
export function PaymentsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Payments and obligations' }} />
      <PaymentsScreen />
    </>
  );
}
