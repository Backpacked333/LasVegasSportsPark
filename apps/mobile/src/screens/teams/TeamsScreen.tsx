/**
 * SCR-C-21 Teams, the fourth destination (SPK-UX-002, SPK-CAP-001, SPK-CAP-002, SPK-COMP-001).
 * The person's teams, each with its next game, standing and readiness indicator, and the entry
 * to create a team entry (SCR-C-27; renewal starts from last season's team, SCR-C-22).
 *
 * The API has no list of the teams a person (or their children) belongs to (reported), so the
 * full list is shown as not available, and the teams opened in this app session (from an
 * invitation, a link or creation) are listed instead, each re-read from
 * `GET /v1/team-entries/{id}`; the API decides what each viewer may see (SPK-CAP-002, §4.10).
 *
 * States: loading (per team); empty (no teams: how to join or create); ready; permission
 * restriction (team role decides what each row shows; a team no longer visible says so); stale
 * (refetch on focus); offline (cached with age, per row); processing and success: not applicable.
 */
import { formatAge } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant, ordinal } from '../../features/teams/format';
import { useOpenedTeamEntries } from '../../features/teams/opened-teams';
import { useMe, useWorkspace, viewerOf, type Workspace } from '../../features/teams/queries';
import { teamRoutes } from '../../features/teams/routes';
import { teamEntryStatus } from '../../features/teams/status';
import { Body, Section, Title } from '../../features/teams/ui';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';

/** The row's readiness indicator: blocking issues for the captain, the entry state otherwise. */
export function teamRowStatus(workspace: Workspace, captainView: boolean): StatusBadgeProps {
  if (captainView) {
    const blocking = workspace.readiness.issues.filter((i) => i.severity === 'blocking').length;
    if (blocking > 0) {
      return {
        tone: 'danger',
        label: `${blocking} readiness ${blocking === 1 ? 'issue' : 'issues'} to resolve`,
      };
    }
  }
  return teamEntryStatus(workspace.entry);
}

function nextGameText(workspace: Workspace): string {
  const next = workspace.upcomingFixtures[0];
  if (!next) return 'No upcoming games';
  const opponent = next.opponent ? `vs ${next.opponent.teamName}` : 'Bye';
  const when = next.fixture.scheduledStart
    ? formatInstant(next.fixture.scheduledStart)
    : 'time not set yet';
  return `Next: ${opponent}, ${when}`;
}

function TeamRow({ entryId, onForget }: { entryId: string; onForget: () => void }) {
  const router = useRouter();
  const now = useNow();
  const { reachable } = useConnectivity();
  const workspace = useWorkspace(entryId);
  const me = useMe();
  const ws = workspace.data;
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: {
      path: { id: ws?.season.id ?? '' },
      query: ws?.division ? { divisionId: ws.division.id } : {},
    },
    enabled: ws !== undefined,
  });

  if (!ws) {
    if (
      workspace.error &&
      (workspace.error.isNotFound || workspace.error.isPermissionRestriction)
    ) {
      return (
        <View style={styles.row} testID={`team-row-${entryId}`}>
          <StateView
            variant="unavailable"
            title="No longer available"
            description="This team can no longer be shown to you."
            actionLabel="Remove from this list"
            onAction={onForget}
          />
        </View>
      );
    }
    if (workspace.error && reachable !== false) {
      return (
        <View style={styles.row} testID={`team-row-${entryId}`}>
          <StateView
            variant="error"
            error={workspace.error}
            onRetry={() => void workspace.refetch()}
          />
        </View>
      );
    }
    return (
      <ListRow
        title={reachable === false ? 'Team not loaded: you are offline' : 'Loading team…'}
        testID={`team-row-${entryId}`}
      />
    );
  }

  const viewer = viewerOf(ws, me.data?.person?.id ?? null, now);
  const row = standings.data?.rows.find((r) => r.teamEntryId === entryId);
  // Loading, a failed read and an empty table are three different things (SPK-UX-008).
  const standing =
    standings.data === undefined
      ? standings.error
        ? 'standing not available'
        : 'standing loading'
      : row && standings.data && standings.data.sourceResultIds.length > 0
        ? `${ordinal(row.position)} of ${standings.data.rows.length}`
        : 'no official standing yet';
  const age = workspace.updatedAt ? `. Updated ${formatAge(workspace.updatedAt, now)}` : '';
  return (
    <ListRow
      title={ws.team.name}
      detail={`${ws.season.name}${ws.division ? `, ${ws.division.name}` : ''}. ${nextGameText(ws)}. Standing: ${standing}${age}`}
      status={teamRowStatus(ws, viewer.captainView)}
      onPress={() => router.push(teamRoutes.workspace(entryId))}
      accessibilityHint="Opens the team workspace"
      testID={`team-row-${entryId}`}
    />
  );
}

function TeamsHome() {
  const router = useRouter();
  const { ids, forget } = useOpenedTeamEntries();
  return (
    <View>
      <Title>Teams</Title>
      <Section title="Your teams">
        <StateView
          variant="unavailable"
          title="Full team list not available yet"
          description="The service cannot list all the teams you and your family belong to yet. Teams you open from an invitation or a link, or create here, are listed below until you close the app."
        />
        {ids.length === 0 ? (
          <StateView
            variant="empty"
            title="No teams to show"
            description="To join a team, open the invitation your captain sent you. To start a team, create a team entry for an open season."
          />
        ) : (
          <View accessibilityRole="list" testID="opened-teams">
            {ids.map((entryId) => (
              <TeamRow key={entryId} entryId={entryId} onForget={() => forget(entryId)} />
            ))}
          </View>
        )}
      </Section>
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
  row: { paddingVertical: spacing.xs },
});
