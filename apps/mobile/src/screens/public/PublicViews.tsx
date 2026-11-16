/**
 * Public views in the customer app, without sign-in (SPK-SCHED-010, proposed amendment PA-06):
 * today's schedule of a facility and the standings of a public competition, reached from the
 * signed-out Discover screen. Everything starts from the organization configured for this build
 * (`organizationSlug`): `GET /v1/public/{organization}/directory` lists what the organization has
 * made public, by name and public code, and the views are read by those codes. No record id and
 * no person appears: the API's public shapes have neither.
 *
 * - Today's schedule: time, field and what occupies it. A private booking reads "Reserved"; a
 *   game shows team names only when its competition is public, else "League game" (the API
 *   decides the words).
 * - Standings: per division of the newest season of the chosen competition.
 *
 * States: loading; empty (nothing public; nothing scheduled); ready with "Last updated"; not
 * available (the organization has not turned public views on, or took the view down); offline
 * (the cached answer with its age, as every read in the app); error with retry; pull to refresh.
 *
 * Look (ADR-008 visual system v2): sections and rows of `src/ui`, a choice among several
 * facilities or competitions as chips.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant } from '../../features/teams/format';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ChipRow } from '../../ui/Chip';
import { FieldValue } from '../../ui/Field';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { makeStyles, spacing } from '../../ui/theme';

type Directory = Schema<'PublicDirectory'>;
type Entry = Schema<'PublicScheduleEntry'>;
type StandingsRow = Schema<'PublicStandingsRow'>;

export const publicRoutes = {
  schedule: '/public/schedule',
  standings: '/public/standings',
} as const;

const REFRESH_MS = 60_000;

function timeOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(
    new Date(iso),
  );
}

export function entryTitle(entry: Entry): string {
  return entry.score ? `${entry.title}, ${entry.score.home} to ${entry.score.away}` : entry.title;
}

export function entryDetail(entry: Entry, timeZone: string): string {
  const fields = entry.fields.length > 0 ? entry.fields.join(', ') : 'Field to be announced';
  return `${timeOf(entry.startsAt, timeZone)} to ${timeOf(entry.endsAt, timeZone)}, ${fields}`;
}

export function standingsRowText(row: StandingsRow): string {
  return `Played ${row.played}, won ${row.won}, drawn ${row.drawn}, lost ${row.lost}, goals ${row.goalsFor} to ${row.goalsAgainst}, ${row.points} points`;
}

function useSlug(): string | null {
  return useApp().services.config.organizationSlug ?? null;
}

function useDirectory(slug: string | null) {
  return useApiQuery({
    path: '/public/{organization}/directory',
    request: { path: { organization: slug ?? '' } },
    enabled: slug !== null,
    staleTime: REFRESH_MS,
  });
}

/**
 * Pull to refresh for a public screen: reads every public view on it again (the directory and
 * the schedule or standings below it).
 */
function usePublicRefresh() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    void queryClient
      .invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'api' &&
          typeof query.queryKey[1] === 'string' &&
          query.queryKey[1].startsWith('/public/'),
      })
      .finally(() => setRefreshing(false));
  };
  return { onRefresh, refreshing };
}

function Detail({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return <FieldValue label={label} value={value} layout="inline" testID={testID} />;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <Text variant="footnote" tone="muted">
      {children}
    </Text>
  );
}

function NoOrganization() {
  return (
    <Screen>
      <StateView
        variant="unavailable"
        title="Not available"
        description="This app is not set up for a facility's public pages."
      />
    </Screen>
  );
}

/** A choice among several public things (facilities, competitions), by name, as chips. */
function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ code: string; name: string }>;
  value: string;
  onChange: (code: string) => void;
}) {
  const styles = useStyles();
  if (options.length < 2) return null;
  return (
    <ChipRow
      mode="single"
      label={label}
      options={options.map((option) => ({ value: option.code, label: option.name }))}
      value={value}
      onChange={(code) => (code ? onChange(code) : undefined)}
      style={styles.choice}
    />
  );
}

/**
 * Today only: the read names no day, so it is always inside the days the API answers for (a
 * window around today, security review L-3) and the screen has no previous or next day control
 * that could leave it.
 */
function DaySchedule({ slug, code }: { slug: string; code: string }) {
  const schedule = useApiQuery({
    path: '/public/{organization}/schedule/{code}',
    request: { path: { organization: slug, code } },
    refetchInterval: REFRESH_MS,
  });
  return (
    <QueryBoundary
      query={schedule}
      label="today's schedule"
      isEmpty={(data) => data.entries.length === 0}
      empty={{ title: 'Nothing is scheduled today', description: 'Check again later.' }}
    >
      {(data) => (
        <Section title={`${data.facilityName} today`} testID="public-schedule">
          <View accessibilityRole="list">
            {data.entries.map((entry, index) => (
              <ListRow
                key={`${entry.startsAt}-${index}`}
                title={entryTitle(entry)}
                detail={entryDetail(entry, data.timezone)}
              />
            ))}
          </View>
          <Detail
            label="Last updated"
            value={formatInstant(data.computedAt, data.timezone)}
            testID="public-updated"
          />
          <Note>Times are in the facility&apos;s time zone.</Note>
        </Section>
      )}
    </QueryBoundary>
  );
}

export function PublicScheduleScreen() {
  const slug = useSlug();
  const directory = useDirectory(slug);
  const [chosen, setChosen] = useState<string | null>(null);
  const refresh = usePublicRefresh();
  if (slug === null) return <NoOrganization />;
  return (
    <Screen {...refresh}>
      <QueryBoundary
        query={directory}
        label="the public schedule"
        isEmpty={(data: Directory) => data.schedules.length === 0}
        empty={{
          title: 'No public schedule',
          description: 'This facility has not made its schedule public.',
        }}
      >
        {(data: Directory) => {
          const code = chosen ?? (data.schedules[0]?.code as string);
          return (
            <>
              <Choice
                label="Facility"
                options={data.schedules.map((s) => ({ code: s.code, name: s.facilityName }))}
                value={code}
                onChange={setChosen}
              />
              <DaySchedule slug={slug} code={code} />
            </>
          );
        }}
      </QueryBoundary>
    </Screen>
  );
}

function SeasonStandings({ slug, code }: { slug: string; code: string }) {
  const styles = useStyles();
  const season = useApiQuery({
    path: '/public/{organization}/seasons/{code}',
    request: { path: { organization: slug, code } },
    refetchInterval: REFRESH_MS,
  });
  return (
    <QueryBoundary
      query={season}
      label="the standings"
      isEmpty={(data) => data.divisions.every((division) => division.standings.length === 0)}
      empty={{ title: 'No standings yet', description: 'The table appears once teams are placed.' }}
    >
      {(data) => (
        <View style={styles.stack} testID="public-standings">
          {data.divisions
            .filter((division) => division.standings.length > 0)
            .map((division) => (
              <Section key={division.name} title={`${division.name}, ${data.seasonName}`}>
                <View accessibilityRole="list">
                  {division.standings.map((row) => (
                    <ListRow
                      key={row.team}
                      title={`${row.position}. ${row.team}`}
                      detail={standingsRowText(row)}
                    />
                  ))}
                </View>
              </Section>
            ))}
          <Detail label="Last updated" value={formatInstant(data.computedAt)} />
        </View>
      )}
    </QueryBoundary>
  );
}

function CompetitionStandings({ slug, code }: { slug: string; code: string }) {
  const competition = useApiQuery({
    path: '/public/{organization}/competitions/{code}',
    request: { path: { organization: slug, code } },
  });
  return (
    <QueryBoundary
      query={competition}
      label="the competition"
      isEmpty={(data) => data.seasons.length === 0}
      empty={{ title: 'No season yet', description: 'This competition has no open season.' }}
    >
      {(data) => <SeasonStandings slug={slug} code={data.seasons[0]?.code as string} />}
    </QueryBoundary>
  );
}

export function PublicStandingsScreen() {
  const slug = useSlug();
  const directory = useDirectory(slug);
  const [chosen, setChosen] = useState<string | null>(null);
  const refresh = usePublicRefresh();
  if (slug === null) return <NoOrganization />;
  return (
    <Screen {...refresh}>
      <QueryBoundary
        query={directory}
        label="the public standings"
        isEmpty={(data: Directory) => data.competitions.length === 0}
        empty={{
          title: 'No public standings',
          description: 'No league or tournament has been made public.',
        }}
      >
        {(data: Directory) => {
          const code = chosen ?? (data.competitions[0]?.code as string);
          return (
            <>
              <Choice
                label="Competition"
                options={data.competitions.map((c) => ({ code: c.code, name: c.name }))}
                value={code}
                onChange={setChosen}
              />
              <CompetitionStandings slug={slug} code={code} />
            </>
          );
        }}
      </QueryBoundary>
    </Screen>
  );
}

/**
 * The signed-out Discover screen's way in: shown only when the organization has something
 * public, so a visitor is never sent to an empty page.
 */
export function PublicLinks() {
  const styles = useStyles();
  const router = useRouter();
  const slug = useSlug();
  const directory = useDirectory(slug);
  const data = directory.data;
  if (!data || (data.schedules.length === 0 && data.competitions.length === 0)) return null;
  return (
    <Card testID="public-links" style={styles.links}>
      <Text variant="body">{`See what is on at ${data.organizationName} without signing in.`}</Text>
      <View style={styles.buttons}>
        {data.schedules.length > 0 ? (
          <Button
            label="Today's schedule"
            variant="secondary"
            onPress={() => router.push(publicRoutes.schedule)}
            accessibilityHint="Shows today's schedule by field and time"
          />
        ) : null}
        {data.competitions.length > 0 ? (
          <Button
            label="League standings"
            variant="secondary"
            onPress={() => router.push(publicRoutes.standings)}
            accessibilityHint="Shows the standings of public leagues and tournaments"
          />
        ) : null}
      </View>
    </Card>
  );
}

/** Route component for app/public/schedule.tsx. */
export function PublicScheduleRoute() {
  return (
    <>
      <Stack.Screen options={{ title: "Today's schedule" }} />
      <PublicScheduleScreen />
    </>
  );
}

/** Route component for app/public/standings.tsx. */
export function PublicStandingsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Standings' }} />
      <PublicStandingsScreen />
    </>
  );
}

const useStyles = makeStyles(() => ({
  stack: { gap: spacing.md },
  choice: { paddingVertical: spacing.sm },
  links: { gap: spacing.md },
  buttons: { gap: spacing.sm },
}));
