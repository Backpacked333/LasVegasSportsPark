/**
 * SCR-S-14 Program, offering and session setup: the program list and "new program"
 * (SPK-CAT-001 reusable program definitions apart from dated offerings; SPK-YOUTH-001 age bands;
 * SPK-UX-008 states). Programs come from `GET /v1/programs`; creation is `POST /v1/programs` with
 * an idempotency key per intent. Age band values are whatever the program manager enters: the
 * approved youth bands are pending DEC-003 and nothing is preset.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { SelectField, TextArea, TextField } from '../../features/registration-finance/fields';
import { PROGRAM_STATUS } from '../../features/registration-finance/labels';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type ProgramStatus = Schema<'ProgramStatus'>;
type AgeBand = Schema<'AgeBand'>;

export function ageBandText(band: AgeBand): string {
  const { minAgeYears: min, maxAgeYears: max } = band;
  if (min === undefined && max === undefined) return 'No age band';
  if (min !== undefined && max !== undefined) return `Ages ${min} to ${max}`;
  return min !== undefined ? `Ages ${min} and over` : `Ages up to ${max}`;
}

/** Optional whole number from a text field; `undefined` when empty, NaN when not a number. */
export function optionalInt(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

export function ProgramForm({
  initial,
  submitLabel,
  busy,
  disabled,
  serverErrors,
  statusOptions,
  onSubmit,
}: {
  initial?: Schema<'Program'>;
  submitLabel: string;
  busy: boolean;
  disabled: boolean;
  serverErrors: Record<string, string>;
  statusOptions: readonly ProgramStatus[];
  onSubmit: (input: {
    name: string;
    description: string;
    activityType: string;
    format: string;
    ageBand: AgeBand;
    status: ProgramStatus;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [activityType, setActivityType] = useState(initial?.activityType ?? '');
  const [format, setFormat] = useState(initial?.format ?? '');
  const [minAge, setMinAge] = useState(initial?.ageBand.minAgeYears?.toString() ?? '');
  const [maxAge, setMaxAge] = useState(initial?.ageBand.maxAgeYears?.toString() ?? '');
  const [status, setStatus] = useState<ProgramStatus>(initial?.status ?? 'draft');
  const [local, setLocal] = useState<Record<string, string>>({});

  const submit = () => {
    const errors: Record<string, string> = {};
    if (name.trim() === '') errors.name = 'Enter a name.';
    if (activityType.trim() === '') errors.activityType = 'Enter the activity type.';
    const min = optionalInt(minAge);
    const max = optionalInt(maxAge);
    if (Number.isNaN(min)) errors['ageBand.minAgeYears'] = 'Enter a whole number of years.';
    if (Number.isNaN(max)) errors['ageBand.maxAgeYears'] = 'Enter a whole number of years.';
    if (min !== undefined && max !== undefined && min > max) {
      errors['ageBand.maxAgeYears'] = 'The maximum age must not be below the minimum.';
    }
    setLocal(errors);
    if (Object.keys(errors).length > 0) return;
    const ageBand: AgeBand = {};
    if (min !== undefined) ageBand.minAgeYears = min;
    if (max !== undefined) ageBand.maxAgeYears = max;
    onSubmit({ name, description, activityType, format, ageBand, status });
  };
  const err = (key: string) => local[key] ?? serverErrors[key] ?? null;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="rf-grid">
        <TextField
          label="Program name"
          required
          value={name}
          onChange={setName}
          error={err('name')}
        />
        <TextField
          label="Activity type"
          required
          hint="For example the sport or discipline, as your organization names it."
          value={activityType}
          onChange={setActivityType}
          error={err('activityType')}
        />
        <TextField label="Format" value={format} onChange={setFormat} error={err('format')} />
        <TextField
          label="Minimum age (years)"
          inputMode="numeric"
          value={minAge}
          onChange={setMinAge}
          error={err('ageBand.minAgeYears')}
        />
        <TextField
          label="Maximum age (years)"
          inputMode="numeric"
          value={maxAge}
          onChange={setMaxAge}
          error={err('ageBand.maxAgeYears')}
        />
        <SelectField
          label="Program status"
          value={status}
          onChange={(v) => setStatus(v as ProgramStatus)}
          options={statusOptions.map((s) => ({ value: s, label: PROGRAM_STATUS[s].label }))}
        />
      </div>
      <TextArea label="Description" value={description} onChange={setDescription} />
      <p className="caption">
        Age bands are entered per program; the approved youth bands and staffing are pending{' '}
        {PENDING.youthStaffing.ids.join(', ')} (owner: {PENDING.youthStaffing.owner}).
      </p>
      <div className="rf-actions">
        <Button type="submit" busy={busy} disabled={disabled}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function CreateProgram() {
  const navigate = useNavigate();
  const online = useOnline();
  const create = useApiCommand('post', '/programs', { invalidate: [['api', '/programs']] });
  return (
    <section className="rf-panel" aria-labelledby="new-program-title">
      <h3 id="new-program-title">New program</h3>
      <ProgramForm
        submitLabel="Create program"
        busy={create.isProcessing}
        disabled={!online}
        serverErrors={fieldErrorsOf(create.error)}
        statusOptions={['draft', 'active']}
        onSubmit={(input) => {
          create
            .submit({
              body: {
                name: input.name.trim(),
                activityType: input.activityType.trim(),
                ...(input.description.trim() ? { description: input.description.trim() } : {}),
                ...(input.format.trim() ? { format: input.format.trim() } : {}),
                ageBand: input.ageBand,
                status: input.status === 'active' ? 'active' : 'draft',
              },
            })
            .then((program) => navigate(`/programs/${program.id}`))
            .catch(() => undefined);
        }}
      />
      <OfflineCaption action="creating a program" />
      <CommandError error={create.error} />
    </section>
  );
}

export function ProgramsScreen() {
  const [status, setStatus] = useState<'' | ProgramStatus>('');
  const programs = useApiQuery({
    path: '/programs',
    request: { query: { limit: 200, ...(status ? { status } : {}) } },
  });
  return (
    <section aria-labelledby="programs-title">
      <h2 id="programs-title">Programs and camps</h2>
      <p>
        Reusable program definitions. Dated offerings, sessions, prices and publication are set up
        inside each program (SPK-CAT-001).
      </p>
      <div className="rf-grid">
        <SelectField
          label="Show programs"
          value={status}
          onChange={(v) => setStatus(v as '' | ProgramStatus)}
          placeholder="All statuses"
          options={(['draft', 'active', 'archived'] as const).map((s) => ({
            value: s,
            label: PROGRAM_STATUS[s].label,
          }))}
        />
      </div>
      <QueryBoundary
        query={programs}
        label="programs"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No programs',
          description:
            'No program matches. Create a reusable program below, then add dated offerings to it.',
        }}
        unavailableOffline={['creating or changing programs']}
      >
        {(data) => (
          <ul className="list" aria-label="Programs">
            {data.items.map((program) => (
              <li key={program.id}>
                <div className="row-text">
                  <Link className="row-title" to={`/programs/${program.id}`}>
                    {program.name}
                  </Link>
                  <span className="caption">
                    {program.activityType}
                    {program.format ? ` · ${program.format}` : ''} · {ageBandText(program.ageBand)}
                  </span>
                </div>
                <StatusBadge {...PROGRAM_STATUS[program.status]} />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      {programs.data?.nextCursor ? (
        <StateView
          variant="empty"
          title="More programs exist"
          description="Only the first 200 are shown. Narrow the list by status."
        />
      ) : null}
      <CreateProgram />
    </section>
  );
}
