/**
 * SCR-C-18 Schedule (SPK-UX-002, SPK-SCHED-006, SPK-SCHED-007, SPK-SCHED-008, SPK-COMMS-005,
 * SPK-UX-008, SPK-UX-009): the signed-in person's activities and those of family members the API
 * lets them view, day by day, with the next-activity card (SCR-C-04) on top and published changes
 * and cancellations shown as old and new details.
 *
 * - `GET /v1/me/family-calendar` (`from`, `to`) is the source of sessions and bookings; the API
 *   includes only people the caller currently holds `view` over, so a child without that grant is
 *   simply absent. `GET /v1/me/fixtures` adds the fixtures of the teams the caller and those
 *   people are on (CMP-02), and `GET /v1/me/team-entries` says whose team each is.
 * - Later weeks load as further windows of both reads; what is already shown stays on screen.
 * - Changes come from schedule notices in `GET /v1/me/inbox` (`detailsBefore` / `detailsAfter`,
 *   in the facility's own time zone). A canceled session leaves the calendar; its notice says so.
 * - SPK-SCHED-008: each activity is grouped into its local day and shown on its own facility's
 *   clock (calendar item `timezone`, fixture `venue.timezone`); only an activity the API gives no
 *   zone for is shown on the device clock, and the list says so.
 * - Customers never see drafts: the calendar, fixtures and notices carry published schedules.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { calendarWindowQuery, mergeCalendars } from '../../features/today/calendar';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import {
  entryPersonIds,
  groupEntriesByDay,
  mergeEntries,
  nextEntry,
  type TodayEntry,
} from '../../features/today/entries';
import { fixtureCardModel, fixtureTitle } from '../../features/today/fixture-model';
import { NextActivityCard } from '../../features/today/NextActivityCard';
import { latestChangeForEvent, upcomingScheduleChanges } from '../../features/today/notices';
import {
  SCHEDULE_WINDOW_DAYS,
  nameOf,
  useApiReads,
  useCalendarWindows,
  useInbox,
  useMe,
  useMyTeams,
  usePersonNames,
  useSignedIn,
} from '../../features/today/queries';
import { Caption, oldestUpdate, Section, SectionQueryState } from '../../features/today/Section';
import { sessionHref, useSessionActivity } from '../../features/today/session-activity';
import { calendarItemStatus, fixtureStatus } from '../../features/today/status';
import {
  addLocalDays,
  displayZone,
  formatDay,
  formatTime,
  startOfLocalDay,
  zoneAbbreviation,
  zoneNotice,
} from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { colors, spacing, type } from '../../ui/theme';

type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;
type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;

/**
 * How many windows Schedule loads at most: about a year ahead. A display limit, not a policy;
 * each window (SCHEDULE_WINDOW_DAYS) stays inside the API's per-request limit of 120 days.
 */
export const MAX_SCHEDULE_WINDOWS = 13;

function NextCard({ item, participant }: { item: FamilyCalendarItem; participant: string }) {
  const router = useRouter();
  const { model } = useSessionActivity(item, participant);
  if (!model) return null;
  const href = sessionHref(item);
  // The card may show the facility's zone (from a schedule notice) while the list below uses the
  // device's: it carries its own zone caption, as on Home (SPK-SCHED-008).
  const notice = zoneNotice(model.zone, model.start ?? item.start);
  return (
    <>
      <NextActivityCard
        model={model}
        onOpen={href ? () => router.push(href as Href) : undefined}
        testID="schedule-next"
      />
      {notice ? <Caption testID="schedule-next-zone">{notice}</Caption> : null}
    </>
  );
}

function NextFixtureCard({
  fixture,
  teams,
  names,
}: {
  fixture: FixtureDetail;
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
}) {
  const router = useRouter();
  const inbox = useInbox();
  const latest = latestChangeForEvent(inbox.data?.items ?? [], fixture.schedulingEventId);
  const model = fixtureCardModel({ fixture, teams, names, change: latest?.change ?? null });
  const notice = zoneNotice(model.zone, model.start ?? fixture.createdAt);
  return (
    <>
      <NextActivityCard
        model={model}
        onOpen={() =>
          router.push({ pathname: '/fixtures/[id]', params: { id: fixture.id } } as Href)
        }
        openLabel="View fixture"
        testID="schedule-next"
      />
      {notice ? <Caption testID="schedule-next-zone">{notice}</Caption> : null}
    </>
  );
}

/** One row of the day list: a session or booking, or a fixture of one of the viewer's teams. */
function EntryRow({
  entry,
  teams,
  names,
}: {
  entry: TodayEntry;
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
}) {
  const router = useRouter();
  const z = entry.zone.zone;
  const time = `${formatTime(entry.start, z)} to ${formatTime(entry.end, z)} ${zoneAbbreviation(entry.start, z)}`;
  if (entry.type === 'session') {
    const item = entry.item;
    const href = sessionHref(item);
    return (
      <ListRow
        title={item.title}
        detail={`${time}. For: ${nameOf(names, item.personId)}`}
        status={calendarItemStatus(item)}
        onPress={href ? () => router.push(href as Href) : undefined}
        accessibilityHint={href ? 'Opens the activity' : undefined}
        testID={`schedule-item-${item.id}`}
      />
    );
  }
  const fixture = entry.fixture;
  const card = fixtureCardModel({ fixture, teams, names, change: null });
  return (
    <ListRow
      title={fixtureTitle(fixture)}
      detail={[`${time}. For: ${card.participant}`, card.location ? `At: ${card.location}` : null]
        .filter(Boolean)
        .join('. ')}
      status={fixtureStatus(fixture.status)}
      onPress={() =>
        router.push({ pathname: '/fixtures/[id]', params: { id: fixture.id } } as Href)
      }
      accessibilityHint="Opens the fixture"
      testID={`schedule-fixture-${fixture.id}`}
    />
  );
}

function ScheduleContent() {
  const router = useRouter();
  const now = useNow();
  const zone = displayZone(null);
  const [windows, setWindows] = useState(1);
  const me = useMe();
  const inbox = useInbox();
  const teams = useMyTeams();
  const reads = useCalendarWindows(now, windows, SCHEDULE_WINDOW_DAYS, zone.zone);
  const firstFrom = calendarWindowQuery(now, 0, SCHEDULE_WINDOW_DAYS, zone.zone).from;
  const fixtureRequests = useMemo(
    () =>
      Array.from({ length: windows }, (_, index) => ({
        query: calendarWindowQuery(new Date(firstFrom), index, SCHEDULE_WINDOW_DAYS, zone.zone),
      })),
    [firstFrom, windows, zone.zone],
  );
  const fixtureReads = useApiReads('/me/fixtures', fixtureRequests, useSignedIn());
  const loaded = reads.flatMap((r) => (r.data ? [r.data] : []));
  const calendar = mergeCalendars(loaded);
  // A fixture list that is not available to this person is left out without comment (§4.10).
  const fixtures = fixtureReads.flatMap((r) =>
    r.data && !(r.error && presentationForError(r.error) === 'unavailable') ? r.data : [],
  );
  const fixtureFailure = fixtureReads.find(
    (r) => r.data === undefined && r.error && presentationForError(r.error) !== 'unavailable',
  );
  const entries = mergeEntries(calendar?.items ?? [], fixtures).filter(
    (e) => new Date(e.end).getTime() > now.getTime(),
  );
  const names = usePersonNames(
    [
      ...(calendar?.participantPersonIds ?? []),
      ...entries.flatMap((e) => entryPersonIds(e, teams.data)),
    ],
    me.data,
  );
  const first = reads[0];

  if (!first || first.data === undefined || !calendar) {
    return (
      <SectionQueryState
        read={first ?? { data: undefined, error: null }}
        label="your schedule"
        unavailable={{ description: 'Your schedule is not available right now.' }}
      />
    );
  }

  const next = nextEntry(entries, now);
  const changes = upcomingScheduleChanges(inbox.data?.items ?? [], now);
  const familyShared = calendar.participantPersonIds.length > 1;
  const shownUntil = addLocalDays(
    startOfLocalDay(now, zone.zone),
    loaded.length * SCHEDULE_WINDOW_DAYS,
    zone.zone,
  );
  const groups = groupEntriesByDay(entries);
  // Only activities the API gave no facility zone for are on the device clock: say so then.
  const deviceClock = entries.find((e) => !e.zone.facility);
  const notice = deviceClock ? zoneNotice(deviceClock.zone, deviceClock.start) : null;
  const later = reads.slice(1).find((r) => r.data === undefined);

  return (
    <View testID="schedule-content">
      <LastUpdated
        at={oldestUpdate([
          ...reads.map((r) => r.updatedAt),
          ...fixtureReads.map((r) => r.updatedAt),
          inbox.updatedAt,
        ])}
        now={now}
      />
      {notice ? <Caption testID="zone-notice">{`In the list below: ${notice}`}</Caption> : null}

      {changes.length > 0 ? (
        <Section title="Changes" testID="schedule-changes">
          {changes.map(({ item, change }) => (
            <View key={item.attemptId} style={styles.change}>
              <Text style={styles.changeTitle}>{item.title}</Text>
              <ChangeDetails change={change} testID={`schedule-change-${item.attemptId}`} />
            </View>
          ))}
        </Section>
      ) : null}

      {next ? (
        <Section title="Next activity">
          {next.type === 'session' ? (
            <NextCard item={next.item} participant={nameOf(names, next.item.personId)} />
          ) : (
            <NextFixtureCard fixture={next.fixture} teams={teams.data} names={names} />
          )}
        </Section>
      ) : null}

      {fixtureFailure ? (
        <View testID="schedule-fixtures-error">
          <Caption>Your team fixtures could not be loaded.</Caption>
          <SectionQueryState read={fixtureFailure} label="your fixtures" />
        </View>
      ) : null}

      {familyShared ? (
        <View style={styles.pad}>
          <Button
            label="Open family calendar"
            variant="secondary"
            onPress={() => router.push('/family-calendar')}
            testID="schedule-family"
          />
        </View>
      ) : null}

      {groups.length === 0 ? (
        <StateView
          variant="empty"
          title="No activities"
          description={`Nothing is scheduled for you${familyShared ? ' or your family' : ''} before ${formatDay(shownUntil, zone.zone)}. Find leagues, programs and camps in Discover.`}
          actionLabel="Open Discover"
          onAction={() => router.push('/discover')}
        />
      ) : (
        groups.map((group) => (
          <Section key={group.key} title={group.heading} testID={`day-${group.key}`}>
            <View accessibilityRole="list">
              {group.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} teams={teams.data} names={names} />
              ))}
            </View>
          </Section>
        ))
      )}

      {later ? (
        <SectionQueryState read={later} label="later activities" />
      ) : windows < MAX_SCHEDULE_WINDOWS ? (
        <View style={styles.pad}>
          <Caption>Showing activities before {formatDay(shownUntil, zone.zone)}.</Caption>
          <Button
            label={`Show the following ${SCHEDULE_WINDOW_DAYS} days`}
            variant="secondary"
            onPress={() => setWindows((w) => Math.min(w + 1, MAX_SCHEDULE_WINDOWS))}
            testID="schedule-more"
          />
        </View>
      ) : null}
    </View>
  );
}

export function ScheduleScreen() {
  return (
    <Screen>
      <RequireSession what="your schedule">
        <ScheduleContent />
      </RequireSession>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  change: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  changeTitle: { ...type.body, fontWeight: '600', color: colors.text },
});
