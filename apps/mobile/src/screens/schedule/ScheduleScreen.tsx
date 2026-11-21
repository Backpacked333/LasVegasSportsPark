/**
 * Handoff M 1h Calendar, colour per child, clashes called out (INTERACTIONS 1h rows 1 to 5 and
 * "Screen states"; SCR-C-18 Calendar absorbing SCR-C-19 Family calendar; SPK-UX-002, SPK-SCHED-006,
 * SPK-SCHED-007, SPK-SCHED-008, SPK-COMMS-005, SPK-YOUTH-007, SPK-IAM-003, SPK-ENTRY-007,
 * SPK-PLACE-004, SPK-UX-008, SPK-UX-009; ADR-008 visual system v2, **Proposed**).
 *
 * - The household "who" chips (`PersonChipRow`, shared with Home: the same choice everywhere,
 *   remembered on the device). Each person keeps their colour on the chip, the week strip's dots,
 *   the row's stripe and the row's avatar, always next to their name. A link may preselect:
 *   `people=everyone` (the old `/family-calendar` link redirects here with it) or a person id
 *   (`people=<id>` or `person=<id>`). A person the API does not include reads as Everyone.
 * - One week at a time (Monday to Sunday): a card strip of the seven days with one dot per person
 *   who has something that day (read out as "Saturday, November 21, today, Maya, Leo"), previous
 *   and next week, and "Today", hidden while today is selected in the shown week (row 5). Picking
 *   a day scrolls the agenda to it.
 * - The agenda (`calendar-day.ts`): each day with something on it under "Today · Saturday 21",
 *   runs of empty days collapsed into one line ("Mon 23 – Tue 24 · nothing scheduled"). A
 *   back-to-back pair (less than 45 minutes between family events at different spaces) gets one
 *   ▲ amber sentence naming both places; overlapping events get ✕ red (row 2). Walk times between
 *   spaces are not in the API: the sentence names the places only.
 * - A row: start and end on the facility's clock, the stripe in the person's colour, the title,
 *   "Maya · Field 2", its status and the person's avatar. A game shows the person's answer
 *   (✓ Going, ◷ Maybe, ✕ Not going), mirroring Home and Game day (row 4: the same cached reads);
 *   a cancelled or postponed game shows that instead. A session shows "▲ Waiver needed" while the
 *   person has a form to sign (`GET /v1/people/{id}/waivers`, as the pass does), else its booking
 *   state when it is not simply confirmed. A row opens the game (Game day) or the activity.
 * - States: loading is grey day headings with two placeholder rows each; an empty week says
 *   "Nothing scheduled for Maya this week" with Explore; errors give the code and "Try again";
 *   offline keeps the cached week with its age (`Screen`'s banner).
 *
 * Reads, as before: `GET /v1/me/family-calendar` and `GET /v1/me/fixtures` in the same 28-day
 * windows Home reads (window 0 is Home's look-ahead: one cached response), `GET /v1/me/team-entries`
 * to attribute games to people (CMP-02), `GET /v1/me/inbox` for published changes, shown as old and
 * new details (SPK-COMMS-005). The API includes only people the caller holds `view` over; the
 * filters never list people from anywhere else. Each activity is on its own facility's clock; an
 * activity without a zone is on the device clock with a line that says so. Pickup sessions
 * (SPK-PLACE-004, DEC-082) and collecting a child (DEC-075, DEC-005) keep their pending states.
 * Names are "You" and given names only (§4.14); ids in routes are opaque.
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { illustrations } from '../../artwork/manifest';
import { pendingMessageFor } from '../../copy/pending';
import { recordedAnswer } from '../../features/home/answers';
import { useFilterPeople, useHousehold, type HouseholdPerson } from '../../features/home/household';
import { shortTime, timeParts } from '../../features/home/when';
import { mergeCalendars } from '../../features/today/calendar';
import { ChangeDetails } from '../../features/today/ChangeDetails';
import { entryPersonIds, mergeEntries, type TodayEntry } from '../../features/today/entries';
import { fixtureTitle } from '../../features/today/fixture-model';
import { upcomingScheduleChanges } from '../../features/today/notices';
import {
  nameOf,
  useApiReads,
  useInbox,
  useMyTeams,
  usePersonNames,
  useSignedIn,
  type ReadResult,
} from '../../features/today/queries';
import { sessionHref } from '../../features/today/session-activity';
import { calendarItemStatus, fixtureStatus } from '../../features/today/status';
import {
  displayZone,
  formatTime,
  localDayKey,
  sharedZone,
  zoneAbbreviation,
  zoneNotice,
  zoneOf,
} from '../../features/today/time';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { addIsoDays } from '../../ui/DateField';
import { DateStrip, todayIn, weekStartOf } from '../../ui/DateStrip';
import { EmptyState } from '../../ui/EmptyState';
import { Icon } from '../../ui/Icon';
import { LastUpdated } from '../../ui/LastUpdated';
import { PersonChipRow, usePersonFilter } from '../../ui/PersonFilter';
import { personColorOf } from '../../ui/person-colors';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  elevation,
  fonts,
  layout,
  makeStyles,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from '../../ui/theme';
import {
  blockKeyOf,
  dayBlocks,
  dayHeading,
  emptyRunLine,
  junctures,
  personFor,
  placeOf,
  type DayBlock,
  type Juncture,
} from './calendar-day';
import {
  EVERYONE,
  FIRST_DAY_OF_WEEK,
  PICKUP_SESSION_LABEL,
  entriesOnDays,
  requestedFilter,
  weekDays,
  weekWindows,
  windowQuery,
} from './calendar-week';

type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;
type PersonWaivers = Schema<'PersonWaivers'>;

/** The reads pull to refresh reads again (the ones this screen shows). */
const REFRESHED_PATHS = [
  '/me/family-calendar',
  '/me/fixtures',
  '/me/team-entries',
  '/me/inbox',
  '/me',
  '/people/{id}/waivers',
] as const;

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
 * The SPK-UX-008 state of reads that have no data yet: the error with its code (in the support
 * fold) and "Try again", offline with nothing cached, or a protected NOT_FOUND or a denial as "not
 * available" without implying a record exists (§4.10). Loading draws `skeleton` when given.
 */
function ReadState({
  read,
  label,
  unavailable,
  skeleton,
}: {
  read: ReadLike;
  label: string;
  unavailable?: string;
  skeleton?: ReactNode;
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
  return skeleton ?? <StateView variant="loading" label={label} />;
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

/** Loading (INTERACTIONS 1h "Screen states"): grey day headings with two placeholder rows each. */
function CalendarSkeleton() {
  const styles = useStyles();
  return (
    <SkeletonGroup testID="schedule-loading">
      {[0, 1].map((day) => (
        <View key={day} style={styles.skeletonDay}>
          <Skeleton shape="line" width="45%" height={16} />
          <View style={styles.skeletonCard}>
            {[0, 1].map((row) => (
              <View key={row} style={styles.skeletonRow}>
                <Skeleton shape="block" width={48} height={34} />
                <View style={styles.flex}>
                  <Skeleton shape="line" width="70%" height={16} />
                  <Skeleton shape="line" width="40%" />
                </View>
                <Skeleton shape="circle" size={30} />
              </View>
            ))}
          </View>
        </View>
      ))}
    </SkeletonGroup>
  );
}

/** The answer a game row mirrors (row 4): the person's, as Home and Game day show it. */
export function answerBadge(
  fixture: FixtureDetail,
  personId: string | undefined,
  selfId: string | null,
): StatusBadgeProps | null {
  if (fixture.status !== 'scheduled') return fixtureStatus(fixture.status);
  if (!personId) return null;
  switch (recordedAnswer(fixture, personId, selfId).state) {
    case 'available':
      return { tone: 'success', label: 'Going' };
    case 'tentative':
      return { tone: 'pending', label: 'Maybe' };
    case 'unavailable':
      return { tone: 'danger', label: 'Not going' };
    default:
      return null;
  }
}

/** A session's status on its row: a form to sign first, else a booking state worth saying. */
export function sessionBadge(
  item: Schema<'FamilyCalendarItem'>,
  waiverNeeded: boolean,
): StatusBadgeProps | null {
  if (waiverNeeded) return { tone: 'warning', label: 'Waiver needed' };
  const status = calendarItemStatus(item);
  return status.tone === 'success' ? null : status;
}

interface RowModel {
  entry: TodayEntry;
  title: string;
  person: HouseholdPerson | undefined;
  who: string;
  place: string | null;
  badge: StatusBadgeProps | null;
  pickup: boolean;
}

/** One row of a day (handoff 1h): time, the person's stripe, what and who, status, avatar. */
function CalendarRow({ row, first }: { row: RowModel; first: boolean }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const { entry, person } = row;
  const z = entry.zone.zone;
  const [start, period] = timeParts(entry.start, z);
  const until =
    period === 'PM' ? `PM to ${shortTime(entry.end, z)}` : `to ${shortTime(entry.end, z)}`;
  const accent = person ? personColorOf(theme, person.slot).accent : theme.kindColors.league;
  const line = [row.who, row.place, row.pickup ? PICKUP_SESSION_LABEL : null]
    .filter(Boolean)
    .join(' · ');
  const href =
    entry.type === 'fixture'
      ? ({ pathname: '/fixtures/[id]', params: { id: entry.fixture.id } } as Href)
      : (sessionHref(entry.item) as Href | null);
  const spoken = [
    row.title,
    `${formatTime(entry.start, z)} to ${formatTime(entry.end, z)} ${zoneAbbreviation(entry.start, z)}`,
    `For: ${row.who}`,
    row.place ? `At: ${row.place}` : null,
    row.pickup ? PICKUP_SESSION_LABEL : null,
    row.badge?.label ?? null,
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <Pressable
      onPress={href ? () => router.push(href) : undefined}
      disabled={!href}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={entry.type === 'fixture' ? 'Opens the game' : 'Opens the activity'}
      style={({ pressed }) => [
        styles.row,
        first ? null : styles.rowDivider,
        pressed ? styles.pressed : null,
      ]}
      testID={
        entry.type === 'fixture'
          ? `schedule-fixture-${entry.fixture.id}`
          : `schedule-item-${entry.item.id}`
      }
    >
      <View style={styles.time}>
        <Text style={styles.clock}>{start}</Text>
        <Text style={styles.until}>{until}</Text>
      </View>
      <View style={[styles.stripe, { backgroundColor: accent }]} />
      <View style={styles.words}>
        <Text style={styles.rowTitle}>{row.title}</Text>
        <Text variant="footnote" tone="muted">
          {line}
        </Text>
        {row.badge ? (
          <View style={styles.badge}>
            <StatusBadge {...row.badge} />
          </View>
        ) : null}
      </View>
      {person ? (
        <Avatar
          name={person.givenName}
          id={person.id}
          personColor={personColorOf(theme, person.slot)}
          size={30}
          decorative
        />
      ) : null}
    </Pressable>
  );
}

/** Back to back (▲ amber) or a clash (✕ red), in one sentence (INTERACTIONS 1h row 2). */
function JunctureBanner({ juncture }: { juncture: Juncture }) {
  const styles = useStyles();
  const theme = useTheme();
  const clash = juncture.kind === 'clash';
  const tone = clash ? 'danger' : 'warning';
  const lead = clash ? 'Clash:' : 'Back to back:';
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: theme.toneBackgrounds[tone] },
        clash ? styles.bannerClash : styles.bannerWarn,
      ]}
      accessible
      accessibilityLabel={`${clash ? '✕' : '▲'} ${lead} ${juncture.sentence}`}
      testID={`schedule-${juncture.kind}-${juncture.first.id}`}
    >
      <Text style={[styles.bannerGlyph, { color: theme.colors[tone] }]}>{clash ? '✕' : '▲'}</Text>
      <Icon name={clash ? 'event_busy' : 'swap_horiz'} size={20} color={theme.colors[tone]} />
      <Text style={styles.bannerText}>
        <Text style={styles.bannerLead}>{lead}</Text> {juncture.sentence}
      </Text>
    </View>
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
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const now = useNow();
  const device = displayZone(null);
  const params = useLocalSearchParams<{ people?: string; person?: string }>();
  const requested = requestedFilter(params);
  const signedIn = useSignedIn();
  const { me, people: household, selfId } = useHousehold();
  const inbox = useInbox();
  const teams = useMyTeams();

  const [picked, setPicked] = useState<string | null>(null);
  // A day picked on the strip scrolls the list to it (a new object for every pick).
  const [scrollTo, setScrollTo] = useState<{ key: string } | null>(null);
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

  // The people the calendar shows: the household members the API included, in household order.
  const included = new Set(calendar?.participantPersonIds ?? []);
  const people = household.filter((p) => included.has(p.id));
  const chips = useFilterPeople(people);
  const filter = usePersonFilter(people);
  // A link that asks for a person (or everyone) selects that chip, also on a later visit.
  const [seenRequest, setSeenRequest] = useState<string | null>(null);
  useEffect(() => {
    if (!requested || requested === seenRequest || !calendar) return;
    setSeenRequest(requested);
    if (requested === EVERYONE) filter.select(null);
    else if (people.some((p) => p.id === requested)) filter.select(requested);
  }, [requested, seenRequest, calendar, people, filter]);
  const active = filter.selected;

  // Waivers of the people shown: a session row says "Waiver needed" as the pass does.
  const waiverRequests = useMemo(() => people.map((p) => ({ path: { id: p.id } })), [people]);
  const waiverReads = useApiReads('/people/{id}/waivers', waiverRequests, signedIn);
  const waiverNeeded = new Set(
    waiverReads.flatMap((r) =>
      r.data && (r.data as PersonWaivers).waivers.some((w) => w.status !== 'current')
        ? [(r.data as PersonWaivers).personId]
        : [],
    ),
  );

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

  const forActive = (e: TodayEntry) =>
    active === null || entryPersonIds(e, teams.data).includes(active);
  const week = entriesOnDays(entries, days, dayZone.zone);
  const shown = week.filter(forActive);
  const byDay = new Map<string, TodayEntry[]>();
  for (const e of shown) {
    const key = localDayKey(e.start, dayZone.zone);
    byDay.set(key, [...(byDay.get(key) ?? []), e]);
  }
  const blocks = dayBlocks(days, byDay);

  // The strip's dots: one per person with something that day, in their colour (row 1).
  const dayDots: Record<string, { color: string; selectedColor: string }[]> = {};
  const dayWords: Record<string, string> = {};
  for (const [day, list] of byDay) {
    const who = people.filter((p) =>
      list.some((e) => entryPersonIds(e, teams.data).includes(p.id)),
    );
    dayDots[day] = who.map((p) => {
      const color = personColorOf(theme, p.slot);
      return { color: color.accent, selectedColor: color.tint };
    });
    dayWords[day] =
      who.length > 0 ? who.map((p) => (p.self ? 'You' : p.givenName)).join(', ') : 'has activities';
  }

  const strip = (
    <DateStrip
      value={selectedDay}
      onChange={(day) => {
        setPicked(day);
        setScrollTo({ key: blockKeyOf(blocks, day) ?? day });
      }}
      today={now}
      timeZone={stripZone}
      dayDots={dayDots}
      dayWords={dayWords}
      variant="card"
      hideTodayWhenShown
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
        {strip}
        <ReadState
          read={calendarState.read}
          label="your calendar"
          unavailable="Your calendar is not available right now."
          skeleton={<CalendarSkeleton />}
        />
      </Screen>
    );
  }

  const family = people.length > 1;
  const askedForEveryone = requested === EVERYONE;
  const changes = upcomingScheduleChanges(inbox.data?.items ?? [], now);
  // Only activities the API gave no facility zone for are on the device clock: say so then.
  const deviceClock = shown.find((e) => !e.zone.facility);
  const notice = deviceClock ? zoneNotice(deviceClock.zone, deviceClock.start) : null;
  const activePerson = people.find((p) => p.id === active);
  const emptyMessage = activePerson
    ? `Nothing scheduled for ${activePerson.self ? 'you' : activePerson.givenName} this week.`
    : family
      ? 'Nothing scheduled for you or your family this week.'
      : 'Nothing scheduled for you this week.';

  const whoOf = (entry: TodayEntry) => {
    const person = personFor(entry, people, teams.data);
    if (person) return { name: person.self ? 'You' : person.givenName, self: person.self };
    const id = entryPersonIds(entry, teams.data)[0];
    return { name: id ? nameOf(names, id) : 'Your team', self: false };
  };
  const rowOf = (entry: TodayEntry): RowModel => {
    const person = personFor(entry, people, teams.data);
    return {
      entry,
      person,
      who: whoOf(entry).name,
      title: entry.type === 'fixture' ? fixtureTitle(entry.fixture) : entry.item.title,
      place: placeOf(entry),
      pickup: entry.type === 'session' && entry.item.bookingKind === 'pickup',
      badge:
        entry.type === 'fixture'
          ? answerBadge(entry.fixture, person?.id, selfId)
          : sessionBadge(entry.item, waiverNeeded.has(entry.item.personId)),
    };
  };

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
      {family ? (
        <PersonChipRow
          people={chips}
          selected={active}
          onSelect={filter.select}
          style={styles.chips}
          testID="schedule-people"
        />
      ) : askedForEveryone ? (
        <Caption testID="family-only-self">
          No family members are shared with you yet. A child appears here when you hold permission
          to view their schedule.
        </Caption>
      ) : null}
      {strip}
      {notice ? <Caption testID="zone-notice">{notice}</Caption> : null}
      {fixturesFailed ? (
        <View testID="schedule-fixtures-error" style={styles.block}>
          <Caption>Your team games could not be loaded.</Caption>
          <ReadState read={fixtureState.read} label="your team games" />
        </View>
      ) : null}
    </View>
  );

  const footer = (
    <View style={styles.footer}>
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
      <PickupSessions onFind={() => router.push('/discover')} />
      {family || askedForEveryone ? <CollectingAChild /> : null}
    </View>
  );

  return (
    <Screen<DayBlock, { key: string; data: DayBlock[] }>
      onRefresh={refresh}
      refreshing={refreshing}
      scrollToSection={scrollTo}
      sections={{
        sections: shown.length === 0 ? [] : blocks.map((b) => ({ key: b.key, data: [b] })),
        keyExtractor: (block) => block.key,
        initialNumToRender: 7 * 3,
        renderItem: ({ item: block }) =>
          block.kind === 'empty' ? (
            <Text style={styles.emptyRun} testID={`day-${block.key}`}>
              {emptyRunLine(block.days)}
            </Text>
          ) : (
            <View testID={`day-${block.day}`} style={styles.day}>
              <Text
                style={[styles.dayTitle, block.day === selectedDay ? styles.dayTitlePicked : null]}
                accessibilityRole="header"
              >
                {dayHeading(block.day, todayIso, addIsoDays(todayIso, 1))}
              </Text>
              {junctures(block.entries, whoOf, (e) => e.zone.zone).map((j) => (
                <JunctureBanner key={`${j.first.id}-${j.second.id}`} juncture={j} />
              ))}
              <View style={[elevation(theme, 'card'), styles.card]} accessibilityRole="list">
                {block.entries.map((entry, index) => (
                  <CalendarRow key={entry.id} row={rowOf(entry)} first={index === 0} />
                ))}
              </View>
            </View>
          ),
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

/** Kept for callers that list a team's people (MyTeamEntry stays the attribution source). */
export type { MyTeamEntry };

const useStyles = makeStyles(({ colors }) => ({
  strip: { paddingHorizontal: layout.gutter, paddingTop: spacing.md },
  chips: { paddingTop: spacing.xs },
  caption: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm },
  flush: { paddingTop: spacing.xs },
  block: { gap: spacing.sm, paddingTop: spacing.sm },
  start: { alignItems: 'flex-start' },
  footer: { paddingBottom: spacing.lg },
  change: { paddingVertical: spacing.xs, gap: spacing.xs },
  changeTitle: { ...type.body, ...fonts.semibold, color: colors.text },
  day: { paddingHorizontal: layout.gutter, paddingTop: spacing.lg, gap: spacing.sm },
  dayTitle: { ...fonts.semibold, fontSize: 15, lineHeight: 20, color: colors.text },
  dayTitlePicked: { color: colors.primary },
  emptyRun: {
    ...fonts.semibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.textMuted,
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.lg,
  },
  card: { borderRadius: radius.lg, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    minHeight: 56,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.divider },
  pressed: { opacity: 0.7 },
  time: { width: 56 },
  clock: { ...tabular(type.title3), ...fonts.bold, color: colors.text },
  until: { ...fonts.regular, fontSize: 12, lineHeight: 16, color: colors.textMuted },
  stripe: { width: 4, alignSelf: 'stretch', borderRadius: 4 },
  words: { flex: 1, gap: 3 },
  rowTitle: { ...fonts.bold, fontSize: 16, lineHeight: 21, color: colors.text },
  badge: { alignItems: 'flex-start' },
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  bannerWarn: { borderColor: colors.warningBorder },
  bannerClash: { borderColor: colors.danger },
  bannerGlyph: { ...fonts.bold, fontSize: 14, lineHeight: 20 },
  bannerText: { flex: 1, ...type.callout, color: colors.text },
  bannerLead: { ...fonts.bold },
  skeletonDay: { paddingHorizontal: layout.gutter, paddingTop: spacing.lg, gap: spacing.sm },
  skeletonCard: { gap: spacing.md, paddingVertical: spacing.sm },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flex: { flex: 1, gap: spacing.xs },
}));
