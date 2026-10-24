/**
 * SCR-W-05 Match report (official) (SPK-STAFF-005, SPK-RESULT-001, SPK-RESULT-002,
 * SPK-DISC-001, SPK-DISC-004, SPK-DISC-005, SPK-UX-008, DEC-010, DEC-063, DEC-065).
 *
 * - Scores, result classification, match incidents, abandonment details and notes, submitted as
 *   a new result revision (`POST /v1/fixtures/{id}/results`); a revision already submitted by
 *   another official is never overwritten (the API keeps both). Who publishes results is DEC-065
 *   (pending): a submitted report is provisional.
 * - Incident narratives are restricted information: they are sent to the API and not repeated
 *   on this screen after submission.
 * - Cards need the players' record ids, and the workspace has no field-limited player list, so
 *   cards are not available here.
 * - Offline, the report stays on screen as entered; submitting needs a connection (a queued
 *   submission is DEC-032, pending).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import {
  SelectField,
  TextAreaField,
  TextField,
  fieldErrorsOf,
} from '../../features/operations/fields';
import { formatInstant, humanize } from '../../features/operations/format';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { MyAssignmentPage, type WorkspaceAssignment } from './MyAssignment';

type Classification = Schema<'ResultClassification'>;
type IncidentInput = Schema<'ResultIncidentInput'>;

const CLASSIFICATIONS: readonly Classification[] = [
  'completed',
  'forfeit',
  'abandoned',
  'postponed',
  'canceled',
  'disputed',
];
const INCIDENT_KINDS = ['misconduct', 'complaint', 'operational', 'injury'] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export function MatchReportScreen() {
  return (
    <MyAssignmentPage title={(item) => `Match report${item ? `: ${item.activity.title}` : ''}`}>
      {(item) =>
        item.activity.targetType === 'fixture' ? (
          <MatchReport item={item} />
        ) : (
          <StateView
            variant="unavailable"
            description="A match report is for an assigned fixture."
          />
        )
      }
    </MyAssignmentPage>
  );
}

/** AbandonmentDetails.minutePlayed and an incident minute are 0 to 200 (SubmitResultBody). */
const MAX_MINUTE = 200;

interface IncidentDraft {
  kind: (typeof INCIDENT_KINDS)[number] | '';
  severity: (typeof SEVERITIES)[number] | '';
  summary: string;
  narrative: string;
  teamEntryId: string;
  minute: string;
}

const EMPTY_INCIDENT: IncidentDraft = {
  kind: '',
  severity: '',
  summary: '',
  narrative: '',
  teamEntryId: '',
  minute: '',
};

function MatchReport({ item }: { item: WorkspaceAssignment }) {
  const { online } = useApp();
  const fixtureId = item.activity.targetId;
  const teams = item.activity.participants.filter((p) => p.teamEntryId);
  const home = item.activity.participants.find((p) => p.side === 'home')?.name ?? 'Home';
  const away = item.activity.participants.find((p) => p.side === 'away')?.name ?? 'Away';
  const results = useApiQuery({
    path: '/fixtures/{id}/results',
    request: { path: { id: fixtureId } },
  });
  const submit = useApiCommand('post', '/fixtures/{id}/results', {
    invalidate: [['api', '/fixtures/{id}/results']],
  });
  const [classification, setClassification] = useState<Classification | ''>('');
  const [homeScore, setHomeScore] = useState('');
  const [awayScore, setAwayScore] = useState('');
  const [forfeiting, setForfeiting] = useState('');
  const [minutePlayed, setMinutePlayed] = useState('');
  const [abandonReason, setAbandonReason] = useState('');
  const [notes, setNotes] = useState('');
  const [incidents, setIncidents] = useState<IncidentDraft[]>([]);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const apiErrors = fieldErrorsOf(submit.error);
  // SubmitResultBody (SPK-RESULT-002): scores are required for a completed or forfeited match and
  // optional for an abandoned one; minutes are 0 to 200.
  const needsScore = classification === 'completed' || classification === 'forfeit';
  const showsScore = needsScore || classification === 'abandoned';
  const minuteOf = (v: string): number | null => {
    if (!/^\d{1,3}$/.test(v.trim())) return null;
    const n = Number(v.trim());
    return n <= MAX_MINUTE ? n : null;
  };

  const send = () => {
    const next: Record<string, string> = {};
    if (!classification) next.classification = 'Choose how the match ended.';
    const score = (v: string) => (/^\d{1,3}$/.test(v.trim()) ? Number(v.trim()) : null);
    const homeGiven = homeScore.trim() !== '';
    const awayGiven = awayScore.trim() !== '';
    if (needsScore && (score(homeScore) === null || score(awayScore) === null)) {
      next.score = 'Enter both scores as whole numbers.';
    } else if (
      classification === 'abandoned' &&
      (homeGiven || awayGiven) &&
      (score(homeScore) === null || score(awayScore) === null)
    ) {
      next.score = 'Enter both scores as whole numbers, or leave both empty.';
    }
    if (classification === 'forfeit' && !forfeiting)
      next.forfeiting = 'Choose the team that forfeited.';
    if (
      classification === 'abandoned' &&
      (minuteOf(minutePlayed) === null || !abandonReason.trim())
    ) {
      next.abandonment = `Give the minute the match stopped (0 to ${MAX_MINUTE}) and the reason.`;
    }
    incidents.forEach((i, n) => {
      if (!i.kind || !i.severity || !i.summary.trim())
        next[`incident${n}`] = 'Each incident needs a kind, a severity and a summary.';
      else if (i.minute.trim() && minuteOf(i.minute) === null)
        next[`incident${n}`] = `An incident minute is a whole number from 0 to ${MAX_MINUTE}.`;
    });
    setProblems(next);
    if (Object.keys(next).length > 0 || !classification) return;
    const incidentInputs: IncidentInput[] = incidents.map((i) => ({
      kind: i.kind as IncidentInput['kind'],
      severity: i.severity as IncidentInput['severity'],
      summary: i.summary.trim(),
      ...(i.narrative.trim() ? { narrative: i.narrative.trim() } : {}),
      ...(i.teamEntryId ? { teamEntryId: i.teamEntryId } : {}),
      ...(minuteOf(i.minute) !== null ? { minute: minuteOf(i.minute) as number } : {}),
    }));
    void submit
      .submit({
        path: { id: fixtureId },
        body: {
          classification,
          ...(needsScore || (classification === 'abandoned' && homeGiven && awayGiven)
            ? { homeScore: Number(homeScore.trim()), awayScore: Number(awayScore.trim()) }
            : {}),
          ...(classification === 'forfeit' ? { forfeitingEntryId: forfeiting } : {}),
          ...(classification === 'abandoned'
            ? {
                abandonment: {
                  minutePlayed: minuteOf(minutePlayed) as number,
                  reason: abandonReason.trim(),
                },
              }
            : {}),
          cards: [],
          incidents: incidentInputs,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };

  // API field errors this form renders next to a field; any other path is shown with the code.
  const rendered = new Set<string>([
    ...(showsScore ? ['homeScore', 'awayScore'] : []),
    ...(classification === 'forfeit' ? ['forfeitingEntryId'] : []),
  ]);
  const unrenderedApiErrors = Object.keys(apiErrors).some((k) => !rendered.has(k));

  return (
    <>
      {results.data && results.data.length > 0 ? (
        <section className="ops-section" aria-labelledby="revisions-title">
          <h3 id="revisions-title">Result revisions</h3>
          <ul className="ops-history" aria-label="Result revisions">
            {results.data.map((r) => (
              <li key={r.id}>
                Revision {r.revisionNo}: {humanize(r.classification)}
                {r.homeScore !== null && r.awayScore !== null
                  ? ` ${r.homeScore}–${r.awayScore}`
                  : ''}{' '}
                <StatusBadge
                  tone={
                    r.status === 'official'
                      ? 'success'
                      : r.status === 'superseded'
                        ? 'neutral'
                        : 'pending'
                  }
                  label={r.status === 'submitted' ? 'Submitted (provisional)' : humanize(r.status)}
                />
                <span className="caption">
                  {' '}
                  by {r.submittedBy.actorLabel}
                  {r.submittedAt ? `, ${formatInstant(r.submittedAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="caption">A new report adds a revision; earlier revisions are kept.</p>
        </section>
      ) : null}
      <form
        className="ops-form ops-section"
        aria-label="Match report"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <fieldset
          className="ops-fieldset"
          aria-invalid={problems.classification ? true : undefined}
          aria-describedby={problems.classification ? 'report-classification-error' : undefined}
        >
          <legend>How did the match end?</legend>
          {CLASSIFICATIONS.map((c) => (
            <label key={c} className="ops-check">
              <input
                type="radio"
                name="classification"
                checked={classification === c}
                onChange={() => setClassification(c)}
              />
              {humanize(c)}
            </label>
          ))}
          {problems.classification ? (
            <span className="error-text" id="report-classification-error" role="alert">
              {problems.classification}
            </span>
          ) : null}
        </fieldset>
        {showsScore ? (
          <fieldset
            className="ops-fieldset"
            aria-invalid={problems.score ? true : undefined}
            aria-describedby={problems.score ? 'report-score-error' : undefined}
          >
            <legend>{needsScore ? 'Score' : 'Score when the match stopped (optional)'}</legend>
            <TextField
              label={`${home} score`}
              value={homeScore}
              onChange={setHomeScore}
              inputMode="numeric"
              error={apiErrors.homeScore}
            />
            <TextField
              label={`${away} score`}
              value={awayScore}
              onChange={setAwayScore}
              inputMode="numeric"
              error={apiErrors.awayScore}
            />
            {problems.score ? (
              <span className="error-text" id="report-score-error" role="alert">
                {problems.score}
              </span>
            ) : null}
          </fieldset>
        ) : null}
        {classification === 'forfeit' ? (
          <SelectField
            label="Team that forfeited"
            value={forfeiting}
            onChange={setForfeiting}
            placeholder="Choose a team"
            options={teams.map((t) => ({ value: t.teamEntryId as string, label: t.name }))}
            error={problems.forfeiting ?? apiErrors.forfeitingEntryId}
          />
        ) : null}
        {classification === 'abandoned' ? (
          <fieldset
            className="ops-fieldset"
            aria-invalid={problems.abandonment ? true : undefined}
            aria-describedby={problems.abandonment ? 'report-abandonment-error' : undefined}
          >
            <legend>Abandonment</legend>
            <TextField
              label="Minute the match stopped"
              value={minutePlayed}
              onChange={setMinutePlayed}
              inputMode="numeric"
            />
            <TextAreaField
              label="Reason for abandonment"
              value={abandonReason}
              onChange={setAbandonReason}
              rows={2}
            />
            {problems.abandonment ? (
              <span className="error-text" id="report-abandonment-error" role="alert">
                {problems.abandonment}
              </span>
            ) : null}
          </fieldset>
        ) : null}
        <fieldset className="ops-fieldset">
          <legend>Incidents</legend>
          {incidents.map((incident, n) => (
            <IncidentEditor
              key={n}
              index={n}
              incident={incident}
              teams={teams.map((t) => ({ value: t.teamEntryId as string, label: t.name }))}
              error={problems[`incident${n}`]}
              onChange={(next) => setIncidents((prev) => prev.map((x, i) => (i === n ? next : x)))}
              onRemove={() => setIncidents((prev) => prev.filter((_, i) => i !== n))}
            />
          ))}
          <Button
            variant="secondary"
            onClick={() => setIncidents((prev) => [...prev, EMPTY_INCIDENT])}
          >
            Add an incident
          </Button>
        </fieldset>
        <StateView
          variant="unavailable"
          title="Cards are not available here yet"
          description="Recording a card needs the player's record, and the workspace cannot read the player list yet. Report cards to the league manager."
        />
        <TextAreaField label="Notes (optional)" value={notes} onChange={setNotes} rows={3} />
        <StateView
          variant="pending-decision"
          subject="Who publishes results"
          decisions={['DEC-065']}
          owner="League manager"
        />
        <div className="ops-actions">
          <Button type="submit" busy={submit.isProcessing} disabled={!online}>
            Submit report
          </Button>
          {!online ? (
            <span className="caption">
              Submitting needs a connection; your report stays here as entered (queued submission is
              pending DEC-032).
            </span>
          ) : null}
        </div>
        {submit.error && (Object.keys(apiErrors).length === 0 || unrenderedApiErrors) ? (
          <CommandError error={submit.error} onRetry={send} subject="This fixture" />
        ) : null}
        {submit.data ? (
          <CommandSuccess
            label={
              submit.data.status === 'submitted'
                ? 'Submitted (provisional)'
                : humanize(submit.data.status)
            }
          >
            <span className="caption">
              Revision {submit.data.revisionNo}. Publication is separately authorised.
            </span>
          </CommandSuccess>
        ) : null}
      </form>
    </>
  );
}

function IncidentEditor({
  index,
  incident,
  teams,
  error,
  onChange,
  onRemove,
}: {
  index: number;
  incident: IncidentDraft;
  teams: { value: string; label: string }[];
  error?: string;
  onChange: (next: IncidentDraft) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const errorId = `incident-${index}-error`;
  return (
    <div
      className="ops-section"
      role="group"
      aria-label={`Incident ${n}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <SelectField
        label={`Incident ${n} kind`}
        value={incident.kind}
        onChange={(v) => onChange({ ...incident, kind: v as IncidentDraft['kind'] })}
        placeholder="Choose"
        options={INCIDENT_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
      />
      <SelectField
        label={`Incident ${n} severity`}
        value={incident.severity}
        onChange={(v) => onChange({ ...incident, severity: v as IncidentDraft['severity'] })}
        placeholder="Choose"
        options={SEVERITIES.map((k) => ({ value: k, label: humanize(k) }))}
      />
      <TextField
        label={`Incident ${n} summary`}
        value={incident.summary}
        onChange={(v) => onChange({ ...incident, summary: v })}
      />
      <TextAreaField
        label={`Incident ${n} narrative (restricted)`}
        value={incident.narrative}
        onChange={(v) => onChange({ ...incident, narrative: v })}
        rows={3}
        hint="Visible only to the people who handle incidents."
      />
      {teams.length > 0 ? (
        <SelectField
          label={`Incident ${n} team (optional)`}
          value={incident.teamEntryId}
          onChange={(v) => onChange({ ...incident, teamEntryId: v })}
          placeholder="No team"
          options={teams}
        />
      ) : null}
      <TextField
        label={`Incident ${n} minute (optional)`}
        value={incident.minute}
        onChange={(v) => onChange({ ...incident, minute: v })}
        inputMode="numeric"
      />
      {error ? (
        <span className="error-text" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
      <Button variant="secondary" onClick={onRemove} aria-label={`Remove incident ${n}`}>
        Remove
      </Button>
    </div>
  );
}
