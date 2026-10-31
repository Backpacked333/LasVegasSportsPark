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
 * - Cards are recorded against players of the field-limited match sheet
 *   (`GET /v1/fixtures/{id}/match-sheet`, CMP-06: names and numbers, the person id only in the
 *   official's full view); when the sheet is not available to the viewer, cards are not offered.
 * - Offline, the report stays on screen as entered; submitting needs a connection (a queued
 *   submission is DEC-032, pending).
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
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
import { useMatchSheet, type MatchSheet } from './MatchSheet';
import { MyAssignmentPage, type WorkspaceAssignment } from './MyAssignment';
import { activityZone } from './WorkspaceScreen';

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
const CARD_KINDS = ['yellow', 'second_yellow', 'red'] as const;
type CardInput = Schema<'ResultCard'>;

interface CardDraft {
  teamEntryId: string;
  personId: string;
  kind: (typeof CARD_KINDS)[number] | '';
  minute: string;
}

const EMPTY_CARD: CardDraft = { teamEntryId: '', personId: '', kind: '', minute: '' };
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
  const [cards, setCards] = useState<CardDraft[]>([]);
  const sheet = useMatchSheet(fixtureId);
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
    cards.forEach((c, n) => {
      if (!c.teamEntryId || !c.personId || !c.kind)
        next[`card${n}`] = 'Each card needs a team, a player and a kind.';
      else if (c.minute.trim() && minuteOf(c.minute) === null)
        next[`card${n}`] = `A card minute is a whole number from 0 to ${MAX_MINUTE}.`;
    });
    setProblems(next);
    if (Object.keys(next).length > 0 || !classification) return;
    const cardInputs: CardInput[] = cards.map((c) => ({
      teamEntryId: c.teamEntryId,
      personId: c.personId,
      kind: c.kind as CardInput['kind'],
      minute: minuteOf(c.minute),
    }));
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
          cards: cardInputs,
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
                  {r.submittedAt ? `, ${formatInstant(r.submittedAt, activityZone(item))}` : ''}
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
        <CardsEditor
          sheet={sheet.data}
          sheetError={sheet.error}
          onRetrySheet={() => void sheet.refetch()}
          cards={cards}
          problems={problems}
          onChange={setCards}
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

/**
 * Cards against players of the match sheet (SPK-DISC-001, SPK-STAFF-005). SPK-UX-008: while the
 * sheet loads, a loading state; a refusal (NOT_FOUND, ACCESS_DENIED) or a sheet without the
 * official's full view, "not available"; any other failure (5xx, timeout, offline), the error
 * with its code and "Try again", never presented as a permission restriction.
 */
function CardsEditor({
  sheet,
  sheetError,
  onRetrySheet,
  cards,
  problems,
  onChange,
}: {
  sheet: MatchSheet | undefined;
  sheetError: ApiError | null;
  onRetrySheet: () => void;
  cards: CardDraft[];
  problems: Record<string, string>;
  onChange: (cards: CardDraft[]) => void;
}) {
  const sides = (sheet?.sides ?? []).filter((side) => side.players.some((p) => p.personId));
  const refused = sheetError !== null && presentationForError(sheetError) === 'unavailable';
  const notAvailable = (
    <StateView
      variant="unavailable"
      title="Cards are not available"
      description="Recording a card needs the match sheet, which is not available to you for this fixture. Report cards to the league manager."
    />
  );
  if (refused) return notAvailable;
  if (sheet === undefined) {
    return sheetError ? (
      <div role="group" aria-label="Cards">
        <p className="caption">Recording a card needs the player list, which could not load.</p>
        <StateView variant="error" error={sheetError} onRetry={onRetrySheet} />
      </div>
    ) : (
      <StateView variant="loading" label="the player list" />
    );
  }
  if (sheet.view !== 'full' || sides.length === 0) return notAvailable;
  const update = (n: number, next: CardDraft) =>
    onChange(cards.map((c, i) => (i === n ? next : c)));
  return (
    <fieldset className="ops-fieldset">
      <legend>Cards</legend>
      {cards.map((card, n) => {
        const label = `Card ${n + 1}`;
        const errorId = `card-${n}-error`;
        const side = sides.find((s) => s.entryId === card.teamEntryId);
        return (
          <div
            key={n}
            className="ops-section"
            role="group"
            aria-label={label}
            aria-invalid={problems[`card${n}`] ? true : undefined}
            aria-describedby={problems[`card${n}`] ? errorId : undefined}
          >
            <SelectField
              label={`${label} team`}
              value={card.teamEntryId}
              onChange={(v) => update(n, { ...card, teamEntryId: v, personId: '' })}
              placeholder="Choose a team"
              options={sides.map((s) => ({ value: s.entryId, label: s.teamName }))}
            />
            <SelectField
              label={`${label} player`}
              value={card.personId}
              onChange={(v) => update(n, { ...card, personId: v })}
              placeholder={side ? 'Choose a player' : 'Choose the team first'}
              disabled={!side}
              options={(side?.players ?? [])
                .filter((p) => p.personId)
                .map((p) => ({
                  value: p.personId as string,
                  label: `${p.jerseyNumber !== null ? `#${p.jerseyNumber} ` : ''}${p.displayName}`,
                }))}
            />
            <SelectField
              label={`${label} kind`}
              value={card.kind}
              onChange={(v) => update(n, { ...card, kind: v as CardDraft['kind'] })}
              placeholder="Choose"
              options={CARD_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
            />
            <TextField
              label={`${label} minute (optional)`}
              value={card.minute}
              onChange={(v) => update(n, { ...card, minute: v })}
              inputMode="numeric"
            />
            {problems[`card${n}`] ? (
              <span className="error-text" id={errorId} role="alert">
                {problems[`card${n}`]}
              </span>
            ) : null}
            <Button
              variant="secondary"
              aria-label={`Remove card ${n + 1}`}
              onClick={() => onChange(cards.filter((_, i) => i !== n))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Button variant="secondary" onClick={() => onChange([...cards, EMPTY_CARD])}>
        Add a card
      </Button>
    </fieldset>
  );
}
