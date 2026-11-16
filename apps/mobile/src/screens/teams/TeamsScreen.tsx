/**
 * SCR-C-21 Teams, the fourth destination (SPK-UX-002, SPK-CAP-001, SPK-CAP-002, SPK-COMP-001;
 * PA-11 SPK-UX-011 **Proposed** customer words; ADR-008 visual system v2).
 *
 * - **Invitations first.** Team invitations still open for the person (`GET /v1/me/team-invitations`,
 *   CMP-03) come before the teams, each with Accept and Decline. Accepting needs the token from the
 *   invitation link, so "Accept" opens the invitation's own detail (SCR-C-17, by id only, §4.14),
 *   where the link's token is used. "Decline" asks once, then sends
 *   `POST /v1/team-invitations/{id}/decline` with the revision read under one idempotency key.
 *   With no open invitation the section is not shown.
 * - **Team cards.** The live teams the signed-in person and the people they may view are on
 *   (`GET /v1/me/team-entries`, CMP-02), each as a picture card (`MediaCard`, `artworkFor`) that
 *   opens the team. The card's one name is the team, its season and division, the next game (on
 *   the facility's clock, SPK-SCHED-008) and its status: the next game's readiness as the API counts
 *   it, with approval kept distinct (SPK-COMP-004). Beside it, as their own elements: who of the
 *   family is on the team and in which role (`AvatarStack`), the official standing as a `StatTile`
 *   (`GET /v1/seasons/{id}/standings`) and the next game's RSVP quick action (`RsvpInline` over
 *   `GET /v1/fixtures/{id}`: the same requests, keys and revisions as the game screen), offered
 *   only while the game takes answers and the person is on its roster.
 * - **Your share.** What a captain asked the person to pay of a team fee
 *   (`GET /v1/me/contribution-requests`, the same read as Home), under the cards: the API does not
 *   say which team a request belongs to, so it is not put on a card.
 * - Renewing starts from last season's team (SCR-C-22), which is why approved entries of past
 *   seasons stay listed (each card names its season); entering a new team is SCR-C-27.
 *
 * The API decides which teams and which people each viewer sees (§4.10, SPK-CAP-002); family
 * members are named through `GET /v1/person-names` (given names only, §4.14) and never put in a
 * route or a log. The list is a FlatList (list mode) with pull to refresh.
 *
 * States: loading; empty (no teams: an illustration, how to join, "Enter a new team"); ready;
 * validation failure: not applicable; permission restriction (the API lists only what the viewer
 * may see; a refused decline is "not available"); stale version (refetch on focus and on pull,
 * "Updated <time>"; a decline of an invitation answered meanwhile reloads it); offline (cached
 * with age, decline and answers disabled); processing (declining, answering); success
 * ("Declined", "Answer recorded"); partial completion: not permitted; recovery required: not
 * applicable, a failed read shows its code with "Try again".
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { usePersonNames, type PersonNameEntry } from '../../api/person-names';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { artworkFor } from '../../artwork/artworkFor';
import { illustrations } from '../../artwork/manifest';
import { formatInstant, formatMoney, ordinal, plural } from '../../features/teams/format';
import {
  MY_TEAMS_KEY,
  useMe,
  useMyTeamEntries,
  type MyTeamEntry,
} from '../../features/teams/queries';
import { usePullToRefresh } from '../../features/teams/refresh';
import { teamRoutes } from '../../features/teams/routes';
import { invitationStatus, teamEntryStatus } from '../../features/teams/status';
import { CommandError } from '../../ui/CommandError';
import { ownResponse, viewerOnRoster } from '../../features/today/fixture-model';
import { RsvpInline } from '../../features/today/RsvpInline';
import { fixtureAcceptsRsvp, type RsvpState } from '../../features/today/status';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveRegion } from '../../ui/announce';
import { AvatarStack, type AvatarPerson } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { MediaCard } from '../../ui/MediaCard';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StatTile } from '../../ui/StatTile';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

type ReadinessCounts = Schema<'ReadinessCounts'>;
type Member = MyTeamEntry['members'][number];
type TeamInvitationView = Schema<'TeamInvitationView'>;

const INVITATIONS_KEY = ['api', '/me/team-invitations'] as const;
const INVITATION_PAGE = 20;

/** The in-app route of a team invitation's detail (SCR-C-17): ids only, never a token (§4.14). */
export function teamInvitationRoute(id: string): string {
  return `/invitations/${id}?type=team`;
}

/**
 * The next game's readiness as the API counts it (SPK-READY-001): never a guess, and "unknown"
 * stays distinct from "ready" (SPK-READY-002).
 */
export function readinessStatus(readiness: ReadinessCounts): StatusBadgeProps {
  switch (readiness.status) {
    case 'ready':
      return { tone: 'success', label: 'Next game: ready' };
    case 'warning':
      return { tone: 'warning', label: 'Next game: ready, with warnings' };
    case 'unknown':
      return {
        tone: 'pending',
        label: `Next game: readiness not known yet${readiness.unknownCount > 0 ? ` (${plural(readiness.unknownCount, 'item')} to confirm)` : ''}`,
      };
    case 'blocked':
      return {
        tone: 'danger',
        label: `Next game: ${plural(readiness.blockingCount, 'issue')} to resolve`,
      };
  }
}

/** A member's part on the team in words: captain first, then the playing status. */
export function memberRoleWords(member: Pick<Member, 'roles' | 'rosterStatus'>): string {
  if (member.roles.includes('captain')) return 'captain';
  if (member.roles.includes('co_captain')) return 'co-captain';
  switch (member.rosterStatus) {
    case 'active':
      return 'player';
    case 'guest':
      return 'guest player';
    case 'substitute':
      return 'substitute';
    default:
      return 'team member';
  }
}

function nameOf(entry: PersonNameEntry | undefined): string {
  if (entry?.state === 'ready') return entry.name.givenName || entry.name.displayName;
  if (entry?.state === 'loading' || entry === undefined) return 'Loading name';
  return 'Family member';
}

/** The viewer first, then the others in the API's order. */
function viewerFirst(members: readonly Member[], viewerId: string | null): Member[] {
  return [...members].sort((a, b) =>
    a.personId === viewerId ? -1 : b.personId === viewerId ? 1 : 0,
  );
}

/** Who of the family is on the team, in words: the avatar stack's name. */
export function membersText(
  members: readonly Member[],
  viewerId: string | null,
  names: ReadonlyMap<string, PersonNameEntry>,
): string {
  const parts = viewerFirst(members, viewerId).map(
    (m) =>
      `${m.personId === viewerId ? 'You' : nameOf(names.get(m.personId))} (${memberRoleWords(m)})`,
  );
  return parts.length > 0 ? `On the team: ${parts.join(', ')}` : 'On the team';
}

function nextGameText(team: MyTeamEntry): string {
  const next = team.nextFixture;
  if (!next) return 'No upcoming games';
  const opponent = next.opponentTeamName ? `vs ${next.opponentTeamName}` : 'Bye';
  const when = next.scheduledStart
    ? formatInstant(next.scheduledStart, next.venue?.timezone)
    : 'time not set yet';
  const where = next.venue ? ` at ${next.venue.facilityName}` : '';
  return `Next: ${opponent}, ${when}${where}`;
}

/** The card's status: the next game's readiness, else the entry's own status. */
function cardStatus(team: MyTeamEntry): StatusBadgeProps {
  return team.nextFixture
    ? readinessStatus(team.nextFixture.readiness)
    : teamEntryStatus(team.teamEntry);
}

/**
 * The card's one name (SPK-UX-009): team, season and division, the next game, and the status.
 * Approval stays distinct from readiness (SPK-COMP-004): with a next game the status is the game's
 * readiness, so an entry not (yet) approved says so before it.
 */
export function teamCardLabel(team: MyTeamEntry): string {
  const entry = team.teamEntry;
  const league = `${team.seasonName}${team.divisionName ? `, ${team.divisionName}` : ''}`;
  const approval =
    team.nextFixture && entry.status !== 'approved' ? `. ${teamEntryStatus(entry).label}` : '';
  return `${team.teamName}, ${league}. ${nextGameText(team)}${approval}, ${cardStatus(team).label}`;
}

/** The standing tile's words: loading, a failed read and an empty table differ (SPK-UX-008). */
export interface StandingWords {
  value: string;
  sublabel: string;
}

function useStanding(team: MyTeamEntry): StandingWords {
  const divisionId = team.teamEntry.divisionId;
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: { path: { id: team.seasonId }, query: divisionId ? { divisionId } : {} },
  });
  const data = standings.data;
  if (data === undefined) {
    return standings.error
      ? { value: 'Not shown', sublabel: 'Could not be loaded' }
      : { value: '…', sublabel: 'Loading' };
  }
  const row = data?.rows.find((r) => r.teamEntryId === team.teamEntry.id);
  if (!data || !row || data.sourceResultIds.length === 0) {
    return { value: 'Not yet', sublabel: 'No official results' };
  }
  return { value: ordinal(row.position), sublabel: `of ${plural(data.rows.length, 'team')}` };
}

/**
 * The next game's RSVP quick action: the game's own read (`GET /v1/fixtures/{id}`, shared with
 * the game screen) gives the answer, its revision and whether the person is on the roster. Shown
 * only while the game takes answers and the person may answer; the game screen says the rest.
 */
function NextGameAnswer({
  fixtureId,
  viewerId,
  teamName,
}: {
  fixtureId: string;
  viewerId: string | null;
  teamName: string;
}) {
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  const detail = fixture.data;
  if (!detail || viewerId === null) return null;
  const onRoster = viewerOnRoster(detail);
  if (onRoster === false || !fixtureAcceptsRsvp(detail.status)) return null;
  const own = ownResponse(detail, viewerId);
  return (
    <RsvpInline
      // Keyed by game: a new next game never inherits the previous one's answer or revision.
      key={detail.id}
      fixtureId={detail.id}
      fixtureStatus={detail.status}
      myResponse={(own?.state ?? detail.myResponse ?? null) as RsvpState | null}
      responseRevision={own?.revision ?? null}
      onRoster={onRoster}
      onReload={() => void fixture.refetch()}
      // Each team card has its own group: its name says whose game it is.
      label={`Are you going to the next ${teamName} game?`}
    />
  );
}

function TeamCard({
  team,
  viewerId,
  viewerName,
  names,
}: {
  team: MyTeamEntry;
  viewerId: string | null;
  viewerName: string | null;
  names: ReadonlyMap<string, PersonNameEntry>;
}) {
  const router = useRouter();
  const styles = useStyles();
  const standing = useStanding(team);
  const entry = team.teamEntry;
  const people: AvatarPerson[] = viewerFirst(team.members, viewerId).map((m) => ({
    id: m.personId,
    name: m.personId === viewerId ? (viewerName ?? 'You') : nameOf(names.get(m.personId)),
  }));
  const art = artworkFor(
    { kind: 'team_entry', name: team.teamName, title: team.divisionName },
    'wide',
  );
  return (
    <MediaCard
      form="hero"
      source={art.source}
      eyebrow={`${team.seasonName}${team.divisionName ? ` · ${team.divisionName}` : ''}`}
      title={team.teamName}
      meta={[nextGameText(team)]}
      tags={[cardStatus(team).label]}
      onPress={() => router.push(teamRoutes.workspace(entry.id))}
      accessibilityLabel={teamCardLabel(team)}
      accessibilityHint="Opens the team"
      style={styles.card}
      testID={`team-row-${entry.id}`}
      trailing={
        <View style={styles.extras}>
          <View style={styles.facts}>
            <View style={styles.members}>
              {people.length > 0 ? (
                <AvatarStack
                  people={people}
                  max={4}
                  size="md"
                  accessibilityLabel={membersText(team.members, viewerId, names)}
                  testID={`team-members-${entry.id}`}
                />
              ) : null}
            </View>
            <StatTile
              label="Standing"
              value={standing.value}
              sublabel={standing.sublabel}
              style={styles.tile}
              testID={`team-standing-${entry.id}`}
            />
          </View>
          {team.nextFixture ? (
            <NextGameAnswer
              fixtureId={team.nextFixture.fixtureId}
              viewerId={viewerId}
              teamName={team.teamName}
            />
          ) : null}
        </View>
      }
    />
  );
}

function InvitationItem({
  invitation,
  onDeclined,
  onReload,
}: {
  invitation: TeamInvitationView;
  onDeclined: (declined: TeamInvitationView) => void;
  /** Reads the list again (an invitation answered or withdrawn meanwhile). */
  onReload: () => void;
}) {
  const router = useRouter();
  const styles = useStyles();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [confirming, setConfirming] = useState(false);
  const decline = useApiCommand('post', '/team-invitations/{id}/decline', {
    invalidate: [INVITATIONS_KEY, MY_TEAMS_KEY],
  });
  const submit = () =>
    void decline
      .submit({ path: { id: invitation.id }, body: { expectedRevision: invitation.revision } })
      .then(onDeclined)
      .catch(() => undefined);
  const from = invitation.invitedBy?.displayName || 'the league';
  // The API's effective status: a pending invitation past its expiry is already "Expired".
  const open = invitation.effectiveStatus === 'pending';
  // The id only (§4.14). SCR-C-17 reads it with the tokenless `GET /v1/team-invitations/{id}`
  // (team-routes.test.tsx); accepting there needs the link's token.
  const openDetail = () => router.push(teamInvitationRoute(invitation.id) as Href);
  return (
    <View style={styles.item} testID={`team-invitation-${invitation.id}`}>
      <ListRow
        title={invitation.teamName}
        detail={`${invitation.seasonName}. From ${from}${invitation.message ? `: "${invitation.message}"` : ''}`}
        status={invitationStatus({
          status: invitation.effectiveStatus,
          expiresAt: invitation.expiresAt,
        })}
        onPress={openDetail}
        accessibilityHint="Opens the invitation"
      />
      {open && confirming ? (
        <View style={styles.confirm}>
          <Text variant="body">{`Decline the invitation to join ${invitation.teamName}? It can no longer be accepted afterwards.`}</Text>
          <View style={styles.buttons}>
            <Button
              label="Decline invitation"
              variant="destructive"
              onPress={submit}
              busy={decline.isProcessing}
              disabled={offline}
            />
            <Button
              label="Keep invitation"
              variant="secondary"
              onPress={() => {
                decline.reset();
                setConfirming(false);
              }}
            />
          </View>
        </View>
      ) : open ? (
        <View style={styles.answers}>
          <Button
            label="Accept"
            onPress={openDetail}
            accessibilityHint={`Opens the invitation to join ${invitation.teamName}, where you accept it from the link you received`}
          />
          <Button
            label="Decline"
            variant="secondary"
            onPress={() => setConfirming(true)}
            disabled={offline}
            accessibilityHint={`Asks before declining the invitation to join ${invitation.teamName}`}
          />
        </View>
      ) : null}
      {decline.error ? (
        <CommandError
          wording="team"
          error={decline.error}
          onRetry={submit}
          onReload={() => {
            decline.reset();
            setConfirming(false);
            onReload();
          }}
          unavailableText="Declining this invitation is not available to you."
        />
      ) : null}
    </View>
  );
}

/** Open team invitations, first on the screen; nothing at all while there are none. */
function TeamInvitations() {
  const invitations = useApiPages({
    path: '/me/team-invitations',
    request: { query: { status: 'pending', limit: INVITATION_PAGE } },
  });
  const [declined, setDeclined] = useState<TeamInvitationView[]>([]);
  const items = invitations.data;
  const none = items !== undefined && items.length === 0;
  // Loading shows nothing yet (the teams below show their own loading state); a failed read and
  // what was just declined are shown.
  const loading = items === undefined && invitations.error === null;
  if (declined.length === 0 && (none || loading)) return null;
  return (
    <Section title="Invitations" testID="team-invitations">
      {declined.map((d) => (
        <LiveRegion key={d.id} announcement={`Declined the invitation to join ${d.teamName}`}>
          <StatusBadge tone="neutral" label={`Declined the invitation to join ${d.teamName}`} />
        </LiveRegion>
      ))}
      {none ? null : (
        <QueryBoundary
          query={invitations}
          label="your team invitations"
          unavailableOffline={['declining an invitation']}
          empty={{ title: '', description: '' }}
        >
          {(list) => (
            <View accessibilityRole="list" accessibilityLabel="Team invitations">
              {list.map((invitation) => (
                <InvitationItem
                  key={invitation.id}
                  invitation={invitation}
                  onDeclined={(d) => setDeclined((done) => [...done, d])}
                  onReload={() => void invitations.refetch()}
                />
              ))}
            </View>
          )}
        </QueryBoundary>
      )}
      <LoadMore pages={invitations} label="team invitations" />
    </Section>
  );
}

/**
 * "Your share": what a captain asked the person (or someone they pay for) to pay of a team fee
 * and is still open (SPK-PAY-004). Each opens the share with the team's totals (SCR-C-25).
 */
function YourShare({
  viewerId,
  names,
}: {
  viewerId: string | null;
  names: ReadonlyMap<string, PersonNameEntry>;
}) {
  const router = useRouter();
  const shares = useApiQuery({
    path: '/me/contribution-requests',
    request: { query: { limit: 20 } },
  });
  const open = (shares.data?.items ?? []).filter((c) => c.status === 'requested');
  if (open.length === 0) return null;
  return (
    <Section title="Your share" testID="your-share">
      {open.map((share) => {
        const whose =
          share.requestedPersonId === viewerId
            ? 'Your share'
            : `Share for ${nameOf(names.get(share.requestedPersonId))}`;
        return (
          <ListRow
            key={share.id}
            title={whose}
            value={formatMoney(share.amountMinor, share.currency)}
            detail={share.obligation.description}
            onPress={() => router.push(teamRoutes.contribution(share.id))}
            accessibilityHint="Opens what you were asked to pay, with the team's totals"
            testID={`your-share-${share.id}`}
          />
        );
      })}
    </Section>
  );
}

function StartTeam() {
  const router = useRouter();
  return (
    <Section title="Start or renew a team">
      <Button
        label="Enter a new team"
        onPress={() => router.push(teamRoutes.newEntry())}
        accessibilityHint="Name a team and enter it in an open season"
      />
      <Text variant="footnote" tone="muted">
        To renew a team for a new season, open last season&apos;s team and choose Renew for a new
        season.
      </Text>
    </Section>
  );
}

/** The teams the viewer may see, or none while the read says they may no longer see them. */
function visibleTeams(read: ReturnType<typeof useMyTeamEntries>): MyTeamEntry[] {
  if (read.error && presentationForError(read.error) === 'unavailable') return [];
  return read.data ?? [];
}

function TeamsHeader({ teams }: { teams: ReturnType<typeof useMyTeamEntries> }) {
  const router = useRouter();
  const styles = useStyles();
  return (
    <View>
      {/* The tab's own header names the screen ("Teams"): no second title here. */}
      <TeamInvitations />
      <Text variant="title3" heading style={styles.heading}>
        Your teams
      </Text>
      <View style={styles.gutter}>
        <QueryBoundary
          query={teams}
          label="your teams"
          empty={{ title: '', description: '' }}
          unavailableOffline={['declining an invitation', 'answering for a game']}
        >
          {(list) =>
            list.length === 0 ? (
              <EmptyState
                source={illustrations['empty-teams']}
                title="No teams yet"
                message="To join a team, accept the invitation your captain sent you. To start one, enter a new team in an open season."
                action={{
                  label: 'Enter a new team',
                  onPress: () => router.push(teamRoutes.newEntry()),
                  accessibilityHint: 'Name a team and enter it in an open season',
                }}
              />
            ) : null
          }
        </QueryBoundary>
      </View>
    </View>
  );
}

function TeamsFooter({
  teams,
  viewerId,
  names,
}: {
  teams: ReturnType<typeof useMyTeamEntries>;
  viewerId: string | null;
  names: ReadonlyMap<string, PersonNameEntry>;
}) {
  const empty = teams.data !== undefined && teams.data.length === 0;
  return (
    <View>
      <YourShare viewerId={viewerId} names={names} />
      {/* The empty state carries its own "Enter a new team". */}
      {empty ? null : <StartTeam />}
    </View>
  );
}

function TeamsContent() {
  const styles = useStyles();
  const teams = useMyTeamEntries();
  const me = useMe();
  const refresh = usePullToRefresh();
  // Who "You" is waits for `GET /v1/me`; until then every member is named from the API.
  const viewerId = me.data?.person?.id ?? null;
  const viewerName = me.data?.person
    ? `${me.data.person.givenName} ${me.data.person.familyName}`.trim()
    : null;
  const list = visibleTeams(teams);
  const others = list.flatMap((t) =>
    t.members.map((m) => m.personId).filter((id) => id !== viewerId),
  );
  const names = usePersonNames(others);
  return (
    <Screen
      onRefresh={refresh.onRefresh}
      refreshing={refresh.refreshing}
      list={{
        data: list,
        keyExtractor: (team) => team.teamEntry.id,
        renderItem: ({ item }) => (
          <TeamCard team={item} viewerId={viewerId} viewerName={viewerName} names={names} />
        ),
        accessibilityRole: 'list',
        accessibilityLabel: 'Your teams',
        testID: 'my-teams',
        ItemSeparatorComponent: () => <View style={styles.separator} />,
        ListFooterComponent: <TeamsFooter teams={teams} viewerId={viewerId} names={names} />,
      }}
    >
      <TeamsHeader teams={teams} />
    </Screen>
  );
}

export function TeamsScreen() {
  const { session } = useApp();
  // Signed out or still loading, the session prompt stands alone; signed in, the list screen.
  if (session.status !== 'signed_in') {
    return (
      <Screen>
        <RequireSession what="your teams">{null}</RequireSession>
      </Screen>
    );
  }
  return <TeamsContent />;
}

const useStyles = makeStyles(() => ({
  heading: {
    paddingHorizontal: layout.gutter,
    marginTop: layout.sectionGap - spacing.sm,
    marginBottom: spacing.sm,
  },
  gutter: { paddingHorizontal: layout.gutter },
  card: { marginHorizontal: layout.gutter },
  separator: { height: layout.cardGap },
  extras: { flex: 1, gap: spacing.md },
  facts: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  members: { flex: 1 },
  tile: { minWidth: 120 },
  item: { gap: spacing.sm, paddingVertical: spacing.xs },
  answers: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  confirm: { gap: spacing.sm },
  buttons: { gap: spacing.sm },
}));
