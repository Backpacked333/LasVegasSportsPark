/**
 * Message sequences (SPK-COMMS-009, proposed amendment PA-05; capability `message_sequences`,
 * DEC-099 pending): the list with a form to start a new one, and one sequence with its steps.
 *
 * A sequence is for seasons or for offerings and belongs to one facility, whose local time its
 * steps are read in. It may be limited to one competition or one program. It produces schedules
 * only while it is switched on, so its steps can be put in order first. A step is a template and
 * a number of days before or after a date of the season or offering; the time of day comes from
 * the message policy unless the step names one (who sends and on which days is pending, DEC-099).
 * Changing a step moves the messages it has not sent; removing it cancels them.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { useOperatingFacility } from '../../../features/operations/context';
import { Button } from '../../../ui/Button';
import { CommandButton } from '../../../ui/CommandButton';
import { CommandError, CommandSuccess, fieldErrorsOf } from '../../../ui/CommandFeedback';
import { SelectField, TextField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import {
  ANCHORS,
  MANAGE_SEQUENCES_ACTION,
  SCHEDULES_KEY,
  SEQUENCES_KEY,
  SUBJECT_LABEL,
  SUBJECT_NOUN,
  anchorLabel,
  timingText,
  type Anchor,
  type Sequence,
  type SequenceStep,
  type SubjectType,
} from './labels';
import { SequencesPage, useCanDo } from './page';

const SEQUENCE_KEY = ['api', '/message-sequences/{id}'] as const;
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The competitions or programs a sequence may be limited to, by name. */
function useScopes(subject: SubjectType | '') {
  const competitions = useApiQuery({
    path: '/competitions',
    enabled: subject === 'season',
    staleTime: 5 * 60_000,
  });
  const programs = useApiQuery({
    path: '/programs',
    request: { query: { limit: 100 } },
    enabled: subject === 'offering',
    staleTime: 5 * 60_000,
  });
  if (subject === 'season')
    return (competitions.data ?? []).map((c) => ({ id: c.id, name: c.name }));
  if (subject === 'offering') {
    return (programs.data?.items ?? []).map((p) => ({ id: p.id, name: p.name }));
  }
  return [];
}

function scopeText(sequence: Sequence, scopes: { id: string; name: string }[]): string {
  if (!sequence.scopeId) {
    return sequence.subjectType === 'season' ? 'Every season' : 'Every offering of the facility';
  }
  const name = scopes.find((s) => s.id === sequence.scopeId)?.name;
  const kind = sequence.subjectType === 'season' ? 'competition' : 'program';
  return name ? `${SUBJECT_LABEL[sequence.subjectType]} of ${name}` : `One ${kind}`;
}

function CreateSequence() {
  const facility = useOperatingFacility();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState<SubjectType | ''>('');
  const [scopeId, setScopeId] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<Sequence | null>(null);
  const scopes = useScopes(subject);
  const create = useApiCommand('post', '/message-sequences', { invalidate: [SEQUENCES_KEY] });
  const apiErrors = fieldErrorsOf(create.error);
  if (!facility.facilityId) {
    return (
      <section className="card" aria-labelledby="ms-new-sequence">
        <h3 id="ms-new-sequence">New sequence</h3>
        <p>
          Choose a facility in the header first: a sequence belongs to one facility, whose local
          time its steps are read in.
        </p>
      </section>
    );
  }
  const facilityId = facility.facilityId;
  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Give the sequence a name.';
    if (!subject) next.subject = 'Choose seasons or offerings.';
    setProblems(next);
    setCreated(null);
    if (Object.keys(next).length > 0 || !subject) return;
    void create
      .submit({
        body: {
          name: name.trim(),
          facilityId,
          subjectType: subject,
          ...(scopeId ? { scopeId } : {}),
        },
      })
      .then((sequence) => {
        setCreated(sequence);
        setName('');
      })
      .catch(() => undefined);
  };
  return (
    <section className="card" aria-labelledby="ms-new-sequence">
      <h3 id="ms-new-sequence">New sequence</h3>
      <form
        noValidate
        className="form"
        aria-label="New sequence"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Name"
          value={name}
          onChange={setName}
          required
          error={problems.name ?? apiErrors.name}
        />
        <SelectField
          label="Messages for"
          value={subject}
          onChange={(value) => {
            setSubject(value as SubjectType | '');
            setScopeId('');
          }}
          required
          placeholder="Choose"
          options={[
            { value: 'season', label: 'Seasons' },
            { value: 'offering', label: 'Offerings' },
          ]}
          hint={`Read in the local time of ${facility.name ?? 'the selected facility'}.`}
          error={problems.subject ?? apiErrors.subjectType}
        />
        {subject ? (
          <SelectField
            label={subject === 'season' ? 'Competition' : 'Program'}
            value={scopeId}
            onChange={setScopeId}
            placeholder={subject === 'season' ? 'Every season' : 'Every offering of the facility'}
            options={scopes.map((s) => ({ value: s.id, label: s.name }))}
            error={apiErrors.scopeId}
          />
        ) : null}
        <div className="actions-row">
          <CommandButton type="submit" busy={create.isProcessing}>
            Create sequence
          </CommandButton>
        </div>
        {created ? (
          <p role="status">
            <StatusBadge tone="success" label="Sequence created, switched off" />{' '}
            <Link to={`/communications/sequences/${created.id}`}>Add its steps</Link>
          </p>
        ) : null}
        <CommandError
          error={create.error}
          onRetry={() => void create.resend().catch(() => undefined)}
        />
      </form>
    </section>
  );
}

function SequenceRow({ sequence }: { sequence: Sequence }) {
  const scopes = useScopes(sequence.subjectType);
  const live = sequence.steps.filter((s) => s.retiredAt === null).length;
  return (
    <li>
      <span className="row-text">
        <Link className="row-title" to={`/communications/sequences/${sequence.id}`}>
          {sequence.name}
        </Link>
        <span className="caption">
          {scopeText(sequence, scopes)} · {live} {live === 1 ? 'step' : 'steps'}
        </span>
      </span>
      <StatusBadge
        tone={sequence.active ? 'success' : 'neutral'}
        label={sequence.active ? 'Switched on' : 'Switched off'}
      />
    </li>
  );
}

export function MessageSequencesScreen() {
  const facility = useOperatingFacility();
  const sequences = useApiQuery({
    path: '/message-sequences',
    request: { query: { facilityId: facility.facilityId ?? undefined } },
    enabled: !facility.loading,
  });
  const canManage = useCanDo(MANAGE_SEQUENCES_ACTION);
  return (
    <SequencesPage
      titleId="message-sequences-title"
      title="Message sequences"
      intro="A sequence turns templates into a dated message schedule for each new season or published offering. Every message still waits for a staff member to confirm it."
      stillAvailable="Sequences that exist stay listed. Nothing new can be created."
    >
      <QueryBoundary
        query={sequences}
        label="message sequences"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No sequences yet',
          description: 'Create a sequence below, add its steps, then switch it on.',
        }}
        unavailableOffline={['creating and changing sequences']}
      >
        {(data) => (
          <ul className="list list-card" aria-label="Message sequences">
            {data.items.map((sequence) => (
              <SequenceRow key={sequence.id} sequence={sequence} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      {canManage ? <CreateSequence /> : null}
    </SequencesPage>
  );
}

// ---------------------------------------------------------------------------------------------
// One sequence
// ---------------------------------------------------------------------------------------------
interface StepDraft {
  templateId: string;
  anchor: Anchor | '';
  days: string;
  direction: 'before' | 'after';
  time: string;
}

const draftOf = (step?: SequenceStep): StepDraft => ({
  templateId: step?.templateId ?? '',
  anchor: step?.anchor ?? '',
  days: step ? String(Math.abs(step.offsetDays)) : '7',
  direction: step && step.offsetDays > 0 ? 'after' : 'before',
  time: step?.sendTimeLocal ?? '',
});

/** The step's fields as the API takes them, or what is wrong with them. */
function readDraft(draft: StepDraft):
  | {
      ok: true;
      value: { templateId: string; anchor: Anchor; offsetDays: number; time: string | null };
    }
  | { ok: false; problems: Record<string, string> } {
  const problems: Record<string, string> = {};
  if (!draft.templateId) problems.templateId = 'Choose a template.';
  if (!draft.anchor) problems.anchor = 'Choose the date to count from.';
  const days = Number(draft.days);
  if (!/^\d{1,3}$/.test(draft.days.trim()) || days > 365) {
    problems.days = 'Enter a whole number of days, 0 to 365.';
  }
  const time = draft.time.trim();
  if (time && !TIME_OF_DAY.test(time)) problems.time = 'Enter a time of day such as 09:00.';
  if (Object.keys(problems).length > 0 || !draft.anchor) return { ok: false, problems };
  return {
    ok: true,
    value: {
      templateId: draft.templateId,
      anchor: draft.anchor,
      offsetDays: draft.direction === 'before' ? -days : days,
      time: time || null,
    },
  };
}

function StepFields({
  draft,
  onChange,
  subject,
  problems,
  templates,
}: {
  draft: StepDraft;
  onChange: (draft: StepDraft) => void;
  subject: SubjectType;
  problems: Record<string, string | undefined>;
  templates: { id: string; name: string }[];
}) {
  return (
    <>
      <SelectField
        label="Template"
        value={draft.templateId}
        onChange={(templateId) => onChange({ ...draft, templateId })}
        required
        placeholder="Choose a template"
        options={templates.map((t) => ({ value: t.id, label: t.name }))}
        error={problems.templateId}
      />
      <SelectField
        label="Counted from"
        value={draft.anchor}
        onChange={(anchor) => onChange({ ...draft, anchor: anchor as Anchor | '' })}
        required
        placeholder="Choose a date"
        options={ANCHORS[subject].map((a) => ({ value: a, label: anchorLabel(a, subject) }))}
        error={problems.anchor}
      />
      <div className="ms-inline">
        <TextField
          label="Days"
          value={draft.days}
          onChange={(days) => onChange({ ...draft, days })}
          required
          error={problems.days}
        />
        <SelectField
          label="Before or after"
          value={draft.direction}
          onChange={(direction) =>
            onChange({ ...draft, direction: direction === 'after' ? 'after' : 'before' })
          }
          options={[
            { value: 'before', label: 'Before that date' },
            { value: 'after', label: 'After that date' },
          ]}
        />
        <TextField
          label="Time of day (optional)"
          value={draft.time}
          onChange={(time) => onChange({ ...draft, time })}
          placeholder="09:00"
          hint="Facility time, 24-hour. Empty uses the time of the message policy."
          error={problems.time}
        />
      </div>
    </>
  );
}

function AddStep({
  sequence,
  templates,
}: {
  sequence: Sequence;
  templates: { id: string; name: string }[];
}) {
  const [draft, setDraft] = useState<StepDraft>(draftOf());
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string | null>(null);
  const add = useApiCommand('post', '/message-sequences/{id}/steps', {
    invalidate: [SEQUENCES_KEY, SEQUENCE_KEY],
  });
  const apiErrors = fieldErrorsOf(add.error);
  const submit = () => {
    const read = readDraft(draft);
    setProblems(read.ok ? {} : read.problems);
    setAdded(null);
    if (!read.ok) return;
    void add
      .submit({
        path: { id: sequence.id },
        body: {
          templateId: read.value.templateId,
          anchor: read.value.anchor,
          offsetDays: read.value.offsetDays,
          ...(read.value.time ? { sendTimeLocal: read.value.time } : {}),
        },
      })
      .then(() => {
        setAdded('Step added.');
        setDraft(draftOf());
      })
      .catch(() => undefined);
  };
  return (
    <form
      noValidate
      className="form"
      aria-label="Add a step"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4>Add a step</h4>
      <StepFields
        draft={draft}
        onChange={setDraft}
        subject={sequence.subjectType}
        problems={{ ...apiErrors, ...problems, time: problems.time ?? apiErrors.sendTimeLocal }}
        templates={templates}
      />
      <div className="actions-row">
        <CommandButton type="submit" variant="secondary" busy={add.isProcessing}>
          Add step
        </CommandButton>
      </div>
      <CommandSuccess message={added} />
      <CommandError error={add.error} onRetry={() => void add.resend().catch(() => undefined)} />
    </form>
  );
}

function StepRow({
  sequence,
  step,
  templates,
  canManage,
  canRemove,
}: {
  sequence: Sequence;
  step: SequenceStep;
  templates: { id: string; name: string }[];
  canManage: boolean;
  canRemove: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [draft, setDraft] = useState<StepDraft>(draftOf(step));
  const [problems, setProblems] = useState<Record<string, string>>({});
  // A changed step moves the messages it has not sent: schedules are read afresh.
  const invalidate = [SEQUENCES_KEY, SEQUENCE_KEY, SCHEDULES_KEY];
  const update = useApiCommand('patch', '/message-sequences/{id}/steps/{stepId}', { invalidate });
  const remove = useApiCommand('post', '/message-sequences/{id}/steps/{stepId}/remove', {
    invalidate,
  });
  const timing = timingText(
    {
      anchor: step.anchor,
      offsetDays: step.offsetDays,
      sendTimeLocal: step.effectiveSendTimeLocal,
    },
    sequence.subjectType,
  );
  const label = `${step.templateName}: ${timing}`;
  const save = () => {
    const read = readDraft(draft);
    setProblems(read.ok ? {} : read.problems);
    if (!read.ok) return;
    void update
      .submit({
        path: { id: sequence.id, stepId: step.id },
        body: {
          templateId: read.value.templateId,
          anchor: read.value.anchor,
          offsetDays: read.value.offsetDays,
          sendTimeLocal: read.value.time,
          expectedRevision: step.revision,
        },
      })
      .then(() => setMode('view'))
      .catch(() => undefined);
  };
  return (
    <li aria-label={label}>
      <span className="row-text">
        <span className="row-title">{step.templateName}</span>
        <span className="caption">
          {timing}
          {step.sendTimeLocal ? '' : ' (the time of the message policy)'}
        </span>
      </span>
      {mode === 'view' && (canManage || canRemove) ? (
        <span className="actions-row">
          {canManage ? (
            <Button
              variant="secondary"
              aria-label={`Change ${label}`}
              onClick={() => setMode('edit')}
            >
              Change
            </Button>
          ) : null}
          {canRemove ? (
            <Button
              variant="secondary"
              aria-label={`Remove ${label}`}
              onClick={() => setMode('remove')}
            >
              Remove
            </Button>
          ) : null}
        </span>
      ) : null}
      {mode === 'edit' ? (
        <div className="form ms-wide" role="group" aria-label={`Change ${label}`}>
          <StepFields
            draft={draft}
            onChange={setDraft}
            subject={sequence.subjectType}
            problems={problems}
            templates={templates}
          />
          <p className="caption">
            Messages of this step that were not sent yet move with it; a confirmed one asks to be
            confirmed again.
          </p>
          <div className="actions-row">
            <CommandButton busy={update.isProcessing} onClick={save}>
              Save step
            </CommandButton>
            <Button variant="secondary" onClick={() => setMode('view')}>
              Keep it as it is
            </Button>
          </div>
          <CommandError
            error={update.error}
            onRetry={() => void update.resend().catch(() => undefined)}
            onReload={() => update.reset()}
          />
        </div>
      ) : null}
      {mode === 'remove' ? (
        <div className="form ms-wide" role="group" aria-label={`Remove ${label}`}>
          <p>
            The step produces no more messages, and its messages that were not sent yet are
            canceled. What was sent is kept.
          </p>
          <div className="actions-row">
            <CommandButton
              busy={remove.isProcessing}
              onClick={() =>
                void remove
                  .submit({
                    path: { id: sequence.id, stepId: step.id },
                    body: { expectedRevision: step.revision },
                  })
                  .catch(() => undefined)
              }
            >
              Remove step
            </CommandButton>
            <Button variant="secondary" onClick={() => setMode('view')}>
              Keep the step
            </Button>
          </div>
          <CommandError
            error={remove.error}
            onRetry={() => void remove.resend().catch(() => undefined)}
            onReload={() => remove.reset()}
          />
        </div>
      ) : null}
    </li>
  );
}

function SequenceDetail({ sequence }: { sequence: Sequence }) {
  const canManage = useCanDo(MANAGE_SEQUENCES_ACTION);
  // Removing a step creates nothing, so it stays possible while the switch is off.
  const canRemove = useCanDo(MANAGE_SEQUENCES_ACTION, { needsCapability: false });
  const scopes = useScopes(sequence.subjectType);
  const templates = useApiQuery({
    path: '/message-templates',
    request: { query: { status: 'active' } },
    enabled: canManage,
  });
  const names = (templates.data?.items ?? []).map((t) => ({ id: t.id, name: t.name }));
  const update = useApiCommand('patch', '/message-sequences/{id}', {
    invalidate: [SEQUENCES_KEY, SEQUENCE_KEY],
  });
  const live = sequence.steps.filter((s) => s.retiredAt === null);
  const noun = SUBJECT_NOUN[sequence.subjectType];
  return (
    <>
      <section className="card" aria-labelledby="ms-sequence">
        <h3 id="ms-sequence">{sequence.name}</h3>
        <p className="ms-badges">
          <StatusBadge
            tone={sequence.active ? 'success' : 'neutral'}
            label={sequence.active ? 'Switched on' : 'Switched off'}
          />
        </p>
        <p>
          {scopeText(sequence, scopes)}.{' '}
          {sequence.active
            ? `Each new ${noun} it applies to gets its message schedule. Every message waits for a confirmation.`
            : `It produces nothing while it is switched off. Add its steps, then switch it on.`}
        </p>
        {canManage ? (
          <div className="actions-row">
            <CommandButton
              variant={sequence.active ? 'secondary' : 'primary'}
              busy={update.isProcessing}
              onClick={() =>
                void update
                  .submit({
                    path: { id: sequence.id },
                    body: { active: !sequence.active, expectedRevision: sequence.revision },
                  })
                  .catch(() => undefined)
              }
            >
              {sequence.active ? 'Switch off' : 'Switch on'}
            </CommandButton>
          </div>
        ) : null}
        <CommandError
          error={update.error}
          onRetry={() => void update.resend().catch(() => undefined)}
          onReload={() => update.reset()}
        />
      </section>
      <section className="card" aria-labelledby="ms-steps">
        <h3 id="ms-steps">Steps</h3>
        <StateView
          variant="pending-decision"
          subject="Who sends and on which days, and which reminders are automatic"
          decisions={['DEC-099']}
        />
        {live.length === 0 ? (
          <p className="caption">No steps yet.</p>
        ) : (
          <ul className="list" aria-label="Steps">
            {live.map((step) => (
              <StepRow
                // Keyed by revision: after a save the row starts from the saved step.
                key={`${step.id}:${step.revision}`}
                sequence={sequence}
                step={step}
                templates={names}
                canManage={canManage}
                canRemove={canRemove}
              />
            ))}
          </ul>
        )}
        {canManage ? <AddStep sequence={sequence} templates={names} /> : null}
      </section>
    </>
  );
}

export function MessageSequenceScreen() {
  const { sequenceId = '' } = useParams();
  const sequence = useApiQuery({
    path: '/message-sequences/{id}',
    request: { path: { id: sequenceId } },
  });
  return (
    <SequencesPage
      titleId="message-sequence-title"
      title="Message sequence"
      intro="The steps of one sequence: which template is sent, and how many days before or after which date."
      actions={
        <Link className="button button-secondary" to="/communications/sequences">
          All sequences
        </Link>
      }
      stillAvailable="The sequence stays readable. A step can still be removed."
    >
      <QueryBoundary
        query={sequence}
        label="the sequence"
        empty={{ title: '', description: '' }}
        unavailableOffline={['changing the sequence']}
      >
        {(data) => <SequenceDetail sequence={data} />}
      </QueryBoundary>
    </SequencesPage>
  );
}
