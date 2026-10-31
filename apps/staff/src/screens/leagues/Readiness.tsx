/**
 * SCR-S-10 readiness pieces (SPK-READY-001 to SPK-READY-004, SPK-UX-008): the season summary
 * for the fixture list (one read for a page of fixtures, CMP-01) and the full explanation for one
 * fixture. A season summary is refused above 100 fixtures (`TOO_MANY_FIXTURES`): the page's time
 * window is read instead, and when that window still holds more than 100 fixtures of the season
 * (the summary filters by time only, not by the list's division or state), each fixture on the
 * page is read on its own; a row is never left unknown only because the season is large. Every
 * issue names its reason, source
 * record, responsible role, required action, last evaluation and deadline (SPK-READY-003). There
 * is no "mark ready" control (SPK-READY-004): "Re-evaluate" asks the API to derive it again.
 */
import {
  formatAge,
  presentationForError,
  type ApiError,
  type Schema,
} from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useRefetch } from '../../features/competition/feedback';
import { useApp, useNow } from '../../providers/AppProviders';
import { formatInstant, shortRef } from '../../features/competition/format';
import { ISSUE_SEVERITY, READINESS_STATUS, humanizeCode } from '../../features/competition/labels';
import {
  effectiveCounts,
  effectiveReadiness,
  orderIssues,
} from '../../features/competition/readiness';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

function useReadiness(fixtureId: string) {
  return useApiQuery({ path: '/fixtures/{id}/readiness', request: { path: { id: fixtureId } } });
}

type Counts = Schema<'ReadinessCounts'>;

interface FixtureTimes {
  id: string;
  scheduledStart: string | null;
}

/** The narrowest window that holds the scheduled fixtures of a page (CMP-01 `from`/`to`). */
function windowOf(fixtures: readonly FixtureTimes[]): { from: string; to: string } | null {
  const starts = fixtures
    .map((f) => (f.scheduledStart ? new Date(f.scheduledStart).getTime() : Number.NaN))
    .filter((t) => Number.isFinite(t));
  if (starts.length === 0) return null;
  // `from` keeps fixtures ending after it; `to` keeps fixtures starting before it.
  return {
    from: new Date(Math.min(...starts)).toISOString(),
    to: new Date(Math.max(...starts) + 1).toISOString(),
  };
}

function isTooMany(error: ApiError | null): boolean {
  return (
    error?.code === 'VALIDATION_FAILED' &&
    (error.details as { code?: unknown } | undefined)?.code === 'TOO_MANY_FIXTURES'
  );
}

export interface SeasonReadinessState {
  /** The read the rows come from (whole season, or the page's window when the season is large). */
  query: ReturnType<typeof useSeasonReadinessQuery>;
  counts(fixtureId: string): Counts | undefined;
  /** The season holds more fixtures than one summary evaluates: only this page's window is read. */
  windowed: boolean;
  /**
   * The page's window also holds more fixtures than one summary evaluates: each fixture on the
   * page is read on its own (`GET /v1/fixtures/{id}/readiness`).
   */
  perFixture: boolean;
}

function useSeasonReadinessQuery(
  seasonId: string,
  query: { from?: string; to?: string },
  enabled: boolean,
) {
  return useApiQuery({
    path: '/seasons/{id}/readiness',
    request: { path: { id: seasonId }, query },
    enabled,
  });
}

/**
 * The readiness of a page of fixtures in one read (`GET /v1/seasons/{id}/readiness`, CMP-01,
 * SPK-READY-001) instead of one read per row. A season with more fixtures than one summary
 * evaluates (VALIDATION_FAILED `TOO_MANY_FIXTURES`) is read for the window of the page shown.
 */
export function useSeasonReadiness(
  seasonId: string,
  fixtures: readonly FixtureTimes[] | undefined,
): SeasonReadinessState {
  const whole = useSeasonReadinessQuery(seasonId, {}, !!seasonId);
  const windowed = isTooMany(whole.error);
  const window = useMemo(() => windowOf(fixtures ?? []), [fixtures]);
  const page = useSeasonReadinessQuery(seasonId, window ?? {}, windowed && window !== null);
  const active = windowed ? page : whole;
  const perFixture = windowed && isTooMany(page.error);
  const items = active.data?.items;
  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.fixtureId, i])), [items]);
  return { query: active, counts: (id) => byId.get(id), windowed, perFixture };
}

/** One row's own readiness read, when the page's window is too large for a summary. */
function FixtureReadinessBadge({ fixtureId }: { fixtureId: string }) {
  const now = useNow();
  const { online, services } = useApp();
  const readiness = useReadiness(fixtureId);
  if (!readiness.data) {
    if (readiness.error && presentationForError(readiness.error) === 'unavailable') {
      return <StatusBadge tone="neutral" label="Readiness not available" />;
    }
    return (
      <StatusBadge
        tone="pending"
        label={
          readiness.error
            ? `Unknown: could not evaluate (${readiness.error.code})`
            : 'Readiness: checking'
        }
      />
    );
  }
  const effective = effectiveReadiness(readiness.data, {
    now,
    staleThresholdMs: services.config.staleDataThresholdMs,
    offline: !online,
    refreshFailed: readiness.error !== null,
  });
  const badge = READINESS_STATUS[effective.status];
  const blocking = readiness.data.issues.filter((i) => i.severity === 'blocking').length;
  const unknown = readiness.data.issues.filter((i) => i.severity === 'unknown').length;
  const detail = [
    blocking > 0 ? `${blocking} blocking` : null,
    unknown > 0 ? `${unknown} unknown` : null,
  ].filter(Boolean);
  return (
    <span>
      <StatusBadge tone={badge.tone} label={badge.label} />
      {detail.length > 0 ? <span className="caption"> ({detail.join(', ')})</span> : null}
    </span>
  );
}

/**
 * One row's readiness from the season summary: unknown until the API answers, unknown when it
 * cannot, and never "Ready" with unknown evidence, offline, after a failed refresh or past the
 * stale threshold (SPK-READY-002).
 */
export function SummaryReadinessBadge({
  fixtureId,
  scheduled,
  readiness,
}: {
  fixtureId: string;
  scheduled: boolean;
  readiness: SeasonReadinessState;
}) {
  const now = useNow();
  const { online, services } = useApp();
  const { query } = readiness;
  const counts = readiness.counts(fixtureId);
  if (readiness.perFixture) {
    if (!scheduled) {
      return <StatusBadge tone="pending" label="Unknown: open the fixture to evaluate" />;
    }
    return <FixtureReadinessBadge fixtureId={fixtureId} />;
  }
  if (!counts || !query.data) {
    if (readiness.windowed && !scheduled) {
      return <StatusBadge tone="pending" label="Unknown: open the fixture to evaluate" />;
    }
    if (query.error && !readiness.windowed && presentationForError(query.error) === 'unavailable') {
      return <StatusBadge tone="neutral" label="Readiness not available" />;
    }
    if (query.data) return <StatusBadge tone="pending" label="Unknown: not evaluated yet" />;
    return (
      <StatusBadge
        tone="pending"
        label={query.error ? 'Unknown: could not evaluate' : 'Readiness: checking'}
      />
    );
  }
  const effective = effectiveCounts(counts, {
    now,
    evaluatedAt: query.data.evaluatedAt,
    staleThresholdMs: services.config.staleDataThresholdMs,
    offline: !online,
    refreshFailed: query.error !== null,
  });
  const badge = READINESS_STATUS[effective.status];
  const detail = [
    counts.blockingCount > 0 ? `${counts.blockingCount} blocking` : null,
    counts.unknownCount > 0 ? `${counts.unknownCount} unknown` : null,
  ].filter(Boolean);
  return (
    <span>
      <StatusBadge tone={badge.tone} label={badge.label} />
      {detail.length > 0 ? <span className="caption"> ({detail.join(', ')})</span> : null}
    </span>
  );
}

/** The summary's age, its failure and "Re-evaluate" above the fixture list (SCR-S-10). */
export function SeasonReadinessStatus({ readiness }: { readiness: SeasonReadinessState }) {
  const now = useNow();
  const { online } = useApp();
  const { query } = readiness;
  const refetchEach = useRefetch(['/fixtures/{id}/readiness']);
  const failed =
    !readiness.perFixture && query.error && !(presentationForError(query.error) === 'unavailable');
  // A large season whose page has no scheduled fixture has nothing to evaluate in a window.
  const nothingToEvaluate = readiness.windowed && query.isPending && query.fetchStatus === 'idle';
  return (
    <div className="actions" data-testid="season-readiness">
      {readiness.perFixture ? (
        <span className="caption" role="note">
          More than 100 fixtures of the season fall in this page’s time window, so readiness is
          evaluated for each fixture on the page.
        </span>
      ) : query.data ? (
        <span className="caption">
          Readiness evaluated {formatAge(new Date(query.data.evaluatedAt), now)}
          {readiness.windowed ? ' for the fixtures on this page' : ''}
        </span>
      ) : null}
      {nothingToEvaluate ? null : (
        <Button
          variant="secondary"
          busy={query.fetchStatus === 'fetching'}
          disabled={!online}
          onClick={() => (readiness.perFixture ? refetchEach() : void query.refetch())}
        >
          Re-evaluate readiness
        </Button>
      )}
      {failed && query.error ? (
        <span className="caption" role="note">
          Readiness could not be evaluated ({query.error.code}), so it is shown as unknown.
        </span>
      ) : null}
      {!online ? (
        <span className="caption" role="note">
          Offline: readiness cannot be confirmed and is shown as unknown.
        </span>
      ) : null}
    </div>
  );
}

export function ReadinessPanel({
  fixtureId,
  timeZone,
}: {
  fixtureId: string;
  /** The facility's time zone for issue times (SPK-SCHED-008), when the fixture has a venue. */
  timeZone?: string | null;
}) {
  const readiness = useReadiness(fixtureId);
  const now = useNow();
  const { online, services } = useApp();
  const reevaluate = () => void readiness.refetch();

  if (!readiness.data) {
    if (readiness.error) {
      if (presentationForError(readiness.error) === 'unavailable') {
        return <StateView variant="unavailable" title="Readiness not available" />;
      }
      return (
        <section className="panel" aria-labelledby="readiness-title">
          <h3 id="readiness-title">Match readiness</h3>
          <StatusBadge tone="pending" label={READINESS_STATUS.unknown.label} />
          <p>Readiness could not be evaluated, so it is unknown. It is never assumed ready.</p>
          <StateView variant="error" error={readiness.error} onRetry={reevaluate} />
        </section>
      );
    }
    return <StateView variant="loading" label="match readiness" />;
  }

  const data = readiness.data;
  const effective = effectiveReadiness(data, {
    now,
    staleThresholdMs: services.config.staleDataThresholdMs,
    offline: !online,
    refreshFailed: readiness.error !== null,
  });
  const badge = READINESS_STATUS[effective.status];
  return (
    <section className="panel" aria-labelledby="readiness-title">
      <h3 id="readiness-title">Match readiness</h3>
      <div className="actions">
        <span data-testid="readiness-overall">
          <StatusBadge tone={badge.tone} label={badge.label} />
        </span>
        <span className="caption">Evaluated {formatAge(new Date(data.evaluatedAt), now)}</span>
        <Button
          variant="secondary"
          busy={readiness.fetchStatus === 'fetching'}
          disabled={!online}
          onClick={reevaluate}
        >
          Re-evaluate
        </Button>
      </div>
      {effective.downgradeReason ? <p role="note">{effective.downgradeReason}</p> : null}
      <p className="caption">
        Readiness is derived from the authoritative records on every evaluation; it cannot be set by
        hand.
      </p>
      {data.checks.length > 0 ? (
        <ul aria-label="Readiness checks">
          {data.checks.map((check) => {
            const c = READINESS_STATUS[check.status];
            return (
              <li key={check.name}>
                {humanizeCode(check.name)}: <StatusBadge tone={c.tone} label={c.label} />
                {check.issueCount > 0
                  ? ` (${check.issueCount} ${check.issueCount === 1 ? 'issue' : 'issues'})`
                  : ''}
              </li>
            );
          })}
        </ul>
      ) : null}
      {data.issues.length === 0 ? (
        <p>No readiness issues were found in this evaluation.</p>
      ) : (
        <ul className="list" aria-label="Readiness issues">
          {orderIssues(data.issues).map((issue, index) => {
            const severity = ISSUE_SEVERITY[issue.severity];
            return (
              <li key={`${issue.code}-${index}`}>
                <div className="row-text">
                  <StatusBadge tone={severity.tone} label={severity.label} />
                  <span>{issue.message}</span>
                  <dl className="facets">
                    <div>
                      <dt>Source record</dt>
                      <dd>
                        {humanizeCode(issue.source.type)}
                        {issue.source.id ? ` ${shortRef(issue.source.id)}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Responsible role</dt>
                      <dd>{humanizeCode(issue.responsibleRole)}</dd>
                    </div>
                    <div>
                      <dt>Required action</dt>
                      <dd>{issue.requiredAction}</dd>
                    </div>
                    <div>
                      <dt>Last evaluated</dt>
                      <dd>{formatInstant(issue.lastEvaluatedAt, timeZone)}</dd>
                    </div>
                    <div>
                      <dt>Deadline</dt>
                      <dd>{issue.deadline ? formatInstant(issue.deadline, timeZone) : 'None'}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data.sides.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table">
            <caption>Teams</caption>
            <thead>
              <tr>
                <th scope="col">Team</th>
                <th scope="col">Entry</th>
                <th scope="col">Roster</th>
                <th scope="col">Eligible</th>
                <th scope="col">Eligibility unknown</th>
                <th scope="col">Minimum to play</th>
              </tr>
            </thead>
            <tbody>
              {data.sides.map((side) => (
                <tr key={side.teamEntryId}>
                  <td>{side.teamName}</td>
                  <td>{side.entryStatus}</td>
                  <td>{side.rosterSize}</td>
                  <td>{side.eligiblePlayers}</td>
                  <td>{side.unknownPlayers}</td>
                  <td>{side.minimumPlayers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
