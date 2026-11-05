/**
 * SCR-C-32 Enrollments and participation (SPK-REG-001, SPK-REG-003, SPK-REG-010, SPK-YOUTH-003,
 * SPK-AT-019, SPK-UX-004, SPK-UX-008, SPK-UX-009; journeys C5, C8, C11).
 *
 * For the person chosen (themselves or someone the API lets the account act for), each record
 * keeps its own state:
 * - enrollments (`GET /v1/enrollments?participantPersonId=`, keyset pages with "Load more"),
 *   current first, then history (transfers, cancellations, completed seasons). The offering's
 *   name and dates come from the enrollment itself (ENR-02), also for a closed or archived
 *   season. A pending enrollment names what it waits for ("Registration pending: awaiting
 *   approval", from `pendingReason`); one whose checkout is `recovery_required` (every page of
 *   `GET /v1/me/registration-checkouts?status=recovery_required`, or its last operation, the same
 *   test as the record, `recovery.tsx`) reads "Payment received. We are completing your
 *   registration."; while that is not known (a read loading or failed) one waiting for payment
 *   reads "Registration pending: payment status not known yet", never "payment not finished", and
 *   a failed read is shown with its code and "Try again"; a confirmed one awaiting placement reads
 *   "Confirmed in <offering>. Awaiting placement.", and a placed one "Confirmed: <team>"
 *   (`GET /v1/placement-requests/{id}`);
 * - applications (`GET /v1/me/applications`): "Awaiting approval", "Not approved: <reason>";
 * - trial participations (`GET /v1/me/trial-participations`), never shown as enrollments;
 * - session bookings (`GET /v1/session-bookings?participantPersonId=`): pickup, trial, makeup.
 * The household lists are read once and shown per person; "Load more" reaches older pages.
 * Opening an enrollment shows the record and the entry to the cancellation and transfer previews
 * (SCR-C-33).
 *
 * States: loading; empty (no participation, with the way to find activities); ready; validation
 * failure: not applicable; permission restriction (a person the API does not let this account see
 * reads "not available", children by view grant); stale version: refreshed on return; offline
 * (cached with age; cancel and transfer need a connection); processing, success: not applicable;
 * partial completion: not permitted; recovery required: labelled on the row and the record. Each
 * section has its own loading and error state.
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { Stack, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useApiPages, type ApiPagesResult } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDateRange } from '../../features/money/format';
import { PeopleGate } from '../../features/money/PeopleGate';
import type { AccountPerson } from '../../features/money/people';
import { useApiRecords, type Records } from '../../features/money/records';
import { moneyRoutes } from '../../features/money/routes';
import { bookingStatus, enrollmentStatus, type Enrollment } from '../../features/money/status';
import { Caption, Section } from '../../features/money/ui';
import { formatInstant } from '../../features/registration/format';
import { useRecoveryCheckouts } from '../../features/registration/in-progress';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import {
  applicationStatus,
  enrollmentOffering,
  SESSION_BOOKING_KIND_LABELS,
  trialStatus,
} from './participation';
import {
  pendingEnrollmentRecovery,
  recoveryIndex,
  recoveryReadFailed,
  RecoveryReadState,
  type OperationRead,
  type RecoveryIndex,
} from './recovery';

type Offering = Schema<'Offering'>;

const CURRENT: readonly Enrollment['status'][] = ['pending', 'confirmed'];
export const ENROLLMENTS_PAGE_SIZE = 50;

/** SPK-YOUTH-003: a trial stays distinct from a paid enrollment. */
export const INTENT_LABELS: Record<Enrollment['intent'], string> = {
  individual_league: 'League registration',
  join_team: 'Team member',
  create_team_entry: 'Team entry',
  youth: 'Youth program',
  trial: 'Trial (not a paid enrollment)',
  makeup: 'Makeup session',
  pickup: 'Pickup session',
  rental_request: 'Rental request',
  membership: 'Membership',
  package_purchase: 'Session package',
  party_request: 'Party booking',
};

export function offeringLabel(
  record: { data: Offering | undefined; loading: boolean } | undefined,
): string {
  if (record?.data) return record.data.name;
  return record?.loading ? 'Loading activity…' : 'Activity no longer listed';
}

/** The recovery answer as `enrollmentStatus` takes it (list row and record alike). */
export function recoveryContext(recovery: ReturnType<typeof pendingEnrollmentRecovery>): {
  recoveryRequired: boolean;
  recoveryUnknown: boolean;
} {
  return {
    recoveryRequired: recovery === 'recovery_required',
    recoveryUnknown: recovery === 'unknown',
  };
}

function EnrollmentRows({
  items,
  all,
  offerings,
  placements,
  operations,
  recovery,
}: {
  items: readonly Enrollment[];
  all: readonly Enrollment[];
  offerings: Records<'/offerings/{id}'>;
  placements: Records<'/placement-requests/{id}'>;
  operations: Records<'/operations/{id}'>;
  recovery: RecoveryIndex;
}) {
  const router = useRouter();
  return (
    <View accessibilityRole="list">
      {items.map((enrollment) => {
        const record = offerings[enrollment.offeringId];
        const about = enrollmentOffering(enrollment, record?.data);
        const name = about?.name ?? offeringLabel(record);
        const target = enrollment.transferredToEnrollmentId
          ? all.find((e) => e.id === enrollment.transferredToEnrollmentId)
          : undefined;
        const targetName = target
          ? (enrollmentOffering(target, offerings[target.offeringId]?.data)?.name ?? null)
          : null;
        const status = enrollmentStatus(enrollment, {
          offeringName: about?.name ?? null,
          transferTargetName: targetName,
          placement: enrollment.placementRequestId
            ? (placements[enrollment.placementRequestId]?.data ?? null)
            : null,
          placementUnknown:
            enrollment.placementRequestId !== null &&
            placements[enrollment.placementRequestId]?.data === undefined,
          ...recoveryContext(
            pendingEnrollmentRecovery(
              enrollment,
              recovery,
              enrollment.lastOperationId ? operations[enrollment.lastOperationId] : undefined,
            ),
          ),
        });
        const dates = about ? formatDateRange(about.startsOn, about.endsOn) : undefined;
        return (
          <ListRow
            key={enrollment.id}
            title={name}
            detail={[INTENT_LABELS[enrollment.intent], dates].filter(Boolean).join('. ')}
            status={status}
            onPress={() => router.push(moneyRoutes.enrollment(enrollment.id))}
            accessibilityHint="Opens the enrollment, with cancellation and transfer"
            testID={`enrollment-${enrollment.id}`}
          />
        );
      })}
    </View>
  );
}

function EnrollmentList({ person }: { person: AccountPerson }) {
  const router = useRouter();
  const enrollments = useApiPages({
    path: '/enrollments',
    request: { query: { participantPersonId: person.personId, limit: ENROLLMENTS_PAGE_SIZE } },
  });
  const items = enrollments.data ?? [];
  // The enrollment carries its offering (ENR-02); the public read is only a fallback.
  const offerings = useApiRecords(
    '/offerings/{id}',
    items.filter((e) => !e.offering).map((e) => e.offeringId),
    enrollments.data !== undefined,
  );
  const placements = useApiRecords(
    '/placement-requests/{id}',
    items
      .filter((e) => e.status === 'confirmed' && e.placementRequestId)
      .map((e) => e.placementRequestId as string),
    enrollments.data !== undefined,
  );
  // Recovery is read the way the record reads it (R3-SCREEN-STATES-04): every checkout in
  // recovery, not the newest page of all checkouts, and each pending enrollment's last operation.
  const pending = items.filter((e) => e.status === 'pending');
  const checkouts = useRecoveryCheckouts(pending.length > 0);
  const operations = useApiRecords(
    '/operations/{id}',
    pending.flatMap((e) => (e.lastOperationId ? [e.lastOperationId] : [])),
    enrollments.data !== undefined,
  );
  const recovery = recoveryIndex(checkouts);
  // Pending enrollments whose recovery is not known yet, and the operation reads behind them.
  const unknown = pending.filter(
    (e) =>
      pendingEnrollmentRecovery(
        e,
        recovery,
        e.lastOperationId ? operations[e.lastOperationId] : undefined,
      ) === 'unknown',
  );
  const unknownOperations = unknown.flatMap((e): OperationRead[] => {
    const read = e.lastOperationId ? operations[e.lastOperationId] : undefined;
    return read ? [read] : [];
  });
  const whose = person.self ? 'your' : `${person.displayName}’s`;
  return (
    <View>
      {unknown.length > 0 && recoveryReadFailed(checkouts, unknownOperations) ? (
        // A failed read is shown, not read as "payment not finished" (§4.11, SPK-UX-008).
        <Section title="Payment status" testID="enrollments-recovery-unknown">
          <Caption>
            {`Whether the payment was received for ${
              unknown.length === 1
                ? 'a pending registration'
                : `${unknown.length} pending registrations`
            } could not be checked.`}
          </Caption>
          <RecoveryReadState checkouts={checkouts} operations={unknownOperations} />
        </Section>
      ) : null}
      <QueryBoundary
        query={enrollments}
        label={`${whose} enrollments`}
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No enrollments yet',
          description: `${person.self ? 'Your' : `${person.displayName}’s`} registrations, placements and completed seasons will appear here. Leagues, programs and camps are in Discover.`,
          actionLabel: 'Open Discover',
          onAction: () => router.push('/discover'),
        }}
        unavailableOffline={['canceling a registration', 'transferring a registration']}
      >
        {(list) => {
          const current = list.filter((e) => CURRENT.includes(e.status));
          const history = list.filter((e) => !CURRENT.includes(e.status));
          return (
            <View>
              {current.length > 0 ? (
                <Section title="Current">
                  <EnrollmentRows
                    items={current}
                    all={list}
                    offerings={offerings}
                    placements={placements}
                    operations={operations}
                    recovery={recovery}
                  />
                </Section>
              ) : null}
              {history.length > 0 ? (
                <Section title="History">
                  <EnrollmentRows
                    items={history}
                    all={list}
                    offerings={offerings}
                    placements={placements}
                    operations={operations}
                    recovery={recovery}
                  />
                </Section>
              ) : null}
            </View>
          );
        }}
      </QueryBoundary>
      <LoadMore pages={enrollments} label="enrollments" />
    </View>
  );
}

/** A failure worth showing in a section: not "not available" (§4.10) and not offline (banner). */
function isVisibleFailure(error: ApiError | null): error is ApiError {
  if (!error) return false;
  const presentation = presentationForError(error);
  return presentation !== 'unavailable' && presentation !== 'offline';
}

/** One household list shown for one person: its own loading, error and "Load more". */
function HouseholdSection({
  title,
  label,
  pages,
  count,
  testID,
  children,
}: {
  title: string;
  /** What "Load more" loads, e.g. "applications". */
  label: string;
  pages: Pick<
    ApiPagesResult<unknown>,
    | 'data'
    | 'error'
    | 'refetch'
    | 'hasNextPage'
    | 'isFetchingNextPage'
    | 'nextPageError'
    | 'loadMore'
  >;
  /** How many loaded records are this person's. */
  count: number;
  testID: string;
  children: ReactNode;
}) {
  if (pages.data === undefined) {
    // The enrollment list above shows the loading and offline states; a list the API does not
    // show this account is simply absent (§4.10); any other failure is shown here.
    if (!isVisibleFailure(pages.error)) return null;
    return (
      <Section title={title} testID={testID}>
        <QueryErrorView error={pages.error as ApiError} onRetry={() => void pages.refetch()} />
      </Section>
    );
  }
  if (count === 0 && !pages.hasNextPage) return null;
  return (
    <Section title={title} testID={testID}>
      {count === 0 ? <Caption>None among those loaded so far.</Caption> : children}
      <LoadMore pages={pages} label={label} />
    </Section>
  );
}

function ApplicationsSection({ person }: { person: AccountPerson }) {
  const pages = useApiPages({
    path: '/me/applications',
    request: { query: { limit: ENROLLMENTS_PAGE_SIZE } },
  });
  const mine = (pages.data ?? []).filter((a) => a.participantPersonId === person.personId);
  const offerings = useApiRecords(
    '/offerings/{id}',
    mine.map((a) => a.offeringId),
  );
  return (
    <HouseholdSection
      title="Applications"
      label="applications"
      pages={pages}
      count={mine.length}
      testID="applications"
    >
      <View accessibilityRole="list">
        {mine.map((application) => (
          <ListRow
            key={application.id}
            title={offeringLabel(offerings[application.offeringId])}
            detail={INTENT_LABELS[application.intent]}
            status={applicationStatus(application)}
            testID={`application-${application.id}`}
          />
        ))}
      </View>
    </HouseholdSection>
  );
}

function TrialsSection({ person }: { person: AccountPerson }) {
  const router = useRouter();
  const pages = useApiPages({
    path: '/me/trial-participations',
    request: { query: { limit: ENROLLMENTS_PAGE_SIZE } },
  });
  const mine = (pages.data ?? []).filter((t) => t.participantPersonId === person.personId);
  const offerings = useApiRecords(
    '/offerings/{id}',
    mine.map((t) => t.offeringId),
  );
  return (
    <HouseholdSection
      title="Trials"
      label="trials"
      pages={pages}
      count={mine.length}
      testID="trials"
    >
      <View accessibilityRole="list">
        {mine.map((trial) => {
          const offering = offerings[trial.offeringId]?.data;
          const when = trial.scheduledFor
            ? `Trial on ${formatInstant(trial.scheduledFor, offering?.facility?.timezone)}`
            : 'Trial (no session chosen)';
          const converted = trial.convertedEnrollmentId;
          return (
            <ListRow
              key={trial.id}
              title={offeringLabel(offerings[trial.offeringId])}
              detail={`${when}. A trial is not an enrollment.`}
              status={trialStatus(trial)}
              onPress={converted ? () => router.push(moneyRoutes.enrollment(converted)) : undefined}
              accessibilityHint={
                converted ? 'Opens the enrollment made after the trial' : undefined
              }
              testID={`trial-${trial.id}`}
            />
          );
        })}
      </View>
    </HouseholdSection>
  );
}

function SessionBookingsSection({ person }: { person: AccountPerson }) {
  const router = useRouter();
  const bookings = useApiQuery({
    path: '/session-bookings',
    request: { query: { participantPersonId: person.personId } },
  });
  const items = bookings.data ?? [];
  const offerings = useApiRecords(
    '/offerings/{id}',
    items.map((b) => b.offeringId),
  );
  if (bookings.data === undefined) {
    if (!isVisibleFailure(bookings.error)) return null;
    return (
      <Section title="Session bookings" testID="session-bookings">
        <QueryErrorView
          error={bookings.error as ApiError}
          onRetry={() => void bookings.refetch()}
        />
      </Section>
    );
  }
  if (items.length === 0) return null;
  return (
    <Section title="Session bookings" testID="session-bookings">
      <View accessibilityRole="list">
        {items.map((booking) => {
          const offering = offerings[booking.offeringId]?.data;
          return (
            <ListRow
              key={booking.id}
              title={offeringLabel(offerings[booking.offeringId])}
              detail={`${SESSION_BOOKING_KIND_LABELS[booking.kind]}. ${formatInstant(
                booking.scheduledStart,
                offering?.facility?.timezone,
              )}`}
              status={bookingStatus(booking.status)}
              onPress={() => router.push(`/sessions/${booking.sessionId}?bookingId=${booking.id}`)}
              accessibilityHint="Opens the session"
              testID={`session-booking-${booking.id}`}
            />
          );
        })}
      </View>
    </Section>
  );
}

function Participation({ person }: { person: AccountPerson }) {
  return (
    <View>
      <EnrollmentList person={person} />
      <ApplicationsSection person={person} />
      <TrialsSection person={person} />
      <SessionBookingsSection person={person} />
    </View>
  );
}

export function EnrollmentsScreen() {
  return (
    <Screen>
      <RequireSession what="enrollments">
        <PeopleGate pickerLabel="Show enrollments for">
          {(person) => <Participation key={person.personId} person={person} />}
        </PeopleGate>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/enrollments/index.tsx. */
export function EnrollmentsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Enrollments and participation' }} />
      <EnrollmentsScreen />
    </>
  );
}
