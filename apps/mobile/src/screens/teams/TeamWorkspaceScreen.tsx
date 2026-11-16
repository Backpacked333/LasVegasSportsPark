/**
 * SCR-C-22 Team workspace overview (SPK-CAP-001, SPK-CAP-002, SPK-COMP-004, SPK-SUPPORT-002,
 * DEC-012). Reads `GET /v1/team-entries/{id}`: upcoming games, the team's standing
 * (`GET /v1/seasons/{id}/standings`) and, for the captain, roster readiness as actionable indicators
 * (accepted, invitations and requests waiting, eligibility, team payment) with who resolves each
 * issue, never private family details, payment instruments, sensitive notes or unrelated
 * purchases. Approval, financial status, roster completion and eligibility stay distinct
 * (SPK-COMP-004).
 *
 * Roster players get the reduced view: no captain sections, teammates' names and playing status
 * without eligibility indicators. Which view is shown follows the workspace's `viewer` (CMP-02,
 * see features/teams/queries.ts), and each captain tool is offered only when its action is in
 * `viewer.availableActions`; the API still authorizes every command behind them.
 *
 * Layout (ADR-008, PA-11): a glass hero (`Hero`, liquid glass where the device offers it) with the
 * team, its league, its status and its form, over summary cards: Games, Table, Roster,
 * Availability and Money, then the season and contacting the operating team. Each card leads to
 * its own screen. Pull to refresh reads everything again (`TeamFrame`).
 *
 * The captain contacts the operating team about the team with `POST /v1/me/support-requests`
 * (features/teams/ContactOperations.tsx, SPK-SUPPORT-002). The API allows that to the captain only
 * (team role `captain`, which a co-captain holds only when the rule set lets co-captains act as
 * captain), so the form follows `viewer.actingAsCaptain`; everyone else, a co-captain who may not
 * act as captain included, is pointed to Support. A forms-outstanding indicator is not built and
 * not mentioned on screen: stage 3 left it pending DEC-002 and DEC-028. What captains may see
 * beyond the API's indicators is DEC-012 (pending). A player's own shares ("Your share") are
 * listed by SCR-C-25 (`/team/contributions`, `GET /v1/me/contribution-requests`).
 *
 * A waiting team (SPK-COMP-006, proposed amendment PA-10) shows its wait first: the division, the
 * place in the order, an open offer the captain accepts or declines, and withdrawing from the list
 * (features/teams/TeamWaiting.tsx).
 *
 * Upcoming game times are in the facility's time zone (SPK-SCHED-008): each game's
 * `GET /v1/fixtures/{id}` (the read SCR-C-24 makes for the same games, so it is shared) gives
 * `venue.timezone`; while it loads or if it fails the device's zone is used, always named.
 *
 * Park UI additions (WorkspaceExtras.tsx): the form guide from official results under the team
 * name, mini standings with the playoff line, the next game's availability progress for the
 * management view, and the captain's check-in of their own side for the next scheduled game
 * (`GET`/`POST /v1/fixtures/{id}/attendance`). "Maybe" stays pending DEC-064; the number of players
 * a game needs is not in the API, so no minimum-players warning is shown.
 *
 * States: loading; empty (no fixtures yet); ready; permission restriction (captain-only sections
 * hidden for players; NOT_FOUND is "not available"); stale (refetch on focus, "Updated <time>");
 * offline (cached with age, sending a request disabled); processing and success: the request to
 * the operating team (other commands live on the linked screens).
 */
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDateRange, ordinal, plural } from '../../features/teams/format';
import { TEAM_ACTIONS, type Viewer, type Workspace } from '../../features/teams/queries';
import { idParam, teamRoutes } from '../../features/teams/routes';
import {
  availabilitySummaryText,
  fixtureStatus,
  isCurrentPlayer,
  rosterMemberStatus,
  rsvpStatus,
  teamEntryStatus,
} from '../../features/teams/status';
import { ContactOperations, ContactThroughSupport } from '../../features/teams/ContactOperations';
import { TeamFrame } from '../../features/teams/TeamFrame';
import { TeamWaiting } from '../../features/teams/TeamWaiting';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { FieldValue } from '../../ui/Field';
import { Hero } from '../../ui/Hero';
import { ListRow } from '../../ui/ListRow';
import { ReasonList } from '../../ui/ReasonList';
import { Section } from '../../ui/Section';
import { StatTile } from '../../ui/StatTile';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { makeStyles, spacing } from '../../ui/theme';
import {
  FormGuide,
  MatchCheckIn,
  MiniStandings,
  RsvpProgress,
  useStandings,
} from './WorkspaceExtras';

type Upcoming = Workspace['upcomingFixtures'][number];

export function upcomingTitle(game: Upcoming): string {
  return game.opponent ? `vs ${game.opponent.teamName}` : 'Bye';
}

function upcomingDetail(game: Upcoming, viewer: Viewer): string {
  const where = game.side === 'home' ? 'Home' : 'Away';
  const round = game.fixture.round ? `, round ${game.fixture.round}` : '';
  const answers = viewer.captainView
    ? `. Availability: ${availabilitySummaryText(game.availability)}`
    : viewer.onRoster
      ? `. Your answer: ${rsvpStatus(game.myResponse).label}`
      : '';
  return `${where}${round}${answers}`;
}

/**
 * One upcoming game. The status names the start in the venue's zone from `GET /v1/fixtures/{id}`
 * (SPK-SCHED-008); a game without a venue yet, or whose read failed, uses the device's zone, named.
 */
function UpcomingGameRow({
  game,
  viewer,
  onPress,
}: {
  game: Upcoming;
  viewer: Viewer;
  onPress: () => void;
}) {
  const detail = useApiQuery({
    path: '/fixtures/{id}',
    request: { path: { id: game.fixture.id } },
  });
  return (
    <ListRow
      title={upcomingTitle(game)}
      detail={upcomingDetail(game, viewer)}
      status={fixtureStatus(game.fixture, detail.data?.venue?.timezone)}
      onPress={onPress}
      accessibilityHint="Opens the game"
      testID={`upcoming-${game.fixture.id}`}
    />
  );
}

/** The standing as a stat tile (tabular figures): loading, failed and empty differ (SPK-UX-008). */
function StandingTile({ workspace }: { workspace: Workspace }) {
  const standings = useStandings(workspace);
  const data = standings.data;
  const row = data?.rows.find((r) => r.teamEntryId === workspace.entry.id);
  let value: string;
  let sublabel: string;
  if (data === undefined) {
    [value, sublabel] = standings.error
      ? ['Not shown', 'The standing could not be loaded.']
      : ['…', 'Loading the standing'];
  } else if (!data || !row || data.sourceResultIds.length === 0) {
    [value, sublabel] = ['Not yet', 'No official results yet.'];
  } else {
    value = ordinal(row.position);
    sublabel = `of ${plural(data.rows.length, 'team')}, ${plural(row.points, 'point')}`;
  }
  return (
    <StatTile label="Standing" value={value} sublabel={sublabel} testID="workspace-standing" />
  );
}

/** The captain's roster readiness: actionable indicators, kept apart (SPK-COMP-004). */
function CaptainReadiness({ workspace }: { workspace: Workspace }) {
  const styles = useStyles();
  const r = workspace.readiness;
  return (
    <View style={styles.group} testID="captain-readiness">
      <FieldValue
        layout="inline"
        label="On the roster"
        value={`${r.rosterCount} (minimum ${r.rosterMin}, maximum ${r.rosterMax})`}
      />
      <StatusBadge
        tone={r.rosterComplete ? 'success' : 'warning'}
        label={r.rosterComplete ? 'Roster complete' : 'Roster not complete'}
      />
      <FieldValue
        layout="inline"
        label="Eligible players"
        value={`${r.eligiblePlayers} of ${r.rosterCount}`}
      />
      <FieldValue
        layout="inline"
        label="Invitations waiting"
        value={String(r.pendingInvitations)}
      />
      <FieldValue
        layout="inline"
        label="Join requests waiting"
        value={String(r.pendingJoinRequests)}
      />
      {r.issues.length > 0 ? (
        <ReasonList reasons={r.issues} testID="readiness-issues" />
      ) : (
        <Text variant="body">Nothing needs your attention.</Text>
      )}
    </View>
  );
}

function ReducedRoster({ workspace, now }: { workspace: Workspace; now: Date }) {
  const players = workspace.roster.filter((m) => isCurrentPlayer(m, now));
  return (
    <View testID="reduced-roster">
      {players.length === 0 ? (
        <Text variant="body">No players on the roster yet.</Text>
      ) : (
        <View accessibilityRole="list" accessibilityLabel="Teammates">
          {players.map((m) => (
            <ListRow key={m.id} title={m.displayName} status={rosterMemberStatus(m, now)} />
          ))}
        </View>
      )}
    </View>
  );
}

export function WorkspaceContent({ workspace, viewer }: { workspace: Workspace; viewer: Viewer }) {
  const router = useRouter();
  const styles = useStyles();
  const now = useNow();
  const queryClient = useQueryClient();
  const entryId = workspace.entry.id;
  const games = workspace.upcomingFixtures;
  const next = games[0];
  const reload = () =>
    void queryClient.invalidateQueries({ queryKey: ['api', '/team-entries/{id}'] });
  const toAvailability = () => router.push(teamRoutes.availability(entryId));
  return (
    <View>
      <Hero
        tone="pitch"
        eyebrow={[workspace.division?.name, workspace.season.name].filter(Boolean).join(' · ')}
        title={workspace.team.name}
      >
        <StatusBadge {...teamEntryStatus(workspace.entry)} testID="entry-status" />
        <FormGuide workspace={workspace} />
      </Hero>
      <TeamWaiting workspace={workspace} onReload={reload} />

      <Section title="Games" testID="workspace-games">
        {games.length === 0 ? (
          <Text variant="body">
            No games yet. They appear here once the league publishes the schedule.
          </Text>
        ) : (
          <View accessibilityRole="list">
            {games.map((game) => (
              <UpcomingGameRow
                key={game.fixture.id}
                game={game}
                viewer={viewer}
                onPress={() => router.push(`/fixtures/${game.fixture.id}` as Href)}
              />
            ))}
          </View>
        )}
        {viewer.actingAsCaptain && next?.fixture.status === 'scheduled' ? (
          <View style={styles.group} testID="check-in-section">
            <Text variant="headline" heading>
              Match sheet check-in
            </Text>
            <Text variant="caption" tone="muted">{`Next game: ${upcomingTitle(next)}`}</Text>
            <MatchCheckIn workspace={workspace} viewer={viewer} game={next} />
          </View>
        ) : null}
      </Section>

      <Section
        title="Table"
        action={{
          label: 'See all',
          accessibilityLabel: 'Standings and results',
          onPress: () => router.push(teamRoutes.standings(entryId)),
        }}
        testID="workspace-table"
      >
        <StandingTile workspace={workspace} />
        <MiniStandings workspace={workspace} />
      </Section>

      <Section title="Roster" testID="workspace-roster">
        {viewer.captainView ? (
          <>
            <CaptainReadiness workspace={workspace} />
            <View style={styles.buttons}>
              <Button
                label="Roster and invitations"
                onPress={() => router.push(teamRoutes.roster(entryId))}
                variant="secondary"
                accessibilityHint="Invitations, join requests, the roster and the captain role"
              />
              {viewer.can(TEAM_ACTIONS.manageRoster) ? (
                <Button
                  label="Roster change or substitute"
                  onPress={() => router.push(teamRoutes.rosterChange(entryId))}
                  variant="secondary"
                />
              ) : null}
            </View>
          </>
        ) : (
          <ReducedRoster workspace={workspace} now={now} />
        )}
      </Section>

      <Section title="Availability" testID="workspace-availability">
        {viewer.captainView && next ? <RsvpProgress game={next} /> : null}
        <Button
          label={viewer.captainView ? 'Availability' : 'Answer availability'}
          onPress={toAvailability}
          variant="secondary"
          accessibilityHint="Opens the answers for this team's games"
        />
      </Section>

      <Section title="Money" testID="workspace-money">
        {viewer.captainView ? (
          <>
            <FieldValue
              layout="inline"
              label="Team payment"
              value={
                workspace.readiness.financialStatusRef
                  ? 'Recorded: see Team contributions'
                  : 'Nothing recorded yet'
              }
            />
            <Button
              label="Team contributions"
              onPress={() => router.push(teamRoutes.contributions(entryId))}
              variant="secondary"
              accessibilityHint="The team's totals and the shares asked of players"
            />
          </>
        ) : (
          // SCR-C-25: the player's own shares (GET /v1/me/contribution-requests).
          <Button
            label="Your share"
            onPress={() => router.push(teamRoutes.myContributions())}
            variant="secondary"
            accessibilityHint="Lists what you were asked to pay for the team, with your own payments only"
          />
        )}
      </Section>

      <Section title="Season" testID="workspace-season">
        <FieldValue
          layout="inline"
          label="Season"
          value={`${workspace.season.name}, ${formatDateRange(workspace.season.startsOn, workspace.season.endsOn)}`}
        />
        <FieldValue
          layout="inline"
          label="Division"
          value={workspace.division?.name ?? 'Not placed in a division yet'}
        />
        <FieldValue
          layout="inline"
          label="Rule set"
          value={`${workspace.ruleSet.name}, version ${workspace.ruleSet.version}`}
        />
        <Text variant="caption" tone="muted">
          Approval, team payment, roster completion and eligibility are tracked separately: an
          approved team is not necessarily paid or complete.
        </Text>
        {viewer.captainView && viewer.can(TEAM_ACTIONS.renew) ? (
          <Button
            label="Renew for a new season"
            onPress={() => router.push(teamRoutes.renewEntry(entryId))}
            variant="secondary"
            accessibilityHint="Starts a new season entry; this season's records stay as they are"
          />
        ) : null}
      </Section>

      <Section title="Contact the operating team">
        {/* SUP-01: the API allows a team request to the captain only (see the header). */}
        {viewer.actingAsCaptain ? (
          <ContactOperations workspace={workspace} />
        ) : (
          <ContactThroughSupport />
        )}
      </Section>
    </View>
  );
}

export function TeamWorkspaceScreen({ entryId }: { entryId: string | null }) {
  return (
    <TeamFrame
      entryId={entryId}
      what="this team"
      unavailableOffline={['availability answers', 'invitations', 'roster changes']}
    >
      {(ws, viewer) => <WorkspaceContent workspace={ws} viewer={viewer} />}
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/index.tsx. */
export function TeamWorkspaceRoute() {
  const entryId = idParam(useLocalSearchParams<{ entryId: string }>().entryId);
  return (
    <>
      <Stack.Screen options={{ title: 'Team' }} />
      <TeamWorkspaceScreen entryId={entryId} />
    </>
  );
}

const useStyles = makeStyles(() => ({
  group: { gap: spacing.sm },
  buttons: { gap: spacing.sm, paddingTop: spacing.xs },
}));
