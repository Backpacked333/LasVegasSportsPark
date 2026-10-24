/**
 * SCR-C-32 Enrollments and participation, one record (SPK-REG-003, SPK-REG-010, SPK-PAY-006,
 * SPK-PLACE-002, SPK-YOUTH-003, SPK-UX-004, SPK-UX-008; §4.6 EnrollmentMachine, §4.11).
 *
 * `GET /v1/enrollments/{id}` with what the API lets this customer read around it: the offering
 * (published offerings only), the placement request, the order and its installment plan
 * ("Confirmed. Next payment due <date>." — a future installment never makes the enrollment look
 * unconfirmed), the operation of a pending enrollment (a `recovery_required` checkout reads
 * "Payment received. We are completing your registration."), and the linked enrollments of a
 * transfer (the old and new records stay linked; attendance history is kept).
 *
 * Entry to SCR-C-33: "Review cancellation" for pending and confirmed enrollments and "Review a
 * transfer" for confirmed ones (EnrollmentMachine transitions); the API's preview then says
 * whether the change is permitted. Nothing is committed from this screen.
 *
 * States: loading; empty: not applicable; ready; permission restriction and protected NOT_FOUND
 * read "not available" with no hint the record exists (§4.10); stale version: refreshed on
 * return; offline (cached with age, the previews need a connection); recovery required as above.
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDateRange, formatInstant, formatMoney } from '../../features/money/format';
import { useNameOf } from '../../features/money/people';
import { useApiRecords } from '../../features/money/records';
import { moneyRoutes, param } from '../../features/money/routes';
import { SecondaryRead, type SecondaryQuery } from '../../features/money/SecondaryRead';
import {
  consequenceSummary,
  enrollmentStatus,
  installmentPlanStatus,
  nextScheduledInstallment,
  type Enrollment,
} from '../../features/money/status';
import { Body, ButtonRow, Caption, Field, Section } from '../../features/money/ui';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { StatusBadge } from '../../ui/StatusBadge';
import { INTENT_LABELS, offeringLabel } from './EnrollmentsScreen';

type Order = Schema<'Order'>;

/** EnrollmentMachine (packages/contracts/src/state-machines.ts): states that allow each change. */
const CANCELABLE: readonly Enrollment['status'][] = ['pending', 'confirmed'];
const TRANSFERABLE: readonly Enrollment['status'][] = ['confirmed'];

function useEnrollmentContext(enrollment: Enrollment) {
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: enrollment.offeringId } },
  });
  const placement = useApiQuery({
    path: '/placement-requests/{id}',
    request: { path: { id: enrollment.placementRequestId ?? '' } },
    enabled: enrollment.placementRequestId !== null && enrollment.status === 'confirmed',
  });
  const order = useApiQuery({
    path: '/orders/{id}',
    request: { path: { id: enrollment.orderRef ?? '' } },
    enabled: enrollment.orderRef !== null,
  });
  const planId = order.data?.installmentPlanId ?? null;
  const plan = useApiQuery({
    path: '/installment-plans/{id}',
    request: { path: { id: planId ?? '' } },
    enabled: planId !== null,
  });
  const operation = useApiQuery({
    path: '/operations/{id}',
    request: { path: { id: enrollment.lastOperationId ?? '' } },
    enabled: enrollment.status === 'pending' && enrollment.lastOperationId !== null,
  });
  const linkedIds = [
    enrollment.transferredFromEnrollmentId,
    enrollment.transferredToEnrollmentId,
  ].filter((id): id is string => id !== null);
  const linked = useApiRecords('/enrollments/{id}', linkedIds);
  const linkedOfferings = useApiRecords(
    '/offerings/{id}',
    Object.values(linked)
      .map((r) => r.data?.offeringId)
      .filter((id): id is string => typeof id === 'string'),
  );
  return { offering, placement, order, plan, operation, linked, linkedOfferings };
}

function PaymentSummary({
  order: query,
  enrollment,
}: {
  order: SecondaryQuery<Order>;
  enrollment: Enrollment;
}) {
  if (!enrollment.orderRef) return null;
  // "Not available to this account" only for a protected NOT_FOUND or a permission restriction;
  // loading, offline and other failures have their own states (SPK-UX-008).
  return (
    <SecondaryRead
      query={query}
      label="the payment details"
      title="Payment"
      unavailable={{
        title: 'Payment details not available',
        description:
          'Payment details are not available to this account. The payer sees them under Payments.',
      }}
    >
      {(order) => <PaymentDetails order={order} />}
    </SecondaryRead>
  );
}

function PaymentDetails({ order }: { order: Order }) {
  const router = useRouter();
  return (
    <Section title="Payment">
      <Field label="Order total" value={formatMoney(order.totalMinor, order.currency)} />
      {order.creditsAppliedMinor > 0 ? (
        <Field
          label="Credits applied"
          value={formatMoney(order.creditsAppliedMinor, order.currency)}
        />
      ) : null}
      <ButtonRow>
        <Button
          label="Open payments"
          variant="secondary"
          onPress={() => router.push(moneyRoutes.payments())}
        />
      </ButtonRow>
    </Section>
  );
}

function EnrollmentDetail({ enrollment }: { enrollment: Enrollment }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const nameOf = useNameOf();
  const ctx = useEnrollmentContext(enrollment);
  const offeringName = ctx.offering.data?.name ?? null;
  const nextInstallment = ctx.plan.data ? nextScheduledInstallment(ctx.plan.data) : null;
  const target = enrollment.transferredToEnrollmentId
    ? ctx.linked[enrollment.transferredToEnrollmentId]?.data
    : undefined;
  const source = enrollment.transferredFromEnrollmentId
    ? ctx.linked[enrollment.transferredFromEnrollmentId]?.data
    : undefined;
  const recoveryRequired = ctx.operation.data?.status === 'recovery_required';
  const status = enrollmentStatus(enrollment, {
    offeringName,
    transferTargetName: target
      ? (ctx.linkedOfferings[target.offeringId]?.data?.name ?? null)
      : null,
    placement: ctx.placement.data ?? null,
    placementUnknown: enrollment.placementRequestId !== null && ctx.placement.data === undefined,
    nextInstallmentDueAt: nextInstallment?.dueAt ?? null,
    recoveryRequired,
  });
  const recorded = enrollment.cancellationConsequence
    ? consequenceSummary(enrollment.cancellationConsequence)
    : null;
  return (
    <View>
      <Section title={offeringLabel({ data: ctx.offering.data, loading: ctx.offering.isPending })}>
        <StatusBadge {...status} testID="enrollment-status" />
        <Field label="Participant" value={nameOf(enrollment.participantPersonId)} />
        <Field label="Kind" value={INTENT_LABELS[enrollment.intent]} />
        {ctx.offering.data ? (
          <Field
            label="Dates"
            value={formatDateRange(ctx.offering.data.startsOn, ctx.offering.data.endsOn)}
          />
        ) : null}
        {enrollment.confirmedAt ? (
          <Field label="Confirmed" value={formatInstant(enrollment.confirmedAt)} />
        ) : null}
        {enrollment.status === 'pending' && !recoveryRequired ? (
          <Caption>
            The facility has not confirmed this registration yet. Anything you need to do appears on
            Home.
          </Caption>
        ) : null}
        {recoveryRequired ? (
          <Caption>
            Your payment was received. The facility is completing the registration; do not pay
            again.
          </Caption>
        ) : null}
      </Section>

      {ctx.plan.data ? (
        <Section title="Installments">
          <StatusBadge {...installmentPlanStatus(ctx.plan.data)} />
          <Field
            label="Still to pay"
            value={formatMoney(ctx.plan.data.outstandingMinor, ctx.plan.data.currency)}
          />
          <Caption>
            A scheduled installment does not change this enrollment: it stays confirmed while
            installments are paid.
          </Caption>
        </Section>
      ) : (
        <PaymentSummary order={ctx.order} enrollment={enrollment} />
      )}

      {enrollment.status === 'canceled' ? (
        <Section title="Cancellation">
          {enrollment.canceledAt ? (
            <Field label="Canceled" value={formatInstant(enrollment.canceledAt)} />
          ) : null}
          {enrollment.cancellationReason ? (
            <Field label="Reason" value={enrollment.cancellationReason} />
          ) : null}
          {recorded ? (
            <>
              <StatusBadge tone={recorded.tone} label={recorded.headline} />
              <Body>{recorded.explanation}</Body>
              <Caption>
                Refunds and credits are carried out by the facility. This app cannot show their
                progress yet.
              </Caption>
            </>
          ) : null}
        </Section>
      ) : null}

      {target || source ? (
        <Section title="Transfer">
          <Caption>
            The old and new enrollments stay linked, and attendance history is kept.
          </Caption>
          {source ? (
            <ListRow
              title={`Transferred from ${offeringLabel(ctx.linkedOfferings[source.offeringId])}`}
              status={enrollmentStatus(source)}
              onPress={() => router.push(moneyRoutes.enrollment(source.id))}
              accessibilityHint="Opens the earlier enrollment"
            />
          ) : null}
          {target ? (
            <ListRow
              title={`Transferred to ${offeringLabel(ctx.linkedOfferings[target.offeringId])}`}
              status={enrollmentStatus(target)}
              onPress={() => router.push(moneyRoutes.enrollment(target.id))}
              accessibilityHint="Opens the new enrollment"
            />
          ) : null}
        </Section>
      ) : null}

      {CANCELABLE.includes(enrollment.status) ? (
        <Section title="Change this registration">
          <Caption>
            You see what a change means, including any refund, credit or charge, before anything is
            committed.
            {offline ? ' Needs a connection.' : ''}
          </Caption>
          <ButtonRow>
            <Button
              label="Review cancellation"
              variant="secondary"
              disabled={offline}
              onPress={() => router.push(moneyRoutes.cancel(enrollment.id))}
            />
            {TRANSFERABLE.includes(enrollment.status) ? (
              <Button
                label="Review a transfer"
                variant="secondary"
                disabled={offline}
                onPress={() => router.push(moneyRoutes.transfer(enrollment.id))}
              />
            ) : null}
          </ButtonRow>
        </Section>
      ) : null}
    </View>
  );
}

export function EnrollmentDetailScreen({ enrollmentId }: { enrollmentId: string }) {
  const enrollment = useApiQuery({
    path: '/enrollments/{id}',
    request: { path: { id: enrollmentId } },
  });
  return (
    <Screen>
      <RequireSession what="this enrollment">
        <QueryBoundary
          query={enrollment}
          label="the enrollment"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['canceling', 'transferring']}
        >
          {(data) => <EnrollmentDetail enrollment={data} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/enrollments/[id]/index.tsx. */
export function EnrollmentDetailRoute() {
  const id = param(useLocalSearchParams<{ id: string }>().id);
  return (
    <>
      <Stack.Screen options={{ title: 'Enrollment' }} />
      {id ? <EnrollmentDetailScreen enrollmentId={id} /> : <NotFoundScreen />}
    </>
  );
}
