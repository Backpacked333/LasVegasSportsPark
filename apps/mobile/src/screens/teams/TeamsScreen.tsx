/**
 * SCR-C-21 Teams, the fourth destination (SPK-UX-002, SPK-CAP-001, SPK-CAP-002, SPK-COMP-001).
 * The live teams the signed-in person and the people they may view are on
 * (`GET /v1/me/team-entries`, CMP-02), each with who of the family is on it and in which role, the
 * next game (in the facility's time zone, SPK-SCHED-008), the official standing
 * (`GET /v1/seasons/{id}/standings`) and the next game's readiness indicator as the API counts it.
 * Team invitations still open for the person (`GET /v1/me/team-invitations`, CMP-03) are listed
 * with the invitation's own detail (SCR-C-17) and can be declined here
 * (`POST /v1/team-invitations/{id}/decline`, the revision read sent). Creating a team entry is
 * SCR-C-27; renewing starts from last season's team (SCR-C-22).
 *
 * The API decides which teams and which people each viewer sees (§4.10, SPK-CAP-002); family
 * members are named through `GET /v1/person-names` (given names only, §4.14) and never put in a
 * route or a log.
 *
 * States: loading; empty (no teams: how to join or create); ready; validation failure: not
 * applicable; permission restriction (the API lists only what the viewer may see; a refused
 * decline is "not available"); stale version (refetch on focus, "Updated <time>"; a decline of an
 * invitation answered meanwhile reloads it); offline (cached with age, decline disabled);
 * processing (declining); success ("Declined"); partial completion: not permitted; recovery
 * required: not applicable, a failed read shows its code with "Try again".
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePersonNames, type PersonNameEntry } from '../../api/person-names';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant, ordinal, plural } from '../../features/teams/format';
import {
  MY_TEAMS_KEY,
  useMe,
  useMyTeamEntries,
  type MyTeamEntry,
} from '../../features/teams/queries';
import { teamRoutes } from '../../features/teams/routes';
import { invitationStatus, teamEntryStatus } from '../../features/teams/status';
import { Body, ButtonRow, CommandFailure, Section, Title } from '../../features/teams/ui';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';

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

export function membersText(
  members: readonly Member[],
  viewerId: string | null,
  names: ReadonlyMap<string, PersonNameEntry>,
): string {
  const parts = [...members]
    .sort((a, b) => (a.personId === viewerId ? -1 : b.personId === viewerId ? 1 : 0))
    .map(
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

function useStandingText(team: MyTeamEntry): string {
  const divisionId = team.teamEntry.divisionId;
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: { path: { id: team.seasonId }, query: divisionId ? { divisionId } : {} },
  });
  const data = standings.data;
  // Loading, a failed read and an empty table are three different things (SPK-UX-008).
  if (data === undefined) return standings.error ? 'not available' : 'loading';
  const row = data?.rows.find((r) => r.teamEntryId === team.teamEntry.id);
  if (!data || !row || data.sourceResultIds.length === 0) return 'no official standing yet';
  return `${ordinal(row.position)} of ${data.rows.length}`;
}

function TeamRow({
  team,
  viewerId,
  names,
}: {
  team: MyTeamEntry;
  viewerId: string | null;
  names: ReadonlyMap<string, PersonNameEntry>;
}) {
  const router = useRouter();
  const standing = useStandingText(team);
  const entry = team.teamEntry;
  // Approval stays distinct from readiness (SPK-COMP-004): with a next game the badge is the
  // game's readiness, so an entry not (yet) approved says so in the detail.
  const approval =
    team.nextFixture && entry.status !== 'approved' ? `. ${teamEntryStatus(entry).label}` : '';
  return (
    <ListRow
      title={team.teamName}
      detail={`${team.seasonName}${team.divisionName ? `, ${team.divisionName}` : ''}. ${membersText(team.members, viewerId, names)}. ${nextGameText(team)}. Standing: ${standing}${approval}`}
      status={
        team.nextFixture ? readinessStatus(team.nextFixture.readiness) : teamEntryStatus(entry)
      }
      onPress={() => router.push(teamRoutes.workspace(entry.id))}
      accessibilityHint="Opens the team workspace"
      testID={`team-row-${entry.id}`}
    />
  );
}

function TeamList({ teams, viewerId }: { teams: MyTeamEntry[]; viewerId: string | null }) {
  const others = teams.flatMap((t) =>
    t.members.map((m) => m.personId).filter((id) => id !== viewerId),
  );
  const names = usePersonNames(others);
  return (
    <View accessibilityRole="list" accessibilityLabel="Your teams" testID="my-teams">
      {teams.map((team) => (
        <TeamRow key={team.teamEntry.id} team={team} viewerId={viewerId} names={names} />
      ))}
    </View>
  );
}

function MyTeams() {
  const teams = useMyTeamEntries();
  const me = useMe();
  // Who "You" is waits for `GET /v1/me`; until then every member is named from the API.
  const viewerId = me.data?.person?.id ?? null;
  return (
    <Section title="Your teams">
      <QueryBoundary
        query={teams}
        label="your teams"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No teams to show',
          description:
            'To join a team, accept the invitation your captain sent you. To start a team, create a team entry for an open season.',
        }}
        unavailableOffline={['declining an invitation', 'creating a team entry']}
      >
        {(list) => <TeamList teams={list} viewerId={viewerId} />}
      </QueryBoundary>
    </Section>
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
  return (
    <View style={styles.item} testID={`team-invitation-${invitation.id}`}>
      <ListRow
        title={invitation.teamName}
        detail={`${invitation.seasonName}. From ${from}${invitation.message ? `: "${invitation.message}"` : ''}`}
        status={invitationStatus({
          status: invitation.effectiveStatus,
          expiresAt: invitation.expiresAt,
        })}
        onPress={() => router.push(teamInvitationRoute(invitation.id))}
        accessibilityHint="Opens the invitation, where you can accept it from the link you received"
      />
      {open && confirming ? (
        <>
          <Body>{`Decline the invitation to join ${invitation.teamName}? It can no longer be accepted afterwards.`}</Body>
          <ButtonRow>
            <Button
              label="Decline invitation"
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
          </ButtonRow>
        </>
      ) : open ? (
        <Button
          label={`Decline the invitation to join ${invitation.teamName}`}
          variant="secondary"
          onPress={() => setConfirming(true)}
          disabled={offline}
        />
      ) : null}
      {decline.error ? (
        <CommandFailure
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

function TeamInvitations() {
  const invitations = useApiPages({
    path: '/me/team-invitations',
    request: { query: { status: 'pending', limit: INVITATION_PAGE } },
  });
  const [declined, setDeclined] = useState<TeamInvitationView[]>([]);
  return (
    <Section title="Invitations to join a team" testID="team-invitations">
      {declined.map((d) => (
        <View key={d.id} accessibilityLiveRegion="polite">
          <StatusBadge tone="neutral" label={`Declined the invitation to join ${d.teamName}`} />
        </View>
      ))}
      <QueryBoundary
        query={invitations}
        label="your team invitations"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No open team invitations',
          description: 'An invitation from a captain appears here until you answer it.',
        }}
        unavailableOffline={['declining an invitation']}
      >
        {(items) => (
          <View accessibilityRole="list" accessibilityLabel="Team invitations">
            {items.map((invitation) => (
              <InvitationItem
                key={invitation.id}
                invitation={invitation}
                onDeclined={(d) => setDeclined((list) => [...list, d])}
                onReload={() => void invitations.refetch()}
              />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={invitations} label="team invitations" />
    </Section>
  );
}

function TeamsHome() {
  const router = useRouter();
  return (
    <View>
      <Title>Teams</Title>
      <MyTeams />
      <TeamInvitations />
      <Section title="Create or renew">
        <Button
          label="Create a team entry"
          onPress={() => router.push(teamRoutes.newEntry())}
          accessibilityHint="Name a team and enter it in an open season"
        />
        <Body muted>
          To renew a team for a new season, open last season&apos;s team and choose Renew for a new
          season.
        </Body>
      </Section>
    </View>
  );
}

export function TeamsScreen() {
  return (
    <Screen>
      <RequireSession what="your teams">
        <TeamsHome />
      </RequireSession>
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: { gap: spacing.xs, paddingVertical: spacing.xs },
});
