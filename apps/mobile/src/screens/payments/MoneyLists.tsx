/**
 * SCR-C-34 account-wide money lists (FIN-01; SPK-PAY-002, SPK-PAY-005, SPK-PAY-007, §4.5, §4.11,
 * SPK-UX-004, SPK-UX-008). Each covers the people this account pays for, as the API scopes it
 * from the account's own authority (never from a parameter the app sends), newest first, in
 * cursor pages with "Load more":
 *
 * - `GET /v1/me/payments`: every payment attempt by state. `unknown` reads "Payment outcome being
 *   confirmed. Do not pay again." and `processing` "Payment processing", never success or failure.
 * - `GET /v1/me/receipts`: money received, with what was applied and any overpayment kept visible.
 * - `GET /v1/me/orders`: orders with their lines, credits applied, payment and fulfillment state.
 * - Needs attention: `GET /v1/me/payments?status=unknown` and
 *   `GET /v1/me/registration-checkouts?status=recovery_required`, so an interrupted payment or a
 *   registration the facility is completing is found again from the server, not from the device.
 *
 * States (each list on its own): loading; empty (with what would appear); ready; error with code
 * and "Try again"; permission restriction ("not available", nothing of another payer); stale or
 * offline (cached with its age; "Load more" needs a connection).
 *
 * Payment attempts, receipts and orders carry no facility, so times are in the device's zone with
 * the zone named (reported; stage 3 left "facility zone on money records" open).
 */
import { presentationForError } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant, formatMoney } from '../../features/money/format';
import {
  RECEIPT_SOURCE_LABELS,
  checkoutRecoveryStatus,
  orderAmounts,
  orderStatus,
  orderTitle,
  paymentTitle,
  receiptAmounts,
} from '../../features/money/payment-lists';
import { useNameOf } from '../../features/money/people';
import { moneyRoutes } from '../../features/money/routes';
import { paymentStatus } from '../../features/money/status';
import { Caption, Section } from '../../features/money/ui';
import { registrationRoutes } from '../../features/registration/routes';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';

const PAGE = 20;

/** "Payer: You. Started Sat, Oct 24, 12:00 PM UTC". */
function payerLine(payer: string, at: string) {
  return `Payer: ${payer}. Started ${formatInstant(at)}`;
}

export function MyPaymentsList() {
  const router = useRouter();
  const nameOf = useNameOf();
  const payments = useApiPages({ path: '/me/payments', request: { query: { limit: PAGE } } });
  return (
    <Section title="Payments" testID="my-payments">
      <QueryBoundary
        query={payments}
        label="your payments"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No payments yet',
          description:
            'Payments you make, or make for the people you pay for, appear here with their state.',
        }}
        unavailableOffline={['loading more payments']}
      >
        {(items) => (
          <View accessibilityRole="list">
            {items.map((attempt) => (
              <ListRow
                key={attempt.id}
                title={paymentTitle(attempt)}
                detail={payerLine(nameOf(attempt.payerPersonId), attempt.createdAt)}
                status={paymentStatus(attempt.status)}
                onPress={() => router.push(moneyRoutes.payment(attempt.id))}
                accessibilityHint="Opens the payment with its state and any refunds"
                testID={`payment-${attempt.id}`}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={payments} label="payments" />
    </Section>
  );
}

export function MyReceiptsList() {
  const router = useRouter();
  const receipts = useApiPages({ path: '/me/receipts', request: { query: { limit: PAGE } } });
  return (
    <Section title="Receipts" testID="my-receipts">
      <QueryBoundary
        query={receipts}
        label="your receipts"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No receipts yet',
          description:
            'Each payment the facility receives from you, online or at the front desk, appears here.',
        }}
        unavailableOffline={['loading more receipts']}
      >
        {(items) => (
          <View accessibilityRole="list">
            {items.map((receipt) => {
              const paymentId = receipt.paymentAttemptId;
              return (
                <ListRow
                  key={receipt.id}
                  title={`Received ${formatMoney(receipt.amountMinor, receipt.currency)}`}
                  detail={`${RECEIPT_SOURCE_LABELS[receipt.sourceKind]}, ${formatInstant(receipt.receivedAt)}. ${receiptAmounts(receipt)}`}
                  onPress={
                    paymentId ? () => router.push(moneyRoutes.payment(paymentId)) : undefined
                  }
                  accessibilityHint={
                    paymentId ? 'Opens the payment this receipt is for' : undefined
                  }
                  testID={`receipt-${receipt.id}`}
                />
              );
            })}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={receipts} label="receipts" />
    </Section>
  );
}

export function MyOrdersList() {
  const router = useRouter();
  const orders = useApiPages({ path: '/me/orders', request: { query: { limit: PAGE } } });
  return (
    <Section title="Orders" testID="my-orders">
      <QueryBoundary
        query={orders}
        label="your orders"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No orders yet',
          description: 'Registrations you pay for appear here as orders, with what each line cost.',
        }}
        unavailableOffline={['loading more orders']}
      >
        {(items) => (
          <View accessibilityRole="list">
            {items.map((order) => (
              <ListRow
                key={order.id}
                title={orderTitle(order)}
                detail={`${orderAmounts(order)}. Ordered ${formatInstant(order.createdAt)}`}
                status={orderStatus(order)}
                onPress={() => router.push(moneyRoutes.order(order.id))}
                accessibilityHint="Opens the order with its balances and installments"
                testID={`order-${order.id}`}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={orders} label="orders" />
    </Section>
  );
}

/**
 * What must not be missed (SPK-PAY-007, §4.11): a payment whose outcome is unknown ("Do not pay
 * again") and a registration whose payment arrived but which the facility is completing. Shown
 * only when there is something; a failed read shows its own code and "Try again" here without
 * hiding the rest of the screen.
 */
export function NeedsAttention() {
  const router = useRouter();
  const nameOf = useNameOf();
  const unknown = useApiQuery({
    path: '/me/payments',
    request: { query: { status: 'unknown', limit: PAGE } },
  });
  const recovery = useApiQuery({
    path: '/me/registration-checkouts',
    request: { query: { status: 'recovery_required', limit: PAGE } },
  });
  const unknownItems = unknown.data?.items ?? [];
  const recoveryItems = recovery.data?.items ?? [];
  // Offline or "not available" says nothing here (the lists below show those states); a failure
  // shows its code, so a missing "needs attention" is never silent.
  const failed = [unknown, recovery].find(
    (q) => q.data === undefined && q.error !== null && presentationForError(q.error) === 'error',
  );
  if (unknownItems.length === 0 && recoveryItems.length === 0 && !failed) return null;
  return (
    <Section title="Needs attention" testID="needs-attention">
      {unknownItems.length > 0 || recoveryItems.length > 0 ? (
        <View accessibilityRole="list">
          {unknownItems.map((attempt) => (
            <ListRow
              key={attempt.id}
              title={paymentTitle(attempt)}
              detail={payerLine(nameOf(attempt.payerPersonId), attempt.createdAt)}
              status={paymentStatus(attempt.status)}
              onPress={() => router.push(moneyRoutes.payment(attempt.id))}
              accessibilityHint="Opens the payment; it never pays again"
              testID={`attention-payment-${attempt.id}`}
            />
          ))}
          {recoveryItems.map((checkout) => (
            <ListRow
              key={checkout.id}
              title="Registration payment"
              detail={`${checkout.payment ? `${formatMoney(checkout.payment.amountMinor, checkout.payment.currency)}. ` : ''}Started ${formatInstant(checkout.createdAt)}`}
              status={checkoutRecoveryStatus(checkout)}
              onPress={() => router.push(registrationRoutes.outcome(checkout.id))}
              accessibilityHint="Opens the registration outcome"
              testID={`attention-checkout-${checkout.id}`}
            />
          ))}
        </View>
      ) : null}
      {unknownItems.length > 0 ? (
        <Caption>
          Do not pay again for a payment being confirmed: the facility confirms the outcome with the
          payment provider, and it is never charged twice.
        </Caption>
      ) : null}
      {failed?.error ? (
        <QueryErrorView error={failed.error} onRetry={() => void failed.refetch()} />
      ) : null}
    </Section>
  );
}
