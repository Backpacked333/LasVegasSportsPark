/**
 * SCR-S-42 Operating restrictions (SPK-FAC-003, SPK-FAC-004, SPK-SCHED-009, SPK-AT-021; DEC-001
 * pending, `POST /v1/maintenance-restrictions`). Per facility:
 *
 * - Operating status now (`GET /v1/facilities/{id}/operating-status`): each space in service or
 *   restricted, with why and until when.
 * - Restrictions (`GET /v1/maintenance-restrictions`) with status proposed, approved, active,
 *   released or withdrawn (a proposed or approved one is withdrawn on its detail screen, FAC-01).
 * - Apply a restriction: the affected area is chosen from the inventory (a whole pitch blocks every
 *   subdivision; a subdivision blocks only itself, and a whole-pitch booking), optionally for a
 *   maintenance task; kind, interval and reason; what happens to events already booked is chosen
 *   explicitly (no default). "Propose" records it for approval; "Propose and approve" makes it
 *   effective through the scheduling authority in the same request. Who may approve, and whether a
 *   second approver is needed, is not decided (DEC-001); the API answers ACCESS_DENIED when the
 *   viewer may not.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import {
  FacilityGate,
  ZoneCaption,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { orderedInventory } from '../../features/schedule-facilities/inventory';
import { ActionGate } from '../../features/schedule-facilities/permission';
import { RESTRICTION_BADGE } from '../../features/schedule-facilities/labels';
import {
  LocalDateTimeField,
  emptyLocal,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import { ResourceChecklist } from '../../features/schedule-facilities/ResourceChecklist';
import { formatInstant, formatRange } from '../../features/schedule-facilities/time';
import {
  ASSETS_KEY,
  OPERATING_STATUS_KEY,
  RESTRICTIONS_KEY,
  TASKS_KEY,
  useFacilityNames,
} from './maintenance-shared';

type RestrictionStatus = Schema<'Restriction'>['status'];
type ResolutionMode = 'cancel_affected' | 'leave_for_resolution';

export const RESTRICTION_INVALIDATES = [
  RESTRICTIONS_KEY,
  ['api', '/maintenance-restrictions/{id}'],
  OPERATING_STATUS_KEY,
  TASKS_KEY,
  ['api', '/maintenance-tasks/{id}'],
  ASSETS_KEY,
  ['api', '/closures'],
  ['api', '/closures/{id}'],
  ['api', '/events'],
] as const;

function OperatingStatusNow({ facility }: { facility: FacilityContext }) {
  const status = useApiQuery({
    path: '/facilities/{id}/operating-status',
    request: { path: { id: facility.id } },
  });
  return (
    <section aria-labelledby="operating-status-title">
      <h4 id="operating-status-title">Operating status now</h4>
      <QueryBoundary
        query={status}
        label="the operating status"
        isEmpty={(data) => data.resources.length === 0}
        empty={{
          title: 'No spaces',
          description: 'Spaces appear here once they are in the resource inventory.',
        }}
        unavailableOffline={['applying or releasing restrictions']}
      >
        {(data) => (
          <ul
            className="list"
            aria-label={`Operating status at ${formatInstant(data.at, facility.timezone)}`}
          >
            {orderedInventory(data.resources.map((r) => ({ ...r, id: r.resourceId }))).map(
              ({ resource: r, depth }) => (
                <li key={r.resourceId} style={{ marginInlineStart: `${depth * 24}px` }}>
                  <div className="row-text">
                    <span className="row-title">{r.name}</span>
                    {r.restrictions.map((x) => (
                      <span className="caption" key={x.restrictionId}>
                        {x.kind}: {x.reason},{' '}
                        {formatRange(x.interval.start, x.interval.end, facility.timezone)}
                        {x.resourceId !== r.resourceId ? ' (through shared space)' : ''}
                      </span>
                    ))}
                  </div>
                  <StatusBadge
                    tone={r.status === 'in_service' ? 'success' : 'danger'}
                    label={r.status === 'in_service' ? 'in_service' : 'restricted'}
                  />
                  {r.inventoryStatus !== 'active' ? (
                    <StatusBadge tone="warning" label={`Inventory status: ${r.inventoryStatus}`} />
                  ) : null}
                </li>
              ),
            )}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

function ApplyRestrictionForm({ facility }: { facility: FacilityContext }) {
  const navigate = useNavigate();
  const { online } = useApp();
  const tz = facility.timezone;
  const [params] = useSearchParams();
  const taskId = params.get('taskId') ?? '';
  const task = useApiQuery({
    path: '/maintenance-tasks/{id}',
    request: { path: { id: taskId } },
    enabled: taskId !== '',
  });
  const { resources } = useFacilityNames(facility.id);
  const [area, setArea] = useState<string[]>([]);
  const [kind, setKind] = useState<'' | 'closed' | 'limited'>('');
  const [start, setStart] = useState<LocalDateTime>(emptyLocal());
  const [end, setEnd] = useState<LocalDateTime>(emptyLocal());
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'' | ResolutionMode>('');
  const [attempted, setAttempted] = useState(false);
  const create = useApiCommand('post', '/maintenance-restrictions', {
    invalidate: RESTRICTION_INVALIDATES,
  });
  const areaId = area[0] ?? task.data?.resourceId ?? '';
  const startAt = toInstant(start, tz);
  const endAt = toInstant(end, tz);
  const problems = [
    !areaId ? 'Choose the affected area from the inventory.' : null,
    !kind ? 'Choose the kind of restriction.' : null,
    !reason.trim() ? 'Enter the reason.' : null,
    !mode ? 'Choose what happens to events already booked.' : null,
    startAt.ok && endAt.ok && startAt.instant >= endAt.instant
      ? 'The end must be after the start.'
      : null,
  ].filter((p): p is string => p !== null);
  const [lastApprove, setLastApprove] = useState(true);
  const submit = (approve: boolean) => {
    setAttempted(true);
    setLastApprove(approve);
    if (problems.length > 0 || !startAt.ok || !endAt.ok || !kind || !mode) return;
    void create
      .submit({
        body: {
          facilityId: facility.id,
          resourceId: areaId,
          ...(taskId && task.data ? { taskId } : {}),
          kind,
          interval: { start: startAt.instant, end: endAt.instant },
          reason: reason.trim(),
          approve,
          resolutionMode: mode,
        },
      })
      .then((r) => navigate(`/facilities/restrictions/${r.id}`))
      .catch(() => undefined);
  };
  return (
    <section aria-labelledby="apply-restriction-title" className="form">
      <h4 id="apply-restriction-title">Apply an operating restriction</h4>
      {taskId ? (
        task.data ? (
          <p>
            For the maintenance task:{' '}
            <Link to={`/facilities/maintenance/tasks/${taskId}`}>{task.data.issue}</Link>
          </p>
        ) : task.error ? (
          <p className="caption">
            The linked task is not available ({task.error.code}); the restriction will not be
            linked.
          </p>
        ) : null
      ) : null}
      <ResourceChecklist
        legend="Affected area"
        single
        resources={resources.data ?? []}
        value={area.length ? area : areaId ? [areaId] : []}
        onChange={setArea}
        error={attempted && !areaId ? 'Choose the affected area from the inventory.' : null}
      />
      <p className="caption">
        A whole pitch also blocks every subdivision. A subdivision blocks only itself, so the other
        half stays bookable, while a whole-pitch booking is refused.
      </p>
      <fieldset>
        <legend>Kind</legend>
        <label>
          <input
            type="radio"
            name="restriction-kind"
            checked={kind === 'closed'}
            onChange={() => setKind('closed')}
          />{' '}
          closed
        </label>
        <label>
          <input
            type="radio"
            name="restriction-kind"
            checked={kind === 'limited'}
            onChange={() => setKind('limited')}
          />{' '}
          limited (partial-use rules are not decided yet, so it currently closes the area like
          closed)
        </label>
      </fieldset>
      <LocalDateTimeField
        label="From"
        value={start}
        onChange={setStart}
        timeZone={tz}
        showErrors={attempted}
      />
      <LocalDateTimeField
        label="Until"
        value={end}
        onChange={setEnd}
        timeZone={tz}
        showErrors={attempted}
      />
      <label htmlFor="restriction-reason">Reason</label>
      <input
        id="restriction-reason"
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
      />
      <fieldset>
        <legend>Events already booked in the area</legend>
        <label>
          <input
            type="radio"
            name="restriction-mode"
            checked={mode === 'cancel_affected'}
            onChange={() => setMode('cancel_affected')}
          />{' '}
          Cancel them when the restriction takes effect (each sends a cancellation notice)
        </label>
        <label>
          <input
            type="radio"
            name="restriction-mode"
            checked={mode === 'leave_for_resolution'}
            onChange={() => setMode('leave_for_resolution')}
          />{' '}
          Leave them for resolution on Closures
        </label>
      </fieldset>
      <StateView
        variant="pending-decision"
        subject="The restriction approval rule (who may approve, and whether a second approver is needed)"
        decisions={['DEC-001']}
        owner="Operations"
      />
      {attempted && problems.length > 0 ? (
        <ul className="field-issues" aria-label="Problems to correct">
          {problems.map((p) => (
            <li key={p} className="error-text">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="field-row">
        <Button
          busy={create.isProcessing && lastApprove}
          disabled={!online || create.isProcessing}
          onClick={() => submit(true)}
        >
          Propose and approve now
        </Button>
        <Button
          variant="secondary"
          busy={create.isProcessing && !lastApprove}
          disabled={!online || create.isProcessing}
          onClick={() => submit(false)}
        >
          Propose for approval
        </Button>
      </span>
      {!online ? <p className="caption">Applying a restriction needs a connection.</p> : null}
      {create.error ? (
        <CommandError
          error={create.error}
          onRetry={() => submit(lastApprove)}
          action="Applying the restriction"
        />
      ) : null}
    </section>
  );
}

function RestrictionList({ facility }: { facility: FacilityContext }) {
  const [status, setStatus] = useState<'' | RestrictionStatus>('');
  const restrictions = useApiQuery({
    path: '/maintenance-restrictions',
    request: { query: { facilityId: facility.id, ...(status ? { status } : {}) } },
  });
  const { resourceNames } = useFacilityNames(facility.id);
  return (
    <section aria-labelledby="restrictions-list-title">
      <h4 id="restrictions-list-title">Restrictions</h4>
      <label>
        Show{' '}
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | RestrictionStatus)}
        >
          <option value="">All</option>
          {(Object.keys(RESTRICTION_BADGE) as RestrictionStatus[]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <QueryBoundary
        query={restrictions}
        label="restrictions"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No restrictions',
          description: 'Restrictions that block a pitch or subdivision appear here.',
        }}
        unavailableOffline={['applying, approving or releasing restrictions']}
      >
        {(list) => (
          <ul className="list" aria-label="Restrictions">
            {[...list]
              .sort((a, b) => b.interval.start.localeCompare(a.interval.start))
              .map((r) => (
                <li key={r.id}>
                  <div className="row-text">
                    <Link className="row-title" to={`/facilities/restrictions/${r.id}`}>
                      {resourceNames.get(r.resourceId) ?? 'An area'}: {r.reason}
                    </Link>
                    <span className="caption">
                      {r.kind} · {formatRange(r.interval.start, r.interval.end, facility.timezone)}
                      {r.taskId ? ' · linked to a maintenance task' : ''}
                      {r.status === 'withdrawn' && r.withdrawalReason
                        ? ` · withdrawn: ${r.withdrawalReason}`
                        : ''}
                    </span>
                  </div>
                  <StatusBadge
                    tone={RESTRICTION_BADGE[r.status].tone}
                    label={RESTRICTION_BADGE[r.status].label}
                  />
                </li>
              ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

export function RestrictionsScreen() {
  return (
    <section aria-labelledby="restrictions-title">
      <h3 id="restrictions-title">Operating restrictions and release to service</h3>
      <FacilityGate purpose="see its operating restrictions">
        {(facility) => (
          <>
            <ZoneCaption facility={facility} />
            <OperatingStatusNow facility={facility} />
            <RestrictionList facility={facility} />
            <ActionGate
              action="facilities.apply_restriction"
              facilityId={facility.id}
              what="Applying operating restrictions"
            >
              <ApplyRestrictionForm facility={facility} />
            </ActionGate>
          </>
        )}
      </FacilityGate>
    </section>
  );
}
