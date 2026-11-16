/**
 * SCR-C-32 Registrations, one record (the API's enrollment; SPK-REG-003, SPK-REG-010, SPK-PAY-006,
 * SPK-PLACE-002, SPK-YOUTH-003, SPK-UX-004, SPK-UX-008; §4.6 EnrollmentMachine, §4.11).
 *
 * `GET /v1/enrollments/{id}` with what the API lets this customer read around it: the offering
 * the enrollment carries (ENR-02: name, dates and facility zone, also for a closed season), the
 * placement request ("Confirmed: <team>" once placed), the order and its installment plan
 * ("Confirmed. Next payment due <date>." — a future installment never makes the enrollment look
 * unconfirmed), what a pending enrollment waits for ("Registration pending: <reason>",
 * `pendingReason`), the operation or checkout of a pending enrollment (a `recovery_required`
 * checkout, from the operation or every page of `GET /v1/me/registration-checkouts?status=
 * recovery_required`, the same test as the list row, reads "Payment received. We are completing
 * your registration."; while that is not known, a record waiting for payment never says the
 * payment is not finished and shows the read loading or failed, with "Try again"), and the linked
 * enrollments of a transfer (the old and
 * new records stay linked; attendance history is kept). A membership shows its term,
 * suspensions and the renewal the customer may start (MembershipSection).
 *
 * Entry to SCR-C-33: "Review cancellation" for pending and confirmed enrollments and "Review a
 * transfer" for confirmed ones (EnrollmentMachine transitions); the API's preview then says
 * whether the change is permitted. Nothing is committed from this screen.
 *
 * States: loading; empty: not applicable; ready; permission restriction and protected NOT_FOUND
 * read "not available" with no hint the record exists (§4.10); stale version: refreshed on
 * return; offline (cached with age, the previews need a connection); recovery required as above.
 *
 * Layout (PA-11, ADR-008): the activity's picture (`artworkFor`) heads the page, then the status in
 * the journeys.md section 3 phrase, the facts, and the sections below. Customer words throughout:
 * registration (never enrollment), cart (never basket).
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDateRange, formatMoney } from '../../features/money/format';
import { formatInstant } from '../../features/registration/format';
import { useRecoveryCheckouts } from '../../features/registration/in-progress';
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
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Artwork } from '../../ui/Artwork';
import { Button } from '../../ui/Button';
import { FieldValue as Field } from '../../ui/Field';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { layout, spacing } from '../../ui/theme';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { StatusBadge } from '../../ui/StatusBadge';
import { INTENT_LABELS, offeringLabel, recoveryContext } from './EnrollmentsScreen';
import { MembershipSection } from './MembershipSection';
import { enrollmentOffering } from './participation';
import { pendingEnrollmentRecovery, recoveryIndex, RecoveryReadState } from './recovery';
import { registrationArt } from './RegistrationCard';

type Order = Schema<'Order'>;

/** EnrollmentMachine (packages/contracts/src/state-machines.ts): states that allow each change. */
const CANCELABLE: readonly Enrollment['status'][] = ['pending', 'confirmed'];
const TRANSFERABLE: readonly Enrollment['status'][] = ['confirmed'];

function useEnrollmentContext(enrollment: Enrollment) {
  // The enrollment carries its offering (ENR-02); the public read is only a fallback.
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: enrollment.offeringId } },
    enabled: !enrollment.offering,
  });
  // Every checkout in recovery, as the list reads them (R3-SCREEN-STATES-04).
  const checkouts = useRecoveryCheckouts(enrollment.status === 'pending');
  const recovery = recoveryIndex(checkouts);
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
  return {
    offering,
    checkouts,
    recovery,
    placement,
    order,
    plan,
    operation,
    linked,
    linkedOfferings,
  };
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
      <View style={styles.buttons}>
        <Button
          label="Open payments"
          variant="secondary"
          onPress={() => router.push(moneyRoutes.payments())}
        />
      </View>
    </Section>
  );
}

function EnrollmentDetail({ enrollment }: { enrollment: Enrollment }) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const nameOf = useNameOf();
  const ctx = useEnrollmentContext(enrollment);
  const about = enrollmentOffering(enrollment, ctx.offering.data);
  const offeringName = about?.name ?? null;
  const timeZone = about?.timezone ?? undefined;
  const nextInstallment = ctx.plan.data ? nextScheduledInstallment(ctx.plan.data) : null;
  const target = enrollment.transferredToEnrollmentId
    ? ctx.linked[enrollment.transferredToEnrollmentId]?.data
    : undefined;
  const source = enrollment.transferredFromEnrollmentId
    ? ctx.linked[enrollment.transferredFromEnrollmentId]?.data
    : undefined;
  const recovery = pendingEnrollmentRecovery(
    enrollment,
    ctx.recovery,
    enrollment.lastOperationId ? ctx.operation : undefined,
  );
  const recoveryRequired = recovery === 'recovery_required';
  // Not known yet: "payment not finished" could invite a second payment (§4.11).
  const paymentUnknown = recovery === 'unknown' && enrollment.pendingReason === 'payment';
  const status = enrollmentStatus(enrollment, {
    offeringName,
    transferTargetName: target
      ? (enrollmentOffering(target, ctx.linkedOfferings[target.offeringId]?.data)?.name ?? null)
      : null,
    placement: ctx.placement.data ?? null,
    placementUnknown: enrollment.placementRequestId !== null && ctx.placement.data === undefined,
    nextInstallmentDueAt: nextInstallment?.dueAt ?? null,
    ...recoveryContext(recovery),
  });
  const recorded = enrollment.cancellationConsequence
    ? consequenceSummary(enrollment.cancellationConsequence)
    : null;
  const title =
    about?.name ??
    offeringLabel({
      data: ctx.offering.data,
      loading: ctx.offering.isPending && ctx.offering.fetchStatus === 'fetching',
    });
  return (
    <View>
      <View style={styles.hero}>
        <Artwork
          source={registrationArt(enrollment.intent, title, ctx.offering.data, 'wide')}
          aspectRatio={16 / 9}
          rounded
          testID="registration-art"
        />
      </View>
      <Section title={title}>
        <StatusBadge {...status} testID="enrollment-status" />
        <Field label="Participant" value={nameOf(enrollment.participantPersonId)} />
        <Field label="Kind" value={INTENT_LABELS[enrollment.intent]} />
        {about ? (
          <Field label="Dates" value={formatDateRange(about.startsOn, about.endsOn)} />
        ) : null}
        {enrollment.confirmedAt ? (
          <Field label="Confirmed" value={formatInstant(enrollment.confirmedAt, timeZone)} />
        ) : null}
        {paymentUnknown ? (
          <View testID="enrollment-recovery-unknown">
            <Text variant="caption" tone="muted">
              Whether the payment for this registration was received is not known yet. It shows here
              once it can be checked.
            </Text>
            <RecoveryReadState
              checkouts={ctx.checkouts}
              operations={enrollment.lastOperationId ? [ctx.operation] : []}
            />
          </View>
        ) : null}
        {enrollment.status === 'pending' && !recoveryRequired && !paymentUnknown ? (
          <Text variant="caption" tone="muted">
            {enrollment.pendingReason === 'forms'
              ? 'A required form is not signed yet. Forms are signed from your cart or from Home.'
              : enrollment.pendingReason === 'payment'
                ? 'The payment for this registration is not finished. Open your cart to finish it.'
                : 'The facility has not confirmed this registration yet. Anything you need to do appears on Home.'}
          </Text>
        ) : null}
        {recoveryRequired ? (
          <Text variant="caption" tone="muted">
            Your payment was received. The facility is completing the registration; do not pay
            again.
          </Text>
        ) : null}
      </Section>

      {ctx.plan.data ? (
        <Section title="Installments">
          <StatusBadge {...installmentPlanStatus(ctx.plan.data)} />
          <Field
            label="Still to pay"
            value={formatMoney(ctx.plan.data.outstandingMinor, ctx.plan.data.currency)}
          />
          <Text variant="caption" tone="muted">
            A scheduled installment does not change this registration: it stays confirmed while
            installments are paid.
          </Text>
        </Section>
      ) : (
        <PaymentSummary order={ctx.order} enrollment={enrollment} />
      )}

      {enrollment.status === 'canceled' ? (
        <Section title="Cancellation">
          {enrollment.canceledAt ? (
            <Field label="Canceled" value={formatInstant(enrollment.canceledAt, timeZone)} />
          ) : null}
          {enrollment.cancellationReason ? (
            <Field label="Reason" value={enrollment.cancellationReason} />
          ) : null}
          {recorded ? (
            <>
              <StatusBadge tone={recorded.tone} label={recorded.headline} />
              <Text variant="body">{recorded.explanation}</Text>
              <Text variant="caption" tone="muted">
                Refunds and credits are carried out by the facility. This app cannot show their
                progress yet.
              </Text>
            </>
          ) : null}
        </Section>
      ) : null}

      {target || source ? (
        <Section title="Transfer">
          <Text variant="caption" tone="muted">
            The old and new registrations stay linked, and attendance history is kept.
          </Text>
          {source ? (
            <ListRow
              title={`Transferred from ${
                enrollmentOffering(source, ctx.linkedOfferings[source.offeringId]?.data)?.name ??
                offeringLabel(ctx.linkedOfferings[source.offeringId])
              }`}
              status={enrollmentStatus(source)}
              onPress={() => router.push(moneyRoutes.enrollment(source.id))}
              accessibilityHint="Opens the earlier registration"
            />
          ) : null}
          {target ? (
            <ListRow
              title={`Transferred to ${
                enrollmentOffering(target, ctx.linkedOfferings[target.offeringId]?.data)?.name ??
                offeringLabel(ctx.linkedOfferings[target.offeringId])
              }`}
              status={enrollmentStatus(target)}
              onPress={() => router.push(moneyRoutes.enrollment(target.id))}
              accessibilityHint="Opens the new registration"
            />
          ) : null}
        </Section>
      ) : null}

      {enrollment.intent === 'membership' ? (
        <MembershipSection enrollment={enrollment} timeZone={timeZone} />
      ) : null}

      {CANCELABLE.includes(enrollment.status) ? (
        <Section title="Change this registration">
          <Text variant="caption" tone="muted">
            You see what a change means, including any refund, credit or charge, before anything is
            committed.
            {offline ? ' Needs a connection.' : ''}
          </Text>
          <View style={styles.buttons}>
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
          </View>
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
      <RequireSession what="this registration">
        <QueryBoundary
          query={enrollment}
          label="the registration"
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
      <Stack.Screen options={{ title: 'Registration' }} />
      {id ? <EnrollmentDetailScreen enrollmentId={id} /> : <NotFoundScreen />}
    </>
  );
}

const styles = {
  hero: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
} as const;
