/**
 * SCR-S-14 Program, offering and session setup: the program list and "new program"
 * (SPK-CAT-001 reusable program definitions apart from dated offerings; SPK-YOUTH-001 age bands;
 * SPK-UX-008 states). Programs come from `GET /v1/programs`; creation is `POST /v1/programs` with
 * an idempotency key per intent. Age band values are whatever the program manager enters: the
 * approved youth bands are pending DEC-003 and nothing is preset.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { CapacityMeter, CheckRow, Segmented } from '../../features/grow/Grow';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { SelectField, TextArea, TextField } from '../../features/registration-finance/fields';
import { formatDate, formatInstant, formatMoney } from '../../features/registration-finance/format';
import {
  CAPACITY_UNIT,
  OFFERING_KIND,
  PROGRAM_STATUS,
  PUBLICATION_STATE,
} from '../../features/registration-finance/labels';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { PageHeader } from '../../ui/Page';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { LoadMore } from '../../ui/LoadMore';
import { StatusBadge } from '../../ui/StatusBadge';
import {
  SPORT_ICON,
  capacityOf,
  poolsOf,
  sportOf,
  staffing,
  summarize,
  type Pool,
  type ProgramSummary,
} from './program-capacity';
import './programs.css';

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
    <section className="rf-panel program-new" aria-labelledby="new-program-title">
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

type Program = Schema<'Program'>;

/** The offerings and capacity pools behind the cards; either may be unavailable to the viewer. */
function useProgramCapacity() {
  // The staff view lists offerings in every publication state at the facilities the viewer
  // manages (others see the published ones); one page of 200, the rest is said, never guessed.
  const offerings = useApiPages({
    path: '/offerings',
    request: { query: { view: 'staff', limit: 200 } },
  });
  const pools = useApiQuery({
    path: '/capacity-pools',
    request: { query: { scopeType: 'offering' } },
  });
  return {
    offerings: offerings.data ?? null,
    moreOfferings: offerings.hasNextPage,
    pools: pools.data ?? null,
    // A failed supplementary read never hides the programs: the cards say capacity is unknown.
    capacityKnown: offerings.data !== undefined && pools.data !== undefined,
  };
}

function ProgramCard({
  program,
  summary,
  capacityKnown,
  selected,
  onSelect,
}: {
  program: Program;
  summary: ProgramSummary | null;
  capacityKnown: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const offerings = summary?.offerings ?? [];
  const sport = sportOf(program, offerings);
  const first = offerings[0];
  const last = offerings[offerings.length - 1];
  const where = first ? (first.locationLabel ?? first.facility.name) : null;
  return (
    <li className="program-card" data-sport={sport} data-selected={selected}>
      <div className="program-card-body">
        <span className="program-card-top">
          <span className="sport-label">
            <Icon name={SPORT_ICON[sport]} size={17} />
            {program.activityType}
            {program.format ? ` · ${program.format}` : ''}
          </span>
          <StatusBadge {...PROGRAM_STATUS[program.status]} />
        </span>
        <Link className="program-name" to={`/programs/${program.id}`}>
          {program.name}
        </Link>
        <span className="program-meta">
          {ageBandText(program.ageBand)}
          {first && last ? ` · ${formatDate(first.startsOn)} to ${formatDate(last.endsOn)}` : ''}
        </span>
        {where ? (
          <span className="program-where">
            <Icon name="location_on" size={15} />
            {where}
          </span>
        ) : null}
        {!capacityKnown ? (
          <span className="caption">Capacity not shown: offerings or pools are not available.</span>
        ) : summary?.capacity ? (
          <CapacityMeter
            capacity={summary.capacity.capacity}
            committed={summary.capacity.committed}
            held={summary.capacity.held}
            note={
              summary.otherUnits > 0
                ? `${CAPACITY_UNIT[summary.capacity.unit]} (+${summary.otherUnits} more)`
                : undefined
            }
          />
        ) : (
          <span className="caption">
            {offerings.length === 0
              ? 'No dated offerings yet.'
              : 'No capacity pool is set on its offerings.'}
          </span>
        )}
      </div>
      <div className="program-card-foot">
        <span>
          {summary?.minPrice ? (
            <strong>From {formatMoney(summary.minPrice.minor, summary.minPrice.currency)}</strong>
          ) : (
            <span>{offerings.length === 1 ? '1 offering' : `${offerings.length} offerings`}</span>
          )}
          {summary && summary.openCount > 0 ? ` · ${summary.openCount} open` : ''}
        </span>
        <button
          type="button"
          className="button button-secondary button-sm"
          aria-pressed={selected}
          aria-label={`Readiness: ${program.name}`}
          onClick={onSelect}
        >
          Readiness
        </button>
      </div>
    </li>
  );
}

function ReadinessRail({
  program,
  summary,
  pools,
}: {
  program: Program;
  summary: ProgramSummary;
  pools: readonly Pool[];
}) {
  const { offerings } = summary;
  const first = offerings[0];
  const last = offerings[offerings.length - 1];
  const zone = first?.facility.timezone ?? null;
  const live = offerings.filter((o) => o.publicationState !== 'archived');
  const drafts = live.filter((o) => o.publicationState === 'draft').length;
  const open = live.filter((o) => o.publicationState === 'registration_open').length;
  const unpriced = live.filter((o) => o.price === null).length;
  const programPools = offerings.flatMap((o) => poolsOf(o.id, pools));
  const staff = staffing(programPools);
  const forms = new Set(live.flatMap((o) => o.requiredFormPolicyVersionIds)).size;
  const closes = live
    .map((o) => o.registrationClosesAt)
    .filter((t): t is string => t !== null && t !== undefined)
    .sort()[0];
  return (
    <section className="card readiness-rail" aria-labelledby="readiness-title">
      <div className="rail-hero">
        <span className="eyebrow">
          {first ? `${OFFERING_KIND[first.kind]} · ` : ''}
          {first && last ? `${formatDate(first.startsOn)} to ${formatDate(last.endsOn)} · ` : ''}
          {ageBandText(program.ageBand)}
        </span>
        <h3 className="rail-title" id="readiness-title">
          Readiness: {program.name}
        </h3>
        <span className="caption">
          {first ? (first.locationLabel ?? first.facility.name) : 'No dated offerings yet'}
        </span>
      </div>
      <div className="rail-section">
        <span className="label-caps">Enrollment by offering</span>
        {offerings.length === 0 ? (
          <p className="caption">Add a dated offering to the program to see its capacity.</p>
        ) : (
          <ul className="readiness-list" aria-label="Enrollment by offering">
            {offerings.map((o) => {
              const { capacity } = capacityOf(poolsOf(o.id, pools));
              return (
                <li key={o.id} className="readiness-week">
                  <span className="readiness-week-head">
                    <Link to={`/programs/offerings/${o.id}`}>{o.name}</Link>
                    <StatusBadge {...PUBLICATION_STATE[o.publicationState]} />
                  </span>
                  {capacity ? (
                    <CapacityMeter
                      capacity={capacity.capacity}
                      committed={capacity.committed}
                      held={capacity.held}
                    />
                  ) : (
                    <span className="caption">No capacity pool.</span>
                  )}
                  <Link className="caption" to={`/registrations/waitlists/${o.id}`}>
                    Waitlist of {o.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="rail-section">
        <span className="label-caps">Readiness</span>
        <ul className="checks" aria-label="Readiness checks">
          <CheckRow
            tone={live.length === 0 ? 'warning' : drafts > 0 ? 'pending' : 'success'}
            label="Open for registration"
            value={`${open} of ${live.length}`}
          />
          <CheckRow
            tone={unpriced > 0 ? 'warning' : live.length === 0 ? 'neutral' : 'success'}
            label="Prices set"
            value={unpriced > 0 ? `${unpriced} without a price` : live.length === 0 ? '–' : 'Set'}
          />
          <CheckRow
            tone={
              staff === null ? 'neutral' : staff.planned >= staff.needed ? 'success' : 'warning'
            }
            label={
              staff === null
                ? 'Staff ratio: not set on any pool'
                : `Staff planned (1:${staff.ratios.join(', 1:')} ratio)`
            }
            value={staff === null ? undefined : `${staff.planned} / ${staff.needed}`}
          />
          <CheckRow
            tone="info"
            label="Required forms"
            value={forms === 0 ? 'None' : String(forms)}
          />
          <CheckRow
            tone="info"
            label="Registration closes"
            value={closes ? formatInstant(closes, zone) : 'Not set'}
          />
        </ul>
        <p className="caption">
          Form completion and age-group splits are not listed by the API, so they are not shown.
        </p>
      </div>
      <div className="rail-actions">
        <Link className="button button-primary button-sm" to={`/programs/${program.id}`}>
          Open program
        </Link>
        <Link className="button button-secondary button-sm" to="/registrations/assisted">
          Register someone
        </Link>
      </div>
    </section>
  );
}

const STATUS_CHOICES: readonly { value: '' | ProgramStatus; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
];

export function ProgramsScreen() {
  const [status, setStatus] = useState<'' | ProgramStatus>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // §4.5: keyset pages with "Load more"; nothing is silently cut off.
  const programs = useApiPages({
    path: '/programs',
    request: { query: { limit: 50, ...(status ? { status } : {}) } },
  });
  const capacity = useProgramCapacity();
  const summaries = useMemo(() => {
    const map = new Map<string, ProgramSummary>();
    if (!capacity.offerings) return map;
    for (const p of programs.data ?? []) {
      map.set(p.id, summarize(p.id, capacity.offerings, capacity.pools ?? []));
    }
    return map;
  }, [programs.data, capacity.offerings, capacity.pools]);
  const items = programs.data ?? [];
  const selected = items.find((p) => p.id === selectedId) ?? items[0] ?? null;
  const selectedSummary = selected ? summaries.get(selected.id) : undefined;
  const committed = capacity.capacityKnown
    ? [...summaries.values()].reduce((n, s) => n + (s.capacity?.committed ?? 0), 0)
    : null;
  const eyebrow = [
    'Grow',
    programs.data
      ? `${items.length}${programs.hasNextPage ? '+' : ''} ${items.length === 1 ? 'program' : 'programs'}`
      : null,
    committed !== null ? `${committed} places committed` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section aria-labelledby="programs-title" className="grow">
      <PageHeader
        eyebrow={eyebrow}
        title="Programs and camps"
        titleId="programs-title"
        intro="Reusable program definitions. Dated offerings, sessions, prices and publication are set up inside each program (SPK-CAT-001)."
        actions={
          <span className="programs-head-actions">
            <Segmented
              label="Show programs"
              value={status}
              options={STATUS_CHOICES}
              onChange={setStatus}
            />
            <a className="button button-primary" href="#new-program-title">
              <Icon name="add" size={19} />
              New program
            </a>
          </span>
        }
      />
      <div className="split">
        <div className="split-main">
          <QueryBoundary
            query={programs}
            label="programs"
            isEmpty={(list) => list.length === 0}
            empty={{
              title: 'No programs',
              description:
                'No program matches. Create a reusable program, then add dated offerings to it.',
            }}
            unavailableOffline={['creating or changing programs']}
          >
            {(list) => (
              <ul className="program-grid" aria-label="Programs">
                {list.map((program) => (
                  <ProgramCard
                    key={program.id}
                    program={program}
                    summary={summaries.get(program.id) ?? null}
                    capacityKnown={capacity.capacityKnown}
                    selected={selected?.id === program.id}
                    onSelect={() => setSelectedId(program.id)}
                  />
                ))}
              </ul>
            )}
          </QueryBoundary>
          <LoadMore pages={programs} label="programs" />
          {capacity.moreOfferings ? (
            <p className="caption">
              Capacity is summed over the first 200 offerings the API listed; open a program for all
              of its offerings.
            </p>
          ) : null}
        </div>
        <div className="split-side">
          {selected && selectedSummary ? (
            <ReadinessRail
              program={selected}
              summary={selectedSummary}
              pools={capacity.pools ?? []}
            />
          ) : null}
          <CreateProgram />
        </div>
      </div>
    </section>
  );
}
