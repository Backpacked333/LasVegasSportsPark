/**
 * SCR-S-09 Fixture generation, part 2: a saved specification and its runs (SPK-FIX-001,
 * SPK-FIX-003 hard constraints distinct from preferences, SPK-FIX-004 search limit and honest
 * outcomes, SPK-FIX-005 drafts only, SPK-AT-010, SPK-AT-011, SPK-UX-008). While the solver runs
 * the limit is shown (processing state); the outcome comes back as a recorded run. "Check only"
 * records the run without creating fixtures or a draft. A run that fails keeps the specification
 * (the input snapshot) so it can be run again. Earlier runs are listed newest first
 * (`GET /v1/fixture-specifications/{id}/solver-runs`, CMP-05) with the outcome in the same honest
 * words: "feasible" never reads as optimal and "none found within the limit" never as impossible.
 * The solver run page shows a recorded run.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, fieldErrorsOf } from '../../features/competition/CommandError';
import { keys } from '../../features/competition/feedback';
import {
  CheckboxField,
  NumberField,
  TextField,
  parseWholeNumber,
} from '../../features/competition/fields';
import { formatDateOnly, formatInstant, shortRef } from '../../features/competition/format';
import {
  FAIRNESS_PREFERENCE,
  SOLVER_OUTCOME,
  SOLVER_STOPPED_BY,
  weekdayName,
} from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { EntryName, useSeasonEntries } from '../../features/competition/names';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { SolverRunView } from './SolverRunView';

type Specification = Schema<'FixtureSpecification'>;

function SpecificationSummary({
  spec,
  entries,
}: {
  spec: Specification;
  entries: ReadonlyMap<string, { teamId: string }>;
}) {
  const hard = spec.fairnessPreferences.filter((p) => p.hard);
  const soft = spec.fairnessPreferences.filter((p) => !p.hard);
  return (
    <>
      <div className="constraint-group" data-kind="hard">
        <h3>
          <StatusBadge tone="danger" label="Hard constraints" />
        </h3>
        <dl className="facets" aria-label="Hard constraints">
          <div>
            <dt>Teams</dt>
            <dd>
              {spec.teamEntryIds.length === 0 ? (
                'No approved teams'
              ) : (
                <ul>
                  {spec.teamEntryIds.map((id) => (
                    <li key={id}>
                      <EntryName entryId={id} teamIdOf={entries} />
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          <div>
            <dt>Games per team</dt>
            <dd>
              {spec.gamesPerTeam}; each pair meets {spec.opponentFrequency}{' '}
              {spec.opponentFrequency === 1 ? 'time' : 'times'}
            </dd>
          </div>
          <div>
            <dt>Dates</dt>
            <dd>
              {formatDateOnly(spec.startsOn)} to {formatDateOnly(spec.endsOn)}
              {spec.blackouts.length > 0
                ? `; blackouts ${spec.blackouts
                    .map((b) => `${formatDateOnly(b.start)} to ${formatDateOnly(b.end)}`)
                    .join(', ')}`
                : '; no blackouts'}
            </dd>
          </div>
          <div>
            <dt>Byes</dt>
            <dd>{spec.byesAllowed ? 'Allowed' : 'Not allowed'}</dd>
          </div>
          <div>
            <dt>Minimum rest</dt>
            <dd>{spec.minimumRestMinutes} minutes</dd>
          </div>
          <div>
            <dt>Allowed start times (facility-local)</dt>
            <dd>
              {spec.allowedStartTimes.map((t) => `${weekdayName(t.weekday)} ${t.time}`).join(', ')}
            </dd>
          </div>
          <div>
            <dt>Match duration</dt>
            <dd>{spec.matchDurationMinutes} minutes</dd>
          </div>
          <div>
            <dt>Resources</dt>
            <dd>{spec.requiredResourceIds.map(shortRef).join(', ')}</dd>
          </div>
          <div>
            <dt>Playoff</dt>
            <dd>
              {spec.playoffStructure
                ? `Single elimination, ${spec.playoffStructure.teams} teams`
                : 'None'}
            </dd>
          </div>
          {hard.map((p, index) => (
            <div key={`hard-${index}`}>
              <dt>Hard preference</dt>
              <dd>{FAIRNESS_PREFERENCE[p.kind]}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="constraint-group" data-kind="preference">
        <h3>
          <StatusBadge tone="info" label="Preferences (weighted)" />
        </h3>
        {soft.length === 0 ? (
          <p>No weighted preferences.</p>
        ) : (
          <ul aria-label="Weighted preferences">
            {soft.map((p, index) => (
              <li key={`soft-${index}`}>
                {FAIRNESS_PREFERENCE[p.kind]}, weight {p.weight ?? 1}
                {p.approvalReference ? ` (approved: ${p.approvalReference})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function GenerateForm({
  spec,
  entries,
}: {
  spec: Specification;
  entries: ReadonlyMap<string, { teamId: string }>;
}) {
  const generate = useApiCommand('post', '/fixture-specifications/{id}/generate', {
    invalidate: keys('/seasons/{id}/fixtures', '/fixture-specifications/{id}/solver-runs'),
  });
  const [maxCandidates, setMaxCandidates] = useState('');
  const [seconds, setSeconds] = useState('');
  const [seed, setSeed] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [draftName, setDraftName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiErrors = fieldErrorsOf(generate.error);

  const candidates = maxCandidates.trim() ? parseWholeNumber(maxCandidates) : null;
  const secs = seconds.trim() ? parseWholeNumber(seconds) : null;
  const limitText = `${candidates ?? 'the default number of'} candidates or ${
    secs !== null ? `${secs} seconds` : 'the default time limit'
  }`;

  const submit = () => {
    const next: Record<string, string> = {};
    if (maxCandidates.trim() && (candidates === null || candidates < 1 || candidates > 500))
      next.maxCandidates = 'Enter 1 to 500, or leave empty for the default.';
    if (seconds.trim() && (secs === null || secs < 1 || secs > 60))
      next.seconds = 'Enter 1 to 60 seconds, or leave empty for the default.';
    const seedValue = seed.trim() ? parseWholeNumber(seed) : null;
    if (seed.trim() && (seedValue === null || seedValue < 0)) next.seed = 'Enter 0 or more.';
    const given = [maxCandidates, seconds, seed].filter((v) => v.trim()).length;
    if (given > 0 && given < 3)
      next.searchSettings =
        'Give all three search settings, or leave all three empty for the default.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const searchSettings =
      candidates !== null && secs !== null && seedValue !== null
        ? { maxCandidates: candidates, timeLimitMs: secs * 1000, seed: seedValue }
        : undefined;
    void generate
      .submit({
        path: { id: spec.id },
        body: {
          dryRun,
          ...(searchSettings ? { searchSettings } : {}),
          ...(draftName.trim() ? { draftName: draftName.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };

  return (
    <section className="panel" aria-labelledby="generate-title">
      <h3 id="generate-title">Generate a proposal</h3>
      <form
        className="form"
        noValidate
        aria-label="Generate fixtures"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="field-grid">
          <NumberField
            label="Candidate limit"
            value={maxCandidates}
            onChange={setMaxCandidates}
            hint="Leave the three settings empty for the service default."
            error={errors.maxCandidates ?? apiErrors['searchSettings.maxCandidates']}
          />
          <NumberField
            label="Time limit (seconds)"
            value={seconds}
            onChange={setSeconds}
            hint="1 to 60 seconds."
            error={errors.seconds ?? apiErrors['searchSettings.timeLimitMs']}
          />
          <NumberField
            label="Seed"
            value={seed}
            onChange={setSeed}
            hint="The same seed and input give the same proposal."
            error={errors.seed}
          />
          <TextField label="Draft name" value={draftName} onChange={setDraftName} />
        </div>
        {errors.searchSettings ? (
          <p className="error-text" role="alert">
            {errors.searchSettings}
          </p>
        ) : null}
        <CheckboxField
          label="Check only (record the run; create no fixtures or schedule draft)"
          checked={dryRun}
          onChange={setDryRun}
        />
        <div className="actions">
          <CommandButton type="submit" busy={generate.isProcessing}>
            {dryRun ? 'Run a check' : 'Generate fixtures and a draft'}
          </CommandButton>
        </div>
        {generate.isProcessing ? (
          <p role="status" aria-busy="true">
            Searching for a proposal: up to {limitText}.
          </p>
        ) : null}
        <CommandError error={generate.error} onRetry={submit} />
      </form>
      {generate.status === 'success' && generate.data ? (
        <>
          <p role="status">
            Run recorded. <Link to={`/leagues/solver-runs/${generate.data.id}`}>Open this run</Link>
          </p>
          <SolverRunView run={generate.data} entries={entries} />
        </>
      ) : null}
    </section>
  );
}

/** Earlier runs of the specification, newest first (CMP-05, SPK-FIX-004, SPK-AT-011). */
function EarlierRuns({ specificationId }: { specificationId: string }) {
  const runs = useApiPages({
    path: '/fixture-specifications/{id}/solver-runs',
    request: { path: { id: specificationId }, query: { limit: 20 } },
  });
  return (
    <section className="panel" aria-labelledby="earlier-runs-title">
      <h3 id="earlier-runs-title">Earlier runs</h3>
      <QueryBoundary
        query={runs}
        label="earlier runs"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No runs yet',
          description: 'Each check or generation from this specification is recorded here.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label="Earlier runs">
            {items.map((run) => {
              const outcome = SOLVER_OUTCOME[run.outcome];
              return (
                <li key={run.id}>
                  <div className="row-text">
                    <Link className="row-title" to={`/leagues/solver-runs/${run.id}`}>
                      Run {shortRef(run.id)}, {formatInstant(run.finishedAt)}
                    </Link>
                    <StatusBadge tone={outcome.tone} label={outcome.label} />
                    <span className="caption">
                      {run.dryRun ? 'Check only' : 'Generated fixtures and a draft'} · search
                      stopped because {SOLVER_STOPPED_BY[run.explanation.stoppedBy]} ·{' '}
                      {run.explanation.candidatesTried} candidates tried
                    </span>
                    <span className="caption">{outcome.explanation}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={runs} label="runs" />
    </section>
  );
}

export function FixtureSpecificationScreen() {
  const { specificationId = '' } = useParams();
  const spec = useApiQuery({
    path: '/fixture-specifications/{id}',
    request: { path: { id: specificationId } },
  });
  const { byId } = useSeasonEntries(spec.data?.seasonId);
  return (
    <section aria-labelledby="specification-title">
      <h2 id="specification-title">{spec.data?.name ?? 'Fixture specification'}</h2>
      <LeaguesNav />
      <QueryBoundary
        query={spec}
        label="the specification"
        empty={{ title: '', description: '' }}
        unavailableOffline={['generating fixtures']}
      >
        {(data) => (
          <>
            <p>
              <Link to={`/leagues/seasons/${data.seasonId}/fixtures`}>Season fixtures</Link>
            </p>
            <SpecificationSummary spec={data} entries={byId} />
            <GenerateForm spec={data} entries={byId} />
            <EarlierRuns specificationId={data.id} />
          </>
        )}
      </QueryBoundary>
    </section>
  );
}

export function SolverRunScreen() {
  const { runId = '' } = useParams();
  const run = useApiQuery({ path: '/solver-runs/{id}', request: { path: { id: runId } } });
  const spec = useApiQuery({
    path: '/fixture-specifications/{id}',
    request: { path: { id: run.data?.specificationId ?? '' } },
    enabled: !!run.data,
  });
  const { byId } = useSeasonEntries(spec.data?.seasonId);
  return (
    <section aria-labelledby="solver-run-title">
      <h2 id="solver-run-title">Solver run</h2>
      <LeaguesNav />
      <QueryBoundary query={run} label="the solver run" empty={{ title: '', description: '' }}>
        {(data) => (
          <>
            <p>
              <Link to={`/leagues/fixture-specifications/${data.specificationId}`}>
                Back to the specification
              </Link>
            </p>
            <SolverRunView run={data} entries={byId} />
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
