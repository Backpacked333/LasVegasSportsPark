/**
 * SCR-C-34 one order (SPK-PAY-002, SPK-PAY-005, SPK-PAY-006, SPK-REG-003, §4.11, SPK-UX-008).
 * Reads `GET /v1/orders/{id}` (the payer or the people who pay for them; protected NOT_FOUND
 * otherwise, shown as "not available"): the lines per participant, the total, credits applied,
 * what was due at checkout, and the payment and fulfillment state ("Payment received. We are
 * completing your registration." for `recovery_required`). An unpaid order reads "Not paid yet"
 * and asks nothing of the payer; while its checkout payment is on its way
 * (`GET /v1/me/payments?purpose=checkout`) that payment's state replaces it ("Payment outcome being
 * confirmed. Do not pay again." for `unknown`) and "Open the payment" shows it. Below it, each balance the order
 * created (`GET /v1/obligations/{id}` per `obligationIds`, each with its own state, and a payment
 * on its way named on its row) and the installment plan (`GET /v1/installment-plans/{id}`).
 *
 * Route: `/payments/order/{orderId}` (opaque id only, §4.14), from Payments "Orders".
 *
 * States: loading; ready; error with code and "Try again" (each secondary read on its own);
 * not available; stale (refetch on focus); offline (cached with age).
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant, formatMoney } from '../../features/money/format';
import { useOrderPayments } from '../../features/money/live-payments';
import {
  liveAttemptStatus,
  obligationAmounts,
  type Order,
} from '../../features/money/payment-lists';
import { PaymentCheckFailed } from '../../features/money/PaymentCheckFailed';
import { useApiRecords } from '../../features/money/records';
import { moneyRoutes, param } from '../../features/money/routes';
import { SecondaryRead } from '../../features/money/SecondaryRead';
import { obligationStatus, paymentStatus, type PaymentAttempt } from '../../features/money/status';
import { Body, ButtonRow, Section } from '../../features/money/ui';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { InstallmentsSection, OrderSection } from './OrderSections';

function OrderBalances({ order }: { order: Order }) {
  const router = useRouter();
  const now = useNow();
  const records = useApiRecords('/obligations/{id}', order.obligationIds);
  if (order.obligationIds.length === 0) return null;
  return (
    <Section title="Balances of this order" testID="order-balances">
      <View accessibilityRole="list">
        {order.obligationIds.map((id) => {
          const record = records[id];
          if (!record || record.loading) {
            return <StateView key={id} variant="loading" label="a balance" />;
          }
          if (!record.data) {
            return record.error ? (
              <QueryErrorView key={id} error={record.error} onRetry={record.refetch} />
            ) : null;
          }
          const obligation = record.data;
          const live = obligation.liveAttempt ?? null;
          return (
            <ListRow
              key={id}
              title={obligation.description}
              detail={obligationAmounts(obligation)}
              status={live ? liveAttemptStatus(live) : obligationStatus(obligation, now)}
              onPress={() => router.push(moneyRoutes.obligation(id))}
              accessibilityHint="Opens the balance and its payment"
              testID={`order-balance-${id}`}
            />
          );
        })}
      </View>
    </Section>
  );
}

/**
 * The order's checkout payment that is still on its way (SPK-PAY-007): its state, the API's
 * amount and start time, and the attempt itself (listed in the account's payments, so it opens).
 */
function OrderLivePayment({ payment }: { payment: PaymentAttempt }) {
  const router = useRouter();
  return (
    <Section title="A payment is on its way" testID="order-live-payment">
      <StatusBadge {...paymentStatus(payment.status)} />
      <Body>
        {`A payment of ${formatMoney(payment.amountMinor, payment.currency)} started ${formatInstant(payment.createdAt)} has no final outcome yet. Do not pay again.`}
      </Body>
      <ButtonRow>
        <Button
          label="Open the payment"
          variant="secondary"
          onPress={() => router.push(moneyRoutes.payment(payment.id))}
          accessibilityHint="Shows the payment's state; it never pays again"
        />
      </ButtonRow>
    </Section>
  );
}

function OrderDetail({ order }: { order: Order }) {
  const planId = order.installmentPlanId;
  const plan = useApiQuery({
    path: '/installment-plans/{id}',
    request: { path: { id: planId ?? '' } },
    enabled: planId !== null,
  });
  // An order stays `awaiting_payment` until a payment succeeds; its checkout payment on its way is
  // found in the account's payments (the order carries no `liveAttempt`; reported).
  const unpaid = order.paymentStatus === 'awaiting_payment';
  const { live, payments } = useOrderPayments(unpaid);
  const livePayment = unpaid ? (live.get(order.id) ?? null) : null;
  return (
    <View>
      <OrderSection order={order} livePayment={livePayment} />
      {livePayment ? <OrderLivePayment payment={livePayment} /> : null}
      {unpaid ? <PaymentCheckFailed query={payments} what="this order" /> : null}
      <OrderBalances order={order} />
      {planId !== null ? (
        <SecondaryRead query={plan} label="the installments" title="Installments">
          {(data) => <InstallmentsSection plan={data} />}
        </SecondaryRead>
      ) : null}
    </View>
  );
}

export function OrderScreen({ orderId }: { orderId: string }) {
  const order = useApiQuery({ path: '/orders/{id}', request: { path: { id: orderId } } });
  return (
    <Screen>
      <RequireSession what="this order">
        <QueryBoundary
          query={order}
          label="the order"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['paying a balance']}
        >
          {(data) => <OrderDetail order={data} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/payments/order/[orderId].tsx. */
export function OrderRoute() {
  const id = param(useLocalSearchParams<{ orderId: string }>().orderId);
  return (
    <>
      <Stack.Screen options={{ title: 'Order' }} />
      {id ? <OrderScreen orderId={id} /> : <NotFoundScreen />}
    </>
  );
}
