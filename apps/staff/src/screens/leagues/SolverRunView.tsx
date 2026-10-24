/**
 * SCR-S-09 solver run outcome (SPK-FIX-002 completeness, SPK-FIX-004 solver outcomes, SPK-FIX-005
 * drafts only, SPK-AT-010, SPK-AT-011). The outcome is the API's, in honest words: "feasible" never
 * reads as optimal, "no proposal within the limit" never reads as impossible, and the client never
 * upgrades or infers an outcome. The input snapshot (rule-set version, search settings, dry run) is
 * shown with the outcome. A partial result lists the remaining obligations with owner and deadline
 * (partial completion state); a proposal stays a scheduling draft until published elsewhere.
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { formatInstant, shortRef } from '../../features/competition/format';
import {
  COMPLETENESS_ISSUE,
  FAIRNESS_PREFERENCE,
  SOLVER_OUTCOME,
  SOLVER_STOPPED_BY,
  humanizeCode,
} from '../../features/competition/labels';
import { EntryName, RuleSetLabel } from '../../features/competition/names';
import { OperationStatus } from '../../features/competition/OperationStatus';
import { StatusBadge } from '../../ui/StatusBadge';

type SolverRun = Schema<'SolverRun'>;

export function SolverRunView({
  run,
  entries,
}: {
  run: SolverRun;
  entries: ReadonlyMap<string, { teamId: string }>;
}) {
  const outcome = SOLVER_OUTCOME[run.outcome];
  const report = run.completenessReport;
  const explanation = run.explanation;
  const games = run.proposal?.games ?? [];
  return (
    <section className="panel" aria-labelledby={`run-${run.id}-title`}>
      <h3 id={`run-${run.id}-title`}>Solver run {shortRef(run.id)}</h3>
      <p>
        <StatusBadge tone={outcome.tone} label={outcome.label} />
      </p>
      <p>{outcome.explanation}</p>
      <p>{explanation.summary}</p>
      <dl className="facets" aria-label="Input snapshot and search">
        <div>
          <dt>Search stopped because</dt>
          <dd>{SOLVER_STOPPED_BY[explanation.stoppedBy]}</dd>
        </div>
        <div>
          <dt>Search limit</dt>
          <dd>
            {run.searchSettings.maxCandidates ?? 'default'} candidates or{' '}
            {run.searchSettings.timeLimitMs !== undefined
              ? `${run.searchSettings.timeLimitMs / 1000} seconds`
              : 'the default time'}
            ; seed {run.searchSettings.seed ?? 'default'}
          </dd>
        </div>
        <div>
          <dt>Candidates tried</dt>
          <dd>{explanation.candidatesTried}</dd>
        </div>
        <div>
          <dt>Rule-set version</dt>
          <dd>
            <RuleSetLabel ruleSetId={run.ruleSetId} />
          </dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>
            {formatInstant(run.startedAt)}
            {run.dryRun ? ' (check only: no fixtures or draft created)' : ''}
          </dd>
        </div>
      </dl>

      <section aria-labelledby={`run-${run.id}-completeness`}>
        <h4 id={`run-${run.id}-completeness`}>Season completeness</h4>
        <p>
          <StatusBadge
            tone={report.complete ? 'success' : 'warning'}
            label={report.complete ? 'Complete season' : 'Incomplete season'}
          />{' '}
          {report.proposedGames} of {report.expectedGames} games proposed, {report.scheduledGames}{' '}
          with a time and resource.
        </p>
        {report.byes.length > 0 ? (
          <ul aria-label="Byes per team">
            {report.byes.map((bye) => (
              <li key={bye.teamEntryId}>
                <EntryName entryId={bye.teamEntryId} teamIdOf={entries} />: {bye.count}{' '}
                {bye.count === 1 ? 'bye' : 'byes'}
              </li>
            ))}
          </ul>
        ) : null}
        {report.issues.length > 0 ? (
          <ul className="list" aria-label="Completeness problems">
            {report.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <div className="row-text">
                  <StatusBadge tone="danger" label={COMPLETENESS_ISSUE[issue.code]} />
                  <span>{issue.message}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {report.remainingObligations.length > 0 ? (
          <div role="group" aria-label="Remaining obligations">
            <p>
              <StatusBadge tone="warning" label="Partial season: obligations remain" />
            </p>
            <ul className="list">
              {report.remainingObligations.map((obligation, index) => (
                <li key={`${obligation.code}-${index}`}>
                  <div className="row-text">
                    <span>{obligation.message}</span>
                    <span className="caption">
                      Owner: {humanizeCode(obligation.owner)} · Deadline:{' '}
                      {obligation.deadline ? formatInstant(obligation.deadline) : 'none recorded'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby={`run-${run.id}-constraints`}>
        <h4 id={`run-${run.id}-constraints`}>Constraints and preferences</h4>
        {explanation.hardViolations.length > 0 ? (
          <ul className="list" aria-label="Hard constraint violations">
            {explanation.hardViolations.map((v, index) => (
              <li key={`${v.constraint}-${index}`}>
                <div className="row-text">
                  <StatusBadge
                    tone="danger"
                    label={`${v.hard ? 'Hard constraint' : 'Preference'}: ${humanizeCode(v.constraint)}`}
                  />
                  <span>{v.message}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>No hard constraint is violated by this proposal.</p>
        )}
        {explanation.preferenceScores.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table">
              <caption>Preference scores (total penalty {explanation.totalPenalty})</caption>
              <thead>
                <tr>
                  <th scope="col">Preference</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Weight</th>
                  <th scope="col">Penalty</th>
                  <th scope="col">Explanation</th>
                </tr>
              </thead>
              <tbody>
                {explanation.preferenceScores.map((score, index) => (
                  <tr key={`${score.kind}-${index}`}>
                    <td>{FAIRNESS_PREFERENCE[score.kind]}</td>
                    <td>{score.hard ? 'Hard constraint' : 'Preference'}</td>
                    <td>{score.weight}</td>
                    <td>{score.penalty}</td>
                    <td>{score.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {games.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table">
            <caption>Proposed games ({games.length})</caption>
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col">Home</th>
                <th scope="col">Away</th>
                <th scope="col">Start</th>
              </tr>
            </thead>
            <tbody>
              {games.map((game) => (
                <tr key={game.key}>
                  <td>{game.round}</td>
                  <td>
                    <EntryName entryId={game.homeEntryId} teamIdOf={entries} />
                  </td>
                  <td>
                    {game.awayEntryId ? (
                      <EntryName entryId={game.awayEntryId} teamIdOf={entries} />
                    ) : (
                      'Bye'
                    )}
                  </td>
                  <td>
                    {game.scheduledStart ? formatInstant(game.scheduledStart) : 'No time found'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No proposal: nothing was created.</p>
      )}

      {run.scheduleDraftId ? (
        <p>
          <StatusBadge tone="pending" label="Draft, not published" /> The proposal is open as
          schedule draft {shortRef(run.scheduleDraftId)}. Review and publish it from{' '}
          <Link to="/schedule">Schedule</Link>, where current conflicts are checked again.
        </p>
      ) : null}
      {run.fixtureIds.length > 0 ? (
        <p>{run.fixtureIds.length} fixtures were created as obligations of this season.</p>
      ) : null}
      <OperationStatus operationId={run.operationId} />
    </section>
  );
}
