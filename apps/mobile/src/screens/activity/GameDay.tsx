/**
 * Game day, the top of the game page (redesign handoff M 1i; INTERACTIONS 1i rows 1 to 5;
 * SPK-CAP-003, SPK-SCHED-008, SPK-RESULT-003, SPK-UX-009):
 *
 * - A scoreboard band on the team's pitch colour: both teams (initials discs, the viewer's side in
 *   floodlight), the kickoff time on the venue's clock with the live countdown ("in 2 h 15 min",
 *   "Now"), and a night card with the field and facility and "Map" (the device's maps app at the
 *   facility address; no gate pins exist in the API).
 * - "Who's playing": the side's answers as one bar and in words (going, maybe, not going, no
 *   answer: `FixtureSide.availability`), and the household child's answer control (the same
 *   `GameAnswer` as Home, so both screens share one answer). "Enough to play" needs a
 *   players-needed figure per game: **Pending decision** (`PROPOSED.playersNeeded`), hidden.
 * - "Check in with Maya's pass" opens the pass on that child; "Team chat" needs a messaging API:
 *   **Proposed** (`PROPOSED.teamChat`), shown disabled with the "Proposed" tag.
 * - The viewer's side's recent form and mini standings with the playoff line (`FormGuide`,
 *   `MiniStandings`, from the team workspace the viewer may read).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { Linking, Platform, Pressable, View } from 'react-native';
import { GameAnswer } from '../../features/home/GameAnswer';
import { holds, useHousehold } from '../../features/home/household';
import { PROPOSED } from '../../features/home/proposed';
import { countdown } from '../../features/home/when';
import { venueOf } from '../../features/today/fixture-model';
import { useFacility } from '../../features/today/queries';
import { formatTime } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { initialsFor } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  elevation,
  fonts,
  layout,
  makeStyles,
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

/** "DF" for "Desert Foxes U9": the first letters of the first two words, age groups left out. */
export function teamInitials(name: string): string {
  const words = name.split(/\s+/u).filter((w) => /^\p{L}/u.test(w) && !/^U\d+$/iu.test(w));
  const picked = words.length > 0 ? words.slice(0, 2) : [initialsFor(name)];
  return picked
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

function TeamDisc({ name, mine }: { name: string; mine: boolean }) {
  const styles = useStyles();
  return (
    <View style={[styles.disc, mine ? styles.discMine : null]}>
      <Text style={[styles.discText, mine ? styles.discTextMine : null]}>{teamInitials(name)}</Text>
    </View>
  );
}

export function GameDay({
  fixture,
  mine,
  workspace,
  zone,
}: {
  fixture: FixtureDetail;
  mine: 'home' | 'away' | null;
  workspace: Workspace | undefined;
  zone: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const now = useNow(30_000);
  const { people, selfId } = useHousehold();
  const venue = venueOf(fixture);
  const facility = useFacility(venue?.facilityId ?? null);
  const side: FixtureSide | null =
    mine === 'home' ? fixture.home : mine === 'away' ? (fixture.away ?? null) : null;
  const memberIds = new Set((workspace?.roster ?? []).map((m) => m.personId));
  const responseIds = new Set((fixture.responses ?? []).map((r) => r.personId));
  // The household child who plays (their answer is listed for this guardian), else nobody.
  const child = people.find((p) => !p.self && (memberIds.has(p.id) || responseIds.has(p.id)));
  const field = venue?.resources[0]?.name ?? 'Field not set yet';
  const query = mapsQuery(facility.data, venue?.facilityName ?? null);
  const c =
    fixture.scheduledStart && fixture.scheduledEnd
      ? countdown(fixture.scheduledStart, fixture.scheduledEnd, now, zone)
      : null;
  const a = side?.availability;
  const total = a ? a.available + a.tentative + a.unavailable + a.noResponse : 0;
  const pct = (n: number): `${number}%` => `${total > 0 ? (n / total) * 100 : 0}%`;
  return (
    <View testID="game-day">
      <View style={styles.band}>
        <View style={styles.teams}>
          <View style={styles.team}>
            <TeamDisc name={fixture.home.teamName} mine={mine === 'home'} />
            <Text style={styles.teamName} numberOfLines={2}>
              {fixture.home.teamName}
            </Text>
          </View>
          <View
            style={styles.center}
            accessible
            accessibilityLabel={`Kickoff ${fixture.scheduledStart ? formatTime(fixture.scheduledStart, zone) : 'not set'}${c && c.state !== 'upcoming' ? `, ${c.label}` : ''}`}
          >
            <Text style={styles.time}>
              {fixture.scheduledStart
                ? formatTime(fixture.scheduledStart, zone).replace(/\s?[AP]M$/u, '')
                : '–'}
            </Text>
            {c && c.state !== 'over' ? (
              <View style={styles.countdown} testID="game-day-countdown">
                <Text style={styles.countdownText}>
                  {c.state === 'today'
                    ? c.label.replace(/^Today · /u, '')
                    : c.label.split(' · ')[0]}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.team}>
            <TeamDisc name={fixture.away?.teamName ?? 'Bye'} mine={mine === 'away'} />
            <Text style={styles.teamName} numberOfLines={2}>
              {fixture.away?.teamName ?? 'Bye'}
            </Text>
          </View>
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
              Who's playing
            </Text>
          </View>
          <View
            style={styles.bar}
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
          <Text variant="footnote" tone="muted">
            {`${a.available} going · ${a.tentative} maybe · ${a.unavailable} not going · ${a.noResponse} no answer`}
          </Text>
          {child ? (
            <GameAnswer
              fixture={fixture}
              side={side}
              personId={child.id}
              personName={child.givenName}
              self={false}
              selfId={selfId}
              mayAnswer={PROPOSED.guardianAnswers && holds(child, 'register')}
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
            accessibilityLabel={child ? `Check in with ${child.givenName}'s pass` : 'Check in'}
            icon="qr_code_2"
            block
            onPress={() =>
              router.push(
                (child ? { pathname: '/pass', params: { person: child.id } } : '/pass') as Href,
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

      {workspace ? <StandingsCard workspace={workspace} /> : null}
    </View>
  );
}

/** Form and mini standings, shown once the season has official results to stand on. */
function StandingsCard({ workspace }: { workspace: Workspace }) {
  const styles = useStyles();
  const theme = useTheme();
  const standings = useStandings(workspace);
  const data = standings.data;
  if (!data || data.sourceResultIds.length === 0 || data.rows.length === 0) return null;
  return (
    <View style={[elevation(theme, 'raised'), styles.card]} testID="game-day-standings">
      <Text variant="title3" accessibilityRole="header">
        Standings
      </Text>
      <FormGuide workspace={workspace} />
      <MiniStandings workspace={workspace} />
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  band: {
    backgroundColor: colors.pitch,
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  teams: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  team: { flex: 1, alignItems: 'center', gap: spacing.xs },
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
  discText: { ...fonts.bold, fontSize: 22, color: colors.onNight },
  discTextMine: { color: colors.onFloodlight },
  teamName: {
    ...fonts.bold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.onNight,
    textAlign: 'center',
  },
  center: { alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm },
  time: { ...tabular(type.largeTitle), fontSize: 40, lineHeight: 46, color: colors.onNight },
  countdown: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.night,
  },
  countdownText: { ...fonts.bold, fontSize: 13, lineHeight: 18, color: colors.floodlight },
  fieldCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.night,
  },
  fieldText: { flex: 1, ...type.callout, color: colors.onNightBody },
  fieldStrong: { ...fonts.bold, color: colors.onNight },
  map: { minHeight: 44, justifyContent: 'center' },
  mapText: { ...fonts.bold, fontSize: 15, color: colors.floodlight },
  card: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.xl,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  segment: { height: 10 },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: layout.gutter,
    marginTop: spacing.lg,
    alignItems: 'flex-start',
  },
  flex: { flex: 1 },
  proposed: { gap: spacing.xs, alignItems: 'center' },
}));
