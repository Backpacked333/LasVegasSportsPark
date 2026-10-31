/**
 * SCR-C-28 Standings and results (SPK-RESULT-001, SPK-RESULT-002, SPK-RESULT-003,
 * SPK-RESULT-004, SPK-DISC-004, POL-025, POL-027). Official standings from official results only
 * (`GET /v1/seasons/{id}/standings`), with the versioned rule set they were calculated with and
 * the explanation of every tiebreak; this team's games (`GET /v1/seasons/{id}/fixtures`, each
 * dated in its venue's zone from `GET /v1/fixtures/{id}`, SPK-SCHED-008) open their result
 * revisions (FixtureResultsScreen: "Official", "Corrected on <date>"); the published
 * bracket where the season has one (`GET /v1/seasons/{id}/bracket-nodes`). Restricted incident
 * narratives are never requested or shown (SPK-DISC-004). Sharing standings publicly depends on
 * the public information policy (DEC-012, pending) and is not offered.
 *
 * Tournament pools (CMP-15, §3.16, capability `tournaments`, DEC-078): a pool's table is
 * PoolStandingsScreen. Where the organization has tournaments turned on, this screen says that the
 * API does not yet name the pool a team plays in (no pool list for a division or an entry,
 * reported), so no pool table can be listed here; with tournaments off nothing is shown.
 *
 * States: loading; empty (no official results yet); ready; permission restriction (not
 * available); stale version (the standings revision changed: "Calculated <time>" and refetch on
 * focus); offline (cached with its calculation time and age); processing and success: not
 * applicable.
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDay, formatInstant, ordinal, plural } from '../../features/teams/format';
import type { Workspace } from '../../features/teams/queries';
import { idParam, teamRoutes } from '../../features/teams/routes';
import { fixtureStatus } from '../../features/teams/status';
import { TeamFrame } from '../../features/teams/TeamFrame';
import { Body, Section, Title } from '../../features/teams/ui';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { colors, spacing, type } from '../../ui/theme';

/** The published component is nullable (reported); a null answer reads as "no official results". */
type Standings = NonNullable<Schema<'Standings'>>;
type StandingsRow = Schema<'StandingsRow'>;
type Tiebreak = Schema<'TiebreakExplanation'>;
type Step = Tiebreak['steps'][number];
type Fixture = Schema<'Fixture'>;
type BracketNode = Schema<'BracketNode'>;

export const TIEBREAKER_LABELS: Record<Step['tiebreaker'], string> = {
  points: 'Points',
  head_to_head: 'Head-to-head',
  goal_difference: 'Goal difference',
  goals_for: 'Goals scored',
  goals_against: 'Goals conceded',
  wins: 'Wins',
  fair_play: 'Fair play',
  draw_of_lots: 'Drawing of lots',
  play_off: 'Play-off',
  exhausted: 'No further tiebreaker in the rule set',
};

const OUTCOME_WORDS: Record<Step['outcome'], string> = {
  resolved: 'separated the teams',
  partially_resolved: 'separated some of the teams',
  not_separating: 'did not separate the teams',
  unresolved: 'left the tie unresolved',
};

const PLAYED: ReadonlySet<Fixture['status']> = new Set([
  'played',
  'forfeit',
  'abandoned',
  'canceled',
  'postponed',
]);

export function standingsRowLabel(row: StandingsRow, ours: boolean): string {
  return `${ordinal(row.position)}: ${row.teamName}${ours ? ' (your team)' : ''}, ${plural(row.points, 'point')}, played ${row.played}, won ${row.won}, drawn ${row.drawn}, lost ${row.lost}, goals ${row.goalsFor} for and ${row.goalsAgainst} against, difference ${row.goalDifference}`;
}

/** Above this text scale the table's fixed columns no longer fit: rows are stacked instead. */
export const LARGE_TEXT_SCALE = 1.3;

/** The table of a division or a pool (SPK-RESULT-003): the rows as the API ordered them. */
export function StandingsTable({
  standings,
  entryId,
}: {
  standings: Pick<Standings, 'rows'>;
  entryId: string;
}) {
  const { fontScale } = useWindowDimensions();
  if (fontScale > LARGE_TEXT_SCALE) {
    // SPK-UX-009 large text: one readable row per team instead of clipped numeric cells.
    return (
      <View accessibilityRole="list" testID="standings-stacked">
        {standings.rows.map((row) => {
          const ours = row.teamEntryId === entryId;
          return (
            <ListRow
              key={row.teamEntryId}
              title={standingsRowLabel(row, ours)}
              testID={`standings-row-${row.teamEntryId}`}
            />
          );
        })}
      </View>
    );
  }
  return (
    <View style={styles.table}>
      <View
        style={styles.tableRow}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={[styles.cellPos, styles.head]}>#</Text>
        <Text style={[styles.cellTeam, styles.head]}>Team</Text>
        {['P', 'W', 'D', 'L', 'GD', 'Pts'].map((h) => (
          <Text key={h} style={[styles.cell, styles.head]}>
            {h}
          </Text>
        ))}
      </View>
      {standings.rows.map((row) => {
        const ours = row.teamEntryId === entryId;
        return (
          <View
            key={row.teamEntryId}
            style={[styles.tableRow, ours && styles.ours]}
            accessible
            accessibilityLabel={standingsRowLabel(row, ours)}
            testID={`standings-row-${row.teamEntryId}`}
          >
            <Text style={styles.cellPos}>{row.position}</Text>
            <Text style={[styles.cellTeam, ours && styles.bold]}>
              {ours ? `${row.teamName} (your team)` : row.teamName}
            </Text>
            {[row.played, row.won, row.drawn, row.lost, row.goalDifference, row.points].map(
              (v, i) => (
                <Text key={i} style={styles.cell}>
                  {String(v)}
                </Text>
              ),
            )}
          </View>
        );
      })}
    </View>
  );
}

export function TiebreakList({
  explanations,
  names,
}: {
  explanations: Tiebreak[];
  names: Map<string, string>;
}) {
  if (explanations.length === 0) return null;
  const name = (id: string) => names.get(id) ?? 'Team';
  return (
    <Section title="How ties were decided" testID="tiebreaks">
      {explanations.map((tie, index) => (
        <View key={index} style={styles.tie}>
          <Body>{`Tied on ${plural(tie.points, 'point')}: ${tie.teamEntryIds.map(name).join(' and ')}`}</Body>
          {tie.steps.map((step, i) => (
            <View
              key={i}
              accessible
              accessibilityLabel={`${TIEBREAKER_LABELS[step.tiebreaker]} ${OUTCOME_WORDS[step.outcome]}. ${step.explanation}`}
              style={styles.step}
            >
              <Text style={styles.stepTitle}>
                {`${i + 1}. ${TIEBREAKER_LABELS[step.tiebreaker]} ${OUTCOME_WORDS[step.outcome]}`}
              </Text>
              <Text style={styles.body}>{step.explanation}</Text>
              {step.values.length > 0 ? (
                <Text style={styles.caption}>
                  {step.values.map((v) => `${name(v.teamEntryId)} ${v.value}`).join(', ')}
                </Text>
              ) : null}
            </View>
          ))}
          {!tie.resolved ? <Body>Still tied after every tiebreaker in the rule set.</Body> : null}
        </View>
      ))}
    </Section>
  );
}

function opponentName(fixture: Fixture, entryId: string, names: Map<string, string>): string {
  const other = fixture.homeEntryId === entryId ? fixture.awayEntryId : fixture.homeEntryId;
  if (!other) return 'Bye';
  return `vs ${names.get(other) ?? 'Opponent'}`;
}

/**
 * One played game. Its day is the facility's (SPK-SCHED-008): `GET /v1/fixtures/{id}` gives
 * `venue.timezone` (the read SCR-C-28's result screen makes too, so it is shared); while it loads
 * or if it fails the device's zone is used.
 */
function ResultRow({
  fixture,
  entryId,
  names,
}: {
  fixture: Fixture;
  entryId: string;
  names: Map<string, string>;
}) {
  const router = useRouter();
  const detail = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixture.id } } });
  const timeZone = detail.data?.venue?.timezone;
  return (
    <ListRow
      title={opponentName(fixture, entryId, names)}
      detail={fixture.scheduledStart ? formatDay(fixture.scheduledStart, timeZone) : undefined}
      status={fixtureStatus(fixture, timeZone)}
      onPress={() => router.push(teamRoutes.result(entryId, fixture.id))}
      accessibilityHint="Opens the official result and its history"
      testID={`result-${fixture.id}`}
    />
  );
}

function Results({ workspace, names }: { workspace: Workspace; names: Map<string, string> }) {
  const entryId = workspace.entry.id;
  const fixtures = useApiQuery({
    path: '/seasons/{id}/fixtures',
    request: { path: { id: workspace.season.id }, query: { teamEntryId: entryId, limit: 100 } },
  });
  return (
    <Section title="Results">
      <QueryBoundary
        query={fixtures}
        label="this team's games"
        isEmpty={(page) => page.items.filter((f) => PLAYED.has(f.status)).length === 0}
        empty={{ title: 'No results yet', description: 'Games appear here once they are played.' }}
      >
        {(page) => (
          <View accessibilityRole="list">
            {page.items
              .filter((f) => PLAYED.has(f.status))
              .map((f) => (
                <ResultRow key={f.id} fixture={f} entryId={entryId} names={names} />
              ))}
          </View>
        )}
      </QueryBoundary>
    </Section>
  );
}

function bracketText(node: BracketNode, names: Map<string, string>): string {
  const side = (id: string | null) => (id ? (names.get(id) ?? 'Team') : 'To be decided');
  const head = `Round ${node.round}, game ${node.slot}${node.name ? ` (${node.name})` : ''}`;
  const winner = node.winnerEntryId ? `. Winner: ${side(node.winnerEntryId)}` : '';
  return `${head}: ${side(node.homeEntryId)} vs ${side(node.awayEntryId)}${winner}`;
}

function Bracket({ workspace, names }: { workspace: Workspace; names: Map<string, string> }) {
  const nodes = useApiQuery({
    path: '/seasons/{id}/bracket-nodes',
    request: {
      path: { id: workspace.season.id },
      query: workspace.division ? { divisionId: workspace.division.id } : {},
    },
  });
  if (nodes.data === undefined) {
    // A failed bracket read says so with its code (SPK-UX-008); loading shows nothing yet.
    return nodes.error ? (
      <Section title="Bracket" testID="bracket">
        <QueryErrorView error={nodes.error} onRetry={() => void nodes.refetch()} />
      </Section>
    ) : null;
  }
  const list = nodes.data;
  if (list.length === 0) return null;
  return (
    <Section title="Bracket" testID="bracket">
      <View accessibilityRole="list">
        {list.map((node) => (
          <ListRow key={node.id} title={bracketText(node, names)} />
        ))}
      </View>
    </Section>
  );
}

function StandingsContent({ workspace }: { workspace: Workspace }) {
  const entryId = workspace.entry.id;
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: {
      path: { id: workspace.season.id },
      query: workspace.division ? { divisionId: workspace.division.id } : {},
    },
  });
  const names = new Map<string, string>([[entryId, workspace.team.name]]);
  for (const game of workspace.upcomingFixtures) {
    if (game.opponent) names.set(game.opponent.entryId, game.opponent.teamName);
  }
  for (const row of standings.data?.rows ?? []) names.set(row.teamEntryId, row.teamName);
  const ruleSetName =
    standings.data && standings.data.ruleSetId === workspace.ruleSet.id
      ? workspace.ruleSet.name
      : 'the season rule set';
  return (
    <View>
      <Title>{`${workspace.season.name}${workspace.division ? `: ${workspace.division.name}` : ''}`}</Title>
      <Section title="Standings">
        <QueryBoundary
          query={standings}
          label="the standings"
          isEmpty={(s) => !s || s.rows.length === 0 || s.sourceResultIds.length === 0}
          empty={{
            title: 'No official results yet',
            description:
              'Standings appear once the league publishes official results. Provisional results are never counted.',
          }}
        >
          {(s) =>
            s ? (
              <View style={styles.group}>
                <StandingsTable standings={s} entryId={entryId} />
                <Body muted>
                  {`Calculated ${formatInstant(s.computedAt)} from ${plural(s.sourceResultIds.length, 'official result')} with ${ruleSetName}, version ${s.ruleSetVersion}. Provisional results are never counted.`}
                </Body>
              </View>
            ) : null
          }
        </QueryBoundary>
      </Section>
      {standings.data ? (
        <TiebreakList explanations={standings.data.tiebreakExplanations} names={names} />
      ) : null}
      <Results workspace={workspace} names={names} />
      <Bracket workspace={workspace} names={names} />
      <TournamentPools />
    </View>
  );
}

/** Shown only while the organization has tournaments on (DEC-016, DEC-078). */
function TournamentPools() {
  const tournaments = usePermissions().isCapabilityEnabled('tournaments');
  if (tournaments !== true) return null;
  return (
    <Section title="Tournament pools" testID="tournament-pools">
      <StateView
        variant="unavailable"
        title="Pool tables not listed yet"
        description="This league can run tournament pools, but the service does not yet say which pool a team plays in, so pool tables cannot be listed here."
      />
    </Section>
  );
}

export function StandingsScreen({ entryId }: { entryId: string | null }) {
  return (
    <TeamFrame entryId={entryId} what="the standings">
      {(ws) => <StandingsContent workspace={ws} />}
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/standings.tsx. */
export function StandingsRoute() {
  const entryId = idParam(useLocalSearchParams<{ entryId: string }>().entryId);
  return (
    <>
      <Stack.Screen options={{ title: 'Standings and results' }} />
      <StandingsScreen entryId={entryId} />
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  table: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.xs,
  },
  ours: { backgroundColor: colors.surface },
  head: { fontWeight: '700', color: colors.textMuted },
  cellPos: { ...type.body, minWidth: 28, flexShrink: 0, color: colors.text },
  cellTeam: { ...type.body, flex: 1, color: colors.text },
  cell: { ...type.body, minWidth: 34, flexShrink: 0, textAlign: 'right', color: colors.text },
  bold: { fontWeight: '700' },
  tie: { gap: spacing.xs, paddingVertical: spacing.xs },
  step: { gap: 2, paddingLeft: spacing.sm },
  stepTitle: { ...type.body, fontWeight: '600', color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
