/**
 * SCR-W-07 a participant's assessments (SPK-YOUTH-005; ENR-14
 * `GET /v1/participants/{personId}/assessments`, `/submit`, `/withdraw`, `/review`).
 *
 * - The API lists what the viewer may read: program managers see the offering's assessments in
 *   their facility scope; a coach sees those of offerings they hold an accepted assignment on
 *   (others' from submission on, and their own drafts). Anyone else sees the list as not available,
 *   never whether the participant exists (§4.10). Paged by the API's cursor. The API answers a
 *   coach NOT_FOUND until an assessment they may read exists (reported as an API issue): for a
 *   participant taken from the coach's own accepted session the page says nothing is visible yet
 *   and still offers recording, without implying that any record exists.
 * - Authors are staff: a name the viewer may not read is labelled "Staff member", never
 *   "Participant". Review times are in the offering's facility zone (SPK-SCHED-008).
 * - Each row shows skill area, observation date, scale value, comments, the private coaching note
 *   (staff only, labelled so), visibility, author and review status with the review note.
 * - Commands follow the Assessment machine and the viewer's permissions (`GET /v1/me/permissions`;
 *   the API has no per-record actions here): the author edits and submits a draft or returned
 *   assessment; the author or a program manager withdraws one (reason; never gated); a program
 *   manager other than the author approves or returns a submitted one (a return says why). Each
 *   sends `expectedRevision` and its own idempotency key; STALE_REVISION reloads. Authoring,
 *   review and correction need the youth_progression switch (DEC-016): while it is off they are
 *   not offered, and a command refused with CAPABILITY_DISABLED shows "turned off".
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePermissions } from '../../../api/permissions';
import { useApiPages } from '../../../api/useApiPages';
import { useKeyedCommands } from '../../../features/operations/commands';
import { nameOf, useFacilityZone, usePersonNames } from '../../../features/operations/context';
import { CommandError, CommandSuccess } from '../../../features/operations/feedback';
import { TextAreaField } from '../../../features/operations/fields';
import { formatInstant } from '../../../features/operations/format';
import { ASSESSMENT_STATUS, ASSESSMENT_VISIBILITY } from '../../../features/operations/labels';
import { Button } from '../../../ui/Button';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { AssessmentForm } from './AssessmentForm';
import {
  ACTIONS,
  YOUTH_CAPABILITY,
  scaleLabel,
  skillLabel,
  type Assessment,
  type AssessmentSubject,
  type AssessmentTemplate,
} from './subject';

const ASSESSMENTS_KEY = ['api', '/participants/{personId}/assessments'] as const;

export function ParticipantAssessments({
  subject,
  templates,
  me,
}: {
  subject: AssessmentSubject;
  templates: readonly AssessmentTemplate[];
  me: string | null;
}) {
  const permissions = usePermissions();
  const capabilityOn = permissions.isCapabilityEnabled(YOUTH_CAPABILITY) === true;
  const mayAuthor = permissions.isPermitted(ACTIONS.author, subject.facilityId) === true;
  const [adding, setAdding] = useState(false);
  const assessments = useApiPages({
    path: '/participants/{personId}/assessments',
    request: {
      path: { personId: subject.personId },
      query: { offeringId: subject.offeringId, limit: 20 },
    },
  });
  const authors = usePersonNames(
    (assessments.data ?? []).map((a) => a.authorPersonId).filter((id) => id !== me),
  );
  const zone = useFacilityZone(subject.facilityId);
  // The coach's own session, nothing they may read yet: the API answers NOT_FOUND (API issue).
  const nothingVisibleYet =
    subject.fromOwnSession === true &&
    assessments.data === undefined &&
    assessments.error?.isNotFound === true;
  return (
    <section className="ops-section" aria-labelledby="participant-assessments-title">
      <h3 id="participant-assessments-title">
        Assessments of {subject.name} in {subject.offeringName}
      </h3>
      {nothingVisibleYet ? (
        <StateView
          variant="empty"
          title="No assessments you can see yet"
          description="Nothing recorded for this participant in this offering is visible to you yet. Assessments you record appear here once saved; others appear once submitted."
        />
      ) : (
        <QueryBoundary
          query={assessments}
          label="assessments"
          isEmpty={(items) => items.length === 0}
          empty={{
            title: 'No assessments yet',
            description: 'Assessments recorded for this participant in this offering appear here.',
          }}
          unavailableOffline={['recording, submitting, reviewing and withdrawing assessments']}
        >
          {(items) => (
            <ul className="list" aria-label="Assessments">
              {items.map((a) => (
                <AssessmentRow
                  key={a.id}
                  assessment={a}
                  subject={subject}
                  templates={templates}
                  me={me}
                  author={
                    a.authorPersonId === me
                      ? 'you'
                      : nameOf(authors, a.authorPersonId, 'Staff member')
                  }
                  capabilityOn={capabilityOn}
                  timezone={zone}
                />
              ))}
            </ul>
          )}
        </QueryBoundary>
      )}
      <LoadMore pages={assessments} label="assessments" />
      {capabilityOn && mayAuthor ? (
        adding ? (
          <AssessmentForm subject={subject} templates={templates} onDone={() => setAdding(false)} />
        ) : (
          <div className="ops-actions">
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Record an assessment
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}

function AssessmentRow({
  assessment: a,
  subject,
  templates,
  me,
  author,
  capabilityOn,
  timezone,
}: {
  assessment: Assessment;
  subject: AssessmentSubject;
  templates: readonly AssessmentTemplate[];
  me: string | null;
  author: string;
  capabilityOn: boolean;
  timezone: string | null;
}) {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const commands = useKeyedCommands({ invalidate: [ASSESSMENTS_KEY] });
  const [mode, setMode] = useState<'edit' | 'correct' | 'withdraw' | 'return' | null>(null);
  // Two audited free texts, never shared: the withdrawal reason and the note to the author.
  const [withdrawReason, setWithdrawReason] = useState('');
  const [returnNote, setReturnNote] = useState('');
  const [missing, setMissing] = useState(false);
  const openMode = (next: typeof mode) => {
    setMode(next);
    setMissing(false);
  };
  const isAuthor = me !== null && a.authorPersonId === me;
  const isManager = permissions.isPermitted(ACTIONS.review, subject.facilityId) === true;
  const mayAuthor = permissions.isPermitted(ACTIONS.author, subject.facilityId) === true;
  const mayWithdraw = permissions.isPermitted(ACTIONS.withdraw, subject.facilityId) === true;
  const open = a.status === 'draft' || a.status === 'returned';
  const can = {
    edit: capabilityOn && isAuthor && open,
    submit: capabilityOn && isAuthor && open,
    withdraw: mayWithdraw && open && (isAuthor || isManager),
    review: capabilityOn && isManager && !isAuthor && a.status === 'submitted',
    correct: capabilityOn && mayAuthor && (a.status === 'published' || a.status === 'recorded'),
  };
  const badge = ASSESSMENT_STATUS[a.status];
  const skill = skillLabel(templates, a);
  const label = `${skill}, observed ${a.observedOn}`;
  const keys = ['submit', 'withdraw', 'approve', 'return'] as const;
  const failed = keys.find((k) => commands.outcome(`${k}|${a.id}`).status === 'error');
  const error = failed ? commands.outcome(`${failed}|${a.id}`).error : undefined;
  const done = keys.map((k) => commands.outcome(`${k}|${a.id}`)).find((o) => o.status === 'success')
    ?.data as Assessment | undefined;
  const pending = keys.some((k) => commands.outcome(`${k}|${a.id}`).status === 'pending');
  const reload = () => {
    commands.reset();
    void queryClient.invalidateQueries({ queryKey: ASSESSMENTS_KEY });
  };
  const body = { expectedRevision: a.revision };
  const run = (k: (typeof keys)[number]) => {
    if ((k === 'withdraw' && !withdrawReason.trim()) || (k === 'return' && !returnNote.trim())) {
      setMissing(true);
      return;
    }
    setMissing(false);
    const path = { id: a.id };
    if (k === 'submit')
      void commands.run(`submit|${a.id}`, 'post', '/assessments/{id}/submit', { path, body });
    if (k === 'withdraw') {
      void commands.run(`withdraw|${a.id}`, 'post', '/assessments/{id}/withdraw', {
        path,
        body: { ...body, reason: withdrawReason.trim() },
      });
    }
    if (k === 'approve') {
      void commands.run(`approve|${a.id}`, 'post', '/assessments/{id}/review', {
        path,
        body: { ...body, decision: 'approve' },
      });
    }
    if (k === 'return') {
      void commands.run(`return|${a.id}`, 'post', '/assessments/{id}/review', {
        path,
        body: { ...body, decision: 'return', note: returnNote.trim() },
      });
    }
  };
  return (
    <li aria-label={label}>
      <div className="row-text">
        <span className="row-title">{skill}</span>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span>
          {scaleLabel(templates, a)} · observed {a.observedOn} ·{' '}
          {ASSESSMENT_VISIBILITY[a.visibility]}
        </span>
        {a.comments ? <span>Feedback: {a.comments}</span> : null}
        {a.staffNote ? (
          <span className="caption">Private coaching note (staff only): {a.staffNote}</span>
        ) : null}
        {a.reviewNote ? <span className="caption">Review note: {a.reviewNote}</span> : null}
        <span className="caption">
          By {author}
          {a.reviewedAt ? ` · reviewed ${formatInstant(a.reviewedAt, timezone)}` : ''}
          {a.correctsAssessmentId ? ' · corrects an earlier assessment' : ''}
        </span>
      </div>
      <div className="ops-actions">
        {can.edit ? (
          <Button variant="secondary" aria-label={`Edit ${label}`} onClick={() => openMode('edit')}>
            Edit
          </Button>
        ) : null}
        {can.submit ? (
          <Button
            aria-label={`Submit for review: ${label}`}
            busy={commands.outcome(`submit|${a.id}`).status === 'pending'}
            onClick={() => run('submit')}
          >
            Submit for review
          </Button>
        ) : null}
        {can.review ? (
          <>
            <Button
              aria-label={`Approve ${label}`}
              busy={commands.outcome(`approve|${a.id}`).status === 'pending'}
              onClick={() => run('approve')}
            >
              {a.visibility === 'family' ? 'Approve and publish' : 'Approve and record'}
            </Button>
            <Button
              variant="secondary"
              aria-label={`Return ${label}`}
              onClick={() => openMode('return')}
            >
              Return
            </Button>
          </>
        ) : null}
        {can.withdraw ? (
          <Button
            variant="secondary"
            aria-label={`Withdraw ${label}`}
            onClick={() => openMode('withdraw')}
          >
            Withdraw
          </Button>
        ) : null}
        {can.correct ? (
          <Button
            variant="secondary"
            aria-label={`Record a correction of ${label}`}
            onClick={() => openMode('correct')}
          >
            Record a correction
          </Button>
        ) : null}
      </div>
      {isAuthor && a.status === 'submitted' ? (
        <p className="caption">Another program manager reviews it; you cannot review your own.</p>
      ) : null}
      {mode === 'edit' ? (
        <AssessmentForm
          subject={subject}
          templates={templates}
          editing={a}
          onDone={() => setMode(null)}
        />
      ) : null}
      {mode === 'correct' ? (
        <AssessmentForm
          subject={subject}
          templates={templates}
          corrects={a}
          onDone={() => setMode(null)}
        />
      ) : null}
      {mode === 'withdraw' || mode === 'return' ? (
        <form
          className="ops-form"
          aria-label={mode === 'withdraw' ? `Withdraw ${label}` : `Return ${label}`}
          onSubmit={(event) => {
            event.preventDefault();
            run(mode);
          }}
        >
          <TextAreaField
            key={mode}
            label={mode === 'withdraw' ? 'Reason for withdrawing' : 'What should change'}
            value={mode === 'withdraw' ? withdrawReason : returnNote}
            onChange={mode === 'withdraw' ? setWithdrawReason : setReturnNote}
            required
            hint={
              mode === 'return' ? 'The author sees this note; the family never does.' : undefined
            }
            error={missing ? 'A reason is required.' : undefined}
          />
          <div className="ops-actions">
            <Button type="submit" busy={pending}>
              {mode === 'withdraw' ? 'Confirm withdrawal' : 'Return to the author'}
            </Button>
            <Button variant="secondary" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <CommandError
          error={error}
          onRetry={failed ? () => run(failed) : undefined}
          onReload={reload}
          subject="This assessment"
        />
      ) : null}
      {done ? <CommandSuccess label={ASSESSMENT_STATUS[done.status].label} /> : null}
    </li>
  );
}
