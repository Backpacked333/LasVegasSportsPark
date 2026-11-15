/**
 * The lobby display (SPK-SCHED-010, proposed amendment PA-06): `/lobby/:organization/:code`, a
 * wall screen nobody is signed in to. It shows today's schedule of the facility in pages that
 * advance by themselves, always says when the schedule was last updated, and keeps showing the
 * last schedule it received while its connection is down. `code` is the facility's public
 * schedule code.
 *
 * `?seasons=<code>,<code>` adds the standings of public seasons as further pages (their public
 * season codes); a season that is not public simply adds no page. How many screens a lobby has
 * and what each shows is the operator's to decide (DEC-100, N4): the page length and the time a
 * page stays are technical defaults a link can change with `?rows=` and `?seconds=`.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useNow } from '../../providers/AppProviders';
import { formatPublicDate, PublicFrame } from './PublicFrame';
import { ScheduleTable, type DaySchedule } from './PublicScheduleScreen';
import { StandingsTable, type SeasonView } from './PublicSeasonScreen';
import { usePublicView } from './usePublicView';

export const LOBBY_ROWS = 8;
export const LOBBY_SECONDS = 12;
const SEASON_CODE = /^[a-z0-9]{16,40}$/;

function bounded(raw: string | null, fallback: number, min: number, max: number): number {
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

interface LobbyPage {
  key: string;
  label: string;
  render: () => ReactNode;
}

/** The schedule entries still to come or under way first; a finished day shows the whole day. */
export function schedulePages(
  schedule: DaySchedule,
  rows: number,
  now: Date,
): DaySchedule['entries'][] {
  const upcoming = schedule.entries.filter((entry) => new Date(entry.endsAt) > now);
  const entries = upcoming.length > 0 ? upcoming : schedule.entries;
  const pages: DaySchedule['entries'][] = [];
  for (let i = 0; i < entries.length; i += rows) pages.push(entries.slice(i, i + rows));
  return pages.length > 0 ? pages : [[]];
}

/** One season's standings for the lobby; renders nothing while it is not available. */
function useSeasonPages(organization: string, code: string | undefined): LobbyPage[] {
  const state = usePublicView(
    {
      path: '/public/{organization}/seasons/{code}',
      request: { path: { organization, code: code ?? '' } },
      enabled: code !== undefined,
    },
    `season:${organization}:${code ?? 'none'}`,
  );
  const data: SeasonView | undefined = code === undefined ? undefined : state.data;
  return useMemo(
    () =>
      (data?.divisions ?? [])
        .filter((division) => division.standings.length > 0)
        .map((division) => ({
          key: `standings-${code}-${division.name}`,
          label: `${data?.competitionName ?? ''}: ${division.name} standings`,
          render: () => <StandingsTable division={division} />,
        })),
    [data, code],
  );
}

export function LobbyScreen() {
  const { organization = '', code = '' } = useParams();
  const [params] = useSearchParams();
  const rows = bounded(params.get('rows'), LOBBY_ROWS, 3, 30);
  const seconds = bounded(params.get('seconds'), LOBBY_SECONDS, 5, 120);
  const seasons = (params.get('seasons') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => SEASON_CODE.test(value));
  // Hooks are called a fixed number of times: a lobby shows at most two seasons' standings.
  const firstSeason = useSeasonPages(organization, seasons[0]);
  const secondSeason = useSeasonPages(organization, seasons[1]);
  // Today only: the read names no day, so it is always inside the days the API answers for (a
  // window around today, security review L-3), and a lobby has no previous or next day control.
  const view = usePublicView(
    { path: '/public/{organization}/schedule/{code}', request: { path: { organization, code } } },
    `lobby:${organization}:${code}`,
  );
  const now = useNow();
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTurn((current) => current + 1), seconds * 1000);
    return () => clearInterval(timer);
  }, [seconds]);

  return (
    <PublicFrame
      view={view}
      variant="lobby"
      organizationName={(data) => data.organizationName}
      title={(data) => data.facilityName}
      subtitle={(data) => formatPublicDate(data.date)}
      timezone={(data) => data.timezone}
    >
      {(data) => {
        const pages: LobbyPage[] = [
          ...schedulePages(data, rows, now).map((entries, index, all) => ({
            key: `schedule-${index}`,
            label: all.length > 1 ? `Today, page ${index + 1} of ${all.length}` : 'Today',
            render: () => (
              <ScheduleTable
                entries={entries}
                timezone={data.timezone}
                caption={`Today at ${data.facilityName}`}
              />
            ),
          })),
          ...firstSeason,
          ...secondSeason,
        ];
        const page = pages[turn % pages.length] as LobbyPage;
        return (
          <section className="public-lobby-page" aria-label={page.label} aria-live="off">
            <h2>{page.label}</h2>
            {page.render()}
            {pages.length > 1 ? (
              <p className="public-note">
                Screen {(turn % pages.length) + 1} of {pages.length}
              </p>
            ) : null}
          </section>
        );
      }}
    </PublicFrame>
  );
}
