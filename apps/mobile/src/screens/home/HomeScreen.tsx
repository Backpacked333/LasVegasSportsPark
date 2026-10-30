/**
 * SCR-C-03 Home (SPK-UX-002, SPK-UX-003, SPK-UX-004, SPK-COMMS-005, SPK-UX-008, SPK-UX-009).
 *
 * Order (SPK-UX-003): a registration whose payment was received but not completed is pinned above
 * everything (§4.11 recovery); then urgent changes, the next scheduled activity (SCR-C-04),
 * actions required before participation, invitations and offers, results and follow-up, and
 * renewal opportunities. Promotional messages never appear here (they stay in the inbox), so
 * marketing cannot obscure today's activity or an unresolved registration.
 *
 * Sources, all answered by the API under its own authorization: `GET /v1/me` (who the person may
 * view), `GET /v1/me/family-calendar` and `GET /v1/me/fixtures` (the next activity: a session,
 * booking or fixture, whichever comes first, CMP-02), `GET /v1/me/team-entries` (whose fixture it
 * is and the opponent), `GET /v1/me/inbox` (changes, actions, invitations, results, renewals; each
 * notice names the participants it concerns, `subjectPersonIds`), `GET /v1/enrollments?status=
 * pending` per participant with `pendingReason` (what is outstanding, ENR-02) and
 * `GET /v1/operations/{id}` (registrations needing something), and `GET /v1/me/registration-
 * checkouts?status=recovery_required` (FIN-01, every page through "Load more"), so a checkout in
 * `recovery_required` the person paid for is pinned even when its enrollment is not listed
 * (another participant, a reinstall), with its outcome screen (SCR-C-15; SCR-C-40 "interrupted
 * payment found on refresh"); a failed read of it shows its code where it would be pinned, and
 * Home is never called empty before it answers. "Payment outstanding" is said only once the
 * basket was read and no checkout runs (SPK-PAY-007). An `availability_request` notice (COM-06)
 * is an action until its fixture starts or everyone it is for has answered; the fixture card
 * names it as its required action. Each section has its own state; the page states the age of
 * what it shows (§4.15) and the SCR-C-40 banner covers connectivity.
 * A fixture read that is not available (NOT_FOUND, ACCESS_DENIED) leaves fixtures out silently;
 * any other failure is shown in the next-activity section with its code and "Try again".
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { calendarWindowQuery } from '../../features/today/calendar';
import { mergeEntries, nextEntry } from '../../features/today/entries';
import {
  fixtureCardModel,
  fixtureRequiredAction,
  ownResponse,
  viewerOnRoster,
} from '../../features/today/fixture-model';
import { NextActivityCard } from '../../features/today/NextActivityCard';
import {
  availabilityRequestOf,
  latestChangeForEvent,
  noticeSection,
  openAvailabilityRequest,
  type NoticeSection,
} from '../../features/today/notices';
import {
  INBOX_PAGE_SIZE,
  SCHEDULE_WINDOW_DAYS,
  nameOf,
  useCalendarWindow,
  useInbox,
  useMe,
  useMyFixtures,
  useMyTeams,
  useOfferings,
  usePersonNames,
} from '../../features/today/queries';
import { registrationRoutes } from '../../features/registration/routes';
import { RsvpControl } from '../../features/today/RsvpControl';
import { Caption, oldestUpdate, Section, SectionQueryState } from '../../features/today/Section';
import { sessionHref, useSessionActivity } from '../../features/today/session-activity';
import { enrollmentStatus, noticeStatus, RECOVERY_PHRASE } from '../../features/today/status';
import { displayZone, zoneNotice } from '../../features/today/time';
import { useApiPages } from '../../api/useApiPages';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { usePendingRegistrations, type PendingRegistration } from './pending-registrations';

type InboxItem = Schema<'InboxItem'>;
type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;
type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;
type Me = Schema<'Me'>;
type Checkout = Schema<'Checkout'>;

/** Checkouts in `recovery_required` per page (FIN-01 `status` filter); "Load more" follows the cursor. */
const CHECKOUTS_PAGE = 20;

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
 * answer in the fixture read's `responses` (the viewer's own, and those the API lists for people
 * they hold `register` over). A fixture not loaded, or an answer not listed, keeps it an action.
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

/** How many notices each Home section shows before "See all in notifications". */
const NOTICES_PER_SECTION = 3;

const NOTICE_SECTIONS: readonly { key: NoticeSection; title: string }[] = [
  { key: 'urgent', title: 'Changes affecting you' },
  { key: 'actions', title: 'Actions required' },
  { key: 'invitations', title: 'Invitations and offers' },
  { key: 'results', title: 'Results and follow-up' },
  { key: 'renewals', title: 'Renewal opportunities' },
];

export function unreadCount(items: readonly InboxItem[]): number {
  return items.filter((i) => !i.readAt && !i.acknowledgedAt && !i.supersededByNotificationId)
    .length;
}

function UnreadBadge() {
  const inbox = useInbox();
  const items = inbox.data?.items;
  if (!items) return null;
  const count = unreadCount(items);
  if (count === 0) return null;
  const more = count >= INBOX_PAGE_SIZE && inbox.data?.nextCursor ? '+' : '';
  return <StatusBadge tone="info" label={`${count}${more} unread`} testID="home-unread" />;
}

function openNotice(router: ReturnType<typeof useRouter>, item: InboxItem) {
  router.push({ pathname: '/inbox', params: { open: item.attemptId } } as Href);
}

/** "For: Sam. " ahead of a notice's text: whom it concerns (SPK-UX-003, `subjectPersonIds`). */
export function noticeFor(item: InboxItem, names: Map<string, string>): string {
  const ids = item.subjectPersonIds ?? [];
  if (ids.length === 0) return '';
  return `For: ${ids.map((id) => nameOf(names, id)).join(', ')}. `;
}

function NoticeRows({ items, names }: { items: InboxItem[]; names: Map<string, string> }) {
  const router = useRouter();
  return (
    <View accessibilityRole="list">
      {items.map((item) => (
        <ListRow
          key={item.attemptId}
          title={item.title}
          detail={`${noticeFor(item, names)}${item.body}`}
          status={noticeStatus(item)}
          onPress={() => openNotice(router, item)}
          accessibilityHint="Opens the notice in your notifications"
          testID={`home-notice-${item.attemptId}`}
        />
      ))}
    </View>
  );
}

function RegistrationRows({
  rows,
  names,
  offeringNames,
  testID,
}: {
  rows: PendingRegistration[];
  names: Map<string, string>;
  offeringNames: Map<string, string>;
  testID: string;
}) {
  return (
    <View accessibilityRole="list">
      {rows.map(({ enrollment, operation, checkout }) => {
        // ENR-02: the enrollment names its offering; older answers fall back to the offering read.
        const offeringName =
          enrollment.offering?.name ?? offeringNames.get(enrollment.offeringId) ?? 'Registration';
        return (
          <ListRow
            key={enrollment.id}
            title={offeringName}
            detail={`For: ${nameOf(names, enrollment.participantPersonId)}`}
            status={enrollmentStatus(enrollment, { offeringName, operation, checkout })}
            testID={`${testID}-${enrollment.id}`}
          />
        );
      })}
    </View>
  );
}

function NextActivitySection({
  item,
  names,
}: {
  item: FamilyCalendarItem;
  names: Map<string, string>;
}) {
  const router = useRouter();
  const { model } = useSessionActivity(item, nameOf(names, item.personId));
  if (!model) return null;
  const href = sessionHref(item);
  const notice = zoneNotice(model.zone, model.start ?? item.start);
  return (
    <>
      <NextActivityCard model={model} onOpen={href ? () => router.push(href as Href) : undefined} />
      {notice ? <Caption>{notice}</Caption> : null}
    </>
  );
}

/** SCR-C-04 for the next fixture: whose it is, opponent, venue, facility clock and RSVP. */
function NextFixtureSection({
  fixture,
  teams,
  names,
  me,
  onReload,
}: {
  fixture: FixtureDetail;
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
  me: Me | undefined;
  onReload: () => void;
}) {
  const router = useRouter();
  const inbox = useInbox();
  const latest = latestChangeForEvent(inbox.data?.items ?? [], fixture.schedulingEventId);
  const viewerId = me?.principal.personId ?? null;
  const requiredAction = fixtureRequiredAction(
    fixture,
    viewerId,
    openAvailabilityRequest(inbox.data?.items ?? [], fixture.id),
  );
  const model = fixtureCardModel({
    fixture,
    teams,
    names,
    change: latest?.change ?? null,
    requiredAction,
  });
  const own = ownResponse(fixture, viewerId);
  const notice = zoneNotice(model.zone, model.start ?? fixture.createdAt);
  return (
    <>
      <NextActivityCard
        model={model}
        rsvp={
          // Keyed by fixture: when the next activity becomes another fixture, its answer and
          // revision never carry over from the previous one (CMP-04, §4.9).
          <RsvpControl
            key={fixture.id}
            fixtureId={fixture.id}
            fixtureStatus={fixture.status}
            myResponse={own?.state ?? fixture.myResponse ?? null}
            responseRevision={own?.revision ?? null}
            onRoster={viewerOnRoster(fixture)}
            onReload={onReload}
          />
        }
        onOpen={() =>
          router.push({ pathname: '/fixtures/[id]', params: { id: fixture.id } } as Href)
        }
        openLabel="View fixture"
      />
      {notice ? <Caption>{notice}</Caption> : null}
    </>
  );
}

function HomeContent() {
  const router = useRouter();
  const now = useNow();
  const zone = displayZone(null);
  const me = useMe();
  const inbox = useInbox();
  const calendar = useCalendarWindow(now, SCHEDULE_WINDOW_DAYS, zone.zone);
  const fixtures = useMyFixtures(calendarWindowQuery(now, 0, SCHEDULE_WINDOW_DAYS, zone.zone));
  const teams = useMyTeams();
  const registrations = usePendingRegistrations(me.data);
  // §4.11, SCR-C-40: only checkouts in recovery, every page of them, so none is missed however
  // many other checkouts the payer has.
  const checkouts = useApiPages({
    path: '/me/registration-checkouts',
    request: { query: { status: 'recovery_required', limit: CHECKOUTS_PAGE } },
    enabled: me.data !== undefined,
  });

  const calendarItems = calendar.data?.items ?? [];
  // A fixture list that is not available to this person is left out without comment (§4.10).
  const fixturesHidden =
    fixtures.error !== null && presentationForError(fixtures.error) === 'unavailable';
  const fixtureList = fixturesHidden ? [] : (fixtures.data ?? []);
  const fixturesSettled = fixtures.data !== undefined || fixtures.error !== null;
  const next = nextEntry(mergeEntries(calendarItems, fixtureList), now);
  const nextTeamMembers =
    next?.type === 'fixture'
      ? (teams.data ?? [])
          .filter(
            (t) =>
              t.teamEntry.id === next.fixture.home.entryId ||
              t.teamEntry.id === next.fixture.away?.entryId,
          )
          .flatMap((t) => t.members.map((m) => m.personId))
      : [];
  const allRegistrations = [
    ...registrations.recovery,
    ...registrations.pending,
    ...registrations.inProgress,
  ];
  const names = usePersonNames(
    [
      ...(next?.type === 'session' ? [next.item.personId] : []),
      ...nextTeamMembers,
      ...allRegistrations.map((r) => r.enrollment.participantPersonId),
      ...(inbox.data?.items ?? []).flatMap((i) => i.subjectPersonIds ?? []),
    ],
    me.data,
  );
  const offerings = useOfferings(
    allRegistrations.filter((r) => !r.enrollment.offering).map((r) => r.enrollment.offeringId),
  );
  const offeringNames = new Map([...offerings].map(([id, o]) => [id, o.name]));

  if (me.data === undefined) {
    return (
      <SectionQueryState
        read={me}
        label="your home"
        unavailable={{
          description:
            'Your account details are not available. Contact the front desk if this continues.',
        }}
      />
    );
  }

  const selfId = me.data.principal.personId ?? null;
  const bySection = new Map<NoticeSection, InboxItem[]>();
  for (const item of inbox.data?.items ?? []) {
    const section = noticeSection(item, now);
    if (!section) continue;
    if (section === 'actions' && availabilityRequestAnswered(item, fixtureList, selfId)) continue;
    bySection.set(section, [...(bySection.get(section) ?? []), item]);
  }
  const unpinnedRecovery = recoveryCheckouts(
    checkouts.data ?? [],
    new Set(registrations.recovery.map((r) => r.enrollment.id)),
  );
  const checkoutsSettled = checkouts.data !== undefined || checkouts.error !== null;
  // A failed read of checkouts in recovery is shown where they would be pinned (§4.11).
  const checkoutsFailed =
    checkouts.data === undefined &&
    checkouts.error !== null &&
    presentationForError(checkouts.error) !== 'unavailable'
      ? checkouts
      : null;
  const urgent = bySection.get('urgent') ?? [];
  const nothingAtAll =
    calendar.data !== undefined &&
    inbox.data !== undefined &&
    fixturesSettled &&
    checkoutsSettled &&
    !checkoutsFailed &&
    !registrations.loading &&
    !next &&
    allRegistrations.length === 0 &&
    unpinnedRecovery.length === 0 &&
    bySection.size === 0;

  const updatedAt = oldestUpdate([
    me.updatedAt,
    inbox.updatedAt,
    calendar.updatedAt,
    fixturesHidden ? null : fixtures.updatedAt,
    registrations.updatedAt,
    checkouts.updatedAt,
  ]);
  const fixturesFailed =
    fixtures.error !== null && !fixturesHidden && fixtures.data === undefined ? fixtures : null;

  return (
    <View testID="home-content">
      <LastUpdated at={updatedAt} now={now} />

      {registrations.recovery.length > 0 || unpinnedRecovery.length > 0 ? (
        <Section title="Registration being completed" testID="home-recovery">
          <Caption>
            Do not pay again. Your payment was received and the facility&apos;s team is completing
            the registration; it will show here as confirmed or with what happens next.
          </Caption>
          <RegistrationRows
            rows={registrations.recovery}
            names={names}
            offeringNames={offeringNames}
            testID="home-recovery-row"
          />
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
        </Section>
      ) : null}
      {checkoutsFailed ? (
        <Section title="Registration being completed" testID="home-recovery-error">
          <Caption>Registrations whose payment is being completed could not be checked.</Caption>
          <SectionQueryState read={checkoutsFailed} label="registrations being completed" />
        </Section>
      ) : null}

      {nothingAtAll ? (
        <StateView
          variant="empty"
          title="Nothing scheduled yet"
          description="Your next activity, changes and the actions you need to take will appear here. Find leagues, programs, camps and more in Discover."
          actionLabel="Open Discover"
          onAction={() => router.push('/discover')}
        />
      ) : null}

      {urgent.length > 0 ? (
        <Section title="Changes affecting you" testID="home-urgent">
          <NoticeRows items={urgent.slice(0, NOTICES_PER_SECTION)} names={names} />
        </Section>
      ) : null}

      {!nothingAtAll ? (
        <Section title="Next activity" testID="home-next">
          <SectionQueryState
            read={calendar}
            label="your next activity"
            unavailable={{ description: 'Your schedule is not available right now.' }}
          />
          {calendar.data !== undefined && next?.type === 'session' ? (
            <NextActivitySection item={next.item} names={names} />
          ) : null}
          {calendar.data !== undefined && next?.type === 'fixture' ? (
            <NextFixtureSection
              fixture={next.fixture}
              teams={teams.data}
              names={names}
              me={me.data}
              onReload={() => void fixtures.refetch()}
            />
          ) : null}
          {fixturesFailed ? (
            <View testID="home-fixtures-error">
              <Caption>Your team fixtures could not be loaded.</Caption>
              <SectionQueryState read={fixturesFailed} label="your fixtures" />
            </View>
          ) : null}
          {calendar.data !== undefined && fixturesSettled && !next ? (
            <StateView
              variant="empty"
              title="No upcoming activities"
              description={`Nothing is scheduled for you, your family or your teams in the next ${SCHEDULE_WINDOW_DAYS} days.`}
              actionLabel="Open Discover"
              onAction={() => router.push('/discover')}
            />
          ) : null}
        </Section>
      ) : null}

      {registrations.pending.length > 0 || (bySection.get('actions') ?? []).length > 0 ? (
        <Section title="Actions required" testID="home-actions">
          <RegistrationRows
            rows={registrations.pending}
            names={names}
            offeringNames={offeringNames}
            testID="home-registration"
          />
          <NoticeRows
            items={(bySection.get('actions') ?? []).slice(0, NOTICES_PER_SECTION)}
            names={names}
          />
        </Section>
      ) : null}
      {registrations.inProgress.length > 0 ? (
        <Section title="Registrations in progress" testID="home-in-progress">
          <RegistrationRows
            rows={registrations.inProgress}
            names={names}
            offeringNames={offeringNames}
            testID="home-in-progress-row"
          />
        </Section>
      ) : null}
      {registrations.error ? (
        <StateView variant="error" error={registrations.error} onRetry={registrations.refetch} />
      ) : null}

      {NOTICE_SECTIONS.filter((s) => s.key !== 'urgent' && s.key !== 'actions').map((s) => {
        const items = bySection.get(s.key) ?? [];
        if (items.length === 0) return null;
        return (
          <Section key={s.key} title={s.title} testID={`home-${s.key}`}>
            <NoticeRows items={items.slice(0, NOTICES_PER_SECTION)} names={names} />
          </Section>
        );
      })}

      {inbox.data === undefined ? (
        <SectionQueryState
          read={inbox}
          label="your notices"
          unavailable={{ description: 'Your notices are not available right now.' }}
        />
      ) : null}
    </View>
  );
}

export function HomeScreen() {
  const router = useRouter();
  return (
    <Screen>
      <View style={styles.quick}>
        <Button
          label="Show facility pass"
          onPress={() => router.push('/pass')}
          testID="home-pass"
        />
        <Button
          label="Open notifications"
          variant="secondary"
          onPress={() => router.push('/inbox')}
          testID="home-inbox"
        />
        <UnreadBadge />
      </View>
      <RequireSession what="your next activity and the actions you need to take">
        <HomeContent />
      </RequireSession>
    </Screen>
  );
}

const styles = StyleSheet.create({
  quick: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
  },
});
