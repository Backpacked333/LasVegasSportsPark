/**
 * SCR-C-32 Enrollments and participation (SPK-REG-003, SPK-REG-010, SPK-YOUTH-003, SPK-AT-019,
 * SPK-UX-004, SPK-UX-008, SPK-UX-009; journeys C5, C8, C11).
 *
 * Each participant's enrollments as independent records with their own states
 * (`GET /v1/enrollments?participantPersonId=`), current first, then history (transfers, cancellations,
 * completed seasons). A transferred enrollment names the offering it moved to. A confirmed
 * enrollment awaiting placement reads "Confirmed in <offering>. Awaiting placement.", never plain
 * "Confirmed" (`GET /v1/placement-requests/{id}`). Opening a row shows the record and the entry to
 * the cancellation and transfer previews (SCR-C-33).
 *
 * States: loading; empty (no participation, with the way to find activities); ready; validation
 * failure: not applicable; permission restriction (a person the API does not let this account see
 * reads "not available", children by view grant); stale version: refreshed on return; offline
 * (cached with age; cancel and transfer need a connection); processing, success: not applicable;
 * partial completion: not permitted; recovery required: shown on the record (SCR-C-32 detail).
 *
 * API gaps (reported): an enrollment carries no offering name or dates, and customers may read
 * only published offerings, so a closed or archived season reads "Activity no longer listed"; the
 * API has no customer list of applications, placements or trial participations by participant.
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDateRange } from '../../features/money/format';
import { PeopleGate } from '../../features/money/PeopleGate';
import type { AccountPerson } from '../../features/money/people';
import { useApiRecords, type Records } from '../../features/money/records';
import { moneyRoutes } from '../../features/money/routes';
import { enrollmentStatus, type Enrollment } from '../../features/money/status';
import { Section } from '../../features/money/ui';
import { RequireSession } from '../../session/RequireSession';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';

type Offering = Schema<'Offering'>;

const CURRENT: readonly Enrollment['status'][] = ['pending', 'confirmed'];

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
};

export function offeringLabel(
  record: { data: Offering | undefined; loading: boolean } | undefined,
): string {
  if (record?.data) return record.data.name;
  return record?.loading ? 'Loading activity…' : 'Activity no longer listed';
}

function EnrollmentRows({
  items,
  all,
  offerings,
  placements,
}: {
  items: readonly Enrollment[];
  all: readonly Enrollment[];
  offerings: Records<'/offerings/{id}'>;
  placements: Records<'/placement-requests/{id}'>;
}) {
  const router = useRouter();
  return (
    <View accessibilityRole="list">
      {items.map((enrollment) => {
        const offering = offerings[enrollment.offeringId];
        const name = offeringLabel(offering);
        const target = enrollment.transferredToEnrollmentId
          ? all.find((e) => e.id === enrollment.transferredToEnrollmentId)
          : undefined;
        const status = enrollmentStatus(enrollment, {
          offeringName: offering?.data?.name ?? null,
          transferTargetName: target ? (offerings[target.offeringId]?.data?.name ?? null) : null,
          placement: enrollment.placementRequestId
            ? (placements[enrollment.placementRequestId]?.data ?? null)
            : null,
        });
        const dates = offering?.data
          ? formatDateRange(offering.data.startsOn, offering.data.endsOn)
          : undefined;
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
  const enrollments = useApiQuery({
    path: '/enrollments',
    request: { query: { participantPersonId: person.personId, limit: 50 } },
  });
  const items = enrollments.data?.items ?? [];
  const offerings = useApiRecords(
    '/offerings/{id}',
    items.map((e) => e.offeringId),
    enrollments.data !== undefined,
  );
  const placements = useApiRecords(
    '/placement-requests/{id}',
    items
      .filter((e) => e.status === 'confirmed' && e.placementRequestId)
      .map((e) => e.placementRequestId as string),
    enrollments.data !== undefined,
  );
  const whose = person.self ? 'your' : `${person.displayName}’s`;
  return (
    <QueryBoundary
      query={enrollments}
      label={`${whose} enrollments`}
      isEmpty={(page) => page.items.length === 0}
      empty={{
        title: 'No enrollments yet',
        description: `${person.self ? 'Your' : `${person.displayName}’s`} registrations, placements and completed seasons will appear here. Leagues, programs and camps are in Discover.`,
        actionLabel: 'Open Discover',
        onAction: () => router.push('/discover'),
      }}
      unavailableOffline={['canceling a registration', 'transferring a registration']}
    >
      {(page) => {
        const current = page.items.filter((e) => CURRENT.includes(e.status));
        const history = page.items.filter((e) => !CURRENT.includes(e.status));
        return (
          <View>
            {current.length > 0 ? (
              <Section title="Current">
                <EnrollmentRows
                  items={current}
                  all={page.items}
                  offerings={offerings}
                  placements={placements}
                />
              </Section>
            ) : null}
            {history.length > 0 ? (
              <Section title="History">
                <EnrollmentRows
                  items={history}
                  all={page.items}
                  offerings={offerings}
                  placements={placements}
                />
              </Section>
            ) : null}
          </View>
        );
      }}
    </QueryBoundary>
  );
}

export function EnrollmentsScreen() {
  return (
    <Screen>
      <RequireSession what="enrollments">
        <PeopleGate pickerLabel="Show enrollments for">
          {(person) => <EnrollmentList key={person.personId} person={person} />}
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
