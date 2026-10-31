/**
 * SCR-S-06 Closure impact and resolution (SPK-SCHED-009, SPK-FAC-003, SPK-AT-009, SPK-AT-021;
 * POL-041 and DEC-009 pending). Reads `GET /v1/closures/{id}`: the impact lists the affected games,
 * programs, rentals and other events, the teams, people and equipment committed to them, the owning
 * records, and the customers, financial obligations and unsent messages they involve
 * (`ClosureImpactView.tsx`).
 *
 * - Apply (`POST /v1/closures/{id}/apply`, `expectedRevision`): the user chooses to cancel the
 *   affected published events (each sends a schedule notice) or to leave them for resolution; no
 *   choice is preselected. The API recomputes the impact when applying; if the affected set
 *   changed since the preview, the screen says what changed ("stale version: affected set changed").
 * - Withdraw a pending closure before it applies (`POST /v1/closures/{id}/withdraw`, reason and
 *   `expectedRevision`, SPK-FAC-003): nothing was closed and nobody is told. A closure held by a
 *   maintenance restriction is withdrawn with its restriction on SCR-S-42; the API answers
 *   RESOURCE_CONFLICT `OWNED_BY_RESTRICTION` and the screen links to that restriction.
 * - Resolve: per affected event, relocate, reschedule or cancel; the choices become one schedule
 *   draft (`POST /v1/schedule-drafts`) that publishes through the normal publication command, so the
 *   resolution is validated and published together or not at all.
 * - Lift (`POST /v1/closures/{id}/lift`) for closures not created by maintenance; a maintenance
 *   restriction returns to service by an authorized release on SCR-S-42 (SPK-FAC-004).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
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
import { useCommandReload } from '../../features/schedule-facilities/reload';
import {
  useFacilityById,
  ZoneCaption,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { resourceNames } from '../../features/schedule-facilities/inventory';
import { ActionGate } from '../../features/schedule-facilities/permission';
import { CLOSURE_BADGE } from '../../features/schedule-facilities/labels';
import {
  LocalDateTimeField,
  localFromInstant,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import { ResourceChecklist } from '../../features/schedule-facilities/ResourceChecklist';
import { formatInstant, formatRange } from '../../features/schedule-facilities/time';
import {
  AffectedEventList,
  ImpactParties,
  ImpactSummary,
  type AffectedEvent,
} from './ClosureImpactView';
import { CLOSURES_KEY } from './ClosuresScreen';
import type { DraftChangeInput } from './draft-changes';
import { DRAFTS_KEY } from './ScheduleDraftsScreen';

type Closure = Schema<'Closure'>;
type Mode = NonNullable<Closure['resolution']>['mode'];

interface ResolutionChoice {
  action: 'leave' | 'relocate' | 'reschedule' | 'cancel';
  resourceIds: string[];
  start: LocalDateTime;
  end: LocalDateTime;
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
  const reload = useCommandReload(apply.reset, [CLOSURES_KEY, ['api', '/closures/{id}']]);
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
        <CommandError
          error={apply.error}
          onRetry={submit}
          onReload={reload}
          action="Applying the closure"
        />
      ) : null}
    </section>
  );
}

/** The restriction that holds a maintenance closure, from the facility's restrictions. */
function useOwningRestriction(closure: Closure, enabled: boolean) {
  const restrictions = useApiQuery({
    path: '/maintenance-restrictions',
    request: { query: { facilityId: closure.facilityId } },
    enabled,
  });
  return restrictions.data?.find((r) => r.schedulingClosureId === closure.id);
}

/** RESOURCE_CONFLICT `OWNED_BY_RESTRICTION` from the withdraw route (FAC-01). */
function owningRestrictionId(error: ApiError | null): string | null {
  if (!error || error.code !== 'RESOURCE_CONFLICT') return null;
  const details = error.details as { code?: unknown; restrictionId?: unknown } | null;
  if (!details || details.code !== 'OWNED_BY_RESTRICTION') return null;
  return typeof details.restrictionId === 'string' ? details.restrictionId : '';
}

function RestrictionLink({ id }: { id: string | null | undefined }) {
  return id ? (
    <Link to={`/facilities/restrictions/${id}`}>Open the restriction</Link>
  ) : (
    <Link to="/facilities/restrictions">Operating restrictions</Link>
  );
}

/** SPK-FAC-003: withdraw a pending closure before it applies; a reason is required. */
function WithdrawPanel({ closure }: { closure: Closure }) {
  const { online } = useApp();
  const maintenance = closure.source === 'maintenance';
  const owner = useOwningRestriction(closure, maintenance);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const withdraw = useApiCommand('post', '/closures/{id}/withdraw', {
    invalidate: [CLOSURES_KEY, ['api', '/closures/{id}'], ['api', '/events']],
  });
  const reload = useCommandReload(withdraw.reset, [CLOSURES_KEY, ['api', '/closures/{id}']]);
  if (maintenance) {
    return (
      <section aria-labelledby="withdraw-title">
        <h4 id="withdraw-title">Withdraw</h4>
        <p>
          This closure belongs to a maintenance restriction. It is withdrawn together with its
          restriction, from Facilities and maintenance.
        </p>
        <RestrictionLink id={owner?.id} />
      </section>
    );
  }
  const submit = () => {
    setAttempted(true);
    if (!reason.trim()) return;
    void withdraw
      .submit({
        path: { id: closure.id },
        body: { reason: reason.trim(), expectedRevision: closure.revision },
      })
      .catch(() => undefined);
  };
  const owned = owningRestrictionId(withdraw.error);
  return (
    <section aria-labelledby="withdraw-title">
      <h4 id="withdraw-title">Withdraw the closure</h4>
      <p>
        Withdrawing ends this planned closure before it applies. Nothing was closed, so nobody is
        told, and the closure is kept for history.
      </p>
      <label htmlFor="withdraw-reason">Reason for withdrawing</label>
      <input
        id="withdraw-reason"
        value={reason}
        maxLength={2000}
        aria-invalid={attempted && !reason.trim() ? true : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {attempted && !reason.trim() ? (
        <span className="error-text" role="alert">
          Enter the reason for withdrawing the closure.
        </span>
      ) : null}
      <Button variant="secondary" busy={withdraw.isProcessing} disabled={!online} onClick={submit}>
        Withdraw closure
      </Button>
      {!online ? <p className="caption">Withdrawing a closure needs a connection.</p> : null}
      {owned !== null ? (
        <div role="alert" className="banner" data-testid="owned-by-restriction">
          <StatusBadge tone="warning" label="Withdraw it with its restriction" />
          <span>
            This closure belongs to a maintenance restriction; withdraw the restriction instead.
          </span>
          <RestrictionLink id={owned} />
        </div>
      ) : withdraw.error ? (
        <CommandError
          error={withdraw.error}
          onRetry={submit}
          onReload={reload}
          action="Withdrawing the closure"
        />
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
  const reloadLift = useCommandReload(lift.reset, [CLOSURES_KEY, ['api', '/closures/{id}']]);
  const restriction = useOwningRestriction(closure, closure.source === 'maintenance');
  if (closure.source === 'maintenance') {
    return (
      <section aria-labelledby="lift-title">
        <h4 id="lift-title">Return to service</h4>
        <p>
          This closure comes from a maintenance restriction. The area returns to service by an
          authorized release, which also checks any required inspection.
        </p>
        <RestrictionLink id={restriction?.id} />
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
        <CommandError
          error={lift.error}
          onRetry={submit}
          onReload={reloadLift}
          action="Lifting the closure"
        />
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
        {shown.withdrawnAt ? (
          <>
            <dt>Withdrawn</dt>
            <dd>
              {formatInstant(shown.withdrawnAt, tz)}
              {shown.withdrawalReason ? `: ${shown.withdrawalReason}` : ''}
            </dd>
          </>
        ) : null}
      </dl>
      {shown.status === 'withdrawn' ? (
        <p role="status" data-testid="closure-withdrawn">
          This closure was withdrawn before it applied: nothing was closed and nobody was told.
        </p>
      ) : null}

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
            : shown.status === 'withdrawn'
              ? 'as previewed before it was withdrawn'
              : 'when applied'}
        </h4>
        {impact ? (
          <>
            <ImpactSummary impact={impact} caption="What this closure affects" />
            <AffectedEventList
              impact={impact}
              names={names}
              timeZone={tz}
              canceled={canceled}
              unresolved={unresolved}
            />
            <ImpactParties impact={impact} />
          </>
        ) : (
          <p>No impact preview was recorded for this closure.</p>
        )}
      </section>

      {shown.status === 'pending' ? (
        <ActionGate
          action="scheduling.manage_closures"
          facilityId={shown.facilityId}
          what="Applying or withdrawing this closure"
        >
          <ApplyPanel closure={shown} onApplied={setApplied} />
          <WithdrawPanel closure={shown} />
        </ActionGate>
      ) : null}
      {toResolve.length > 0 ? (
        <ActionGate
          action="scheduling.manage_drafts"
          facilityId={shown.facilityId}
          what="Building a resolution draft"
        >
          <ResolutionBuilder
            key={toResolve.map((e) => e.eventId).join()}
            closure={shown}
            facility={facility}
            events={toResolve}
            resources={resources.data ?? []}
          />
        </ActionGate>
      ) : null}
      {shown.status === 'active' && shown.source === 'maintenance' ? (
        <LiftPanel closure={shown} />
      ) : shown.status === 'active' ? (
        <ActionGate
          action="scheduling.manage_closures"
          facilityId={shown.facilityId}
          what="Lifting this closure"
        >
          <LiftPanel closure={shown} />
        </ActionGate>
      ) : null}
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
