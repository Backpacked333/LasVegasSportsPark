/**
 * SCR-S-06 Closure impact and resolution (SPK-SCHED-009, SPK-FAC-003, SPK-AT-009, SPK-AT-021;
 * POL-041 and DEC-009 pending). Reads `GET /v1/closures/{id}`: the impact lists the affected games,
 * programs, rentals and other events, the teams, people and equipment committed to them, and the
 * owning records. The API does not return the affected customers, financial obligations or messages
 * (finance and communications resolve those from the owning records), so those rows say so instead
 * of showing a number.
 *
 * - Apply (`POST /v1/closures/{id}/apply`, `expectedRevision`): the user chooses to cancel the
 *   affected published events (each sends a schedule notice) or to leave them for resolution; no
 *   choice is preselected. The API recomputes the impact when applying; if the affected set
 *   changed since the preview, the screen says what changed ("stale version: affected set changed").
 * - Resolve: per affected event, relocate, reschedule or cancel; the choices become one schedule
 *   draft (`POST /v1/schedule-drafts`) that publishes through the normal publication command, so the
 *   resolution is validated and published together or not at all.
 * - Lift (`POST /v1/closures/{id}/lift`) for closures not created by maintenance; a maintenance
 *   restriction returns to service by an authorized release on SCR-S-42 (SPK-FAC-004).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import {
  useFacilityById,
  ZoneCaption,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { namesOf, resourceNames } from '../../features/schedule-facilities/inventory';
import {
  CLOSURE_BADGE,
  EVENT_KIND_LABEL,
  eventBadge,
} from '../../features/schedule-facilities/labels';
import {
  LocalDateTimeField,
  localFromInstant,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import { ResourceChecklist } from '../../features/schedule-facilities/ResourceChecklist';
import { formatInstant, formatRange } from '../../features/schedule-facilities/time';
import { CLOSURES_KEY } from './ClosuresScreen';
import type { DraftChangeInput } from './draft-changes';
import { DRAFTS_KEY } from './ScheduleDraftsScreen';

type Closure = Schema<'Closure'>;
// The OpenAPI component is declared nullable (it is reused as a nullable field), hence NonNullable.
type AffectedEvent = NonNullable<Schema<'ClosureImpact'>>['affectedEvents'][number];
type Mode = NonNullable<Closure['resolution']>['mode'];

interface ResolutionChoice {
  action: 'leave' | 'relocate' | 'reschedule' | 'cancel';
  resourceIds: string[];
  start: LocalDateTime;
  end: LocalDateTime;
}

function ImpactSummary({ closure }: { closure: Closure }) {
  const impact = closure.impact;
  if (!impact) return <p>No impact preview was recorded for this closure.</p>;
  const s = impact.summary;
  const rows: [string, string][] = [
    ['Games', String(s.games)],
    ['Programs', String(s.programs)],
    ['Rentals', String(s.rentals)],
    ['Other events', String(s.other)],
    ['Teams', String(s.teams)],
    ['People committed (staff, officials, coaches, participants)', String(s.people)],
    ['Equipment', String(s.equipment)],
    ['Owning records (fixtures, sessions, rentals)', String(impact.sourceRecords.length)],
  ];
  return (
    <table className="facts-table">
      <caption>What this closure affects</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
        {['Customers', 'Financial obligations', 'Messages'].map((label) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>
              Not available here: resolved by the owning records, not listed by the scheduling
              service
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function commitmentSummary(e: AffectedEvent): string {
  const count = (t: string) => e.commitments.filter((c) => c.partyType === t).length;
  const parts = [
    count('team') ? `${count('team')} team${count('team') === 1 ? '' : 's'}` : null,
    count('person') ? `${count('person')} ${count('person') === 1 ? 'person' : 'people'}` : null,
    count('equipment') ? `${count('equipment')} equipment` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'no commitments';
}

function ResolutionBuilder({
  closure,
  facility,
  events,
  resources,
}: {
  closure: Closure;
  facility: FacilityContext;
  events: AffectedEvent[];
  resources: Schema<'Resource'>[];
}) {
  const navigate = useNavigate();
  const { online } = useApp();
  const tz = facility.timezone;
  const [choices, setChoices] = useState<Record<string, ResolutionChoice>>(() =>
    Object.fromEntries(
      events.map((e) => [
        e.eventId,
        {
          action: 'leave',
          resourceIds: e.resourceIds,
          start: localFromInstant(e.scheduledStart, tz),
          end: localFromInstant(e.scheduledEnd, tz),
        },
      ]),
    ),
  );
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/schedule-drafts', { invalidate: [DRAFTS_KEY] });

  const update = (id: string, patch: Partial<ResolutionChoice>) =>
    setChoices((prev) => ({ ...prev, [id]: { ...(prev[id] as ResolutionChoice), ...patch } }));

  const built = events.map((e) => {
    const c = choices[e.eventId] as ResolutionChoice;
    if (c.action === 'leave') return { change: null, problem: null };
    if (c.action === 'cancel') {
      return {
        change: {
          kind: 'cancel',
          targetEventId: e.eventId,
          proposed: { reason: `Closure: ${closure.reason}`.slice(0, 2000) },
        } as DraftChangeInput,
        problem: null,
      };
    }
    if (c.action === 'relocate') {
      return c.resourceIds.length === 0 || c.resourceIds.join() === e.resourceIds.join()
        ? { change: null, problem: `${e.title}: choose different spaces.` }
        : {
            change: {
              kind: 'resource_change',
              targetEventId: e.eventId,
              resourceIds: c.resourceIds,
            } as DraftChangeInput,
            problem: null,
          };
    }
    const s = toInstant(c.start, tz);
    const en = toInstant(c.end, tz);
    if (!s.ok || !en.ok)
      return {
        change: null,
        problem: `${e.title}: ${!s.ok ? s.message : !en.ok ? en.message : ''}`,
      };
    if (s.instant >= en.instant)
      return { change: null, problem: `${e.title}: the end must be after the start.` };
    return {
      change: {
        kind: 'move',
        targetEventId: e.eventId,
        proposed: { scheduledStart: s.instant, scheduledEnd: en.instant },
        ...(c.resourceIds.join() !== e.resourceIds.join() ? { resourceIds: c.resourceIds } : {}),
      } as DraftChangeInput,
      problem: null,
    };
  });
  const changes = built.flatMap((b) => (b.change ? [b.change] : []));
  const problems = built.flatMap((b) => (b.problem ? [b.problem] : []));

  const submit = () => {
    setAttempted(true);
    if (problems.length > 0 || changes.length === 0) return;
    void create
      .submit({
        body: {
          facilityId: closure.facilityId,
          name: `Closure resolution: ${closure.reason}`.slice(0, 200),
          changes,
        },
      })
      .then((draft) => navigate(`/schedule/drafts/${draft.id}`))
      .catch(() => undefined);
  };

  return (
    <section aria-labelledby="resolution-title">
      <h4 id="resolution-title">Build a resolution</h4>
      <p>
        Choose what happens to each affected event. Your choices become one schedule draft; it is
        validated and then published together, so customers are told once, with old and new details.
      </p>
      <StateView
        variant="pending-decision"
        subject="The closure resolution policy (which relocation, rescheduling and cancellation options apply) and the policy-governed financial adjustment that follows"
        decisions={['POL-041', 'DEC-009']}
        owner="Operations; Finance"
      />
      <ul className="list" aria-label="Affected events to resolve">
        {events.map((e) => {
          const c = choices[e.eventId] as ResolutionChoice;
          return (
            <li key={e.eventId}>
              <fieldset className="resolution-choice">
                <legend>
                  {e.title}: {formatRange(e.scheduledStart, e.scheduledEnd, tz)}
                </legend>
                {(
                  [
                    ['leave', 'Leave as is for now'],
                    ['relocate', 'Relocate to another space'],
                    ['reschedule', 'Reschedule'],
                    ['cancel', 'Cancel'],
                  ] as const
                ).map(([action, label]) => (
                  <label key={action}>
                    <input
                      type="radio"
                      name={`resolve-${e.eventId}`}
                      checked={c.action === action}
                      onChange={() => update(e.eventId, { action })}
                    />{' '}
                    {label}
                  </label>
                ))}
                {c.action === 'relocate' || c.action === 'reschedule' ? (
                  <ResourceChecklist
                    legend={`Spaces for ${e.title}`}
                    resources={resources}
                    value={c.resourceIds}
                    onChange={(ids) => update(e.eventId, { resourceIds: ids })}
                  />
                ) : null}
                {c.action === 'reschedule' ? (
                  <>
                    <LocalDateTimeField
                      label={`New start for ${e.title}`}
                      value={c.start}
                      onChange={(v) => update(e.eventId, { start: v })}
                      timeZone={tz}
                    />
                    <LocalDateTimeField
                      label={`New end for ${e.title}`}
                      value={c.end}
                      onChange={(v) => update(e.eventId, { end: v })}
                      timeZone={tz}
                    />
                  </>
                ) : null}
              </fieldset>
            </li>
          );
        })}
      </ul>
      {attempted && changes.length === 0 && problems.length === 0 ? (
        <p className="error-text" role="alert">
          Choose a resolution for at least one event.
        </p>
      ) : null}
      {attempted && problems.length > 0 ? (
        <ul className="field-issues" aria-label="Problems to correct">
          {problems.map((p) => (
            <li key={p} className="error-text">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      <Button busy={create.isProcessing} disabled={!online} onClick={submit}>
        Create resolution draft ({changes.length} change{changes.length === 1 ? '' : 's'})
      </Button>
      {create.error ? (
        <CommandError
          error={create.error}
          onRetry={submit}
          action="Creating the resolution draft"
        />
      ) : null}
    </section>
  );
}

function ApplyPanel({ closure, onApplied }: { closure: Closure; onApplied: (c: Closure) => void }) {
  const { online } = useApp();
  const [mode, setMode] = useState<'' | Mode>('');
  const [attempted, setAttempted] = useState(false);
  const apply = useApiCommand('post', '/closures/{id}/apply', {
    invalidate: [CLOSURES_KEY, ['api', '/events']],
  });
  const submit = () => {
    setAttempted(true);
    if (!mode) return;
    void apply
      .submit({ path: { id: closure.id }, body: { mode, expectedRevision: closure.revision } })
      .then(onApplied)
      .catch(() => undefined);
  };
  return (
    <section aria-labelledby="apply-title">
      <h4 id="apply-title">Apply the closure</h4>
      <fieldset>
        <legend>Affected events that are already published</legend>
        <label>
          <input
            type="radio"
            name="apply-mode"
            checked={mode === 'cancel_affected'}
            onChange={() => setMode('cancel_affected')}
          />{' '}
          Cancel them now (each sends a cancellation notice)
        </label>
        <label>
          <input
            type="radio"
            name="apply-mode"
            checked={mode === 'leave_for_resolution'}
            onChange={() => setMode('leave_for_resolution')}
          />{' '}
          Leave them for resolution (they appear in the scheduler queue on Today)
        </label>
      </fieldset>
      {attempted && !mode ? (
        <p className="error-text" role="alert">
          Choose what happens to the affected events.
        </p>
      ) : null}
      <p className="caption">The impact is checked again when the closure is applied.</p>
      <Button busy={apply.isProcessing} disabled={!online} onClick={submit}>
        Apply closure
      </Button>
      {!online ? <p className="caption">Applying a closure needs a connection.</p> : null}
      {apply.error ? (
        <CommandError error={apply.error} onRetry={submit} action="Applying the closure" />
      ) : null}
    </section>
  );
}

function LiftPanel({ closure }: { closure: Closure }) {
  const { online } = useApp();
  const [confirm, setConfirm] = useState(false);
  const lift = useApiCommand('post', '/closures/{id}/lift', {
    invalidate: [CLOSURES_KEY, ['api', '/closures/{id}']],
  });
  const restrictions = useApiQuery({
    path: '/maintenance-restrictions',
    request: { query: { facilityId: closure.facilityId } },
    enabled: closure.source === 'maintenance',
  });
  if (closure.source === 'maintenance') {
    const restriction = restrictions.data?.find((r) => r.schedulingClosureId === closure.id);
    return (
      <section aria-labelledby="lift-title">
        <h4 id="lift-title">Return to service</h4>
        <p>
          This closure comes from a maintenance restriction. The area returns to service by an
          authorized release, which also checks any required inspection.
        </p>
        {restriction ? (
          <Link to={`/facilities/restrictions/${restriction.id}`}>Open the restriction</Link>
        ) : (
          <Link to="/facilities/restrictions">Operating restrictions</Link>
        )}
      </section>
    );
  }
  const submit = () =>
    void lift
      .submit({ path: { id: closure.id }, body: { expectedRevision: closure.revision } })
      .catch(() => undefined);
  return (
    <section aria-labelledby="lift-title">
      <h4 id="lift-title">Lift the closure</h4>
      {confirm ? (
        <>
          <p>Lifting makes the space bookable again from now. Canceled events stay canceled.</p>
          <Button busy={lift.isProcessing} disabled={!online} onClick={submit}>
            Confirm lift
          </Button>
          <Button variant="secondary" onClick={() => setConfirm(false)}>
            Keep it closed
          </Button>
        </>
      ) : (
        <Button variant="secondary" disabled={!online} onClick={() => setConfirm(true)}>
          Lift closure
        </Button>
      )}
      {lift.error ? (
        <CommandError error={lift.error} onRetry={submit} action="Lifting the closure" />
      ) : null}
    </section>
  );
}

function ClosureDetail({ closure, facility }: { closure: Closure; facility: FacilityContext }) {
  const tz = facility.timezone;
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: closure.facilityId } },
  });
  const names = resourceNames(resources.data ?? []);
  // The preview the user reviewed, kept to compare with what applying actually affected.
  const [previewIds] = useState<string[] | null>(() =>
    closure.status === 'pending'
      ? (closure.impact?.affectedEvents.map((e) => e.eventId) ?? [])
      : null,
  );
  const [applied, setApplied] = useState<Closure | null>(null);
  const shown = applied && applied.revision >= closure.revision ? applied : closure;
  const impact = shown.impact;
  const affected = impact?.affectedEvents ?? [];
  const canceled = new Set(shown.resolution?.canceledEventIds ?? []);
  const unresolved = new Set(shown.resolution?.unresolvedEventIds ?? []);
  const appliedIds = applied?.impact?.affectedEvents.map((e) => e.eventId) ?? [];
  const added = previewIds && applied ? appliedIds.filter((id) => !previewIds.includes(id)) : [];
  const removed = previewIds && applied ? previewIds.filter((id) => !appliedIds.includes(id)) : [];
  const toResolve =
    shown.status === 'active'
      ? affected.filter((e) => unresolved.has(e.eventId))
      : shown.status === 'pending'
        ? affected.filter((e) => e.status === 'published')
        : [];
  const badge = CLOSURE_BADGE[shown.status];

  return (
    <div>
      <ZoneCaption facility={facility} />
      <p>
        <strong>{shown.reason}</strong> <StatusBadge tone={badge.tone} label={badge.label} />
      </p>
      <dl className="facts">
        <dt>Area</dt>
        <dd>{shown.resourceId ? (names.get(shown.resourceId) ?? 'A space') : 'Whole facility'}</dd>
        <dt>When</dt>
        <dd>{formatRange(shown.interval.start, shown.interval.end, tz)}</dd>
        <dt>Source</dt>
        <dd>{shown.source}</dd>
        {shown.appliedAt ? (
          <>
            <dt>Applied</dt>
            <dd>{formatInstant(shown.appliedAt, tz)}</dd>
          </>
        ) : null}
        {shown.liftedAt ? (
          <>
            <dt>Lifted</dt>
            <dd>{formatInstant(shown.liftedAt, tz)}</dd>
          </>
        ) : null}
      </dl>

      {applied ? (
        <div role="status" className="banner" data-testid="closure-applied">
          <StatusBadge tone="success" label="Closure applied" />
          <span>
            {applied.resolution?.canceledEventIds.length ?? 0} event(s) canceled,{' '}
            {applied.resolution?.unresolvedEventIds.length ?? 0} awaiting resolution.
          </span>
          {added.length > 0 || removed.length > 0 ? (
            <span data-testid="affected-set-changed">
              The affected set changed since the preview: {added.length} more event
              {added.length === 1 ? '' : 's'} affected, {removed.length} no longer affected. The
              list below is what was applied.
            </span>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="impact-title">
        <h4 id="impact-title">
          Impact{' '}
          {shown.status === 'pending'
            ? `as previewed ${formatInstant(shown.updatedAt, tz)}`
            : 'when applied'}
        </h4>
        <ImpactSummary closure={shown} />
        {affected.length === 0 ? (
          <StateView
            variant="empty"
            title="Nothing is affected"
            description="No booked event overlaps this closure."
          />
        ) : (
          <ul className="list" aria-label="Affected events">
            {affected.map((e) => {
              const eb = eventBadge(e.status);
              return (
                <li key={e.eventId}>
                  <div className="row-text">
                    <span className="row-title">{e.title}</span>
                    <span className="caption">
                      {EVENT_KIND_LABEL[e.kind]} ·{' '}
                      {formatRange(e.scheduledStart, e.scheduledEnd, tz)} on{' '}
                      {namesOf(e.resourceIds, names)} · {commitmentSummary(e)}
                      {e.sourceType ? ` · from a ${e.sourceType.replace(/_/g, ' ')}` : ''}
                    </span>
                  </div>
                  <StatusBadge tone={eb.tone} label={eb.label} />
                  {canceled.has(e.eventId) ? (
                    <StatusBadge tone="neutral" label="Canceled by this closure" />
                  ) : null}
                  {unresolved.has(e.eventId) ? (
                    <StatusBadge tone="warning" label="Awaiting resolution" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {shown.status === 'pending' ? <ApplyPanel closure={shown} onApplied={setApplied} /> : null}
      {toResolve.length > 0 ? (
        <ResolutionBuilder
          key={toResolve.map((e) => e.eventId).join()}
          closure={shown}
          facility={facility}
          events={toResolve}
          resources={resources.data ?? []}
        />
      ) : null}
      {shown.status === 'active' ? <LiftPanel closure={shown} /> : null}
    </div>
  );
}

export function ClosureDetailScreen() {
  const { closureId = '' } = useParams();
  const closure = useApiQuery({ path: '/closures/{id}', request: { path: { id: closureId } } });
  const facility = useFacilityById(closure.data?.facilityId);
  return (
    <section aria-labelledby="closure-title">
      <h3 id="closure-title">Closure impact and resolution</h3>
      <Link to="/schedule/closures">All closures</Link>
      <QueryBoundary
        query={closure}
        label="the closure"
        empty={{ title: '', description: '' }}
        unavailableOffline={['applying, lifting or resolving the closure']}
      >
        {(data) =>
          facility ? (
            <ClosureDetail key={data.id} closure={data} facility={facility} />
          ) : (
            <StateView variant="loading" label="the facility" />
          )
        }
      </QueryBoundary>
    </section>
  );
}
