/**
 * Parts of the team workspace (SCR-C-22) added with the park UI redesign, each reading what the
 * API states and nothing more:
 *
 * - `FormGuide`: the team's last five official results, oldest first, as W/D/L letters
 *   (SPK-RESULT-001: official results only). This team's fixtures that were played or forfeited
 *   (`GET /v1/seasons/{id}/fixtures?teamEntryId=`), each fixture's result revisions
 *   (`GET /v1/fixtures/{id}/results`, readable by the roster), the `official` revision only. A
 *   forfeit counts against the forfeiting side; otherwise the score decides (equal is a draw,
 *   whatever a shootout decided: the form shows the match result). Nothing is shown while the
 *   reads are not answered, never a guess.
 * - `MiniStandings`: the official table (`GET /v1/seasons/{id}/standings`) around the team, with
 *   the playoff line (`playoffLine.cutPosition`, SPK-RESULT-003) written out as a row, and the
 *   team's own row named "your team" (not colour alone, SPK-UX-009).
 * - `RsvpProgress`: for the management view, how many of the roster said they are available for
 *   the next game, from the counts the workspace already gives (`availability`, SPK-CAP-003: an
 *   answer is neither attendance nor eligibility). A minimum-players warning is not shown: the
 *   API does not state how many players a game needs. "Maybe" answers wait on DEC-064.
 * - `MatchCheckIn`: the captain marks their own side's players present or absent for the next
 *   scheduled game (`GET`/`POST /v1/fixtures/{id}/attendance`, SPK-UX-007, SPK-STAFF-005; own
 *   side only, the API refuses the other side). The players are the workspace's current roster;
 *   each mark supersedes the player's previous one, "Clear" withdraws it. The count is the side's
 *   `present` from the API. Each player's command is its own intent (`useKeyedCommands`).
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useRef } from 'react';
import { Text, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { useApiRecords } from '../../features/registration/queries';
import { ordinal, plural } from '../../features/teams/format';
import type { Viewer, Workspace } from '../../features/teams/queries';
import { isCurrentPlayer } from '../../features/teams/status';
import { Body, CommandFailure, Detail, OfflineNotice } from '../../features/teams/ui';
import { useKeyedCommands } from '../../features/teams/useKeyedCommands';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import {
  fonts,
  makeStyles,
  radius,
  spacing,
  type,
  useTheme,
  type ThemeColors,
} from '../../ui/theme';

type Revision = Schema<'ResultRevision'>;
type SeasonFixture = Schema<'SeasonFixture'>;
type Standings = NonNullable<Schema<'Standings'>>;
type Upcoming = Workspace['upcomingFixtures'][number];

export type FormOutcome = 'W' | 'D' | 'L';
export const FORM_LENGTH = 5;
const OUTCOME_WORD: Record<FormOutcome, string> = { W: 'won', D: 'drew', L: 'lost' };
/** The API's page limit. */
const READ_LIMIT = 200;

/** The outcome of an official result for one side, or null when the result names none. */
export function outcomeFor(
  entryId: string,
  revision: Revision,
  fixture: Pick<SeasonFixture, 'homeEntryId'>,
): FormOutcome | null {
  if (revision.status !== 'official') return null;
  if (revision.forfeitingEntryId) return revision.forfeitingEntryId === entryId ? 'L' : 'W';
  if (revision.homeScore === null || revision.awayScore === null) return null;
  const home = entryId === fixture.homeEntryId;
  const mine = home ? revision.homeScore : revision.awayScore;
  const theirs = home ? revision.awayScore : revision.homeScore;
  return mine > theirs ? 'W' : mine < theirs ? 'L' : 'D';
}

/** The fixtures whose results make the form: played or forfeited, with an opponent, newest last. */
export function formFixtures(fixtures: readonly SeasonFixture[]): SeasonFixture[] {
  return fixtures
    .filter((f) => (f.status === 'played' || f.status === 'forfeit') && f.awayEntryId !== null)
    .sort((a, b) => (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? ''))
    .slice(-FORM_LENGTH);
}

export function FormGuide({ workspace }: { workspace: Workspace }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const entryId = workspace.entry.id;
  const fixtures = useApiQuery({
    path: '/seasons/{id}/fixtures',
    request: {
      path: { id: workspace.season.id },
      query: { teamEntryId: entryId, limit: READ_LIMIT },
    },
    staleTime: 60_000,
  });
  const played = useMemo(() => formFixtures(fixtures.data?.items ?? []), [fixtures.data]);
  const results = useApiRecords(
    '/fixtures/{id}/results',
    played.map((f) => f.id),
    fixtures.data !== undefined,
  );
  if (fixtures.data === undefined) return null;
  // Every fixture's results must have answered: a partial form would mislead.
  if (played.some((f) => results[f.id]?.data === undefined)) return null;
  const form = played
    .map((f) => {
      const official = (results[f.id]?.data ?? []).find((r) => r.status === 'official');
      return official ? outcomeFor(entryId, official, f) : null;
    })
    .filter((o): o is FormOutcome => o !== null);
  if (form.length === 0) return null;
  const look = formLook(colors);
  return (
    <View
      style={styles.form}
      accessible
      accessibilityLabel={`Form, last ${plural(form.length, 'official result')}, oldest first: ${form.map((o) => OUTCOME_WORD[o]).join(', ')}`}
      testID="form-guide"
    >
      {form.map((o, i) => (
        <View key={i} style={[styles.formPill, look[o].pill]}>
          <Text style={[styles.formText, look[o].text]}>{o}</Text>
        </View>
      ))}
    </View>
  );
}

/** Pills of the form guide, on the night workspace card: win in floodlight, draw light, loss outlined. */
function formLook(colors: ThemeColors) {
  return {
    W: { pill: { backgroundColor: colors.floodlight }, text: { color: colors.onFloodlight } },
    D: { pill: { backgroundColor: colors.onNight }, text: { color: colors.night } },
    L: {
      pill: { backgroundColor: colors.nightRaised, borderColor: colors.nightMuted, borderWidth: 1 },
      text: { color: colors.onNight },
    },
  } as const;
}

/** The rows shown: all of a short table, else five around the team (with the playoff line's). */
export function miniRows(standings: Standings, entryId: string): Standings['rows'] {
  const rows = standings.rows;
  if (rows.length <= 8) return rows;
  const mine = rows.findIndex((r) => r.teamEntryId === entryId);
  const centre = mine < 0 ? 0 : mine;
  const start = Math.max(0, Math.min(centre - 2, rows.length - 5));
  return rows.slice(start, start + 5);
}

export function useStandings(workspace: Workspace) {
  return useApiQuery({
    path: '/seasons/{id}/standings',
    request: {
      path: { id: workspace.season.id },
      query: workspace.division ? { divisionId: workspace.division.id } : {},
    },
  });
}

export function MiniStandings({ workspace }: { workspace: Workspace }) {
  const styles = useStyles();
  const standings = useStandings(workspace);
  const data = standings.data;
  if (!data || data.sourceResultIds.length === 0 || data.rows.length === 0) return null;
  const entryId = workspace.entry.id;
  const rows = miniRows(data, entryId);
  const cut = data.playoffLine?.cutPosition ?? null;
  return (
    <View testID="mini-standings">
      <View
        style={styles.tableHead}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={[styles.cellPos, styles.headText]}>#</Text>
        <Text style={[styles.cellTeam, styles.headText]}>Team</Text>
        <Text style={[styles.cellNum, styles.headText]}>GD</Text>
        <Text style={[styles.cellNum, styles.headText]}>Pts</Text>
      </View>
      <View accessibilityRole="list">
        {rows.map((row) => {
          const own = row.teamEntryId === entryId;
          const gd = row.goalDifference > 0 ? `+${row.goalDifference}` : String(row.goalDifference);
          return (
            <View key={row.teamEntryId}>
              <View
                style={[styles.tableRow, own && styles.ownRow]}
                accessible
                accessibilityLabel={`${ordinal(row.position)}, ${row.teamName}${own ? ' (your team)' : ''}, goal difference ${gd}, ${plural(row.points, 'point')}`}
                testID={`mini-row-${row.teamEntryId}`}
              >
                <Text style={[styles.cellPos, own && styles.ownText]}>{row.position}</Text>
                <Text style={[styles.cellTeam, own && styles.ownText]}>
                  {own ? `${row.teamName} · You` : row.teamName}
                </Text>
                <Text style={[styles.cellNum, own && styles.ownText]}>{gd}</Text>
                <Text style={[styles.cellNum, own && styles.ownText]}>{row.points}</Text>
              </View>
              {cut !== null && row.position === cut && cut < data.rows.length ? (
                <View
                  style={styles.playoffLine}
                  accessible
                  accessibilityLabel={`Playoff line: the top ${plural(cut, 'team')} qualify if the table ends as it stands`}
                  testID="playoff-line"
                >
                  <Text style={styles.playoffText}>{`▲ Playoff line · top ${cut} qualify`}</Text>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** "5 of 7 available": the next game's answers (the workspace's counts). */
export function rsvpProgress(summary: Schema<'AvailabilitySummary'>) {
  const total = summary.available + summary.unavailable + summary.tentative + summary.noResponse;
  return { available: summary.available, total };
}

export function RsvpProgress({ game }: { game: Upcoming }) {
  const styles = useStyles();
  const { available, total } = rsvpProgress(game.availability);
  if (total === 0) return null;
  const text = `${available} of ${total} available`;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Next game: ${text}`}
      accessibilityValue={{ min: 0, max: total, now: available, text }}
      testID="rsvp-progress"
    >
      <Text style={styles.progressLabel}>{`Next game: ${text}`}</Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.round((available / total) * 100)}%` }]} />
      </View>
      <Text style={styles.caption}>
        {`${plural(game.availability.noResponse, 'player')} without an answer yet. Availability is not attendance.`}
      </Text>
    </View>
  );
}

type MarkState = Schema<'AttendanceMarkState'>;
const MARK_LABELS: Record<'present' | 'absent', string> = { present: 'Present', absent: 'Absent' };

export const ATTENDANCE_KEY = ['api', '/fixtures/{id}/attendance'] as const;

export function MatchCheckIn({
  workspace,
  viewer,
  game,
}: {
  workspace: Workspace;
  viewer: Viewer;
  game: Upcoming;
}) {
  const styles = useStyles();
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const fixtureId = game.fixture.id;
  const entryId = workspace.entry.id;
  const scheduled = game.fixture.status === 'scheduled';
  const enabled = viewer.actingAsCaptain && scheduled;
  const attendance = useApiQuery({
    path: '/fixtures/{id}/attendance',
    request: { path: { id: fixtureId } },
    enabled,
  });
  const marks = useKeyedCommands('post', '/fixtures/{id}/attendance', {
    invalidate: [ATTENDANCE_KEY, ['api', '/fixtures/{id}/match-sheet']],
  });
  /** What was last sent for each player: "Try again" resends exactly that (same intent). */
  const lastSent = useRef(new Map<string, MarkState>());
  if (!enabled) return null;
  const players = workspace.roster.filter((m) => isCurrentPlayer(m, now));
  const side = attendance.data?.sides.find((s) => s.teamEntryId === entryId);
  const markOf = (personId: string) =>
    side?.marks.find((m) => m.personId === personId)?.state ?? null;
  const send = (personId: string, state: MarkState) => {
    lastSent.current.set(personId, state);
    void marks.submit(personId, {
      path: { id: fixtureId },
      body: { teamEntryId: entryId, personId, state },
    });
  };
  return (
    <View testID="match-check-in">
      {attendance.data === undefined ? (
        attendance.error ? (
          <CommandFailure
            read
            error={attendance.error}
            onRetry={() => void attendance.refetch()}
            unavailableText="Check-in is not available for this game."
            testID="check-in-error"
          />
        ) : (
          <Body muted>Loading check-in…</Body>
        )
      ) : (
        <>
          <Detail
            label="Checked in"
            value={`${side?.present ?? 0} present, ${side?.absent ?? 0} absent, of ${plural(players.length, 'player')}`}
            testID="check-in-count"
          />
          <View accessibilityRole="list">
            {players.map((p) => {
              const mark = markOf(p.personId);
              const state = marks.states[p.personId];
              const busy = state?.status === 'processing';
              return (
                <View key={p.personId} style={styles.player} testID={`check-in-${p.personId}`}>
                  <Text style={styles.playerName}>
                    {p.jerseyNumber !== null
                      ? `${p.displayName} · #${p.jerseyNumber}`
                      : p.displayName}
                  </Text>
                  <StatusBadge
                    tone={
                      mark === 'present' ? 'success' : mark === 'absent' ? 'neutral' : 'pending'
                    }
                    label={mark && mark !== 'cleared' ? MARK_LABELS[mark] : 'Not checked in'}
                  />
                  <View style={styles.markButtons}>
                    {(['present', 'absent'] as const).map((s) => (
                      <Button
                        key={s}
                        label={`${MARK_LABELS[s]}: ${p.displayName}`}
                        variant={mark === s ? 'primary' : 'secondary'}
                        onPress={() => send(p.personId, s)}
                        disabled={offline || busy || mark === s}
                        busy={busy}
                      />
                    ))}
                    {mark ? (
                      <Button
                        label={`Clear: ${p.displayName}`}
                        variant="secondary"
                        onPress={() => send(p.personId, 'cleared')}
                        disabled={offline || busy}
                      />
                    ) : null}
                  </View>
                  {state?.status === 'failed' ? (
                    <CommandFailure
                      error={state.error}
                      onRetry={() =>
                        send(p.personId, lastSent.current.get(p.personId) ?? 'present')
                      }
                      unavailableText="Check-in is not available for this player."
                      testID={`check-in-failure-${p.personId}`}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
          {offline ? <OfflineNotice what="Checking players in" /> : null}
          <Body muted>
            Mark your own team only. The referee or league staff confirm the match sheet.
          </Body>
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  form: { flexDirection: 'row', gap: 6, paddingTop: spacing.sm },
  formPill: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formText: { ...fonts.extrabold, fontSize: 14, lineHeight: 18 },
  tableHead: { flexDirection: 'row', paddingVertical: spacing.xs },
  headText: { ...type.eyebrow, color: colors.textMuted },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  ownRow: { backgroundColor: colors.surface },
  ownText: { ...fonts.bold },
  cellPos: { ...type.body, width: 28, color: colors.text },
  cellTeam: { ...type.body, flex: 1, color: colors.text },
  cellNum: { ...type.body, width: 44, textAlign: 'right', color: colors.text },
  playoffLine: {
    borderTopWidth: 2,
    borderTopColor: colors.primary,
    borderStyle: 'dashed',
    paddingVertical: 2,
  },
  playoffText: { ...type.caption, ...fonts.bold, color: colors.primary },
  progressLabel: { ...type.body, ...fonts.bold, color: colors.text },
  track: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    marginVertical: spacing.xs,
  },
  fill: { height: 8, backgroundColor: colors.primary },
  caption: { ...type.caption, color: colors.textMuted },
  player: {
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  playerName: { ...type.body, ...fonts.bold, color: colors.text },
  markButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
}));
