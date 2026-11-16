/**
 * SCR-C-34 sections shared by a balance (ObligationScreen) and an order (OrderScreen): the order
 * with its lines per participant, credits applied and its payment and fulfillment state, and the
 * installment plan with amounts, due dates, authorization, notices and the API's retry rules
 * (SPK-PAY-002, SPK-PAY-006, SPK-REG-003, §4.11; DEC-073 and POL-016 are the API's values).
 */
import { View } from 'react-native';
import { formatDay, formatInstant, formatMoney } from '../../features/money/format';
import {
  ORDER_FULFILLMENT_STATUS,
  orderPaymentStatus,
  type Order,
} from '../../features/money/payment-lists';
import { useMe, useNameOf } from '../../features/money/people';
import {
  installmentPlanStatus,
  installmentStatus,
  type InstallmentPlan,
  type PaymentAttempt,
} from '../../features/money/status';
import { ListRow } from '../../ui/ListRow';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { FieldValue as Field } from '../../ui/Field';
import { Section } from '../../ui/Section';

export function OrderSection({
  order,
  livePayment = null,
}: {
  order: Order;
  /** The order's checkout payment still on its way, when known: its state replaces "Not paid yet". */
  livePayment?: PaymentAttempt | null;
}) {
  const nameOf = useNameOf();
  return (
    <Section title="Order">
      <StatusBadge {...orderPaymentStatus(order, livePayment)} testID="order-payment" />
      <StatusBadge
        {...ORDER_FULFILLMENT_STATUS[order.fulfillmentStatus]}
        testID="order-fulfillment"
      />
      <View accessibilityRole="list">
        {order.lines.map((line) => (
          <ListRow
            key={line.id}
            // SPK-PAY-014, SPK-REG-012: an add-on or a uniform bought with a place is its own
            // line on the receipt, named as such, with the days it was bought for.
            title={`${
              line.lineKind === 'addon'
                ? 'Add-on: '
                : line.lineKind === 'uniform'
                  ? 'Uniform: '
                  : ''
            }${line.description}${line.quantity > 1 ? ` × ${line.quantity}` : ''}`}
            detail={`${nameOf(line.participantPersonId)}. ${formatMoney(line.totalMinor, line.currency)}`}
          />
        ))}
      </View>
      <Field label="Order total" value={formatMoney(order.totalMinor, order.currency)} />
      {order.creditsAppliedMinor > 0 ? (
        <Field
          label="Credits applied"
          value={formatMoney(order.creditsAppliedMinor, order.currency)}
        />
      ) : null}
      <Field label="Due at checkout" value={formatMoney(order.dueNowMinor, order.currency)} />
      {order.paidAt ? <Field label="Paid" value={formatInstant(order.paidAt)} /> : null}
    </Section>
  );
}

/**
 * Who authorized the recurring charges, as recorded (SPK-PAY-006): "You" only when it was the
 * signed-in person; another known person by name; otherwise just the date (a staff-assisted
 * registration, or an unrecorded authorizer).
 */
export function authorizationText(
  plan: Pick<InstallmentPlan, 'authorization'>,
  selfId: string | null,
  nameOf: (personId: string) => string,
): string {
  const at = formatInstant(plan.authorization.authorizedAt);
  const by = plan.authorization.authorizedByPersonId;
  if (by && selfId && by === selfId) return `You authorized these installments on ${at}`;
  if (by) {
    const name = nameOf(by);
    if (name !== 'Participant' && name !== 'Loading name…') {
      return `${name} authorized these installments on ${at}`;
    }
  }
  return `Authorized on ${at}`;
}

export function InstallmentsSection({ plan }: { plan: InstallmentPlan }) {
  const me = useMe();
  const selfId = me.data?.person?.id ?? null;
  const nameOf = useNameOf();
  const failed = plan.installments.some((i) => i.status === 'failed');
  return (
    <Section title="Installments" testID="installments">
      <StatusBadge {...installmentPlanStatus(plan)} />
      <Field label="Plan total" value={formatMoney(plan.totalMinor, plan.currency)} />
      <Field label="Still to pay" value={formatMoney(plan.outstandingMinor, plan.currency)} />
      <Field label="Authorization" value={authorizationText(plan, selfId, nameOf)} />
      <Field
        label="Reminders"
        value={`Sent ${plan.noticePolicy.daysBefore} ${plan.noticePolicy.daysBefore === 1 ? 'day' : 'days'} before each due date`}
      />
      <Field
        label="If a payment fails"
        value={`Tried up to ${plan.retryPolicy.maxAttempts} times, ${plan.retryPolicy.retryIntervalHours} hours apart`}
      />
      <Text variant="caption" tone="muted">
        Installments do not change your registration: it stays confirmed while they are paid.
      </Text>
      <View accessibilityRole="list">
        {[...plan.installments]
          .sort((a, b) => a.sequence - b.sequence)
          .map((installment) => {
            const details = [
              `Due ${formatDay(installment.dueAt)}`,
              installment.extensionCount > 0
                ? `moved from ${formatDay(installment.originalDueAt)}`
                : null,
              installment.paidAt ? `paid ${formatInstant(installment.paidAt)}` : null,
              installment.lastFailureReason
                ? `last attempt: ${installment.lastFailureReason}`
                : null,
              installment.noticeSentAt
                ? `reminder sent ${formatDay(installment.noticeSentAt)}`
                : null,
            ].filter(Boolean);
            return (
              <ListRow
                key={installment.id}
                title={`Installment ${installment.sequence}: ${formatMoney(installment.amountMinor, installment.currency)}`}
                detail={details.join(', ')}
                status={installmentStatus(installment)}
                testID={`installment-${installment.sequence}`}
              />
            );
          })}
      </View>
      {failed ? (
        // Customer retry of a failed installment waits on DEC-019 and a retry policy (stage 3
        // did not build it); the facility collects it.
        <Text variant="body">
          Payment attention needed: contact the facility. Retrying a failed installment is done by
          the facility, not in the app.
        </Text>
      ) : null}
    </Section>
  );
}
