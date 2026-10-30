/**
 * SCR-W-07 assessment templates for program managers (SPK-YOUTH-005; ENR-14
 * `POST /v1/assessment-templates`, `/approve`, `/retire`; capability youth_progression, DEC-016).
 *
 * Which templates, skill areas, scales and family visibility are approved is DEC-054 (pending):
 * the screen records what a program manager drafts and approves, and invents none. A template
 * names its program, a name and version, its skill areas (lower-case key and label) and an ordinal
 * scale (levels in order, lowest first, 2 to 20). Approval sends `expectedRevision`; retiring
 * needs a reason and is never gated by the switch. The API has no read or list of templates, so
 * the templates drafted or approved on this page are the ones offered to the assessment form.
 */
import { useState } from 'react';
import { usePermissions } from '../../../api/permissions';
import { useApiCommand } from '../../../api/useApiCommand';
import { CommandError, CommandSuccess } from '../../../features/operations/feedback';
import { TextAreaField, TextField, fieldErrorsOf } from '../../../features/operations/fields';
import { TEMPLATE_STATUS } from '../../../features/operations/labels';
import { Button } from '../../../ui/Button';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { ACTIONS, SKILL_KEY, UUID, YOUTH_CAPABILITY, type AssessmentTemplate } from './subject';

interface AreaDraft {
  key: string;
  label: string;
}

export function Templates({
  programId,
  facilityId,
  templates,
  onTemplate,
}: {
  programId: string | null;
  facilityId: string | null;
  templates: readonly AssessmentTemplate[];
  onTemplate: (template: AssessmentTemplate) => void;
}) {
  const permissions = usePermissions();
  const capabilityOn = permissions.isCapabilityEnabled(YOUTH_CAPABILITY) === true;
  const mayManage = permissions.isPermitted(ACTIONS.manageTemplate, facilityId) === true;
  const mayRetire = permissions.isPermitted(ACTIONS.retireTemplate, facilityId) === true;
  if (!mayManage && !mayRetire) return null;
  return (
    <section className="ops-section" aria-labelledby="templates-title">
      <h3 id="templates-title">Assessment templates</h3>
      <StateView
        variant="pending-decision"
        subject="The approved templates, scales and which feedback families see"
        decisions={['DEC-054']}
        owner="Program manager; Operator/privacy owner"
      />
      {templates.length > 0 ? (
        <ul className="list" aria-label="Templates on this page">
          {templates.map((t) => (
            <TemplateRow
              key={t.id}
              template={t}
              mayApprove={capabilityOn && mayManage}
              mayRetire={mayRetire}
              onChange={onTemplate}
            />
          ))}
        </ul>
      ) : (
        <p className="caption">
          The service does not list templates: templates drafted or approved here are offered when
          recording an assessment.
        </p>
      )}
      {capabilityOn && mayManage ? (
        <TemplateForm programId={programId} onDrafted={onTemplate} />
      ) : null}
    </section>
  );
}

function TemplateRow({
  template: t,
  mayApprove,
  mayRetire,
  onChange,
}: {
  template: AssessmentTemplate;
  mayApprove: boolean;
  mayRetire: boolean;
  onChange: (t: AssessmentTemplate) => void;
}) {
  const approve = useApiCommand('post', '/assessment-templates/{id}/approve');
  const retire = useApiCommand('post', '/assessment-templates/{id}/retire');
  const [retiring, setRetiring] = useState(false);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const badge = TEMPLATE_STATUS[t.status];
  const label = `${t.name} (version ${t.version})`;
  const doApprove = () =>
    void approve
      .submit({ path: { id: t.id }, body: { expectedRevision: t.revision } })
      .then(onChange)
      .catch(() => undefined);
  const doRetire = () => {
    if (!reason.trim()) {
      setMissing(true);
      return;
    }
    setMissing(false);
    void retire
      .submit({ path: { id: t.id }, body: { reason: reason.trim() } })
      .then((next) => {
        onChange(next);
        setRetiring(false);
      })
      .catch(() => undefined);
  };
  return (
    <li aria-label={label}>
      <div className="row-text">
        <span className="row-title">{label}</span>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span className="caption">
          Skill areas: {t.skillAreas.map((s) => s.label).join(', ')} · scale:{' '}
          {t.scale.levels.join(', ')}
        </span>
      </div>
      <div className="ops-actions">
        {t.status === 'draft' && mayApprove ? (
          <Button busy={approve.isProcessing} aria-label={`Approve ${label}`} onClick={doApprove}>
            Approve
          </Button>
        ) : null}
        {t.status !== 'retired' && mayRetire ? (
          <Button
            variant="secondary"
            aria-label={`Retire ${label}`}
            aria-expanded={retiring}
            onClick={() => setRetiring((r) => !r)}
          >
            Retire
          </Button>
        ) : null}
      </div>
      {retiring ? (
        <form
          className="ops-form"
          aria-label={`Retire ${label}`}
          onSubmit={(event) => {
            event.preventDefault();
            doRetire();
          }}
        >
          <TextAreaField
            label="Reason for retiring"
            value={reason}
            onChange={setReason}
            required
            hint="Assessments already recorded on it keep it."
            error={missing ? 'A reason is required.' : undefined}
          />
          <Button type="submit" busy={retire.isProcessing}>
            Confirm retirement
          </Button>
        </form>
      ) : null}
      {approve.error ? (
        <CommandError error={approve.error} onRetry={doApprove} subject="This template" />
      ) : null}
      {retire.error ? (
        <CommandError error={retire.error} onRetry={doRetire} subject="This template" />
      ) : null}
    </li>
  );
}

function TemplateForm({
  programId,
  onDrafted,
}: {
  programId: string | null;
  onDrafted: (t: AssessmentTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [program, setProgram] = useState(programId ?? '');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [areas, setAreas] = useState<AreaDraft[]>([{ key: '', label: '' }]);
  const [levels, setLevels] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const command = useApiCommand('post', '/assessment-templates');
  const apiErrors = fieldErrorsOf(command.error);
  if (!open) {
    return (
      <div className="ops-actions">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Draft a template
        </Button>
      </div>
    );
  }
  const levelList = levels
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const submit = () => {
    const next: Record<string, string> = {};
    if (!UUID.test(program.trim())) next.program = 'Give the program reference.';
    if (!name.trim()) next.name = 'Name the template.';
    if (!/^\d{1,4}$/.test(version.trim()) || Number(version) < 1)
      next.version = 'Give the version as a whole number from 1.';
    const keys = areas.map((a) => a.key.trim());
    if (areas.some((a) => !SKILL_KEY.test(a.key.trim()) || !a.label.trim()))
      next.areas = 'Each skill area needs a lower-case key (letters, digits, _) and a label.';
    else if (new Set(keys).size !== keys.length) next.areas = 'Skill area keys must be unique.';
    if (levelList.length < 2 || levelList.length > 20)
      next.levels = 'Give 2 to 20 scale levels, one per line, lowest first.';
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    void command
      .submit({
        body: {
          programId: program.trim(),
          name: name.trim(),
          version: Number(version),
          skillAreas: areas.map((a) => ({ key: a.key.trim(), label: a.label.trim() })),
          scale: { kind: 'ordinal', levels: levelList },
        },
      })
      .then((t) => {
        onDrafted(t);
        setOpen(false);
      })
      .catch(() => undefined);
  };
  return (
    <form
      className="ops-form ops-section"
      aria-label="Draft an assessment template"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h4>Draft a template</h4>
      <TextField
        label="Program reference"
        value={program}
        onChange={setProgram}
        hint="The program the template belongs to (the chosen offering's program by default)."
        error={problems.program ?? apiErrors.programId}
      />
      <TextField
        label="Template name"
        value={name}
        onChange={setName}
        required
        error={problems.name ?? apiErrors.name}
      />
      <TextField
        label="Version"
        value={version}
        onChange={setVersion}
        inputMode="numeric"
        required
        error={problems.version ?? apiErrors.version}
      />
      <fieldset
        className="ops-fieldset"
        aria-invalid={problems.areas ? true : undefined}
        aria-describedby={problems.areas ? 'template-areas-error' : undefined}
      >
        <legend>Skill areas</legend>
        {areas.map((area, n) => (
          <div key={n} role="group" aria-label={`Skill area ${n + 1}`}>
            <TextField
              label={`Skill area ${n + 1} key`}
              value={area.key}
              onChange={(v) =>
                setAreas((prev) => prev.map((a, i) => (i === n ? { ...a, key: v } : a)))
              }
            />
            <TextField
              label={`Skill area ${n + 1} label`}
              value={area.label}
              onChange={(v) =>
                setAreas((prev) => prev.map((a, i) => (i === n ? { ...a, label: v } : a)))
              }
            />
            {areas.length > 1 ? (
              <Button
                variant="secondary"
                aria-label={`Remove skill area ${n + 1}`}
                onClick={() => setAreas((prev) => prev.filter((_, i) => i !== n))}
              >
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        <Button
          variant="secondary"
          onClick={() => setAreas((prev) => [...prev, { key: '', label: '' }])}
        >
          Add a skill area
        </Button>
        {(problems.areas ?? apiErrors.skillAreas) ? (
          <span className="error-text" id="template-areas-error" role="alert">
            {problems.areas ?? apiErrors.skillAreas}
          </span>
        ) : null}
      </fieldset>
      <TextAreaField
        label="Scale levels (one per line, lowest first)"
        value={levels}
        onChange={setLevels}
        rows={4}
        required
        error={problems.levels ?? apiErrors.scale}
      />
      <div className="ops-actions">
        <Button type="submit" busy={command.isProcessing}>
          Save the template as a draft
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError error={command.error} onRetry={submit} subject="This program" />
      ) : null}
      {command.data ? <CommandSuccess label={TEMPLATE_STATUS[command.data.status].label} /> : null}
    </form>
  );
}
