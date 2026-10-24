/**
 * SCR-S-10 readiness pieces (SPK-READY-001 to SPK-READY-004, SPK-UX-008): a row badge for the
 * fixture list and the full explanation for one fixture. Every issue names its reason, source
 * record, responsible role, required action, last evaluation and deadline (SPK-READY-003). There
 * is no "mark ready" control (SPK-READY-004): "Re-evaluate" asks the API to derive it again.
 */
import { formatAge, presentationForError } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useNow } from '../../providers/AppProviders';
import { formatInstant, shortRef } from '../../features/competition/format';
import { ISSUE_SEVERITY, READINESS_STATUS, humanizeCode } from '../../features/competition/labels';
import { effectiveReadiness, orderIssues } from '../../features/competition/readiness';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

function useReadiness(fixtureId: string) {
  return useApiQuery({ path: '/fixtures/{id}/readiness', request: { path: { id: fixtureId } } });
}

/** One row's readiness: unknown until the API answers, and unknown when it cannot answer. */
export function ReadinessBadge({ fixtureId }: { fixtureId: string }) {
  const readiness = useReadiness(fixtureId);
  const now = useNow();
  const { online, services } = useApp();
  if (!readiness.data) {
    if (readiness.error && presentationForError(readiness.error) === 'unavailable') {
      return <StatusBadge tone="neutral" label="Readiness not available" />;
    }
    return (
      <StatusBadge
        tone="pending"
        label={readiness.error ? 'Unknown: could not evaluate' : 'Readiness: checking'}
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
  return <StatusBadge tone={badge.tone} label={badge.label} />;
}

export function ReadinessPanel({ fixtureId }: { fixtureId: string }) {
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
                      <dd>{formatInstant(issue.lastEvaluatedAt)}</dd>
                    </div>
                    <div>
                      <dt>Deadline</dt>
                      <dd>{issue.deadline ? formatInstant(issue.deadline) : 'None'}</dd>
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
