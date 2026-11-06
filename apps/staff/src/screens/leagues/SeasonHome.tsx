/**
 * The season home's live cards (SCR-S-08 season home, with SCR-S-10 readiness and SCR-S-13
 * standings; SPK-RESULT-001, SPK-RESULT-003, SPK-READY-001 to SPK-READY-004, SPK-SCHED-008,
 * SPK-UX-006, SPK-UX-008):
 *
 * - Standings: the season or one division's table (`GET /v1/seasons/{id}/standings`), official
 *   results only, with each team's recent form derived from official results and the rule set's
 *   tiebreak order (`GET /v1/rule-sets/{id}`) in the footer. The full table, tie explanations and
 *   brackets are on the standings screen.
 * - Game readiness for the next 24 hours: the season's fixtures in that window
 *   (`GET /v1/seasons/{id}/fixtures?from&to`) with each match's derived readiness and its checks
 *   (`GET /v1/fixtures/{id}/readiness`, at most READINESS_ROWS matches; the full list is on the
 *   fixtures screen). Readiness is never shown as ready on unknown or stale evidence, offline or
 *   after a failed refresh, and there is no "mark ready" control (SPK-READY-004).
 *
 * A read the viewer may not make reads "not available to you" in words; a failed read names its
 * code with a way to load it again.
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { useDivisionZones } from '../../features/competition/facilities';
import { useSeasonForm } from '../../features/competition/form';
import { READINESS_STATUS, humanizeCode } from '../../features/competition/labels';
import { effectiveReadiness } from '../../features/competition/readiness';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CardHead } from '../../ui/Page';
import { StatusBadge } from '../../ui/StatusBadge';
import { StandingsTable } from './StandingsScreen';

type Division = Schema<'Division'>;
type SeasonFixture = Schema<'SeasonFixture'>;

/** Matches whose own readiness is read on the season home; the rest are on the fixtures screen. */
const READINESS_ROWS = 10;
const QUARTER_HOUR = 15 * 60_000;

function ReadNote({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: ApiError;
  onRetry: () => void;
}) {
  if (presentationForError(error) === 'unavailable') {
    return <p className="card-pad caption">{what} are not available to you.</p>;
  }
  return (
    <p className="card-pad caption">
      {what} could not load ({error.code}).{' '}
      <Button
        variant="secondary"
        className="button-sm"
        onClick={onRetry}
        aria-label={`Load ${what.toLowerCase()} again`}
      >
        Load again
      </Button>
    </p>
  );
}

const TIEBREAKER_TEXT: Record<string, string> = {
  points: 'points',
  head_to_head: 'head-to-head',
  goal_difference: 'goal difference',
  goals_for: 'goals for',
  goals_against: 'goals against',
  wins: 'wins',
  fair_play: 'fair play',
  draw_of_lots: 'drawing of lots',
  play_off: 'play-off',
};

function TiebreakOrder({ ruleSetId }: { ruleSetId: string }) {
  const ruleSet = useApiQuery({
    path: '/rule-sets/{id}',
    request: { path: { id: ruleSetId } },
    staleTime: 5 * 60_000,
  });
  const order = (ruleSet.data?.content.tiebreakers ?? []).filter((t) => t !== 'points');
  if (order.length === 0) return null;
  return (
    <> · Ties on points: {order.map((t) => TIEBREAKER_TEXT[t] ?? humanizeCode(t)).join(', ')}</>
  );
}

export function SeasonStandingsCard({
  seasonId,
  ruleSetId,
  divisions,
}: {
  seasonId: string;
  ruleSetId: string;
  divisions: readonly Division[] | undefined;
}) {
  const [divisionId, setDivisionId] = useState('');
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: { path: { id: seasonId }, query: { ...(divisionId ? { divisionId } : {}) } },
  });
  const form = useSeasonForm(seasonId, divisionId || undefined);
  const choices = [{ id: '', name: 'Whole season' }, ...(divisions ?? [])];
  const data = standings.data;
  return (
    <section className="card card-flush" aria-labelledby="season-standings-title">
      <CardHead
        aside={
          choices.length > 1 ? (
            <div className="segmented" role="group" aria-label="Standings of">
              {choices.map((d) => (
                <button
                  key={d.id || 'season'}
                  type="button"
                  aria-pressed={divisionId === d.id}
                  onClick={() => setDivisionId(d.id)}
                >
                  {d.name}
                </button>
              ))}
            </div>
          ) : null
        }
      >
        <h3 id="season-standings-title">Standings</h3>
      </CardHead>
      {standings.error && !data ? (
        <ReadNote
          what="Standings"
          error={standings.error}
          onRetry={() => void standings.refetch()}
        />
      ) : data === undefined ? (
        <p className="card-pad caption" aria-busy="true">
          Loading standings…
        </p>
      ) : !data || data.sourceResultIds.length === 0 ? (
        <div className="card-pad">
          <StatusBadge tone="neutral" label="No official results yet" />
          <p className="caption">
            The table appears once a result of this season is published as official.
          </p>
        </div>
      ) : (
        <div className="season-standings">
          <StandingsTable standings={data} form={form} compact caption="Season standings" />
        </div>
      )}
      <p className="card-note">
        Only official results count
        <TiebreakOrder ruleSetId={ruleSetId} /> ·{' '}
        <Link to={`/leagues/seasons/${seasonId}/standings`}>Full table, ties and brackets</Link>
      </p>
    </section>
  );
}

function timeParts(iso: string, zone: string | null): { time: string; day: string } {
  const date = new Date(iso);
  const base: Intl.DateTimeFormatOptions = zone ? { timeZone: zone } : {};
  try {
    return {
      time: new Intl.DateTimeFormat(undefined, {
        ...base,
        hour: 'numeric',
        minute: '2-digit',
      }).format(date),
      day: new Intl.DateTimeFormat(undefined, {
        ...base,
        weekday: 'short',
        timeZoneName: 'short',
      }).format(date),
    };
  } catch {
    return { time: date.toLocaleTimeString(), day: '' };
  }
}

function GameRow({
  fixture,
  zone,
  divisionName,
  readOwn,
}: {
  fixture: SeasonFixture;
  zone: string | null;
  divisionName: string | null;
  readOwn: boolean;
}) {
  const now = useNow();
  const { online, services } = useApp();
  const readiness = useApiQuery({
    path: '/fixtures/{id}/readiness',
    request: { path: { id: fixture.id } },
    enabled: readOwn,
  });
  const when = fixture.scheduledStart ? timeParts(fixture.scheduledStart, zone) : null;
  const data = readiness.data;
  const effective = data
    ? effectiveReadiness(data, {
        now,
        staleThresholdMs: services.config.staleDataThresholdMs,
        offline: !online,
        refreshFailed: readiness.error !== null,
      })
    : null;
  const title = `${fixture.homeTeamName} v ${fixture.awayTeamName ?? 'bye'}`;
  return (
    <li aria-label={title}>
      <span className="ready-time">
        {when?.time ?? 'No time'}
        {when ? <small>{when.day}</small> : null}
      </span>
      <span className="ready-match">
        <Link to={`/leagues/fixtures/${fixture.id}`}>{title}</Link>
        <span className="caption">
          {divisionName ?? 'No division'}
          {fixture.round !== null ? ` · round ${fixture.round}` : ''}
        </span>
      </span>
      <span className="ready-checks">
        {!readOwn ? (
          <span className="caption">Open the fixture for its readiness</span>
        ) : effective && data ? (
          <>
            <StatusBadge
              tone={READINESS_STATUS[effective.status].tone}
              label={READINESS_STATUS[effective.status].label}
            />
            {data.checks.map((check) => {
              // A ready check reads as unknown when the whole evaluation is not confirmed.
              const shown =
                check.status === 'ready' && effective.status === 'unknown'
                  ? 'unknown'
                  : check.status;
              return (
                <StatusBadge
                  key={check.name}
                  tone={READINESS_STATUS[shown].tone}
                  label={`${humanizeCode(check.name)}${
                    check.issueCount > 0 ? ` · ${check.issueCount}` : ''
                  }`}
                />
              );
            })}
          </>
        ) : readiness.error ? (
          presentationForError(readiness.error) === 'unavailable' ? (
            <StatusBadge tone="neutral" label="Readiness not available" />
          ) : (
            <StatusBadge
              tone="pending"
              label={`Unknown: could not evaluate (${readiness.error.code})`}
            />
          )
        ) : (
          <StatusBadge tone="pending" label="Readiness: checking" />
        )}
      </span>
    </li>
  );
}

export function GameReadinessCard({
  seasonId,
  divisions,
}: {
  seasonId: string;
  divisions: readonly Division[] | undefined;
}) {
  const now = useNow(60_000);
  // The window moves in quarter hours so the read is not repeated every minute; games that
  // started in the last three hours stay listed while they are being played.
  const window = useMemo(() => {
    const start = Math.floor(now.getTime() / QUARTER_HOUR) * QUARTER_HOUR - 3 * 3_600_000;
    return {
      from: new Date(start).toISOString(),
      to: new Date(start + 27 * 3_600_000).toISOString(),
    };
  }, [now]);
  const fixtures = useApiQuery({
    path: '/seasons/{id}/fixtures',
    request: { path: { id: seasonId }, query: { ...window, limit: 50 } },
  });
  const zoneOf = useDivisionZones(divisions);
  const divisionName = new Map((divisions ?? []).map((d) => [d.id, d.name]));
  const games = (fixtures.data?.items ?? [])
    .filter((f) => f.awayEntryId !== null && f.scheduledStart)
    .sort((a, b) => (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? ''));
  return (
    <section className="card card-flush" aria-labelledby="season-ready-title">
      <CardHead
        aside={
          <span className="caption">
            A game is ready when every check is clear; readiness is derived, never set by hand
          </span>
        }
      >
        <h3 id="season-ready-title">Next 24 hours · game readiness</h3>
      </CardHead>
      {fixtures.error && !fixtures.data ? (
        <ReadNote what="Fixtures" error={fixtures.error} onRetry={() => void fixtures.refetch()} />
      ) : !fixtures.data ? (
        <p className="card-pad caption" aria-busy="true">
          Loading the next games…
        </p>
      ) : games.length === 0 ? (
        <p className="card-pad caption">
          No games of this season are scheduled in the next 24 hours.
        </p>
      ) : (
        <ul className="ready-list" aria-label="Games in the next 24 hours">
          {games.map((f, i) => (
            <GameRow
              key={f.id}
              fixture={f}
              zone={zoneOf(f.divisionId)}
              divisionName={f.divisionId ? (divisionName.get(f.divisionId) ?? null) : null}
              readOwn={i < READINESS_ROWS}
            />
          ))}
        </ul>
      )}
      <p className="card-note">
        <Link to={`/leagues/seasons/${seasonId}/fixtures`}>All fixtures and readiness</Link>
        {fixtures.data?.nextCursor ? ' · more games in this window are on the fixtures screen' : ''}
      </p>
    </section>
  );
}
