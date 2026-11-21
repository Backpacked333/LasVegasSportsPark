/**
 * Game day, the top of the game page (redesign handoff M 1i; INTERACTIONS 1i rows 1 to 5;
 * SPK-CAP-003, SPK-SCHED-008, SPK-RESULT-001, SPK-RESULT-003, SPK-UX-009; ADR-008, **Proposed**):
 *
 * - A scoreboard band on the team's pitch colour, under the status bar: back, "Fall season · U9 ·
 *   Week 7" and Share (the system share sheet with the game, the time and the place); both teams
 *   (initials discs, the viewer's side in floodlight) with each one's place and record from the
 *   division's table ("2nd · 5-1-1", won-drawn-lost); the kickoff time on the venue's clock with
 *   the live countdown ("in 2 h 15 min", "Now"), or the score once there is a result; and a night
 *   card with the field and facility and "Map" (the device's maps app at the facility address; no
 *   gate pins and no arrival time exist in the API: "arrive by" is POL-046, pending).
 * - "Who's playing": the side's answers as one bar and in words (going, maybe, not going, no
 *   answer: `FixtureSide.availability`), then the household person's answer as one line ("Maya is
 *   going" with Change); Change, or no answer yet, shows the answer control (`GameAnswer`, the same
 *   as Home: one shared answer). "Enough to play" needs a players-needed figure per game:
 *   **Pending decision** (`PROPOSED.playersNeeded`), hidden.
 * - "Check in" opens the pass on that person (row 4); "Team chat" needs a messaging API:
 *   **Proposed** (`PROPOSED.teamChat`), shown disabled with the "Proposed" tag. "Message the coach"
 *   opens M 4d in its proposed state.
 * - Standings: the viewer's side's recent form (W/D/L, oldest first) and the division's table with
 *   the viewer's row highlighted and the playoff cut as a dashed line; the card opens the full
 *   standings and results (row 5, `/team/{entryId}/standings`).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useContext, useState } from 'react';
import { Linking, Platform, Pressable, Share, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useApiQuery } from '../../api/useApiQuery';
import { answerSentence, recordedAnswer, type Answer } from '../../features/home/answers';
import { GameAnswer } from '../../features/home/GameAnswer';
import { holds, useHousehold, type HouseholdPerson } from '../../features/home/household';
import { PROPOSED } from '../../features/home/proposed';
import { countdown } from '../../features/home/when';
import { teamRoutes } from '../../features/teams/routes';
import { venueOf } from '../../features/today/fixture-model';
import { useFacility } from '../../features/today/queries';
import { formatTime, formatWhen } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { Avatar, initialsFor } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { personColorOf } from '../../ui/person-colors';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  elevation,
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from '../../ui/theme';
import { mapsQuery } from '../home/TodayHero';
import { FormGuide, MiniStandings, useStandings } from '../teams/WorkspaceExtras';

type FixtureDetail = Schema<'FixtureDetail'>;
type FixtureSide = Schema<'FixtureSide'>;
type Workspace = Schema<'TeamEntryWorkspace'>;
type ResultRevision = Schema<'ResultRevision'>;
type StandingsRow = Schema<'StandingsRow'>;

/** "DF" for "Desert Foxes U9": the first letters of the first two words, age groups left out. */
export function teamInitials(name: string): string {
  const words = name.split(/\s+/u).filter((w) => /^\p{L}/u.test(w) && !/^U\d+$/iu.test(w));
  const picked = words.length > 0 ? words.slice(0, 2) : [initialsFor(name)];
  return picked
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

/** "Desert Foxes" for "Desert Foxes U9": the band names the team without its age group. */
export function shortTeamName(name: string): string {
  return name.replace(/\s+U\d+$/iu, '').trim() || name;
}

const ORDINALS = ['th', 'st', 'nd', 'rd'];
export function ordinal(n: number): string {
  const v = n % 100;
  return `${n}${ORDINALS[(v - 20) % 10] ?? ORDINALS[v] ?? ORDINALS[0]}`;
}

/** "2nd · 5-1-1": place and won-drawn-lost from the division's table. */
export function recordLine(row: StandingsRow | undefined): string | null {
  if (!row) return null;
  return `${ordinal(row.position)} · ${row.won}-${row.drawn}-${row.lost}`;
}

function TeamDisc({ name, mine }: { name: string; mine: boolean }) {
  const styles = useStyles();
  return (
    <View style={[styles.disc, mine ? styles.discMine : null]}>
      <Text style={[styles.discText, mine ? styles.discTextMine : null]}>{teamInitials(name)}</Text>
    </View>
  );
}

function TeamColumn({
  name,
  mine,
  row,
}: {
  name: string;
  mine: boolean;
  row: StandingsRow | undefined;
}) {
  const styles = useStyles();
  const record = recordLine(row);
  return (
    <View
      style={styles.team}
      accessible
      accessibilityLabel={[
        name,
        mine ? 'your team' : null,
        row
          ? `${ordinal(row.position)} place, ${row.won} won, ${row.drawn} drawn, ${row.lost} lost`
          : null,
      ]
        .filter(Boolean)
        .join(', ')}
    >
      <TeamDisc name={name} mine={mine} />
      <Text style={styles.teamName} numberOfLines={2}>
        {shortTeamName(name)}
      </Text>
      {record ? <Text style={styles.record}>{record}</Text> : null}
    </View>
  );
}

/**
 * Whose answer "Who's playing" shows: the household child who plays (their answer is listed for
 * this guardian). A viewer who plays themselves answers in the game's details below (the RSVP).
 */
export function answeringPerson(
  fixture: FixtureDetail,
  workspace: Workspace | undefined,
  people: readonly HouseholdPerson[],
): HouseholdPerson | undefined {
  const memberIds = new Set((workspace?.roster ?? []).map((m) => m.personId));
  const responseIds = new Set((fixture.responses ?? []).map((r) => r.personId));
  return people.find((p) => !p.self && (memberIds.has(p.id) || responseIds.has(p.id)));
}

export function GameDay({
  fixture,
  mine,
  workspace,
  zone,
  result,
}: {
  fixture: FixtureDetail;
  mine: 'home' | 'away' | null;
  workspace: Workspace | undefined;
  zone: string;
  /** The current result (official, else submitted), when there is one. */
  result?: ResultRevision | null;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  // Absent outside a SafeAreaProvider (a screen rendered on its own in a test).
  const insets = useContext(SafeAreaInsetsContext);
  const now = useNow(30_000);
  const { people, selfId } = useHousehold();
  const venue = venueOf(fixture);
  const facility = useFacility(venue?.facilityId ?? null);
  // The division's table (the same read as the standings card, so one cached answer).
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: {
      path: { id: workspace?.season.id ?? '' },
      query: workspace?.division ? { divisionId: workspace.division.id } : {},
    },
    enabled: !!workspace,
  });
  const table = workspace ? standings.data : undefined;
  const rowOf = (entryId: string | undefined) =>
    entryId ? table?.rows.find((r) => r.teamEntryId === entryId) : undefined;
  const side: FixtureSide | null =
    mine === 'home' ? fixture.home : mine === 'away' ? (fixture.away ?? null) : null;
  const person = answeringPerson(fixture, workspace, people);
  const [changing, setChanging] = useState(false);
  const field = venue?.resources[0]?.name ?? 'Field not set yet';
  const query = mapsQuery(facility.data, venue?.facilityName ?? null);
  const c =
    fixture.scheduledStart && fixture.scheduledEnd
      ? countdown(fixture.scheduledStart, fixture.scheduledEnd, now, zone)
      : null;
  const a = side?.availability;
  const total = a ? a.available + a.tentative + a.unavailable + a.noResponse : 0;
  const pct = (n: number): `${number}%` => `${total > 0 ? (n / total) * 100 : 0}%`;
  const title = [
    workspace?.season.name,
    workspace?.division?.name,
    fixture.round ? `Week ${fixture.round}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const scored =
    result && result.homeScore !== null && result.awayScore !== null
      ? `${result.homeScore} – ${result.awayScore}`
      : null;
  const kickoff = fixture.scheduledStart ? formatTime(fixture.scheduledStart, zone) : null;
  const share = () => {
    const words = [
      `${fixture.home.teamName} vs ${fixture.away?.teamName ?? 'Bye'}`,
      fixture.scheduledStart ? formatWhen(fixture.scheduledStart, zone) : null,
      venue ? `${field}, ${venue.facilityName}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    void Share.share({ message: words }).catch(() => undefined);
  };
  const recorded = person ? recordedAnswer(fixture, person.id, selfId).state : null;
  const answered: Answer | null =
    recorded === 'available' || recorded === 'tentative' || recorded === 'unavailable'
      ? recorded
      : null;

  return (
    <View testID="game-day">
      <View style={[styles.band, { paddingTop: (insets?.top ?? 0) + spacing.xs }]}>
        <View style={styles.bar}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={4}
            style={styles.barButton}
            testID="game-day-back"
          >
            <Icon name="arrow_back" size={24} color={theme.colors.onNight} />
          </Pressable>
          <Text style={styles.barTitle} numberOfLines={1} accessibilityRole="header">
            {title || 'Game day'}
          </Text>
          <Pressable
            onPress={share}
            accessibilityRole="button"
            accessibilityLabel="Share the game"
            hitSlop={4}
            style={styles.barButton}
            testID="game-day-share"
          >
            <Icon name="ios_share" size={22} color={theme.colors.onNight} />
          </Pressable>
        </View>
        <View style={styles.teams}>
          <TeamColumn
            name={fixture.home.teamName}
            mine={mine === 'home'}
            row={rowOf(fixture.home.entryId)}
          />
          <View
            style={styles.center}
            accessible
            accessibilityLabel={
              scored
                ? `Score ${scored}`
                : `Kickoff ${kickoff ?? 'not set'}${c && c.state !== 'upcoming' ? `, ${c.label}` : ''}`
            }
          >
            <Text style={styles.time}>
              {scored ?? (kickoff ? kickoff.replace(/\s?[AP]M$/u, '') : '–')}
            </Text>
            {scored ? (
              <View style={styles.countdown}>
                <Text style={styles.countdownText}>
                  {result?.status === 'official' ? 'Final' : 'Provisional'}
                </Text>
              </View>
            ) : c && c.state !== 'over' ? (
              <View style={styles.countdown} testID="game-day-countdown">
                <Text style={styles.countdownText}>
                  {c.state === 'today'
                    ? c.label.replace(/^Today · /u, '')
                    : c.label.split(' · ')[0]}
                </Text>
              </View>
            ) : null}
          </View>
          <TeamColumn
            name={fixture.away?.teamName ?? 'Bye'}
            mine={mine === 'away'}
            row={rowOf(fixture.away?.entryId)}
          />
        </View>
        <View style={styles.fieldCard}>
          <Icon name="location_on" size={20} color={theme.colors.floodlight} />
          <Text style={styles.fieldText}>
            <Text style={styles.fieldStrong}>{field}</Text>
            {venue ? `, ${venue.facilityName}` : ''}
          </Text>
          <Pressable
            onPress={() => {
              if (!query) return;
              const q = encodeURIComponent(query);
              void Linking.openURL(
                Platform.select({
                  ios: `maps:0,0?q=${q}`,
                  android: `geo:0,0?q=${q}`,
                  default: `https://maps.apple.com/?q=${q}`,
                }),
              ).catch(() => undefined);
            }}
            disabled={!query}
            accessibilityRole="button"
            accessibilityLabel="Map"
            accessibilityHint="Opens your maps app at the facility"
            style={styles.map}
            hitSlop={8}
          >
            <Text style={styles.mapText}>Map</Text>
          </Pressable>
        </View>
      </View>

      {side && a ? (
        <View style={[elevation(theme, 'raised'), styles.card]} testID="game-day-playing">
          <View style={styles.cardHead}>
            <Text variant="title3" accessibilityRole="header">
              Who&apos;s playing
            </Text>
          </View>
          <View
            style={styles.track}
            accessible
            accessibilityLabel={`${a.available} going, ${a.tentative} maybe, ${a.unavailable} not going, ${a.noResponse} no answer`}
          >
            <View
              style={[
                styles.segment,
                { width: pct(a.available), backgroundColor: theme.colors.primary },
              ]}
            />
            <View
              style={[
                styles.segment,
                { width: pct(a.tentative), backgroundColor: theme.colors.floodlight },
              ]}
            />
            <View
              style={[
                styles.segment,
                { width: pct(a.unavailable), backgroundColor: theme.colors.danger },
              ]}
            />
          </View>
          <View style={styles.counts} accessibilityElementsHidden>
            <Text variant="footnote" tone="muted">
              <Text style={[styles.count, { color: theme.colors.success }]}>{a.available}</Text>{' '}
              going
            </Text>
            <Text variant="footnote" tone="muted">
              <Text style={styles.count}>{a.tentative}</Text> maybe
            </Text>
            <Text variant="footnote" tone="muted">
              <Text style={[styles.count, { color: theme.colors.danger }]}>{a.unavailable}</Text>{' '}
              not going
            </Text>
            <Text variant="footnote" tone="muted">{`${a.noResponse} no answer`}</Text>
          </View>
          {person && answered && !changing ? (
            <View style={styles.mine} testID="game-day-my-answer">
              <Avatar
                name={person.givenName}
                id={person.id}
                personColor={personColorOf(theme, person.slot)}
                size={36}
                decorative
              />
              <Text style={styles.mineText}>
                {answerSentence(person.givenName, person.self, answered)}
              </Text>
              <Pressable
                onPress={() => setChanging(true)}
                accessibilityRole="button"
                accessibilityLabel={`Change ${person.self ? 'your' : `${person.givenName}'s`} answer`}
                style={styles.change}
                hitSlop={8}
              >
                <Text style={styles.changeText}>Change</Text>
              </Pressable>
            </View>
          ) : person ? (
            <GameAnswer
              fixture={fixture}
              side={side}
              personId={person.id}
              personName={person.givenName}
              self={person.self}
              selfId={selfId}
              mayAnswer={person.self || (PROPOSED.guardianAnswers && holds(person, 'register'))}
              now={now}
              testID="game-day-answer"
            />
          ) : null}
        </View>
      ) : null}

      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button
            label="Check in"
            accessibilityLabel={
              person && !person.self ? `Check in with ${person.givenName}'s pass` : 'Check in'
            }
            icon="qr_code_2"
            block
            onPress={() =>
              router.push(
                (person ? { pathname: '/pass', params: { person: person.id } } : '/pass') as Href,
              )
            }
            testID="game-day-check-in"
          />
        </View>
        {PROPOSED.teamChat ? null : (
          <View style={[styles.flex, styles.proposed]} testID="game-day-team-chat">
            <Button
              label="Team chat"
              icon="chat"
              variant="secondary"
              block
              disabled
              onPress={() => undefined}
            />
            <StatusBadge tone="pending" label="Proposed" />
          </View>
        )}
      </View>
      <Pressable
        onPress={() =>
          router.push({ pathname: '/messages/coach', params: { fixtureId: fixture.id } } as Href)
        }
        accessibilityRole="link"
        accessibilityLabel="Message the coach"
        style={styles.link}
        testID="game-day-message-coach"
      >
        <Icon name="forum" size={18} color={theme.colors.primary} />
        <Text style={styles.linkText}>Message the coach</Text>
      </Pressable>

      {workspace ? <StandingsCard workspace={workspace} /> : null}
    </View>
  );
}

/** Form and the division's table, once the season has official results to stand on (row 5). */
function StandingsCard({ workspace }: { workspace: Workspace }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const standings = useStandings(workspace);
  const data = standings.data;
  if (!data || data.sourceResultIds.length === 0 || data.rows.length === 0) return null;
  return (
    <Pressable
      onPress={() => router.push(teamRoutes.standings(workspace.entry.id) as Href)}
      accessibilityRole="button"
      accessibilityLabel="Standings"
      accessibilityHint="Opens the full standings and results"
      style={({ pressed }) => [
        elevation(theme, 'card'),
        styles.card,
        styles.standings,
        pressed ? styles.pressed : null,
      ]}
      testID="game-day-standings"
    >
      <View style={styles.cardHead}>
        <Text style={styles.standingsTitle}>Standings</Text>
        <FormGuide workspace={workspace} variant="card" />
      </View>
      <MiniStandings workspace={workspace} variant="card" />
    </Pressable>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  band: {
    backgroundColor: colors.pitch,
    paddingHorizontal: layout.gutter,
    paddingBottom: 22,
    gap: spacing.md,
  },
  bar: { flexDirection: 'row', alignItems: 'center', marginHorizontal: -spacing.sm },
  barButton: {
    width: MIN_TOUCH_SIZE,
    height: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barTitle: {
    flex: 1,
    textAlign: 'center',
    ...fonts.semibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.onNightBody,
  },
  teams: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  team: { flex: 1, alignItems: 'center', gap: spacing.sm },
  disc: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.onNightBody,
  },
  discMine: { backgroundColor: colors.floodlight, borderColor: colors.floodlight },
  discText: { ...fonts.extrabold, fontSize: 22, color: colors.onNight },
  discTextMine: { color: colors.onFloodlight },
  teamName: {
    ...fonts.bold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.onNight,
    textAlign: 'center',
  },
  record: { ...fonts.regular, fontSize: 12, lineHeight: 16, color: colors.onNightBody },
  center: { alignItems: 'center', gap: 6, paddingHorizontal: spacing.sm },
  time: { ...tabular(type.largeTitle), ...fonts.extrabold, color: colors.onNight },
  countdown: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.night,
  },
  countdownText: { ...fonts.bold, fontSize: 12, lineHeight: 16, color: colors.floodlight },
  fieldCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: colors.night,
    marginTop: spacing.xs,
  },
  fieldText: { flex: 1, ...type.callout, color: colors.onNightBody },
  fieldStrong: { ...fonts.bold, color: colors.onNight },
  map: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  mapText: { ...fonts.semibold, fontSize: 14, color: colors.floodlight },
  card: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.lg,
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: radius.lg,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  track: {
    flexDirection: 'row',
    height: 10,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  segment: { height: 10 },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  count: { ...fonts.bold, color: colors.text },
  mine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.page,
  },
  mineText: { flex: 1, ...fonts.semibold, fontSize: 15, lineHeight: 20, color: colors.text },
  change: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  changeText: { ...fonts.semibold, fontSize: 14, color: colors.primary },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: layout.gutter,
    marginTop: spacing.md,
    alignItems: 'flex-start',
  },
  flex: { flex: 1 },
  proposed: { gap: spacing.xs, alignItems: 'center' },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'center',
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
  },
  linkText: { ...fonts.semibold, fontSize: 15, color: colors.primary },
  standings: { paddingVertical: 14, gap: 10, marginTop: spacing.sm },
  standingsTitle: { ...fonts.semibold, fontSize: 17, lineHeight: 22, color: colors.text },
  pressed: { opacity: 0.8 },
}));
