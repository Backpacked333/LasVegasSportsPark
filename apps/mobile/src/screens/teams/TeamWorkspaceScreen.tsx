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
 * The captain contacts the operating team about the team with `POST /v1/me/support-requests`
 * (features/teams/ContactOperations.tsx, SPK-SUPPORT-002). The API allows that to the captain only
 * (team role `captain`, which a co-captain holds only when the rule set lets co-captains act as
 * captain), so the form follows `viewer.actingAsCaptain`; everyone else, a co-captain who may not
 * act as captain included, is pointed to Support. A forms-outstanding indicator is not built:
 * stage 3 left it pending DEC-002 and DEC-028. What captains may see beyond the API's indicators
 * is DEC-012 (pending). A player's own contribution requests are listed by SCR-C-25
 * (`/team/contributions`, `GET /v1/me/contribution-requests`).
 *
 * Upcoming game times are in the facility's time zone (SPK-SCHED-008): each game's
 * `GET /v1/fixtures/{id}` (the read SCR-C-24 makes for the same games, so it is shared) gives
 * `venue.timezone`; while it loads or if it fails the device's zone is used, always named.
 *
 * States: loading; empty (no fixtures yet); ready; permission restriction (captain-only sections
 * hidden for players; NOT_FOUND is "not available"); stale (refetch on focus, "Updated <time>");
 * offline (cached with age, sending a request disabled); processing and success: the request to
 * the operating team (other commands live on the linked screens).
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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
import { Body, ButtonRow, Detail, ReasonList, Section, Title } from '../../features/teams/ui';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

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
      accessibilityHint="Opens availability for this team's games"
      testID={`upcoming-${game.fixture.id}`}
    />
  );
}

function StandingSummary({ workspace }: { workspace: Workspace }) {
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: {
      path: { id: workspace.season.id },
      query: workspace.division ? { divisionId: workspace.division.id } : {},
    },
  });
  const data = standings.data;
  const row = data?.rows.find((r) => r.teamEntryId === workspace.entry.id);
  let text: string;
  if (data === undefined) {
    text = standings.error ? 'The standing could not be loaded.' : 'Loading the standing…';
  } else if (!data || !row || data.sourceResultIds.length === 0) {
    text = 'No official results yet.';
  } else {
    text = `${ordinal(row.position)} of ${data.rows.length}, ${plural(row.points, 'point')}`;
  }
  return <Detail label="Standing" value={text} testID="workspace-standing" />;
}

function CaptainReadiness({ workspace }: { workspace: Workspace }) {
  const r = workspace.readiness;
  return (
    <Section title="Roster readiness" testID="captain-readiness">
      <Detail
        label="On the roster"
        value={`${r.rosterCount} (minimum ${r.rosterMin}, maximum ${r.rosterMax})`}
      />
      <StatusBadge
        tone={r.rosterComplete ? 'success' : 'warning'}
        label={r.rosterComplete ? 'Roster complete' : 'Roster not complete'}
      />
      <Detail label="Eligible players" value={`${r.eligiblePlayers} of ${r.rosterCount}`} />
      <Detail label="Invitations waiting" value={String(r.pendingInvitations)} />
      <Detail label="Join requests waiting" value={String(r.pendingJoinRequests)} />
      <Detail
        label="Team payment"
        value={
          r.financialStatusRef ? 'Recorded: see Team contributions' : 'No obligation recorded yet'
        }
      />
      <Detail
        label="Forms outstanding"
        value="Not shown: waiting on a decision (DEC-002, DEC-028)"
      />
      {r.issues.length > 0 ? (
        <ReasonList reasons={r.issues} testID="readiness-issues" />
      ) : (
        <Body>Nothing needs your attention.</Body>
      )}
    </Section>
  );
}

function ReducedRoster({ workspace, now }: { workspace: Workspace; now: Date }) {
  const players = workspace.roster.filter((m) => isCurrentPlayer(m, now));
  return (
    <Section title="Teammates" testID="reduced-roster">
      {players.length === 0 ? (
        <Body>No players on the roster yet.</Body>
      ) : (
        <View accessibilityRole="list">
          {players.map((m) => (
            <ListRow key={m.id} title={m.displayName} status={rosterMemberStatus(m, now)} />
          ))}
        </View>
      )}
    </Section>
  );
}

export function WorkspaceContent({ workspace, viewer }: { workspace: Workspace; viewer: Viewer }) {
  const router = useRouter();
  const now = useNow();
  const entryId = workspace.entry.id;
  const games = workspace.upcomingFixtures;
  return (
    <View>
      <Title>{workspace.team.name}</Title>
      <Section title="Season">
        <Detail
          label="Season"
          value={`${workspace.season.name}, ${formatDateRange(workspace.season.startsOn, workspace.season.endsOn)}`}
        />
        <Detail
          label="Division"
          value={workspace.division?.name ?? 'Not placed in a division yet'}
        />
        <Detail
          label="Rule set"
          value={`${workspace.ruleSet.name}, version ${workspace.ruleSet.version}`}
        />
        <StatusBadge {...teamEntryStatus(workspace.entry)} testID="entry-status" />
        <Body muted>
          Approval, team payment, roster completion and eligibility are tracked separately: an
          approved entry is not necessarily paid or complete.
        </Body>
      </Section>

      <Section title="Upcoming games">
        {games.length === 0 ? (
          <Body>No games yet. They appear here once the league publishes the schedule.</Body>
        ) : (
          <View accessibilityRole="list">
            {games.map((game) => (
              <UpcomingGameRow
                key={game.fixture.id}
                game={game}
                viewer={viewer}
                onPress={() => router.push(teamRoutes.availability(entryId))}
              />
            ))}
          </View>
        )}
      </Section>

      <Section title="Standings">
        <StandingSummary workspace={workspace} />
        <Button
          label="Standings and results"
          onPress={() => router.push(teamRoutes.standings(entryId))}
          variant="secondary"
        />
      </Section>

      {viewer.captainView ? <CaptainReadiness workspace={workspace} /> : null}

      {viewer.captainView ? (
        <Section title="Captain tools">
          <ButtonRow>
            <Button
              label="Roster and invitations"
              onPress={() => router.push(teamRoutes.roster(entryId))}
              variant="secondary"
              accessibilityHint="Invitations, join requests, the roster and the captain role"
            />
            <Button
              label="Availability"
              onPress={() => router.push(teamRoutes.availability(entryId))}
              variant="secondary"
            />
            <Button
              label="Team contributions"
              onPress={() => router.push(teamRoutes.contributions(entryId))}
              variant="secondary"
            />
            {viewer.can(TEAM_ACTIONS.manageRoster) ? (
              <Button
                label="Roster change or substitute"
                onPress={() => router.push(teamRoutes.rosterChange(entryId))}
                variant="secondary"
              />
            ) : null}
            {viewer.can(TEAM_ACTIONS.renew) ? (
              <Button
                label="Renew for a new season"
                onPress={() => router.push(teamRoutes.renewEntry(entryId))}
                variant="secondary"
                accessibilityHint="Starts a new season entry; this season's records stay as they are"
              />
            ) : null}
          </ButtonRow>
        </Section>
      ) : (
        <>
          <Section title="Your team">
            <ButtonRow>
              <Button
                label="Answer availability"
                onPress={() => router.push(teamRoutes.availability(entryId))}
                variant="secondary"
              />
              {/* SCR-C-25: the player's own contribution requests (GET /v1/me/contribution-requests). */}
              <Button
                label="Your contributions"
                onPress={() => router.push(teamRoutes.myContributions())}
                variant="secondary"
                accessibilityHint="Lists the team contributions asked of you, with your own payments only"
              />
            </ButtonRow>
          </Section>
          <ReducedRoster workspace={workspace} now={now} />
        </>
      )}

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
