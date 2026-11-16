/**
 * The person blocks of SCR-C-03 Home, in the order `homeLayout()` decides (ADR-008; PA-11
 * **Proposed**):
 *
 * - **Family this week** (a parent): one card per family member the family calendar includes, with
 *   their next activity in the next seven days, from the reads Home already made. Opens Calendar
 *   filtered to that person (SCR-C-18, which absorbed the family calendar, SCR-C-19).
 * - **My team** (a player): one card per team the person plays on (`GET /v1/me/team-entries`):
 *   the next game as the API lists it (`nextFixture`, on the venue's clock), the official standing
 *   (`GET /v1/seasons/{id}/standings`, shown only once official results exist) and, when a captain
 *   asked the person to pay part of a team fee, "Your share" (`GET /v1/me/contribution-requests`).
 *   Opens the team. The contribution read gives no due date, so none is shown.
 *
 * Every card is one element with one name (SPK-UX-009). Nothing here decides who may see what.
 */
import { formatMinorUnits, type Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { entryPersonIds, type TodayEntry } from '../../features/today/entries';
import { nameOf } from '../../features/today/queries';
import { formatWhen, zoneOf } from '../../features/today/time';
import { ordinal } from '../../features/teams/format';
import { Avatar } from '../../ui/Avatar';
import { Card } from '../../ui/Card';
import { ListRow } from '../../ui/ListRow';
import { Section } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { makeStyles, spacing } from '../../ui/theme';

type MyTeamEntry = Schema<'MyTeamEntry'>;

const WEEK_MS = 7 * 86_400_000;

/** "Sat, Oct 24, 10:00 AM PDT · Junior Skills" on the activity's own clock (SPK-SCHED-008). */
export function entryLine(entry: TodayEntry): string {
  const title =
    entry.type === 'session'
      ? entry.item.title
      : `${entry.fixture.home.teamName} vs ${entry.fixture.away?.teamName ?? 'Bye'}`;
  return `${formatWhen(entry.start, entry.zone.zone)} · ${title}`;
}

/** The soonest activity of each person within the next seven days, or null. */
export function nextThisWeek(
  personId: string,
  entries: readonly TodayEntry[],
  teams: readonly MyTeamEntry[] | undefined,
  now: Date,
): TodayEntry | null {
  const until = now.getTime() + WEEK_MS;
  return (
    entries.find(
      (e) => new Date(e.start).getTime() < until && entryPersonIds(e, teams).includes(personId),
    ) ?? null
  );
}

export function FamilyThisWeek({
  personIds,
  entries,
  teams,
  names,
  now,
}: {
  personIds: readonly string[];
  entries: readonly TodayEntry[];
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
  now: Date;
}) {
  const router = useRouter();
  const styles = useStyles();
  return (
    <Section title="Family this week" variant="plain" testID="home-family">
      {personIds.map((personId) => {
        const name = nameOf(names, personId);
        const next = nextThisWeek(personId, entries, teams, now);
        const line = next ? entryLine(next) : 'Nothing this week';
        return (
          <Card
            key={personId}
            elevation="card"
            onPress={() =>
              router.push({ pathname: '/schedule', params: { person: personId } } as Href)
            }
            accessibilityLabel={`${name}. Next: ${line}`}
            accessibilityHint={`Opens Calendar for ${name}`}
            testID={`home-family-${personId}`}
          >
            <View style={styles.person}>
              <Avatar name={name} id={personId} decorative />
              <View style={styles.words}>
                <Text variant="headline">{name}</Text>
                <Text variant="footnote" tone="muted">
                  {line}
                </Text>
              </View>
            </View>
          </Card>
        );
      })}
    </Section>
  );
}

/** "2nd of 8", or null while it is loading, not available or not official yet. */
function useStanding(team: MyTeamEntry): string | null {
  const divisionId = team.teamEntry.divisionId;
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: { path: { id: team.seasonId }, query: divisionId ? { divisionId } : {} },
  });
  const data = standings.data;
  const row = data?.rows.find((r) => r.teamEntryId === team.teamEntry.id);
  if (!data || !row || data.sourceResultIds.length === 0) return null;
  return `${ordinal(row.position)} of ${data.rows.length}`;
}

function nextGameLine(team: MyTeamEntry): string {
  const next = team.nextFixture;
  if (!next?.scheduledStart) return 'No game scheduled yet';
  const zone = zoneOf(next.venue?.timezone).zone;
  const against = next.opponentTeamName ? `vs ${next.opponentTeamName}` : 'Game';
  return `${against} · ${formatWhen(next.scheduledStart, zone)}`;
}

function TeamCard({ team }: { team: MyTeamEntry }) {
  const router = useRouter();
  const styles = useStyles();
  const standing = useStanding(team);
  const next = nextGameLine(team);
  const league = team.divisionName ?? team.seasonName;
  return (
    <Card
      elevation="card"
      onPress={() => router.push(`/team/${team.teamEntry.id}` as Href)}
      accessibilityLabel={[
        team.teamName,
        league,
        `Next: ${next}`,
        standing && `Standing: ${standing}`,
      ]
        .filter(Boolean)
        .join('. ')}
      accessibilityHint="Opens the team"
      testID={`home-team-${team.teamEntry.id}`}
    >
      <View style={styles.words}>
        <Text variant="title3">{team.teamName}</Text>
        <Text variant="footnote" tone="muted">
          {league}
        </Text>
        <Text variant="callout">{`Next: ${next}`}</Text>
        {standing ? <Text variant="callout" tabular>{`Standing: ${standing}`}</Text> : null}
      </View>
    </Card>
  );
}

export function MyTeam({ teams }: { teams: readonly MyTeamEntry[] }) {
  const router = useRouter();
  const shares = useApiQuery({
    path: '/me/contribution-requests',
    request: { query: { limit: 20 } },
  });
  const share = shares.data?.items.find((c) => c.status === 'requested') ?? null;
  return (
    <Section title={teams.length > 1 ? 'My teams' : 'My team'} variant="plain" testID="home-team">
      {teams.map((team) => (
        <TeamCard key={team.teamEntry.id} team={team} />
      ))}
      {share ? (
        <ListRow
          title="Your share"
          value={formatMinorUnits(share.amountMinor, share.currency)}
          detail={share.obligation.description}
          onPress={() => router.push(`/team/contribution/${share.id}` as Href)}
          accessibilityHint="Opens what you were asked to pay"
          testID="home-team-share"
        />
      ) : null}
    </Section>
  );
}

const useStyles = makeStyles(() => ({
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  words: { flex: 1, gap: spacing.xxs },
}));
