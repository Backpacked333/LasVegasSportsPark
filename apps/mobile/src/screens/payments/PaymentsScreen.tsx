/**
 * SCR-C-34 Payments and obligations (SPK-PAY-002, SPK-PAY-005, SPK-PAY-006, SPK-PAY-007,
 * SPK-REG-003, SPK-AT-004, SPK-UX-004, SPK-UX-008; DEC-008, DEC-073 and POL-016 govern
 * installments and team billing and are the API's configuration, never the app's).
 *
 * What a person owes and has paid: `GET /v1/obligations?debtorPersonId=` (a registration order
 * makes the payer the debtor), balances due first, then history. Each row shows the amount, what
 * is left to pay and the status; an overpayment is shown, never hidden (SPK-PAY-005). Opening a
 * row shows the order lines, the installment plan with its due dates, authorization and notices,
 * the receipts of a payment made here, and "Pay" (SCR-C-34 detail).
 *
 * States: loading; empty (no payments); ready; validation failure: on the detail; permission
 * restriction (a person whose balances this account may not see reads "not available", nothing of
 * another payer is shown); stale version: refreshed on return; offline (cached with age, paying
 * needs a connection); processing and recovery required: on the detail.
 *
 * API gaps (reported): there is no customer list of orders, payment attempts, receipts or
 * checkouts, so a payment's state and receipt are visible only for a payment made on this screen,
 * and a `recovery_required` checkout cannot be listed here. Team obligation lines belong to the
 * captain workspace (SCR-C-25).
 */
import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatMoney } from '../../features/money/format';
import { PeopleGate } from '../../features/money/PeopleGate';
import type { AccountPerson } from '../../features/money/people';
import { moneyRoutes } from '../../features/money/routes';
import { obligationStatus, type Obligation } from '../../features/money/status';
import { Section } from '../../features/money/ui';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';

/** "Left to pay $40.00 of $120.00", with any overpayment named (SPK-PAY-005). */
export function obligationAmounts(obligation: Obligation): string {
  const t = obligation.totals;
  const parts =
    obligation.status === 'open'
      ? [
          `Left to pay ${formatMoney(t.remainingMinor, t.currency)} of ${formatMoney(t.amountMinor, t.currency)}`,
        ]
      : [`${formatMoney(t.amountMinor, t.currency)}`];
  if (t.excessMinor > 0)
    parts.push(`Paid beyond the balance: ${formatMoney(t.excessMinor, t.currency)}`);
  return parts.join('. ');
}

function ObligationRows({ items }: { items: readonly Obligation[] }) {
  const router = useRouter();
  const now = useNow();
  return (
    <View accessibilityRole="list">
      {items.map((obligation) => (
        <ListRow
          key={obligation.id}
          title={obligation.description}
          detail={obligationAmounts(obligation)}
          status={obligationStatus(obligation, now)}
          onPress={() => router.push(moneyRoutes.obligation(obligation.id))}
          accessibilityHint="Opens the balance, its order, installments and payment"
          testID={`obligation-${obligation.id}`}
        />
      ))}
    </View>
  );
}

function ObligationList({ person }: { person: AccountPerson }) {
  const obligations = useApiQuery({
    path: '/obligations',
    request: { query: { debtorPersonId: person.personId, limit: 50 } },
  });
  return (
    <QueryBoundary
      query={obligations}
      label="payments"
      isEmpty={(page) => page.items.length === 0}
      empty={{
        title: 'No payments',
        description: `Orders, balances due and installments ${person.self ? 'you owe' : `${person.displayName} owes`} will appear here.`,
      }}
      unavailableOffline={['paying a balance']}
    >
      {(page) => {
        const open = page.items.filter((o) => o.status === 'open');
        const closed = page.items.filter((o) => o.status !== 'open');
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
  );
}

export function PaymentsScreen() {
  return (
    <Screen>
      <RequireSession what="payments">
        <PeopleGate pickerLabel="Show payments of">
          {(person) => <ObligationList key={person.personId} person={person} />}
        </PeopleGate>
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
