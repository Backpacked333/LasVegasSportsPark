/**
 * SCR-S-12 Disputes and discipline, part 2: restricted discipline records (SPK-DISC-001 cards,
 * misconduct, suspensions, complaints, appeals, operational incidents; SPK-DISC-002 every
 * suspension field; SPK-DISC-003 approval and overturn with history; SPK-DISC-004 sensitive
 * narratives restricted; SPK-UX-008). Lists show only the safe incident summary: a narrative is
 * opened deliberately on the incident page. Reading needs league management authority; anyone
 * else gets "not available" and nothing implies a record exists. A proposed suspension must state
 * its scope (never assumed to span every program) and completion criteria; its subject is found by
 * name (person search, ID-02) or entered by reference. Decisions and appeals are listed with their
 * own actions (DisciplineRecords.tsx, CMP-05). The lengths, scopes and appeal procedure are
 * pending DEC-010 and DEC-063, so nothing is preset.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, fieldErrorsOf } from '../../features/competition/CommandError';
import { keys, PendingNote, SuccessNote, useRefetch } from '../../features/competition/feedback';
import {
  CheckboxField,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  isRecordReference,
  parseWholeNumber,
} from '../../features/competition/fields';
import { formatInstant, localInputToIso } from '../../features/competition/format';
import {
  APPEAL_SUMMARY,
  INCIDENT_KIND,
  INCIDENT_STATUS,
  SUSPENSION_SOURCE,
  SUSPENSION_STATUS,
} from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { PersonName, usePersonNames } from '../../features/competition/names';
import { PersonSearchField } from '../../features/competition/PersonSearchField';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { Appeals, Decisions } from './DisciplineRecords';

type Suspension = Schema<'Suspension'>;
type IncidentStatus = Schema<'IncidentStatus'>;
type SuspensionStatus = Schema<'SuspensionStatus'>;

function useCompetitionNames(): ReadonlyMap<string, string> {
  const competitions = useApiQuery({ path: '/competitions', staleTime: 5 * 60_000 });
  return new Map((competitions.data ?? []).map((c) => [c.id, c.name]));
}

function Incidents() {
  const [status, setStatus] = useState('');
  const incidents = useApiQuery({
    path: '/incidents',
    request: { query: { ...(status ? { status: status as IncidentStatus } : {}) } },
  });
  return (
    <section className="panel" aria-labelledby="incidents-title">
      <h3 id="incidents-title">Incidents and reports</h3>
      <SelectField
        label="Incident status"
        value={status}
        onChange={setStatus}
        options={Object.entries(INCIDENT_STATUS).map(([value, b]) => ({ value, label: b.label }))}
        placeholder="All statuses"
      />
      <QueryBoundary
        query={incidents}
        label="incidents"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No incidents',
          description:
            'Cards, misconduct reports, complaints and operational incidents appear here.',
        }}
        unavailableOffline={['reviewing and closing incidents']}
      >
        {(data) => (
          <ul className="list" aria-label="Incidents">
            {data.map((incident) => {
              const badge = INCIDENT_STATUS[incident.status];
              return (
                <li key={incident.id}>
                  <div className="row-text">
                    <Link className="row-title" to={`/leagues/discipline/incidents/${incident.id}`}>
                      {INCIDENT_KIND[incident.kind]}: {incident.summary}
                    </Link>
                    <span className="caption">
                      Severity {incident.severity} · {formatInstant(incident.occurredAt)} · reported
                      by {incident.reportedBy.actorLabel}
                    </span>
                  </div>
                  <StatusBadge tone={badge.tone} label={`Incident ${badge.label}`} />
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

export function suspensionTerms(s: Suspension, competitionNames: ReadonlyMap<string, string>) {
  const scope =
    s.scope === 'all'
      ? 'Every competition'
      : `Only: ${s.competitionIds.map((id) => competitionNames.get(id) ?? 'a competition').join(', ')}`;
  const period =
    s.effectiveFrom || s.effectiveTo
      ? `${formatInstant(s.effectiveFrom)} to ${s.effectiveTo ? formatInstant(s.effectiveTo) : 'open-ended'}`
      : null;
  const count =
    s.matchCount !== null ? `${s.matchesServed} of ${s.matchCount} matches served` : null;
  return { scope, period, count };
}

function SuspensionActions({ suspension }: { suspension: Suspension }) {
  const update = useApiCommand('patch', '/suspensions/{id}', {
    invalidate: keys('/suspensions', '/suspensions/{id}'),
  });
  const reload = useRefetch(['/suspensions']);
  const [overturning, setOverturning] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<'approve' | 'overturn'>('approve');
  const send = (action: 'approve' | 'overturn') => {
    setLast(action);
    if (action === 'overturn' && !reason.trim()) {
      setError('Overturning needs a reason.');
      return;
    }
    setError(null);
    void update
      .submit({
        path: { id: suspension.id },
        body: {
          action,
          expectedRevision: suspension.revision,
          ...(action === 'overturn' ? { reason: reason.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };
  if (suspension.status === 'served' || suspension.status === 'overturned') return null;
  return (
    <div className="form">
      <div className="actions">
        {suspension.status === 'proposed' ? (
          <CommandButton
            busy={update.isProcessing && last === 'approve'}
            onClick={() => send('approve')}
          >
            Approve
          </CommandButton>
        ) : null}
        <Button variant="secondary" onClick={() => setOverturning((o) => !o)}>
          Overturn
        </Button>
      </div>
      {overturning ? (
        <form
          className="form"
          noValidate
          aria-label="Overturn the suspension"
          onSubmit={(event) => {
            event.preventDefault();
            send('overturn');
          }}
        >
          <TextAreaField
            label="Reason for overturning"
            required
            value={reason}
            onChange={setReason}
            error={error}
          />
          <CommandButton
            type="submit"
            variant="secondary"
            busy={update.isProcessing && last === 'overturn'}
          >
            Overturn the suspension
          </CommandButton>
        </form>
      ) : null}
      {update.status === 'success' && update.data ? (
        <SuccessNote>{`Suspension ${update.data.status}`}</SuccessNote>
      ) : null}
      <CommandError
        error={update.error}
        onRetry={() => send(last)}
        onReload={() => {
          update.reset();
          reload();
        }}
      />
    </div>
  );
}

function ProposeSuspensionForm() {
  const competitions = useApiQuery({ path: '/competitions', staleTime: 5 * 60_000 });
  const create = useApiCommand('post', '/suspensions', { invalidate: keys('/suspensions') });
  const [subject, setSubject] = useState('');
  const [basis, setBasis] = useState('');
  const [scope, setScope] = useState('');
  const [competitionIds, setCompetitionIds] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [matchCount, setMatchCount] = useState('');
  const [criteria, setCriteria] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiErrors = fieldErrorsOf(create.error);
  const err = (key: string, apiKey = key) => errors[key] ?? apiErrors[apiKey];

  const submit = () => {
    const next: Record<string, string> = {};
    if (!isRecordReference(subject))
      next.subject = 'Find the person by name, or enter the reference shown on their record.';
    if (!basis.trim()) next.basis = 'State the basis for the suspension.';
    if (!scope) next.scope = 'Choose the scope: a suspension is never assumed to apply everywhere.';
    if (scope === 'competitions' && competitionIds.length === 0)
      next.competitionIds = 'Choose the competitions it applies to.';
    const count = matchCount.trim() ? parseWholeNumber(matchCount) : null;
    if (matchCount.trim() && (count === null || count < 1)) next.matchCount = 'Enter at least 1.';
    const effectiveFrom = localInputToIso(from);
    const effectiveTo = localInputToIso(to);
    if (count === null && !effectiveFrom)
      next.matchCount = 'State an effective period or a match count.';
    if (effectiveFrom && effectiveTo && effectiveFrom >= effectiveTo)
      next.to = 'The end is before the start.';
    if (!criteria.trim()) next.criteria = 'State the completion criteria.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void create
      .submit({
        body: {
          subjectPersonId: subject.trim(),
          basis: basis.trim(),
          terms: {
            scope: scope as 'all' | 'competitions',
            competitionIds: scope === 'competitions' ? competitionIds : [],
            ...(effectiveFrom ? { effectiveFrom } : {}),
            ...(effectiveTo ? { effectiveTo } : {}),
            ...(count !== null ? { matchCount: count } : {}),
            completionCriteria: criteria.trim(),
          },
        },
      })
      .then(() => {
        // The intent is complete: clear the form so a second click cannot propose a duplicate
        // suspension under a new key (§4.9).
        setSubject('');
        setBasis('');
        setScope('');
        setCompetitionIds([]);
        setFrom('');
        setTo('');
        setMatchCount('');
        setCriteria('');
        setErrors({});
      })
      .catch(() => undefined);
  };

  return (
    <form
      className="form"
      noValidate
      aria-label="Propose a suspension"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <PersonSearchField
        label="Suspended person"
        required
        value={subject}
        onChange={setSubject}
        error={err('subject', 'subjectPersonId')}
      />
      <TextAreaField
        label="Basis"
        required
        value={basis}
        onChange={setBasis}
        error={err('basis')}
      />
      <SelectField
        label="Scope"
        required
        value={scope}
        onChange={setScope}
        options={[
          { value: 'competitions', label: 'Named competitions only' },
          { value: 'all', label: 'Every competition' },
        ]}
        error={err('scope', 'terms.scope')}
      />
      {scope === 'competitions' ? (
        <fieldset>
          <legend>Applicable competitions</legend>
          {(competitions.data ?? []).map((c) => (
            <CheckboxField
              key={c.id}
              label={c.name}
              checked={competitionIds.includes(c.id)}
              onChange={(checked) =>
                setCompetitionIds((ids) =>
                  checked ? [...ids, c.id] : ids.filter((id) => id !== c.id),
                )
              }
            />
          ))}
          {err('competitionIds', 'terms.competitionIds') ? (
            <span className="error-text" role="alert">
              {err('competitionIds', 'terms.competitionIds')}
            </span>
          ) : null}
        </fieldset>
      ) : null}
      <div className="field-grid">
        <TextField
          label="Effective from"
          type="datetime-local"
          value={from}
          onChange={setFrom}
          hint="Your device's time zone."
        />
        <TextField
          label="Effective until"
          type="datetime-local"
          value={to}
          onChange={setTo}
          error={err('to', 'terms.effectiveTo')}
        />
        <NumberField
          label="Match count"
          value={matchCount}
          onChange={setMatchCount}
          error={err('matchCount', 'terms.matchCount')}
          hint="An effective period, a match count, or both."
        />
      </div>
      <TextAreaField
        label="Completion criteria"
        required
        value={criteria}
        onChange={setCriteria}
        error={err('criteria', 'terms.completionCriteria')}
      />
      <CommandButton type="submit" busy={create.isProcessing}>
        Propose the suspension
      </CommandButton>
      {create.status === 'success' && create.data ? (
        <SuccessNote>{`Suspension ${create.data.status}: awaiting approval`}</SuccessNote>
      ) : null}
      <CommandError error={create.error} onRetry={submit} />
    </form>
  );
}

function Suspensions() {
  const [status, setStatus] = useState('');
  const [proposing, setProposing] = useState(false);
  const names = useCompetitionNames();
  const suspensions = useApiQuery({
    path: '/suspensions',
    request: { query: { ...(status ? { status: status as SuspensionStatus } : {}) } },
  });
  const people = usePersonNames((suspensions.data ?? []).map((s) => s.subjectPersonId));
  return (
    <section className="panel" aria-labelledby="suspensions-title">
      <h3 id="suspensions-title">Suspensions</h3>
      <div className="actions">
        <SelectField
          label="Suspension status"
          value={status}
          onChange={setStatus}
          options={Object.entries(SUSPENSION_STATUS).map(([value, b]) => ({
            value,
            label: b.label,
          }))}
          placeholder="All statuses"
        />
        <Button
          variant="secondary"
          aria-expanded={proposing}
          onClick={() => setProposing((o) => !o)}
        >
          {proposing ? 'Close the proposal form' : 'Propose a suspension'}
        </Button>
      </div>
      {proposing ? <ProposeSuspensionForm /> : null}
      <QueryBoundary
        query={suspensions}
        label="suspensions"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No suspensions',
          description:
            'Suspensions proposed by the rule set from cards, or by a decision, appear here for approval.',
        }}
        unavailableOffline={['approving or overturning suspensions']}
      >
        {(data) => (
          <ul className="list" aria-label="Suspensions">
            {data.map((s) => {
              const badge = SUSPENSION_STATUS[s.status];
              const terms = suspensionTerms(s, names);
              return (
                <li key={s.id} aria-labelledby={`suspension-${s.id}`}>
                  <div className="row-text">
                    <span className="row-title" id={`suspension-${s.id}`}>
                      <PersonName personId={s.subjectPersonId} names={people} />
                    </span>
                    <StatusBadge tone={badge.tone} label={`Suspension ${badge.label}`} />
                    <dl className="facets">
                      <div>
                        <dt>Basis</dt>
                        <dd>{s.basis}</dd>
                      </div>
                      <div>
                        <dt>Scope</dt>
                        <dd>{terms.scope}</dd>
                      </div>
                      <div>
                        <dt>Effective period</dt>
                        <dd>{terms.period ?? 'Not stated'}</dd>
                      </div>
                      <div>
                        <dt>Match count</dt>
                        <dd>{terms.count ?? 'Not stated'}</dd>
                      </div>
                      <div>
                        <dt>Completion criteria</dt>
                        <dd>{s.completionCriteria}</dd>
                      </div>
                      <div>
                        <dt>Approval</dt>
                        <dd>
                          {s.approvedBy
                            ? `${s.approvedBy.actorLabel} ${formatInstant(s.approvedAt)}`
                            : 'Not approved'}
                        </dd>
                      </div>
                      <div>
                        <dt>Appeal</dt>
                        <dd>{APPEAL_SUMMARY[s.appealStatus]}</dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>{SUSPENSION_SOURCE[s.sourceKind]}</dd>
                      </div>
                    </dl>
                    {s.overturnReason ? <span>Overturned: {s.overturnReason}</span> : null}
                  </div>
                  <SuspensionActions suspension={s} />
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

export function DisciplineScreen() {
  return (
    <section aria-labelledby="discipline-title">
      <h2 id="discipline-title">Discipline</h2>
      <LeaguesNav />
      <p className="caption">
        Restricted records: narratives never appear in public results, team views or customer
        exports. Disputes are reviewed under Disputes or from each fixture.
      </p>
      <PendingNote decision={PENDING.discipline} />
      <Incidents />
      <Suspensions />
      <Decisions />
      <Appeals />
    </section>
  );
}
