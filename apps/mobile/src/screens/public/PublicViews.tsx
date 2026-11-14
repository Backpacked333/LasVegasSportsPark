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
 * (the cached answer with its age, as every read in the app); error with retry.
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant } from '../../features/teams/format';
import { Body, ButtonRow, Detail, Section } from '../../features/teams/ui';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
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

/** A choice among several public things (facilities, competitions), by name. */
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
  if (options.length < 2) return null;
  return (
    <View accessibilityLabel={label}>
      <ButtonRow>
        {options.map((option) => (
          <Button
            key={option.code}
            label={option.name}
            variant={option.code === value ? 'primary' : 'secondary'}
            onPress={() => onChange(option.code)}
            accessibilityHint={option.code === value ? 'Selected' : 'Shows this one instead'}
          />
        ))}
      </ButtonRow>
    </View>
  );
}

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
          <Body muted>Times are in the facility&apos;s time zone.</Body>
        </Section>
      )}
    </QueryBoundary>
  );
}

export function PublicScheduleScreen() {
  const slug = useSlug();
  const directory = useDirectory(slug);
  const [chosen, setChosen] = useState<string | null>(null);
  if (slug === null) return <NoOrganization />;
  return (
    <Screen>
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
  if (slug === null) return <NoOrganization />;
  return (
    <Screen>
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
  const router = useRouter();
  const slug = useSlug();
  const directory = useDirectory(slug);
  const data = directory.data;
  if (!data || (data.schedules.length === 0 && data.competitions.length === 0)) return null;
  return (
    <Card testID="public-links">
      <Body>See what is on at {data.organizationName} without signing in.</Body>
      <ButtonRow>
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
      </ButtonRow>
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
}));
