/**
 * SCR-C-18 Calendar (SPK-UX-002, SPK-SCHED-006, SPK-SCHED-007, SPK-SCHED-008, SPK-COMMS-005,
 * SPK-UX-008, SPK-UX-009, SPK-CAP-003), which absorbs SCR-C-19 Family calendar (PA-11 and ADR-008,
 * both **Proposed**; SPK-YOUTH-007, SPK-IAM-003, SPK-ENTRY-007, SPK-PLACE-004): the signed-in
 * person's activities and those of family members the API lets them view, one week at a time, with
 * a filter per person, overlapping commitments highlighted, published changes as old and new
 * details, and the RSVP for a game in a sheet.
 *
 * - One week model: a `DateStrip` (previous week, next week, Today; weeks run Monday to Sunday,
 *   `calendar-week.ts`) over a `SectionList` agenda with one section per day of the week, the
 *   selected day highlighted. Pull to refresh reads everything shown again.
 * - `GET /v1/me/family-calendar` (`from`, `to`) is the source of sessions and bookings, read in the
 *   same 28-day windows Home reads (window 0 is Home's look-ahead: one cached response). The API
 *   includes only people the caller currently holds `view` over (`participantPersonIds`), so a child
 *   without that grant is simply absent; the filters never list people from anywhere else.
 *   `GET /v1/me/fixtures` (the same windows) adds the games of the teams the caller and those people
 *   are on, attributed through `GET /v1/me/team-entries` (CMP-02).
 * - Person chips: Everyone, You, then each family member, shown once the API shares someone. A
 *   link may preselect one: `people=everyone` (the old `/family-calendar` link redirects here with
 *   it) or a person id (`people=<id>` or `person=<id>`). A filter for someone the API no longer
 *   includes falls back to Everyone.
 * - SPK-YOUTH-007: overlaps between sessions and bookings come from the API (`overlaps`); a game
 *   overlapping another commitment of the same person is marked too. Each is a warning badge in
 *   words on the row, with a count for the week; the parent may knowingly accept an overlap
 *   (further handling is DEC-050).
 * - SPK-SCHED-008: each activity is shown on its own facility's clock (calendar item `timezone`,
 *   fixture `venue.timezone`); the week's days are laid out on the facility clock when every
 *   activity shares one, otherwise on the device's, and an activity the API gives no zone for is
 *   on the device clock with a line that says so.
 * - Changes come from schedule notices in `GET /v1/me/inbox` (`detailsBefore` / `detailsAfter`,
 *   in the facility's own time zone). A canceled session leaves the calendar; its notice says so.
 * - RSVP (SCR-C-04, SPK-CAP-003): a game the signed-in person plays in has an availability chip
 *   that opens a sheet with the RSVP control (`POST /v1/fixtures/{id}/availability` with the
 *   answer's revision). Answers are for the signed-in person only (answering for a child is
 *   DEC-090).
 * - Pickup sessions (SPK-PLACE-004, DEC-082, capability `pickup_sessions`): a booked one is listed
 *   as the API serves it, labelled "Pickup session" from its `bookingKind` (ENR-15). Finding more
 *   is offered only while the switch is on; while it is off there is no entry point, and booked
 *   ones stay listed (reads are never gated).
 * - Collecting a child from a supervised session is not offered: supervised pickup is DEC-075 and
 *   the pickup procedure DEC-005, and the API has no customer command for it. Seeing a schedule
 *   never implies pickup authority (SPK-ENTRY-007). Arrival guidance is not shown (POL-046).
 * - Customers never see drafts: the calendar, games and notices carry published schedules.
 *   Names are "You" and given names only (§4.14); ids in routes are opaque.
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { illustrations } from '../../artwork/manifest';
import { pendingMessageFor } from '../../copy/pending';
import { mergeCalendars } from '../../features/today/calendar';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import {
  entryPersonIds,
  mergeEntries,
  nextEntry,
  type TodayEntry,
} from '../../features/today/entries';
import {
  fixtureCardModel,
  fixtureTitle,
  ownResponse,
  venueLocation,
  viewerOnRoster,
} from '../../features/today/fixture-model';
import { upcomingScheduleChanges } from '../../features/today/notices';
import {
  nameOf,
  useApiReads,
  useInbox,
  useMe,
  useMyTeams,
  usePersonNames,
  useSignedIn,
  type ReadResult,
} from '../../features/today/queries';
import { RsvpControl } from '../../features/today/RsvpControl';
import { sessionHref } from '../../features/today/session-activity';
import {
  calendarItemStatus,
  fixtureAcceptsRsvp,
  fixtureStatus,
  rsvpStatus,
} from '../../features/today/status';
import {
  displayZone,
  formatDay,
  formatRange,
  formatTime,
  localDayKey,
  sharedZone,
  zoneAbbreviation,
  zoneNotice,
  zoneOf,
} from '../../features/today/time';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { Chip, ChipRow } from '../../ui/Chip';
import { DateStrip, todayIn, weekStartOf } from '../../ui/DateStrip';
import { EmptyState } from '../../ui/EmptyState';
import { InfoCard } from '../../ui/InfoCard';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { Sheet } from '../../ui/Sheet';
import { StateView } from '../../ui/StateView';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { Tag } from '../../ui/Tag';
import { Text } from '../../ui/Text';
import {
  fonts,
  layout,
  makeStyles,
  radius,
  spacing,
  type,
  useTheme,
  type ThemeKindColors,
} from '../../ui/theme';
import {
  EVERYONE,
  FIRST_DAY_OF_WEEK,
  PICKUP_SESSION_LABEL,
  entriesOnDays,
  instantOfDay,
  overlapNotes,
  overlapPairs,
  overlapsAmong,
  peopleInOrder,
  requestedFilter,
  weekDays,
  weekWindows,
  windowQuery,
} from './calendar-week';

type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;

/** The reads pull to refresh reads again (the ones this screen shows). */
const REFRESHED_PATHS = [
  '/me/family-calendar',
  '/me/fixtures',
  '/me/team-entries',
  '/me/inbox',
  '/me',
] as const;

/** Enough cells for a week of day sections (header, day, footer each) on the first render. */
const WEEK_CELLS = 7 * 3;

/** Oldest receipt time among the reads that have data: the age the page states (§4.15). */
function oldestUpdate(dates: readonly (Date | null)[]): Date | null {
  let oldest: Date | null = null;
  for (const d of dates) if (d && (!oldest || d < oldest)) oldest = d;
  return oldest;
}

interface ReadLike {
  data: unknown;
  error: ApiError | null;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => void;
}

/**
 * The SPK-UX-008 state of reads that have no data yet: loading, the error with its code (in the
 * support fold) and "Try again", offline with nothing cached, or a protected NOT_FOUND or a denial
 * as "not available" without implying a record exists (§4.10).
 */
function ReadState({
  read,
  label,
  unavailable,
}: {
  read: ReadLike;
  label: string;
  unavailable?: string;
}) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const retry = () => read.refetch();
  if (read.error) {
    const presentation = presentationForError(read.error);
    if (presentation === 'unavailable') {
      return <StateView variant="unavailable" description={unavailable} />;
    }
    if (presentation === 'offline') {
      return (
        <StateView variant="offline-stale" offline updatedAt={null} now={now} onRetry={retry} />
      );
    }
    return <StateView variant="error" error={read.error} onRetry={retry} />;
  }
  if (read.fetchStatus === 'paused' || reachable === false) {
    return <StateView variant="offline-stale" offline updatedAt={null} now={now} onRetry={retry} />;
  }
  return <StateView variant="loading" label={label} />;
}

/**
 * The reads of the shown week as one: their data once every one has it, else the state of the
 * first that lacks it (retrying retries each that lacks it). A read the API refuses as not
 * available hides the week even when an older copy is cached (§4.10, §4.14).
 */
function combine<T>(reads: readonly ReadResult<T>[]): { data: T[] | undefined; read: ReadLike } {
  const missing = reads.filter(
    (r) =>
      r.data === undefined || (r.error !== null && presentationForError(r.error) === 'unavailable'),
  );
  const shown = missing.find((r) => r.error !== null) ?? missing[0];
  return {
    data: missing.length === 0 ? reads.flatMap((r) => (r.data ? [r.data] : [])) : undefined,
    read: {
      data: undefined,
      error: shown?.error ?? null,
      fetchStatus: shown?.fetchStatus ?? 'idle',
      refetch: () => missing.forEach((r) => r.refetch()),
    },
  };
}

/** Stripe colour per kind of entry (decorative; the row's words name the activity). */
function entryAccent(entry: TodayEntry, kindColors: ThemeKindColors): string {
  if (entry.type === 'fixture') return kindColors.league;
  return entry.item.kind === 'session_booking' ? kindColors.dropin : kindColors.program;
}

/** "6:30" over "PM" in condensed figures, on the activity's own clock (SPK-SCHED-008). */
function StartTime({ entry }: { entry: TodayEntry }) {
  const styles = useStyles();
  const [clock, meridiem] = formatTime(entry.start, entry.zone.zone).split(/\s+/);
  return (
    <View style={styles.time}>
      <Text style={styles.clock}>{clock}</Text>
      {meridiem ? <Text style={styles.meridiem}>{meridiem}</Text> : null}
    </View>
  );
}

/** Whether the signed-in person answers for this game themselves (SPK-CAP-003; DEC-090). */
function answersFor(
  entry: TodayEntry,
  teams: readonly MyTeamEntry[] | undefined,
  selfId: string | null,
): entry is Extract<TodayEntry, { type: 'fixture' }> {
  if (entry.type !== 'fixture' || !selfId) return false;
  const fixture = entry.fixture;
  return (
    fixtureAcceptsRsvp(fixture.status) &&
    viewerOnRoster(fixture) !== false &&
    entryPersonIds(entry, teams).includes(selfId)
  );
}

function answerOf(fixture: FixtureDetail, selfId: string | null) {
  return ownResponse(fixture, selfId)?.state ?? fixture.myResponse ?? null;
}

/** One row of a day: a session or booking, or a game of one of the family's teams. */
function EntryRow({
  entry,
  teams,
  names,
  overlap,
  next,
  selfId,
  onAnswer,
}: {
  entry: TodayEntry;
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
  overlap: string | undefined;
  next: boolean;
  selfId: string | null;
  onAnswer: (fixtureId: string) => void;
}) {
  const styles = useStyles();
  const router = useRouter();
  const { kindColors } = useTheme();
  const z = entry.zone.zone;
  const time = `${formatTime(entry.start, z)} to ${formatTime(entry.end, z)} ${zoneAbbreviation(entry.start, z)}`;
  const badges: StatusBadgeProps[] = [
    ...(next ? [{ tone: 'info' as const, label: 'Next up' }] : []),
    ...(overlap ? [{ tone: 'warning' as const, label: overlap }] : []),
  ];
  if (entry.type === 'session') {
    const item = entry.item;
    const href = sessionHref(item);
    const pickup = item.bookingKind === 'pickup' ? PICKUP_SESSION_LABEL : null;
    return (
      <ListRow
        title={item.title}
        detail={[`${time}. For: ${nameOf(names, item.personId)}`, pickup]
          .filter(Boolean)
          .join('. ')}
        status={calendarItemStatus(item)}
        badges={badges}
        accent={entryAccent(entry, kindColors)}
        leading={<StartTime entry={entry} />}
        onPress={href ? () => router.push(href as Href) : undefined}
        accessibilityHint={href ? 'Opens the activity' : undefined}
        testID={`schedule-item-${item.id}`}
      />
    );
  }
  const fixture = entry.fixture;
  const title = fixtureTitle(fixture);
  const card = fixtureCardModel({ fixture, teams, names, change: null });
  const answer = rsvpStatus(answerOf(fixture, selfId));
  return (
    <View style={styles.game}>
      <ListRow
        title={title}
        detail={[`${time}. For: ${card.participant}`, card.location ? `At: ${card.location}` : null]
          .filter(Boolean)
          .join('. ')}
        status={fixtureStatus(fixture.status)}
        badges={badges}
        accent={entryAccent(entry, kindColors)}
        leading={<StartTime entry={entry} />}
        onPress={() =>
          router.push({ pathname: '/fixtures/[id]', params: { id: fixture.id } } as Href)
        }
        accessibilityHint="Opens the game"
        testID={`schedule-fixture-${fixture.id}`}
      />
      {answersFor(entry, teams, selfId) ? (
        <View style={styles.answer}>
          <Chip
            label={`Your availability: ${answer.label}`}
            icon="event_available"
            accessibilityLabel={`Your availability for ${title}: ${answer.label}`}
            accessibilityHint="Opens your answer"
            onPress={() => onAnswer(fixture.id)}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The day's header: the date, "Today", and the selected day highlighted. */
function DayHeader({
  title,
  selected,
  today,
}: {
  title: string;
  selected: boolean;
  today: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.dayHeader, selected ? styles.dayHeaderSelected : null]}>
      <Text
        style={[styles.dayTitle, selected ? styles.dayTitleSelected : null]}
        accessibilityRole="header"
      >
        {title}
      </Text>
      {today ? <Tag label="Today" tone="tonal" /> : null}
    </View>
  );
}

/** The RSVP for one game, in a sheet (SCR-C-04, SPK-CAP-003). */
function AnswerSheet({
  fixture,
  teams,
  names,
  selfId,
  onClose,
  onReload,
}: {
  fixture: FixtureDetail | null;
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
  selfId: string | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const styles = useStyles();
  const router = useRouter();
  const card = fixture ? fixtureCardModel({ fixture, teams, names, change: null }) : null;
  const zone = zoneOf(fixture?.venue?.timezone);
  const own = fixture ? ownResponse(fixture, selfId) : null;
  return (
    <Sheet open={fixture !== null} onClose={onClose} title={fixture ? fixtureTitle(fixture) : ''}>
      {fixture && card ? (
        <>
          <View style={styles.sheetFacts}>
            {fixture.scheduledStart && fixture.scheduledEnd ? (
              <Text variant="callout">
                {formatRange(fixture.scheduledStart, fixture.scheduledEnd, zone.zone)}
              </Text>
            ) : null}
            {venueLocation(fixture.venue) ? (
              <Text variant="callout" tone="muted">
                {venueLocation(fixture.venue)}
              </Text>
            ) : null}
            <Text variant="callout" tone="muted">{`For: ${card.participant}`}</Text>
          </View>
          {/* Keyed by game so one game's answer and revision never show on another (CMP-04). */}
          <RsvpControl
            key={fixture.id}
            fixtureId={fixture.id}
            fixtureStatus={fixture.status}
            myResponse={own?.state ?? fixture.myResponse ?? null}
            responseRevision={own?.revision ?? null}
            onRoster={viewerOnRoster(fixture)}
            onReload={onReload}
          />
          <Button
            label="Open the game"
            variant="secondary"
            onPress={() => {
              onClose();
              router.push({ pathname: '/fixtures/[id]', params: { id: fixture.id } } as Href);
            }}
          />
        </>
      ) : null}
    </Sheet>
  );
}

/**
 * Pickup sessions (SPK-PLACE-004, DEC-082): finding more is offered only while the organization
 * has the capability on. While it is off there is no entry point (PA-11); booked ones stay listed.
 */
function PickupSessions({ onFind }: { onFind: () => void }) {
  const styles = useStyles();
  const permissions = usePermissions();
  if (permissions.isCapabilityEnabled('pickup_sessions') !== true) return null;
  return (
    <Section title="Pickup sessions" variant="plain" testID="schedule-pickup-sessions">
      <Text variant="caption" tone="muted">
        Book a seat in a pickup session from Explore. Booked ones show here marked &quot;
        {PICKUP_SESSION_LABEL}&quot;.
      </Text>
      <View style={styles.start}>
        <Button label="Find pickup sessions" variant="secondary" onPress={onFind} />
      </View>
    </Section>
  );
}

/** Collecting a child (DEC-075, DEC-005): what to do for now, and what a schedule does not allow. */
function CollectingAChild() {
  const styles = useStyles();
  return (
    <Section title="Collecting a child" variant="plain" testID="schedule-collecting">
      <StateView
        variant="pending-decision"
        subject="Choosing who collects a child from a supervised session"
        message={pendingMessageFor(['DEC-075', 'DEC-005'])}
        decisions={['DEC-075', 'DEC-005']}
        owner="Product owner (DEC-075); Operations (DEC-005)"
      />
      <Text variant="caption" tone="muted" style={styles.flush}>
        Seeing a child&apos;s schedule does not by itself allow collecting them; staff check current
        pickup permission at release.
      </Text>
    </Section>
  );
}

function Caption({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useStyles();
  return (
    <Text variant="caption" tone="muted" style={styles.caption} testID={testID}>
      {children}
    </Text>
  );
}

function CalendarContent() {
  const styles = useStyles();
  const router = useRouter();
  const queryClient = useQueryClient();
  const now = useNow();
  const device = displayZone(null);
  const params = useLocalSearchParams<{ people?: string; person?: string }>();
  const requested = requestedFilter(params);
  const signedIn = useSignedIn();
  const me = useMe();
  const inbox = useInbox();
  const teams = useMyTeams();

  // A link that asks for a person (or everyone) selects that chip, also on a later visit.
  const [filter, setFilter] = useState(requested ?? EVERYONE);
  const [seenRequest, setSeenRequest] = useState(requested);
  if (seenRequest !== requested) {
    setSeenRequest(requested);
    if (requested) setFilter(requested);
  }
  const [picked, setPicked] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The week follows the selected day; today on the device's clock until a day is picked, so the
  // windows never depend on what they return.
  const deviceToday = todayIn(now, device.zone);
  const selectedDay = picked ?? deviceToday;
  const weekStart = weekStartOf(selectedDay, FIRST_DAY_OF_WEEK);
  const windows = weekWindows(now, weekStart, device.zone);
  const requests = windows.map((index) => ({ query: windowQuery(now, index, device.zone) }));
  const calendarReads = useApiReads('/me/family-calendar', requests, signedIn);
  const fixtureReads = useApiReads('/me/fixtures', requests, signedIn);
  const calendarState = combine(calendarReads);
  const calendar = calendarState.data ? mergeCalendars(calendarState.data) : undefined;
  // A game list that is not available to this person is left out without comment (§4.10).
  const fixturesHidden = fixtureReads.some(
    (r) => r.error !== null && presentationForError(r.error) === 'unavailable',
  );
  const fixtureState = combine(fixtureReads);
  const fixtures = fixturesHidden ? [] : fixtureReads.flatMap((r) => r.data ?? []);
  const fixturesFailed = !fixturesHidden && fixtureState.read.error !== null;
  const entries = mergeEntries(calendar?.items ?? [], fixtures);
  const names = usePersonNames(
    [
      ...(calendar?.participantPersonIds ?? []),
      ...entries.flatMap((e) => entryPersonIds(e, teams.data)),
    ],
    me.data,
  );
  const selfId = me.data?.principal.personId ?? null;

  // One facility clock for the days when every activity shares it, else the device's.
  const dayZone = zoneOf(sharedZone(entries.map((e) => (e.zone.facility ? e.zone.zone : null))));
  const stripZone = dayZone.facility ? dayZone.zone : null;
  const todayIso = todayIn(now, dayZone.zone);
  const days = weekDays(weekStart);

  const refresh = () => {
    setRefreshing(true);
    void Promise.all(
      REFRESHED_PATHS.map((path) =>
        queryClient.refetchQueries({ queryKey: ['api', path], type: 'active' }),
      ),
    ).finally(() => setRefreshing(false));
  };
  const reloadGames = () => fixtureReads.forEach((r) => r.refetch());

  const strip = (marked: readonly string[]) => (
    <DateStrip
      value={selectedDay}
      onChange={setPicked}
      today={now}
      timeZone={stripZone}
      markedDates={marked}
      firstDayOfWeek={FIRST_DAY_OF_WEEK}
      // Moving week selects today in it, else its first day.
      onWeekChange={(start) => setPicked(weekDays(start).includes(todayIso) ? todayIso : start)}
      style={styles.strip}
      testID="schedule-week"
    />
  );

  if (!calendar) {
    return (
      <Screen onRefresh={refresh} refreshing={refreshing}>
        {strip([])}
        <ReadState
          read={calendarState.read}
          label="your calendar"
          unavailable="Your calendar is not available right now."
        />
      </Screen>
    );
  }

  const people = peopleInOrder(calendar.participantPersonIds, selfId);
  // A filter for someone the API no longer includes (a grant was removed) falls back to everyone.
  const activeFilter = filter === EVERYONE || people.includes(filter) ? filter : EVERYONE;
  const forActive = (e: TodayEntry) =>
    activeFilter === EVERYONE || entryPersonIds(e, teams.data).includes(activeFilter);
  const week = entriesOnDays(entries, days, dayZone.zone);
  const shown = week.filter(forActive);
  const weekOverlaps = { overlaps: overlapsAmong(calendar, week) };
  const notes = overlapNotes(weekOverlaps, week, teams.data, names);
  const overlapCount = overlapPairs(calendar, week, teams.data).filter(
    (personIds) => activeFilter === EVERYONE || personIds.includes(activeFilter),
  ).length;
  const byDay = new Map<string, TodayEntry[]>();
  for (const e of shown) {
    const key = localDayKey(e.start, dayZone.zone);
    byDay.set(key, [...(byDay.get(key) ?? []), e]);
  }
  const next = nextEntry(entries, now);
  const changes = upcomingScheduleChanges(inbox.data?.items ?? [], now);
  // Only activities the API gave no facility zone for are on the device clock: say so then.
  const deviceClock = shown.find((e) => !e.zone.facility);
  const notice = deviceClock ? zoneNotice(deviceClock.zone, deviceClock.start) : null;
  const family = people.length > 1;
  const askedForEveryone = requested === EVERYONE;
  const answeringFixture =
    entries.find(
      (e): e is Extract<TodayEntry, { type: 'fixture' }> =>
        e.type === 'fixture' && e.fixture.id === answering,
    )?.fixture ?? null;

  const sections = shown.length === 0 ? [] : days.map((day) => ({ key: day, data: [day] }));
  const emptyMessage =
    activeFilter !== EVERYONE
      ? `Nothing is scheduled for ${nameOf(names, activeFilter)} this week.`
      : family
        ? 'Nothing is scheduled for you or your family this week.'
        : 'Nothing is scheduled for you this week.';

  const header = (
    <View testID="schedule-content">
      {/* §4.15: the age of the oldest read shown (calendar, games, whose team each is, notices). */}
      <LastUpdated
        at={oldestUpdate([
          ...calendarReads.map((r) => r.updatedAt),
          ...(fixturesHidden ? [] : fixtureReads.map((r) => r.updatedAt)),
          teams.updatedAt,
          inbox.updatedAt,
        ])}
        now={now}
      />
      {strip([...byDay.keys()])}
      {family ? (
        <ChipRow
          mode="single"
          label="Show activities for"
          options={[EVERYONE, ...people].map((id) => ({
            value: id,
            label: id === EVERYONE ? 'Everyone' : nameOf(names, id),
          }))}
          value={activeFilter}
          onChange={(id) => setFilter(id ?? EVERYONE)}
          style={styles.chips}
          testID="schedule-people"
        />
      ) : askedForEveryone ? (
        <Caption testID="family-only-self">
          No family members are shared with you yet. A child appears here when you hold permission
          to view their schedule.
        </Caption>
      ) : null}
      {overlapCount > 0 ? (
        <InfoCard
          tone="warning"
          title={`${overlapCount} overlapping commitment${overlapCount === 1 ? '' : 's'} this week`}
          message="Overlaps are highlighted so you can plan around them."
          style={styles.card}
          testID="overlap-summary"
        />
      ) : null}
      {notice ? <Caption testID="zone-notice">{notice}</Caption> : null}
      {fixturesFailed ? (
        <View testID="schedule-fixtures-error" style={styles.block}>
          <Caption>Your team games could not be loaded.</Caption>
          <ReadState read={fixtureState.read} label="your team games" />
        </View>
      ) : null}
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
      <AnswerSheet
        fixture={answeringFixture}
        teams={teams.data}
        names={names}
        selfId={selfId}
        onClose={() => setAnswering(null)}
        onReload={reloadGames}
      />
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      <PickupSessions onFind={() => router.push('/discover')} />
      {family || askedForEveryone ? <CollectingAChild /> : null}
    </View>
  );

  return (
    <Screen<string, { key: string; data: string[] }>
      onRefresh={refresh}
      refreshing={refreshing}
      sections={{
        sections,
        keyExtractor: (day) => day,
        initialNumToRender: WEEK_CELLS,
        renderSectionHeader: ({ section }) => (
          <DayHeader
            title={formatDay(instantOfDay(section.key, dayZone.zone), dayZone.zone)}
            selected={section.key === selectedDay}
            today={section.key === todayIso}
          />
        ),
        renderItem: ({ item: day }) => {
          const dayEntries = byDay.get(day) ?? [];
          return (
            <View testID={`day-${day}`} style={styles.day}>
              {dayEntries.length > 0 ? (
                <View accessibilityRole="list">
                  {dayEntries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      teams={teams.data}
                      names={names}
                      overlap={notes.get(entry.id)}
                      next={next?.id === entry.id}
                      selfId={selfId}
                      onAnswer={setAnswering}
                    />
                  ))}
                </View>
              ) : (
                <Caption>Nothing scheduled.</Caption>
              )}
            </View>
          );
        },
        ListEmptyComponent: (
          <EmptyState
            source={illustrations['empty-calendar']}
            title="No activities this week"
            message={`${emptyMessage} Find leagues, classes and camps in Explore.`}
            action={{ label: 'Explore activities', onPress: () => router.push('/discover') }}
          />
        ),
        ListFooterComponent: footer,
      }}
    >
      {header}
    </Screen>
  );
}

export function ScheduleScreen() {
  const { session } = useApp();
  if (session.status === 'signed_in') return <CalendarContent />;
  return (
    <Screen>
      <RequireSession what="your calendar">{null}</RequireSession>
    </Screen>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  strip: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm },
  chips: { paddingTop: spacing.md },
  card: { marginHorizontal: layout.gutter, marginTop: spacing.md },
  caption: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm },
  flush: { paddingTop: spacing.xs },
  block: { gap: spacing.sm, paddingTop: spacing.sm },
  start: { alignItems: 'flex-start' },
  footer: { paddingBottom: spacing.lg },
  change: { paddingVertical: spacing.xs, gap: spacing.xs },
  changeTitle: { ...type.body, ...fonts.semibold, color: colors.text },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginHorizontal: layout.gutter - spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.page,
  },
  dayHeaderSelected: { backgroundColor: colors.tonal },
  dayTitle: { ...type.title3, color: colors.text },
  dayTitleSelected: { color: colors.onTonal },
  day: { paddingTop: spacing.sm },
  game: { gap: 0 },
  answer: {
    paddingHorizontal: layout.gutter,
    marginTop: -spacing.xs,
    marginBottom: spacing.sm,
    alignItems: 'flex-start',
  },
  sheetFacts: { gap: spacing.xs },
  time: { width: 50, paddingLeft: 2 },
  clock: { ...type.title, fontSize: 21, lineHeight: 22, color: colors.text },
  meridiem: {
    ...type.caption,
    ...fonts.bold,
    fontSize: 11,
    lineHeight: 14,
    color: colors.textMuted,
  },
}));
