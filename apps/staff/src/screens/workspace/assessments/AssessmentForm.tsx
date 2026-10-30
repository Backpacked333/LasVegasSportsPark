/**
 * SCR-W-07 record or edit an assessment (SPK-YOUTH-005; ENR-14 `POST /v1/assessments`,
 * `PATCH /v1/assessments/{id}`; capability youth_progression, DEC-016; templates DEC-054).
 *
 * - An assessment uses an approved template: skill area, observation date, a value on the
 *   template's scale, comments, visibility and (once reviewed) review status. The author is the
 *   API's principal.
 * - Private coaching notes and family-visible feedback stay separate (SPK-YOUTH-005): the staff
 *   note is never shown to a family; comments reach the family only when the visibility is
 *   "family" and another program manager approves. Visibility is chosen explicitly, nothing
 *   preselected.
 * - The API offers no read of templates, so a template's skill areas and scale are known only for
 *   templates drafted or approved on this page; otherwise staff give the template reference, the
 *   skill area key and the value, and the API answers TEMPLATE_MISMATCH when they do not fit.
 * - Edits send `expectedRevision`; a correction of a published or recorded assessment is a new
 *   assessment naming the one it corrects (`correctsAssessmentId`).
 */
import { useState } from 'react';
import { useApiCommand } from '../../../api/useApiCommand';
import { CommandError, CommandSuccess } from '../../../features/operations/feedback';
import {
  SelectField,
  TextAreaField,
  TextField,
  fieldErrorsOf,
} from '../../../features/operations/fields';
import { ASSESSMENT_STATUS, ASSESSMENT_VISIBILITY } from '../../../features/operations/labels';
import { Button } from '../../../ui/Button';
import {
  DATE_ONLY,
  SKILL_KEY,
  UUID,
  type Assessment,
  type AssessmentSubject,
  type AssessmentTemplate,
} from './subject';

type Visibility = Assessment['visibility'];

const OTHER_TEMPLATE = 'other';

export function AssessmentForm({
  subject,
  templates,
  editing,
  corrects,
  onDone,
}: {
  subject: AssessmentSubject;
  templates: readonly AssessmentTemplate[];
  /** Edit this draft or returned assessment (PATCH). */
  editing?: Assessment;
  /** Record a correction of this published or recorded assessment. */
  corrects?: Assessment;
  onDone: (saved: Assessment) => void;
}) {
  const base = editing ?? corrects;
  const approved = templates.filter(
    (t) => t.status === 'approved' && (!subject.programId || t.programId === subject.programId),
  );
  const [templateChoice, setTemplateChoice] = useState(
    base ? (approved.some((t) => t.id === base.templateId) ? base.templateId : OTHER_TEMPLATE) : '',
  );
  const [templateRef, setTemplateRef] = useState(
    base && !approved.some((t) => t.id === base.templateId) ? base.templateId : '',
  );
  const [skill, setSkill] = useState(base?.skillAreaKey ?? '');
  const [observedOn, setObservedOn] = useState(editing?.observedOn ?? '');
  const [scale, setScale] = useState(base ? String(base.scaleValue) : '');
  const [visibility, setVisibility] = useState<Visibility | ''>(editing?.visibility ?? '');
  const [comments, setComments] = useState(editing?.comments ?? '');
  const [staffNote, setStaffNote] = useState(editing?.staffNote ?? '');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const create = useApiCommand('post', '/assessments', {
    invalidate: [['api', '/participants/{personId}/assessments']],
  });
  const update = useApiCommand('patch', '/assessments/{id}', {
    invalidate: [['api', '/participants/{personId}/assessments']],
  });
  const command = editing ? update : create;
  const apiErrors = fieldErrorsOf(command.error);
  const template =
    templateChoice && templateChoice !== OTHER_TEMPLATE
      ? approved.find((t) => t.id === templateChoice)
      : undefined;
  const templateId = editing
    ? editing.templateId
    : templateChoice === OTHER_TEMPLATE
      ? templateRef.trim()
      : templateChoice;

  const submit = () => {
    const next: Record<string, string> = {};
    if (!editing && !UUID.test(templateId)) next.template = 'Choose an approved template.';
    if (!SKILL_KEY.test(skill)) next.skill = 'Choose the skill area.';
    if (!DATE_ONLY.test(observedOn)) next.observedOn = 'Give the observation date.';
    const value = Number(scale);
    const levels = template?.scale.levels.length ?? 20;
    if (!/^\d{1,2}$/.test(scale) || value < 1 || value > levels)
      next.scale = `Choose a value on the scale (1 to ${levels}).`;
    if (!visibility) next.visibility = 'Choose who may see it.';
    setProblems(next);
    if (Object.keys(next).length > 0 || !visibility) return;
    const fields = {
      skillAreaKey: skill,
      observedOn,
      scaleValue: value,
      visibility,
    };
    const onSaved = (saved: Assessment) => onDone(saved);
    if (editing) {
      void update
        .submit({
          path: { id: editing.id },
          body: {
            ...fields,
            comments: comments.trim() ? comments.trim() : null,
            staffNote: staffNote.trim() ? staffNote.trim() : null,
            expectedRevision: editing.revision,
          },
        })
        .then(onSaved)
        .catch(() => undefined);
      return;
    }
    void create
      .submit({
        body: {
          ...fields,
          templateId,
          participantPersonId: subject.personId,
          offeringId: subject.offeringId,
          ...(comments.trim() ? { comments: comments.trim() } : {}),
          ...(staffNote.trim() ? { staffNote: staffNote.trim() } : {}),
          ...(corrects ? { correctsAssessmentId: corrects.id } : {}),
        },
      })
      .then(onSaved)
      .catch(() => undefined);
  };

  const title = editing
    ? 'Edit the assessment'
    : corrects
      ? 'Record a correction'
      : `Record an assessment of ${subject.name}`;
  return (
    <form
      className="ops-form ops-section"
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4>{title}</h4>
      {corrects ? (
        <p className="caption">
          The {ASSESSMENT_STATUS[corrects.status].label.toLowerCase()} assessment stays as recorded;
          the correction is a new assessment that names it.
        </p>
      ) : null}
      {editing ? null : (
        <>
          <SelectField
            label="Template"
            value={templateChoice}
            onChange={(v) => {
              setTemplateChoice(v);
              setSkill('');
              setScale('');
            }}
            placeholder="Choose a template"
            options={[
              ...approved.map((t) => ({ value: t.id, label: `${t.name} (version ${t.version})` })),
              { value: OTHER_TEMPLATE, label: 'Another approved template (by reference)' },
            ]}
            hint="Templates cannot be listed by the service: those approved on this page are offered."
            error={problems.template ?? apiErrors.templateId}
          />
          {templateChoice === OTHER_TEMPLATE ? (
            <TextField
              label="Template reference"
              value={templateRef}
              onChange={setTemplateRef}
              hint="The full reference of an approved template of this program."
            />
          ) : null}
        </>
      )}
      {template ? (
        <SelectField
          label="Skill area"
          value={skill}
          onChange={setSkill}
          placeholder="Choose a skill area"
          options={template.skillAreas.map((s) => ({ value: s.key, label: s.label }))}
          error={problems.skill ?? apiErrors.skillAreaKey}
        />
      ) : (
        <TextField
          label="Skill area key"
          value={skill}
          onChange={setSkill}
          hint="The template's key for the skill area, for example ball_control."
          error={problems.skill ?? apiErrors.skillAreaKey}
        />
      )}
      <TextField
        label="Observation date"
        type="date"
        value={observedOn}
        onChange={setObservedOn}
        required
        error={problems.observedOn ?? apiErrors.observedOn}
      />
      {template ? (
        <SelectField
          label="Value on the scale"
          value={scale}
          onChange={setScale}
          placeholder="Choose a level"
          options={template.scale.levels.map((level, i) => ({
            value: String(i + 1),
            label: `${i + 1}: ${level}`,
          }))}
          hint="Lowest first, as the template defines it."
          error={problems.scale ?? apiErrors.scaleValue}
        />
      ) : (
        <TextField
          label="Value on the scale"
          value={scale}
          onChange={setScale}
          inputMode="numeric"
          hint="A whole number on the template's scale, 1 being the lowest level."
          error={problems.scale ?? apiErrors.scaleValue}
        />
      )}
      <fieldset
        className="ops-fieldset"
        aria-invalid={problems.visibility ? true : undefined}
        aria-describedby={problems.visibility ? 'assessment-visibility-error' : undefined}
      >
        <legend>Who may see it</legend>
        {(Object.keys(ASSESSMENT_VISIBILITY) as Visibility[]).map((v) => (
          <label key={v} className="ops-check">
            <input
              type="radio"
              name="assessment-visibility"
              checked={visibility === v}
              onChange={() => setVisibility(v)}
            />
            {ASSESSMENT_VISIBILITY[v]}
          </label>
        ))}
        {problems.visibility ? (
          <span className="error-text" id="assessment-visibility-error" role="alert">
            {problems.visibility}
          </span>
        ) : null}
      </fieldset>
      <TextAreaField
        label="Feedback comments (optional)"
        value={comments}
        onChange={setComments}
        rows={3}
        hint="Shown to the family only when the visibility is family and a program manager approves it."
        error={apiErrors.comments}
      />
      <TextAreaField
        label="Private coaching note (optional)"
        value={staffNote}
        onChange={setStaffNote}
        rows={3}
        hint="Staff only: never shown to the family."
        error={apiErrors.staffNote}
      />
      <div className="ops-actions">
        <Button type="submit" busy={command.isProcessing}>
          {editing ? 'Save the draft' : 'Save as draft'}
        </Button>
      </div>
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError error={command.error} onRetry={submit} subject="This assessment" />
      ) : null}
      {command.data ? (
        <CommandSuccess label={ASSESSMENT_STATUS[command.data.status].label} />
      ) : null}
    </form>
  );
}
