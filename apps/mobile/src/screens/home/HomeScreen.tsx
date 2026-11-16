/**
 * SCR-C-03 Home (SPK-UX-002, SPK-UX-003, SPK-UX-004, SPK-COMMS-005, SPK-UX-008, SPK-UX-009;
 * PA-11 SPK-UX-011 **Proposed** plain words; ADR-008 visual system v2).
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
 * payment found on refresh"); a failed read of it shows its failure where it would be pinned, and
 * Home is never called empty before it answers. "Payment outstanding" is said only once the
 * basket was read and no checkout runs (SPK-PAY-007). An `availability_request` notice (COM-06)
 * is an action until its fixture starts or everyone it is for has answered; the game card names
 * it as its required action. Each section has its own state; the page states the age of what it
 * shows (§4.15) and the SCR-C-40 banner covers connectivity. A fixture read that is not available
 * (NOT_FOUND, ACCESS_DENIED) leaves fixtures out silently; any other failure is shown in the
 * next-activity section with "Try again" (its code in "Details for support").
 *
 * Look (ADR-008), top to bottom:
 * 1. The greeting over the day or night band (`GreetingBand`); the cart, pass and inbox are the
 *    tab header's actions above it.
 * 2. The pinned recovery as a warning card.
 * 3. "Changes affecting you", then **Up next**: a hero `MediaCard` with the change, the required
 *    action and, for a game, "Going / Not going" beside it (`UpNext`).
 * 4. **Needs you**: one card of up to three single-verb rows that open their item (`NeedsYou`).
 * 5. Quick actions: Pass, Calendar, Explore, and Pay while an amount is due (`QuickActions`).
 * 6. "Family this week" and "My team", in the order `homeLayout()` decides (`PersonBlocks`).
 * 7. Results and renewals as a carousel (`FollowUp`), then "Picked for" (`HomePickedFor`).
 * With nothing at all: "You're all caught up" with the empty-home illustration. Pulling the page
 * down reads everything on it again.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { illustrations } from '../../artwork/manifest';
import { registrationRoutes } from '../../features/registration/routes';
import { calendarWindowQuery } from '../../features/today/calendar';
import { entryPersonIds, mergeEntries, nextEntry } from '../../features/today/entries';
import { noticeTarget } from '../../features/today/notice-target';
import {
  availabilityRequestOf,
  noticeSection,
  type NoticeSection,
} from '../../features/today/notices';
import {
  nameOf,
  SCHEDULE_WINDOW_DAYS,
  useCalendarWindow,
  useInbox,
  useMe,
  useMyFixtures,
  useMyTeams,
  useOfferings,
  usePersonNames,
  useSignedIn,
} from '../../features/today/queries';
import { oldestUpdate, SectionQueryState } from '../../features/today/read-state';
import { RECOVERY_PHRASE } from '../../features/today/status';
import { displayZone } from '../../features/today/time';
import { useApp, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { EmptyState } from '../../ui/EmptyState';
import { InfoCard } from '../../ui/InfoCard';
import { LastUpdated } from '../../ui/LastUpdated';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';
import { FollowUp } from './FollowUp';
import { GreetingBand } from './GreetingBand';
import { homeLayout, type HomeBlock } from './home-layout';
import { HomePickedFor, pickedForPerson } from './HomePickedFor';
import { NeedsYou, NoticeRow, RegistrationRow } from './NeedsYou';
import { usePendingRegistrations } from './pending-registrations';
import { FamilyThisWeek, MyTeam } from './PersonBlocks';
import { QuickActions } from './QuickActions';
import { UpNextFixture, UpNextSession } from './UpNext';

export { noticeFor } from './open-notice';

type InboxItem = Schema<'InboxItem'>;
type FixtureDetail = Schema<'FixtureDetail'>;
type Checkout = Schema<'Checkout'>;

/** Checkouts in `recovery_required` per page (FIN-01 `status` filter); "Load more" follows the cursor. */
const CHECKOUTS_PAGE = 20;

/** How many notices "Changes affecting you" shows before the inbox. */
const URGENT_SHOWN = 3;

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

/** Where the Pay quick action goes: the first action notice about an amount due, or none. */
export function payTarget(actions: readonly InboxItem[]): Href | null {
  const due = actions.find(
    (item) => item.kind === 'payment_attention' && noticeTarget(item).kind === 'subject',
  );
  return due ? (noticeTarget(due).href as Href) : null;
}

function HomeContent() {
  const router = useRouter();
  const styles = useStyles();
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
  const upcoming = mergeEntries(calendarItems, fixtureList).filter(
    (e) => new Date(e.end).getTime() > now.getTime(),
  );
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
  const selfId = me.data?.principal.personId ?? null;
  const familyIds = (calendar.data?.participantPersonIds ?? []).filter((id) => id !== selfId);
  const pickedFor = pickedForPerson(me.data);
  const names = usePersonNames(
    [
      ...(next?.type === 'session' ? [next.item.personId] : []),
      ...familyIds,
      ...nextTeamMembers,
      ...allRegistrations.map((r) => r.enrollment.participantPersonId),
      ...(inbox.data?.items ?? []).flatMap((i) => i.subjectPersonIds ?? []),
      ...(pickedFor ? [pickedFor] : []),
    ],
    me.data,
  );
  const offerings = useOfferings(
    allRegistrations.filter((r) => !r.enrollment.offering).map((r) => r.enrollment.offeringId),
  );
  const offeringNames = new Map([...offerings].map(([id, o]) => [id, o.name]));

  // The quick actions keep their place (the second child) while the account loads and after, so
  // the same buttons stay mounted and a press during loading is never lost.
  if (me.data === undefined) {
    return (
      <View>
        <SectionQueryState
          read={me}
          label="your home"
          unavailable={{
            description:
              'Your account details are not available. Contact the front desk if this continues.',
          }}
        />
        <QuickActions />
      </View>
    );
  }

  const bySection = new Map<NoticeSection, InboxItem[]>();
  for (const item of inbox.data?.items ?? []) {
    const section = noticeSection(item, now);
    if (!section) continue;
    if (section === 'actions' && availabilityRequestAnswered(item, fixtureList, selfId)) continue;
    bySection.set(section, [...(bySection.get(section) ?? []), item]);
  }
  const notices = (section: NoticeSection) => bySection.get(section) ?? [];
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
  const urgent = notices('urgent');
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

  // "Family this week" for a parent, "My team" for a player, the sooner one first (homeLayout).
  const myTeams = (teams.data ?? []).filter(
    (t) => selfId !== null && t.members.some((m) => m.personId === selfId),
  );
  const familySoonest =
    upcoming.find((e) => entryPersonIds(e, teams.data).some((id) => familyIds.includes(id)))
      ?.start ?? null;
  const teamSoonest =
    myTeams
      .map((t) => t.nextFixture?.scheduledStart ?? null)
      .filter((s): s is string => !!s)
      .sort()[0] ?? null;
  const blocks = homeLayout({
    family: familyIds.length > 0 ? { soonest: familySoonest } : null,
    team: myTeams.length > 0 ? { soonest: teamSoonest } : null,
  });
  const block = (kind: HomeBlock) =>
    kind === 'family' ? (
      <FamilyThisWeek
        key="family"
        personIds={familyIds}
        entries={upcoming}
        teams={teams.data}
        names={names}
        now={now}
      />
    ) : (
      <MyTeam key="team" teams={myTeams} />
    );

  return (
    <View testID="home-content">
      <>
        <LastUpdated at={updatedAt} now={now} />

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

        {nothingAtAll ? (
          <EmptyState
            source={illustrations['empty-home']}
            title="You're all caught up"
            message="Your next activity, changes and anything you need to do will show up here."
            action={{ label: 'Explore activities', onPress: () => router.push('/discover') }}
            testID="home-empty"
          />
        ) : null}

        {urgent.length > 0 ? (
          <Section title="Changes affecting you" testID="home-urgent">
            <View accessibilityRole="list">
              {urgent.slice(0, URGENT_SHOWN).map((item) => (
                <NoticeRow key={item.attemptId} item={item} names={names} />
              ))}
            </View>
          </Section>
        ) : null}

        {!nothingAtAll ? (
          <Section title="Up next" variant="carousel" testID="home-next">
            <SectionQueryState
              read={calendar}
              label="your next activity"
              unavailable={{ description: 'Your schedule is not available right now.' }}
            />
            {calendar.data !== undefined && next?.type === 'session' ? (
              <UpNextSession item={next.item} names={names} />
            ) : null}
            {calendar.data !== undefined && next?.type === 'fixture' ? (
              <UpNextFixture
                fixture={next.fixture}
                teams={teams.data}
                names={names}
                me={me.data}
                onReload={() => void fixtures.refetch()}
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
            {calendar.data !== undefined && fixturesSettled && !next ? (
              <StateView
                variant="empty"
                title="Nothing coming up"
                description={`Nothing is scheduled for you, your family or your teams in the next ${SCHEDULE_WINDOW_DAYS} days.`}
                actionLabel="Explore activities"
                onAction={() => router.push('/discover')}
              />
            ) : null}
          </Section>
        ) : null}

        <NeedsYou
          registrations={registrations.pending}
          actions={notices('actions')}
          invitations={notices('invitations')}
          names={names}
          offeringNames={offeringNames}
        />
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
      </>

      <QuickActions pay={payTarget(notices('actions'))} />

      <>
        {blocks.map(block)}

        <FollowUp results={notices('results')} renewals={notices('renewals')} names={names} />

        {pickedFor ? <HomePickedFor personId={pickedFor} name={nameOf(names, pickedFor)} /> : null}

        {inbox.data === undefined ? (
          <SectionQueryState
            read={inbox}
            label="your notices"
            unavailable={{ description: 'Your notices are not available right now.' }}
          />
        ) : null}
      </>
    </View>
  );
}

export function HomeScreen() {
  const signedIn = useSignedIn();
  const signedOut = useApp().session.status === 'signed_out';
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // Pull to refresh: every read on the page again, as the connectivity banner's "Refresh" does.
  const refresh = () => {
    setRefreshing(true);
    void queryClient.refetchQueries({ type: 'active' }).finally(() => setRefreshing(false));
  };
  return (
    <Screen onRefresh={signedIn ? refresh : undefined} refreshing={refreshing}>
      <GreetingBand />
      <RequireSession what="your next activity and the actions you need to take">
        <HomeContent />
      </RequireSession>
      {/* Signed out, the pass is still one tap away; signed in, the content places the actions. */}
      {signedOut ? <QuickActions /> : null}
    </Screen>
  );
}

const useStyles = makeStyles(() => ({
  gutter: { paddingHorizontal: layout.gutter, marginTop: spacing.sm },
  stack: { gap: spacing.sm },
}));
