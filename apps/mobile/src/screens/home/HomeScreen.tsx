/**
 * SCR-C-03 Home, redesigned "Today first" (redesign handoff M 1b, with its states M 3a, 3f and 3g;
 * BUILD_PLAN Phase 1; ADR-008 visual system v2, **Proposed**; SPK-UX-002, SPK-UX-003, SPK-UX-004,
 * SPK-COMMS-005, SPK-UX-008, SPK-UX-009, SPK-CAP-003, SPK-PAY-004/005/007, SPK-REG-011, §4.10,
 * §4.11, §4.15).
 *
 * Top to bottom:
 * 1. The date and "Hi, Dana" beside the pass and the inbox (unread badge) (`HeaderActions`).
 *    After a pull to refresh, "Updated just now" for 2 s.
 * 2. A registration whose payment was received but not completed, pinned first (§4.11: "Do not pay
 *    again"), and the failure of that read where it would be pinned.
 * 3. The household "who" chips (`PersonChipRow`, shared with Calendar and Explore): they filter
 *    the whole page. Hidden with one person.
 * 4. "Changes affecting you" (urgent schedule changes, SPK-UX-003).
 * 5. The hero (`TodayHero`): the next activity of the people shown, with its live countdown,
 *    kickoff and place, the game answer (`GameAnswer`, optimistic with Undo), Directions and Show
 *    pass. A game of today that was cancelled shows first as the red card (3g) until "See what's
 *    next". Nothing today: the next activity with its day. Nothing at all: "Find something for
 *    Maya" with Explore.
 * 6. "To do" with "3 left · about 2 min": fees (Pay sheet, 2b/3b), forms (Sign sheet, 2c) and team
 *    invitations (Join sheet, 3c), acting in place; a done row flashes "✓ Paid" for 3 s and leaves
 *    (3a). Registrations that need something and other action notices follow in the same card.
 * 7. "This week": the day strip with one dot per person, the next rows, and "Calendar".
 * 8. Registrations in progress, results and renewals (SPK-UX-003 order), then "Picked for Maya".
 *
 * Loading keeps the final layout (skeleton hero and rows). Offline (3f), the app's banner says how
 * old the page is; every write is disabled with its reason (answers, Pay, Sign, Join) while the
 * pass, times and places stay. Promotional messages never appear here (they stay in the inbox).
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { illustrations } from '../../artwork/manifest';
import { PaySheet } from '../../features/money/PaySheet';
import { formatMoney } from '../../features/money/format';
import { useFilterPeople, useHousehold, type HouseholdPerson } from '../../features/home/household';
import { todoItems, todoSummary, useTodoReads, type TodoItem } from '../../features/home/todo';
import { registrationRoutes } from '../../features/registration/routes';
import {
  JoinTeamSheet,
  snoozeInvitation,
  snoozedInvitations,
} from '../../features/teams/JoinTeamSheet';
import { calendarWindowQuery } from '../../features/today/calendar';
import {
  entryPersonIds,
  mergeEntries,
  nextEntry,
  type TodayEntry,
} from '../../features/today/entries';
import { noticeTarget } from '../../features/today/notice-target';
import {
  availabilityRequestOf,
  noticeSection,
  type NoticeSection,
} from '../../features/today/notices';
import {
  SCHEDULE_WINDOW_DAYS,
  useCalendarWindow,
  useInbox,
  useMyFixtures,
  useMyTeams,
  useOfferings,
  useSignedIn,
} from '../../features/today/queries';
import { oldestUpdate, SectionQueryState } from '../../features/today/read-state';
import { RECOVERY_PHRASE } from '../../features/today/status';
import { useKnownFacilityZone } from '../../features/today/known-zone';
import { addLocalDays, formatDay, localDayKey, startOfLocalDay } from '../../features/today/time';
import {
  offersAlsoSign,
  SignSheet,
  type SignOutcome,
  type SignPerson,
} from '../../features/waivers/SignSheet';
import { HeaderActions } from '../../navigation/HeaderActions';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { EmptyState } from '../../ui/EmptyState';
import { InfoCard } from '../../ui/InfoCard';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { personColorOf } from '../../ui/person-colors';
import { PersonChipRow, usePersonFilter } from '../../ui/PersonFilter';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { Skeleton } from '../../ui/Skeleton';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { useToast } from '../../ui/Toast';
import { fonts, layout, makeStyles, spacing, type, useTheme } from '../../ui/theme';
import { FollowUp } from './FollowUp';
import { HomePickedFor, pickedForPerson } from './HomePickedFor';
import { NoticeRow, RegistrationRow } from './NeedsYou';
import { registrationVerb } from './home-layout';
import { usePendingRegistrations } from './pending-registrations';
import { CancelledHero, TodayHero } from './TodayHero';
import { DONE_FLASH_MS, TodoCard, TodoRow, todoLine, type DoneRow } from './TodoList';
import { WeekRows, WeekStrip } from './WeekStrip';

export { noticeFor } from './open-notice';

type InboxItem = Schema<'InboxItem'>;
type FixtureDetail = Schema<'FixtureDetail'>;
type Checkout = Schema<'Checkout'>;
type Obligation = Schema<'Obligation'>;
type TeamInvitationView = Schema<'TeamInvitationView'>;

/** Checkouts in `recovery_required` per page (FIN-01 `status` filter); "Load more" follows the cursor. */
const CHECKOUTS_PAGE = 20;
/** How many notices "Changes affecting you" shows before the inbox. */
const URGENT_SHOWN = 3;
/** How many rows "This week" lists under the strip. */
const WEEK_ROWS = 3;
/** How long "Updated just now" stays after a pull to refresh (handoff Shell row 6). */
export const UPDATED_NOTE_MS = 2_000;

/** Said when the pinned recovery card appears (§4.11): never invites a second payment. */
export const RECOVERY_MESSAGE =
  "Do not pay again. Your payment was received and we're completing the registration. It will show here as confirmed, or with what happens next.";

/**
 * Checkouts in `recovery_required` (§4.11) not already pinned through one of their enrollments:
 * money was received, the registration is not complete, and the person must not pay again.
 */
export function recoveryCheckouts(
  checkouts: readonly Checkout[],
  pinnedEnrollmentIds: ReadonlySet<string>,
): Checkout[] {
  return checkouts.filter(
    (c) =>
      c.status === 'recovery_required' &&
      !c.enrollmentIds.some((id) => pinnedEnrollmentIds.has(id)),
  );
}

/**
 * Whether an availability request (COM-06) is already answered: every person it is for has an
 * answer in the fixture read's `responses`. A fixture not loaded, or an answer not listed, keeps
 * it an action.
 */
export function availabilityRequestAnswered(
  item: InboxItem,
  fixtures: readonly FixtureDetail[],
  selfId: string | null,
): boolean {
  const request = availabilityRequestOf(item);
  if (!request) return false;
  const fixture = fixtures.find((f) => f.id === request.fixtureId);
  if (!fixture) return false;
  const people = (item.subjectPersonIds ?? []).length > 0 ? item.subjectPersonIds : [selfId];
  return people.every((personId) => {
    if (!personId) return false;
    const listed = (fixture.responses ?? []).find((r) => r.personId === personId)?.state;
    const state = listed ?? (personId === selfId ? fixture.myResponse : null) ?? null;
    return state !== null && state !== 'no_response';
  });
}

/** Where a payment notice goes: the first action notice about an amount due, or none. */
export function payTarget(actions: readonly InboxItem[]): Href | null {
  const due = actions.find(
    (item) => item.kind === 'payment_attention' && noticeTarget(item).kind === 'subject',
  );
  return due ? (noticeTarget(due).href as Href) : null;
}

/** "Saturday, November 21" on the facility clock. */
export function longDate(now: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: zone,
  }).format(now);
}

/** Today's cancelled game for the people shown (3g), the first not yet passed by "See what's next". */
export function cancelledToday(
  fixtures: readonly FixtureDetail[],
  now: Date,
  zone: string,
  dismissed: ReadonlySet<string>,
): FixtureDetail | null {
  const today = localDayKey(now, zone);
  return (
    fixtures.find(
      (f) =>
        f.status === 'canceled' &&
        !!f.scheduledStart &&
        localDayKey(f.scheduledStart, f.venue?.timezone ?? zone) === today &&
        !dismissed.has(f.id),
    ) ?? null
  );
}

type OpenSheet =
  | { kind: 'pay'; obligation: Obligation; itemId: string; who: string }
  | { kind: 'sign'; personId: string; itemId: string | null }
  | { kind: 'join'; invitation: TeamInvitationView; itemId: string }
  | null;

function HomeSkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.skeleton} testID="home-skeleton">
      <Skeleton shape="block" height={300} />
      <Skeleton shape="line" width="30%" height={20} />
      <Skeleton shape="block" height={64} />
      <Skeleton shape="block" height={64} />
      <Skeleton shape="block" height={64} />
    </View>
  );
}

function Greeting({
  name,
  now,
  zone,
  note,
}: {
  name: string | null;
  now: Date;
  zone: string;
  note: string | null;
}) {
  const styles = useStyles();
  return (
    <View style={styles.greeting}>
      <View style={styles.greetingWords}>
        <Text style={styles.date}>{longDate(now, zone)}</Text>
        <Text style={styles.hello} accessibilityRole="header">
          {name ? `Hi, ${name}` : 'Hi'}
        </Text>
        {note ? (
          <Text variant="footnote" tone="muted" testID="home-updated-note">
            {note}
          </Text>
        ) : null}
      </View>
      <HeaderActions />
    </View>
  );
}

function HomeContent({ refreshedNote }: { refreshedNote: string | null }) {
  const router = useRouter();
  const styles = useStyles();
  const theme = useTheme();
  const toast = useToast();
  const now = useNow(30_000);
  const zone = useKnownFacilityZone().zone;
  const offline = useConnectivity().reachable === false;
  const { me, people, selfId, names } = useHousehold();
  const filterPeople = useFilterPeople(people);
  const { selected, select } = usePersonFilter(people);
  const inbox = useInbox();
  const calendar = useCalendarWindow(now, SCHEDULE_WINDOW_DAYS, zone);
  const fixtures = useMyFixtures(calendarWindowQuery(now, 0, SCHEDULE_WINDOW_DAYS, zone));
  const teams = useMyTeams();
  const registrations = usePendingRegistrations(me.data);
  const todo = useTodoReads(people, selfId);
  // §4.11, SCR-C-40: only checkouts in recovery, every page of them.
  const checkouts = useApiPages({
    path: '/me/registration-checkouts',
    request: { query: { status: 'recovery_required', limit: CHECKOUTS_PAGE } },
    enabled: me.data !== undefined,
  });
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [done, setDone] = useState<Map<string, DoneRow>>(new Map());
  const [dismissedCancel, setDismissedCancel] = useState<Set<string>>(new Set());
  const [hiddenInvites, setHiddenInvites] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const flashDone = useCallback((row: DoneRow) => {
    setDone((m) => new Map(m).set(row.item.id, row));
    timers.current.push(
      setTimeout(() => {
        setDone((m) => {
          const next = new Map(m);
          next.delete(row.item.id);
          return next;
        });
      }, DONE_FLASH_MS),
    );
  }, []);

  const shown = (ids: readonly string[]) => selected === null || ids.includes(selected);
  const personOf = (id: string): HouseholdPerson | undefined => people.find((p) => p.id === id);
  const whoOf = (id: string) => {
    const p = personOf(id);
    return p ? (p.self ? 'You' : p.givenName) : (names.get(id) ?? 'Family member');
  };

  const fixturesHidden =
    fixtures.error !== null && presentationForError(fixtures.error) === 'unavailable';
  const fixtureList = useMemo(
    () => (fixturesHidden ? [] : (fixtures.data ?? [])),
    [fixturesHidden, fixtures.data],
  );
  const fixturesSettled = fixtures.data !== undefined || fixtures.error !== null;
  const allEntries = mergeEntries(calendar.data?.items ?? [], fixtureList);
  const entries = allEntries.filter((e) => shown(entryPersonIds(e, teams.data)));
  const next = nextEntry(entries, now);
  const cancelled = cancelledToday(
    fixtureList.filter((f) => {
      const entry = { type: 'fixture', fixture: f } as TodayEntry;
      return shown(entryPersonIds(entry, teams.data));
    }),
    now,
    zone,
    dismissedCancel,
  );

  const pickedFor = selected && !personOf(selected)?.self ? selected : pickedForPerson(me.data);
  const allRegistrations = [
    ...registrations.recovery,
    ...registrations.pending,
    ...registrations.inProgress,
  ];
  const offerings = useOfferings(
    allRegistrations.filter((r) => !r.enrollment.offering).map((r) => r.enrollment.offeringId),
  );
  const offeringNames = new Map([...offerings].map(([id, o]) => [id, o.name]));

  const items = todoItems({
    obligations: todo.obligations,
    waivers: todo.waivers,
    invitations: todo.invitations,
    selfId,
    now,
    snoozed: snoozedInvitations(),
    // Re-read after "Not now": the snooze list is kept outside React state.
    hidden: hiddenInvites,
  }).filter((i) => shown([i.personId]));
  const doneOnly = [...done.values()].filter(
    (d) => !items.some((i) => i.id === d.item.id) && shown([d.item.personId]),
  );
  const needsWaiver = new Set(items.filter((i) => i.kind === 'sign').map((i) => i.personId));

  if (me.data === undefined) {
    return me.error ? (
      <SectionQueryState
        read={me}
        label="your home"
        unavailable={{
          description:
            'Your account details are not available. Contact the front desk if this continues.',
        }}
      />
    ) : (
      <HomeSkeleton />
    );
  }

  const bySection = new Map<NoticeSection, InboxItem[]>();
  for (const item of inbox.data?.items ?? []) {
    const section = noticeSection(item, now);
    if (!section) continue;
    if (section === 'actions' && availabilityRequestAnswered(item, fixtureList, selfId)) continue;
    const about = item.subjectPersonIds ?? [];
    if (selected !== null && about.length > 0 && !about.includes(selected)) continue;
    bySection.set(section, [...(bySection.get(section) ?? []), item]);
  }
  const notices = (section: NoticeSection) => bySection.get(section) ?? [];
  // Notices already acted on in place by a To do row are not listed twice.
  const payIds = new Set(todo.obligations.map((o) => `/payments/${o.id}`));
  const actionNotices = notices('actions').filter(
    (n) => !(n.kind === 'payment_attention' && payIds.has(String(noticeTarget(n).href))),
  );
  const inviteNotices = todo.invitations.length > 0 ? [] : notices('invitations');
  const unpinnedRecovery = recoveryCheckouts(
    checkouts.data ?? [],
    new Set(registrations.recovery.map((r) => r.enrollment.id)),
  );
  const checkoutsSettled = checkouts.data !== undefined || checkouts.error !== null;
  const checkoutsFailed =
    checkouts.data === undefined &&
    checkouts.error !== null &&
    presentationForError(checkouts.error) !== 'unavailable'
      ? checkouts
      : null;
  const urgent = notices('urgent');
  const fixturesFailed =
    fixtures.error !== null && !fixturesHidden && fixtures.data === undefined ? fixtures : null;
  const nothingAtAll =
    calendar.data !== undefined &&
    inbox.data !== undefined &&
    fixturesSettled &&
    checkoutsSettled &&
    !checkoutsFailed &&
    !registrations.loading &&
    !todo.loading &&
    allEntries.filter((e) => new Date(e.end).getTime() > now.getTime()).length === 0 &&
    allRegistrations.length === 0 &&
    unpinnedRecovery.length === 0 &&
    bySection.size === 0 &&
    items.length === 0 &&
    doneOnly.length === 0;
  const updatedAt = oldestUpdate([
    me.updatedAt,
    inbox.updatedAt,
    calendar.updatedAt,
    fixturesHidden ? null : fixtures.updatedAt,
    registrations.updatedAt,
    checkouts.updatedAt,
  ]);

  // This week: the rest of this week's activities after the hero.
  const weekEnd = addLocalDays(
    startOfLocalDay(now, zone),
    7 - ((new Date(`${localDayKey(now, zone)}T12:00:00Z`).getUTCDay() + 6) % 7),
    zone,
  );
  const weekEntries = entries.filter(
    (e) => new Date(e.end).getTime() > now.getTime() && new Date(e.start) < weekEnd,
  );
  const laterRows = weekEntries.filter((e) => e.id !== next?.id).slice(0, WEEK_ROWS);
  const firstChild = people.find((p) => !p.self);
  const focusName = selected ? whoOf(selected) : (firstChild?.givenName ?? null);

  const contextFor = (personId: string): string | null => {
    const upcoming = allEntries.find(
      (e) =>
        new Date(e.end).getTime() > now.getTime() &&
        entryPersonIds(e, teams.data).includes(personId),
    );
    if (!upcoming) return null;
    return upcoming.type === 'session' ? upcoming.item.title : 'the next game';
  };

  const act = (item: TodoItem) => {
    if (item.kind === 'pay') {
      setSheet({
        kind: 'pay',
        obligation: item.obligation,
        itemId: item.id,
        who: whoOf(item.personId),
      });
    } else if (item.kind === 'sign') {
      setSheet({ kind: 'sign', personId: item.personId, itemId: item.id });
    } else {
      setSheet({ kind: 'join', invitation: item.invitation, itemId: item.id });
    }
  };

  const signPerson = (personId: string): SignPerson | null => {
    const list = todo.waivers.find((w) => w.personId === personId)?.waivers ?? [];
    const waiver = list.find((w) => w.status !== 'current' && w.currentVersion !== null);
    const person = personOf(personId);
    return waiver && person ? { id: personId, givenName: person.givenName, waiver } : null;
  };
  const signing = sheet?.kind === 'sign' ? signPerson(sheet.personId) : null;
  const siblings: SignPerson[] = signing
    ? todo.waivers.flatMap(({ personId, waivers }) => {
        if (personId === signing.id) return [];
        const person = personOf(personId);
        const same = waivers.find((w) => offersAlsoSign(signing.waiver, w, now));
        return person && same ? [{ id: personId, givenName: person.givenName, waiver: same }] : [];
      })
    : [];

  const onSigned = (outcome: SignOutcome) => {
    const current = sheet;
    setSheet(null);
    if (current?.kind === 'sign' && signing) {
      const item = items.find((i) => i.id === current.itemId);
      if (item) {
        flashDone({ item, label: '✓ Signed', line: `${signing.givenName} · signed` });
      }
    }
    const [first] = outcome.signed;
    if (outcome.failed.length > 0) {
      toast.show({
        message: `Signed for ${outcome.signed.join(' and ')}. ${outcome.failed.join(' and ')}'s form didn't save.`,
        tone: 'info',
      });
    } else if (outcome.signed.length > 1) {
      toast.show({ message: `Signed for ${outcome.signed.join(' and ')}. ${first} is cleared.` });
    } else {
      toast.show({ message: `Signed. ${first} is cleared to check in.` });
    }
    todo.refetch();
  };

  const cancelledPlayer = (() => {
    if (!cancelled) return null;
    const ids = entryPersonIds({ type: 'fixture', fixture: cancelled } as TodayEntry, teams.data);
    const p =
      people.find((x) => !x.self && ids.includes(x.id)) ?? people.find((x) => ids.includes(x.id));
    return p ? { name: p.givenName, color: personColorOf(theme, p.slot) } : null;
  })();
  const cancelReason = cancelled
    ? ((inbox.data?.items ?? []).find(
        (n) =>
          n.subject?.id === cancelled.id ||
          (n.detailsAfter as { eventId?: string } | null)?.eventId === cancelled.schedulingEventId,
      )?.body ?? null)
    : null;

  return (
    <View testID="home-content">
      {/* §4.15: the age of what is shown once it is not fresh ("Updated 5 minutes ago"). */}
      <LastUpdated
        at={
          refreshedNote || !updatedAt || now.getTime() - updatedAt.getTime() < 60_000
            ? null
            : updatedAt
        }
        now={now}
      />

      {registrations.recovery.length > 0 || unpinnedRecovery.length > 0 ? (
        <View style={styles.gutter}>
          <InfoCard
            tone="warning"
            title="Registration being completed"
            message={RECOVERY_MESSAGE}
            testID="home-recovery"
          >
            {registrations.recovery.length > 0 ? (
              <View accessibilityRole="list">
                {registrations.recovery.map((row) => (
                  <RegistrationRow
                    key={row.enrollment.id}
                    row={row}
                    names={names}
                    offeringNames={offeringNames}
                    testID="home-recovery-row"
                  />
                ))}
              </View>
            ) : null}
            {unpinnedRecovery.length > 0 ? (
              <View accessibilityRole="list">
                {unpinnedRecovery.map((c) => (
                  <ListRow
                    key={c.id}
                    title="Registration checkout"
                    detail={`${c.enrollmentIds.length} registration${c.enrollmentIds.length === 1 ? '' : 's'} being completed`}
                    status={{ tone: 'warning', label: RECOVERY_PHRASE }}
                    onPress={() => router.push(registrationRoutes.outcome(c.id) as Href)}
                    accessibilityHint="Opens what happens next with this checkout"
                    testID={`home-recovery-checkout-${c.id}`}
                  />
                ))}
              </View>
            ) : null}
            <LoadMore pages={checkouts} label="registrations being completed" />
          </InfoCard>
        </View>
      ) : null}
      {checkoutsFailed ? (
        <View style={styles.gutter} testID="home-recovery-error">
          <InfoCard
            tone="warning"
            title="Registration being completed"
            message="We couldn't check whether a payment is being completed."
          >
            <SectionQueryState read={checkoutsFailed} label="registrations being completed" />
          </InfoCard>
        </View>
      ) : null}

      <PersonChipRow
        people={filterPeople}
        selected={selected}
        onSelect={select}
        style={styles.chips}
      />

      {urgent.length > 0 ? (
        <Section title="Changes affecting you" testID="home-urgent">
          <View accessibilityRole="list">
            {urgent.slice(0, URGENT_SHOWN).map((item) => (
              <NoticeRow key={item.attemptId} item={item} names={names} />
            ))}
          </View>
        </Section>
      ) : null}

      {nothingAtAll ? (
        <EmptyState
          source={illustrations['empty-home']}
          title={focusName ? `Find something for ${focusName}` : "You're all caught up"}
          message="Classes, camps and leagues that fit your family's week show up here, with anything you need to do."
          action={{ label: 'Explore activities', onPress: () => router.push('/discover') }}
          testID="home-empty"
        />
      ) : (
        <View style={styles.hero} testID="home-next">
          {calendar.data === undefined && calendar.error === null ? <HomeSkeleton /> : null}
          <SectionQueryState
            read={calendar}
            label="your next activity"
            unavailable={{ description: 'Your schedule is not available right now.' }}
          />
          {cancelled ? (
            <CancelledHero
              fixture={cancelled}
              reason={cancelReason}
              zone={cancelled.venue?.timezone ?? zone}
              player={cancelledPlayer}
              onNext={() => setDismissedCancel((s) => new Set(s).add(cancelled.id))}
            />
          ) : calendar.data !== undefined && next ? (
            <TodayHero
              key={next.id}
              entry={next}
              people={people}
              selfId={selfId}
              teams={teams.data}
              names={names}
              inbox={inbox.data?.items ?? []}
              now={now}
              needsWaiver={needsWaiver}
              onSign={(personId) =>
                setSheet({ kind: 'sign', personId, itemId: `sign:${personId}` })
              }
              onPass={(personId) =>
                router.push(
                  (personId
                    ? { pathname: '/pass', params: { person: personId } }
                    : '/pass') as Href,
                )
              }
            />
          ) : null}
          {fixturesFailed ? (
            <View testID="home-fixtures-error" style={styles.stack}>
              <Text variant="footnote" tone="muted" style={styles.gutter}>
                Your team games could not be loaded.
              </Text>
              <SectionQueryState read={fixturesFailed} label="your games" />
            </View>
          ) : null}
          {calendar.data !== undefined && fixturesSettled && !next && !cancelled ? (
            <StateView
              variant="empty"
              title={
                focusName && selected ? `Nothing coming up for ${focusName}` : 'Nothing coming up'
              }
              description={`Nothing is scheduled in the next ${SCHEDULE_WINDOW_DAYS} days.`}
              actionLabel="Explore activities"
              onAction={() => router.push('/discover')}
            />
          ) : null}
        </View>
      )}

      {items.length +
        doneOnly.length +
        actionNotices.length +
        inviteNotices.length +
        registrations.pending.length >
      0 ? (
        <View style={styles.section} testID="home-todo">
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              To do
            </Text>
            <Text variant="footnote" tone="muted" testID="home-todo-summary">
              {todoSummary(items)}
            </Text>
          </View>
          {items.length + doneOnly.length > 0 ? (
            <TodoCard testID="home-todo-rows">
              {[...doneOnly.map((d) => d.item), ...items].map((item, index) => (
                <TodoRow
                  key={item.id}
                  item={item}
                  first={index === 0}
                  done={done.get(item.id) ?? null}
                  line={todoLine(item, whoOf(item.personId), zone, contextFor(item.personId))}
                  disabled={offline}
                  onAct={() => act(item)}
                />
              ))}
            </TodoCard>
          ) : null}
          {offline && items.length > 0 ? (
            <Text variant="footnote" tone="muted" style={styles.gutter}>
              Paying, signing and answering need a connection.
            </Text>
          ) : null}
          {registrations.pending.length + actionNotices.length > 0 ? (
            <View accessibilityRole="list" testID="home-actions" style={styles.gutterless}>
              {registrations.pending.map((row) => (
                <RegistrationRow
                  key={row.enrollment.id}
                  row={row}
                  names={names}
                  offeringNames={offeringNames}
                  verb={registrationVerb(row.enrollment.pendingReason)}
                  onPress={() => router.push(`/enrollments/${row.enrollment.id}` as Href)}
                  testID="home-registration"
                />
              ))}
              {actionNotices.map((item) => (
                <NoticeRow key={item.attemptId} item={item} names={names} />
              ))}
            </View>
          ) : null}
          {inviteNotices.length > 0 ? (
            <View accessibilityRole="list" testID="home-invitations" style={styles.gutterless}>
              {inviteNotices.map((item) => (
                <NoticeRow key={item.attemptId} item={item} names={names} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {weekEntries.length > 0 ? (
        <View style={styles.section} testID="home-this-week">
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              This week
            </Text>
            <Text
              variant="callout"
              tone="accent"
              style={styles.link}
              accessibilityRole="link"
              onPress={() => router.push('/schedule')}
              testID="home-calendar-link"
            >
              Calendar
            </Text>
          </View>
          <WeekStrip entries={entries} people={people} teams={teams.data} now={now} zone={zone} />
          <WeekRows
            entries={laterRows}
            people={people}
            teams={teams.data}
            names={names}
            now={now}
            zone={zone}
          />
        </View>
      ) : null}

      {registrations.inProgress.length > 0 ? (
        <Section title="Registrations in progress" testID="home-in-progress">
          <View accessibilityRole="list">
            {registrations.inProgress.map((row) => (
              <RegistrationRow
                key={row.enrollment.id}
                row={row}
                names={names}
                offeringNames={offeringNames}
                testID="home-in-progress-row"
              />
            ))}
          </View>
        </Section>
      ) : null}
      {registrations.error ? (
        <StateView variant="error" error={registrations.error} onRetry={registrations.refetch} />
      ) : null}

      <FollowUp results={notices('results')} renewals={notices('renewals')} names={names} />

      {pickedFor ? <HomePickedFor personId={pickedFor} name={whoOf(pickedFor)} /> : null}

      {inbox.data === undefined ? (
        <SectionQueryState
          read={inbox}
          label="your notices"
          unavailable={{ description: 'Your notices are not available right now.' }}
        />
      ) : null}

      <PaySheet
        open={sheet?.kind === 'pay'}
        onClose={() => setSheet(null)}
        obligation={sheet?.kind === 'pay' ? sheet.obligation : null}
        subtitle={
          sheet?.kind === 'pay'
            ? `${sheet.who} · due ${formatDay(sheet.obligation.dueAt, zone)}`
            : ''
        }
        onPaid={(outcome) => {
          if (sheet?.kind !== 'pay') return;
          const amount = formatMoney(outcome.payment.amountMinor, outcome.payment.currency);
          const item = items.find((i) => i.id === sheet.itemId);
          if (item) {
            flashDone({
              item,
              label: '✓ Paid',
              line: `${sheet.who} · ${amount} paid · receipt in Payments`,
            });
          }
          setSheet(null);
          toast.show({
            message: `Paid ${amount.replace(/\.00$/u, '')}. Your receipt is in Payments.`,
          });
        }}
      />
      <SignSheet
        open={sheet?.kind === 'sign'}
        onClose={() => setSheet(null)}
        person={signing}
        siblings={siblings}
        context={
          signing
            ? contextFor(signing.id)
              ? `needed before ${contextFor(signing.id)}`
              : null
            : null
        }
        signerName={
          me.data.person ? `${me.data.person.givenName} ${me.data.person.familyName}` : ''
        }
        onSigned={onSigned}
      />
      <JoinTeamSheet
        open={sheet?.kind === 'join'}
        onClose={() => setSheet(null)}
        invitation={sheet?.kind === 'join' ? sheet.invitation : null}
        zone={zone}
        onJoined={(invitation) => {
          const item = items.find((i) => i.kind === 'join' && i.invitation.id === invitation.id);
          if (item) flashDone({ item, label: '✓ Joined', line: 'You · on the team' });
          setSheet(null);
          toast.show({ message: `You joined ${invitation.teamName}. Added to Calendar.` });
        }}
        onNotNow={(invitation) => {
          snoozeInvitation(invitation.id, now);
          setHiddenInvites((n) => n + 1);
          setSheet(null);
        }}
      />
    </View>
  );
}

export function HomeScreen() {
  const signedIn = useSignedIn();
  const queryClient = useQueryClient();
  const now = useNow();
  const zone = useKnownFacilityZone().zone;
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return undefined;
    const timer = setTimeout(() => setNote(null), UPDATED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  // Pull to refresh: every read on the page again; "Updated just now" for 2 s once done.
  const refresh = () => {
    setRefreshing(true);
    void queryClient
      .refetchQueries({ type: 'active' })
      .then(() => setNote('Updated just now'))
      .finally(() => setRefreshing(false));
  };
  return (
    <Screen onRefresh={signedIn ? refresh : undefined} refreshing={refreshing}>
      <HomeGreeting now={now} zone={zone} note={note} />
      <RequireSession what="your next activity and the actions you need to take">
        <HomeContent refreshedNote={note} />
      </RequireSession>
    </Screen>
  );
}

function HomeGreeting({ now, zone, note }: { now: Date; zone: string; note: string | null }) {
  const { me } = useHousehold();
  return <Greeting name={me.data?.person?.givenName ?? null} now={now} zone={zone} note={note} />;
}

const useStyles = makeStyles(({ colors }) => ({
  gutter: { paddingHorizontal: layout.gutter, marginTop: spacing.sm },
  gutterless: { marginHorizontal: layout.gutter },
  stack: { gap: spacing.sm },
  skeleton: { paddingHorizontal: layout.gutter, gap: spacing.md, marginTop: spacing.lg },
  greeting: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: layout.gutter,
    paddingTop: 6,
  },
  greetingWords: { flex: 1, gap: 2 },
  date: { ...fonts.semibold, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  hello: { ...type.display, color: colors.text },
  chips: { marginTop: 14, flexGrow: 0 },
  hero: { marginTop: spacing.lg, gap: spacing.sm },
  section: { marginTop: spacing.xl - 4, gap: spacing.sm },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: layout.gutter,
  },
  sectionTitle: { ...type.title3, color: colors.text },
  link: { ...fonts.semibold, minHeight: 24 },
}));
