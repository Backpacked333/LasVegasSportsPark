/**
 * SCR-S-42 restriction and release to service (SPK-FAC-003, SPK-FAC-004, SPK-SCHED-009,
 * SPK-AT-021). One restriction (`GET /v1/maintenance-restrictions/{id}`) with its affected area and
 * what it blocks, approval and release facts, its maintenance task's inspection gate, its scheduling
 * closure and the events still awaiting resolution, and the last approve or release operation.
 *
 * - Approve a proposed restriction, or resume an approved one whose activation did not complete
 *   (`POST .../approve`, `expectedRevision`); both make it effective through the scheduling
 *   authority.
 * - Release (`POST .../release`, a reason is required): an authorized return to service that lifts
 *   the closure. When the task requires an inspection, the latest one must have passed; the API
 *   refuses otherwise (ELIGIBILITY_FAILED `inspection_required`) and the screen says what is missing.
 *   An inspection recorded concurrently surfaces as STALE_REVISION with "Reload".
 * - Withdraw a proposed restriction, or an approved one whose closure is still pending
 *   (`POST .../withdraw`, a reason is required, `expectedRevision`; FAC-01, SPK-FAC-004): it never
 *   took effect, and its pending scheduling closure is withdrawn with it in the same command. An
 *   active restriction is released instead; the API answers INVALID_TRANSITION and the screen
 *   says so.
 * - Recovery required: affected events of the closure that are still unresolved link to SCR-S-06.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import { inspectionRequired } from '../../features/schedule-facilities/error-details';
import { ActionGate } from '../../features/schedule-facilities/permission';
import {
  useFacilityById,
  ZoneCaption,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { OPERATION_BADGE, RESTRICTION_BADGE } from '../../features/schedule-facilities/labels';
import { formatInstant, formatRange } from '../../features/schedule-facilities/time';
import { useFacilityNames } from './maintenance-shared';
import { RESTRICTION_INVALIDATES } from './RestrictionsScreen';

type Restriction = Schema<'Restriction'>;
type ResolutionMode = 'cancel_affected' | 'leave_for_resolution';

function OperationLine({ id }: { id: string }) {
  const op = useApiQuery({ path: '/operations/{id}', request: { path: { id } } });
  if (!op.data) {
    if (op.error) {
      return (
        <p className="caption">
          Last approve, release or withdrawal: operation status not available ({op.error.code}).{' '}
          <Button variant="secondary" onClick={() => void op.refetch()}>
            Try again
          </Button>
        </p>
      );
    }
    return <StateView variant="loading" label="the last operation" />;
  }
  const badge = OPERATION_BADGE[op.data.status];
  return (
    <p>
      Last approve, release or withdrawal: <StatusBadge tone={badge.tone} label={badge.label} />
      {op.data.error ? (
        <span className="caption">
          {' '}
          {op.data.error.code}: {op.data.error.message}
        </span>
      ) : null}
    </p>
  );
}

function InspectionGate({ taskId, facility }: { taskId: string; facility: FacilityContext }) {
  const task = useApiQuery({ path: '/maintenance-tasks/{id}', request: { path: { id: taskId } } });
  if (task.error) {
    return (
      <p className="caption">The linked maintenance task is not available ({task.error.code}).</p>
    );
  }
  if (!task.data) return null;
  const t = task.data;
  const latest = t.latestInspection;
  return (
    <section aria-labelledby="gate-title">
      <h4 id="gate-title">Inspection before release</h4>
      <p>
        Task: <Link to={`/facilities/maintenance/tasks/${t.id}`}>{t.issue}</Link> (status {t.status}
        )
      </p>
      {t.requiresInspection ? (
        latest?.outcome === 'passed' ? (
          <StatusBadge
            tone="success"
            label={`Inspection passed ${formatInstant(latest.inspectedAt, facility.timezone)}`}
          />
        ) : (
          <>
            <StatusBadge
              tone="warning"
              label={
                latest
                  ? `Last inspection failed ${formatInstant(latest.inspectedAt, facility.timezone)}`
                  : 'No inspection recorded'
              }
            />
            <p>A passed inspection is required before this area returns to service.</p>
          </>
        )
      ) : (
        <p>This task does not require an inspection.</p>
      )}
      {t.status === 'closed' ? (
        <p className="caption">
          The task is closed; that alone does not return the area to service.
        </p>
      ) : null}
    </section>
  );
}

function ClosureFollowUp({ closureId }: { closureId: string }) {
  const closure = useApiQuery({ path: '/closures/{id}', request: { path: { id: closureId } } });
  if (!closure.data) {
    // SPK-UX-008: the recovery state never disappears silently when the closure cannot be read.
    return (
      <section aria-labelledby="closure-follow-up">
        <h4 id="closure-follow-up">Booking impact</h4>
        {closure.error ? (
          closure.error.isNotFound || closure.error.isPermissionRestriction ? (
            <StateView
              variant="unavailable"
              description="Booking impact could not be loaded; open Closures to check for events awaiting resolution."
            />
          ) : (
            <StateView
              variant="error"
              error={closure.error}
              onRetry={() => void closure.refetch()}
            />
          )
        ) : (
          <StateView variant="loading" label="the booking impact" />
        )}
        <Link to={`/schedule/closures/${closureId}`}>Open the closure</Link>
      </section>
    );
  }
  const unresolved = closure.data.resolution?.unresolvedEventIds.length ?? 0;
  return (
    <section aria-labelledby="closure-follow-up">
      <h4 id="closure-follow-up">Booking impact</h4>
      {unresolved > 0 ? (
        <div className="banner" role="status">
          <StatusBadge
            tone="danger"
            label="Recovery required: closure impact resolution still open"
          />
          <span>
            {unresolved} affected event{unresolved === 1 ? '' : 's'} still need
            {unresolved === 1 ? 's' : ''} a resolution.
          </span>
          <Link to={`/schedule/closures/${closureId}`}>Resolve on Closures</Link>
        </div>
      ) : (
        <p>
          {closure.data.impact?.affectedEvents.length ?? 0} event(s) were affected; none await
          resolution. <Link to={`/schedule/closures/${closureId}`}>Closure impact</Link>
        </p>
      )}
    </section>
  );
}

/** FAC-01 (SPK-FAC-004): withdraw a restriction that never took effect, with its reason. */
function WithdrawRestriction({
  restriction,
  onReload,
}: {
  restriction: Restriction;
  onReload: () => void;
}) {
  const { online } = useApp();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const withdraw = useApiCommand('post', '/maintenance-restrictions/{id}/withdraw', {
    invalidate: RESTRICTION_INVALIDATES,
  });
  const submit = () => {
    setAttempted(true);
    if (!reason.trim()) return;
    void withdraw
      .submit({
        path: { id: restriction.id },
        body: { reason: reason.trim(), expectedRevision: restriction.revision },
      })
      .catch(() => undefined);
  };
  const reload = () => {
    withdraw.reset();
    onReload();
  };
  return (
    <section aria-labelledby="withdraw-restriction-title">
      <h4 id="withdraw-restriction-title">Withdraw</h4>
      <p>
        Withdrawing ends this restriction before it takes effect
        {restriction.schedulingClosureId ? ', together with its planned closure' : ''}. The area
        stays bookable and the restriction is kept for history.
      </p>
      <label htmlFor="withdraw-restriction-reason">Reason for withdrawing</label>
      <input
        id="withdraw-restriction-reason"
        value={reason}
        maxLength={2000}
        aria-invalid={attempted && !reason.trim() ? true : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {attempted && !reason.trim() ? (
        <span className="error-text" role="alert">
          Enter the reason for withdrawing the restriction.
        </span>
      ) : null}
      <Button variant="secondary" busy={withdraw.isProcessing} disabled={!online} onClick={submit}>
        Withdraw restriction
      </Button>
      {!online ? <p className="caption">Withdrawing needs a connection.</p> : null}
      {withdraw.error?.code === 'INVALID_TRANSITION' ? (
        <div role="alert" className="banner" data-testid="withdraw-took-effect">
          <StatusBadge tone="warning" label="Already in effect: release it instead" />
          <span>
            The restriction or its closure has already taken effect, so it can no longer be
            withdrawn. Reload to see its current state; the area returns to service by an authorized
            release.
          </span>
          <Button variant="secondary" onClick={reload}>
            Reload
          </Button>
        </div>
      ) : withdraw.error ? (
        <CommandError
          error={withdraw.error}
          onRetry={submit}
          onReload={reload}
          action="Withdrawing the restriction"
        />
      ) : null}
    </section>
  );
}

function Actions({ restriction }: { restriction: Restriction }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'' | ResolutionMode>('');
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const approve = useApiCommand('post', '/maintenance-restrictions/{id}/approve', {
    invalidate: RESTRICTION_INVALIDATES,
  });
  const release = useApiCommand('post', '/maintenance-restrictions/{id}/release', {
    invalidate: RESTRICTION_INVALIDATES,
  });
  const reload = () => {
    approve.reset();
    release.reset();
    void queryClient.invalidateQueries({ queryKey: ['api', '/maintenance-restrictions/{id}'] });
    void queryClient.invalidateQueries({ queryKey: ['api', '/maintenance-tasks/{id}'] });
  };
  const runApprove = () => {
    setAttempted(true);
    if (restriction.status === 'proposed' && !mode) return;
    void approve
      .submit({
        path: { id: restriction.id },
        body: { expectedRevision: restriction.revision, ...(mode ? { resolutionMode: mode } : {}) },
      })
      .catch(() => undefined);
  };
  const runRelease = () => {
    setAttempted(true);
    if (!reason.trim()) return;
    void release
      .submit({
        path: { id: restriction.id },
        body: { expectedRevision: restriction.revision, reason: reason.trim() },
      })
      .catch(() => undefined);
  };
  const gate = inspectionRequired(release.error);

  if (restriction.status === 'released') {
    return <p>This area was returned to service; the restriction is kept for history.</p>;
  }
  if (restriction.status === 'withdrawn') {
    return (
      <p data-testid="restriction-withdrawn">
        This restriction was withdrawn before it took effect; the area was never restricted by it.
        It is kept for history.
      </p>
    );
  }
  if (restriction.status === 'proposed' || restriction.status === 'approved') {
    return (
      <>
        <section aria-labelledby="approve-title">
          <h4 id="approve-title">
            {restriction.status === 'proposed' ? 'Approve' : 'Activation not complete'}
          </h4>
          {restriction.status === 'approved' ? (
            <p>
              The restriction was approved but is not yet effective on the schedule. Resuming makes
              it effective; it does not create a second closure.
            </p>
          ) : null}
          <fieldset>
            <legend>Events already booked in the area</legend>
            <label>
              <input
                type="radio"
                name="approve-mode"
                checked={mode === 'cancel_affected'}
                onChange={() => setMode('cancel_affected')}
              />{' '}
              Cancel them (each sends a cancellation notice)
            </label>
            <label>
              <input
                type="radio"
                name="approve-mode"
                checked={mode === 'leave_for_resolution'}
                onChange={() => setMode('leave_for_resolution')}
              />{' '}
              Leave them for resolution on Closures
            </label>
          </fieldset>
          {attempted && restriction.status === 'proposed' && !mode ? (
            <span className="error-text" role="alert">
              Choose what happens to events already booked.
            </span>
          ) : null}
          <Button busy={approve.isProcessing} disabled={!online} onClick={runApprove}>
            {restriction.status === 'proposed' ? 'Approve and make effective' : 'Resume activation'}
          </Button>
          {approve.error ? (
            <CommandError
              error={approve.error}
              onRetry={runApprove}
              onReload={reload}
              action="Approving the restriction"
            />
          ) : null}
        </section>
        <WithdrawRestriction restriction={restriction} onReload={reload} />
      </>
    );
  }
  return (
    <section aria-labelledby="release-title">
      <h4 id="release-title">Release to service</h4>
      <p>
        Releasing lifts the closure so the area can be booked again. It needs release authority and,
        when the task requires one, a passed inspection.
      </p>
      <label htmlFor="release-reason">Reason for the release</label>
      <input
        id="release-reason"
        value={reason}
        maxLength={2000}
        aria-invalid={attempted && !reason.trim() ? true : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {attempted && !reason.trim() ? (
        <span className="error-text" role="alert">
          Enter the reason for the release.
        </span>
      ) : null}
      <Button busy={release.isProcessing} disabled={!online} onClick={runRelease}>
        Release to service
      </Button>
      {!online ? <p className="caption">Releasing needs a connection.</p> : null}
      {gate ? (
        <div role="alert" className="banner" data-testid="inspection-required">
          <StatusBadge tone="danger" label="Release refused: a passed inspection is required" />
          <span>
            {gate.latestOutcome
              ? `The latest inspection ${gate.latestOutcome}.`
              : 'No inspection has been recorded for the task.'}{' '}
            Record a passed inspection on the task, then release.
          </span>
          {restriction.taskId ? (
            <Link to={`/facilities/maintenance/tasks/${restriction.taskId}`}>Open the task</Link>
          ) : null}
        </div>
      ) : null}
      {release.error && !gate ? (
        <CommandError
          error={release.error}
          onRetry={runRelease}
          onReload={reload}
          action="Releasing to service"
        />
      ) : null}
    </section>
  );
}

function RestrictionView({
  restriction,
  facility,
}: {
  restriction: Restriction;
  facility: FacilityContext;
}) {
  const tz = facility.timezone;
  const { resources, resourceNames, assetNames } = useFacilityNames(restriction.facilityId);
  const area = resources.data?.find((r) => r.id === restriction.resourceId);
  const subdivisions = (resources.data ?? []).filter(
    (r) => r.parentResourceId === restriction.resourceId,
  );
  const badge = RESTRICTION_BADGE[restriction.status];
  return (
    <div>
      <ZoneCaption facility={facility} />
      <p>
        <strong>
          {resourceNames.get(restriction.resourceId) ?? 'An area'}: {restriction.reason}
        </strong>{' '}
        <StatusBadge tone={badge.tone} label={badge.label} />
      </p>
      <dl className="facts">
        <dt>Affected area</dt>
        <dd>
          {area
            ? area.kind === 'subdivision'
              ? `${area.name}, a subdivision: only this part is blocked, plus any booking of its whole pitch`
              : subdivisions.length > 0
                ? `${area.name}, the whole space: its subdivisions (${subdivisions.map((s) => s.name).join(', ')}) are blocked too`
                : area.name
            : 'Not in the current inventory'}
        </dd>
        {restriction.assetId ? (
          <>
            <dt>Asset</dt>
            <dd>{assetNames.get(restriction.assetId) ?? 'An asset'}</dd>
          </>
        ) : null}
        <dt>Kind</dt>
        <dd>{restriction.kind}</dd>
        <dt>When</dt>
        <dd>{formatRange(restriction.interval.start, restriction.interval.end, tz)}</dd>
        <dt>Blocked conflict units</dt>
        <dd>
          {restriction.status === 'active' || restriction.status === 'released'
            ? restriction.affectedConflictUnitIds.length
            : restriction.status === 'withdrawn'
              ? 'none: it never took effect'
              : 'set when it takes effect'}
        </dd>
        <dt>Approved</dt>
        <dd>
          {restriction.approvedAt
            ? `${formatInstant(restriction.approvedAt, tz)} by ${restriction.approvedBy?.actorLabel || 'staff'}`
            : 'Not yet'}
        </dd>
        <dt>Released</dt>
        <dd>
          {restriction.releasedAt
            ? `${formatInstant(restriction.releasedAt, tz)} by ${restriction.releasedBy?.actorLabel || 'staff'}: ${restriction.releaseReason ?? ''}`
            : 'Not yet'}
        </dd>
        {restriction.withdrawnAt ? (
          <>
            <dt>Withdrawn</dt>
            <dd>
              {`${formatInstant(restriction.withdrawnAt, tz)} by ${restriction.withdrawnBy?.actorLabel || 'staff'}: ${restriction.withdrawalReason ?? ''}`}
            </dd>
          </>
        ) : null}
      </dl>
      {restriction.operationId ? <OperationLine id={restriction.operationId} /> : null}
      {restriction.taskId ? (
        <InspectionGate taskId={restriction.taskId} facility={facility} />
      ) : null}
      {restriction.schedulingClosureId ? (
        <ClosureFollowUp closureId={restriction.schedulingClosureId} />
      ) : null}
      {restriction.status === 'proposed' || restriction.status === 'approved' ? (
        <ActionGate
          action="facilities.apply_restriction"
          facilityId={restriction.facilityId}
          what="Approving or withdrawing restrictions"
        >
          <Actions key={restriction.revision} restriction={restriction} />
        </ActionGate>
      ) : restriction.status === 'active' ? (
        <ActionGate
          action="facilities.release_to_service"
          facilityId={restriction.facilityId}
          what="Releasing areas to service"
        >
          <Actions key={restriction.revision} restriction={restriction} />
        </ActionGate>
      ) : (
        <Actions key={restriction.revision} restriction={restriction} />
      )}
    </div>
  );
}

export function RestrictionDetailScreen() {
  const { restrictionId = '' } = useParams();
  const restriction = useApiQuery({
    path: '/maintenance-restrictions/{id}',
    request: { path: { id: restrictionId } },
  });
  const facility = useFacilityById(restriction.data?.facilityId);
  return (
    <section aria-labelledby="restriction-title">
      <h3 id="restriction-title">Operating restriction</h3>
      <Link to="/facilities/restrictions">All restrictions</Link>
      <QueryBoundary
        query={restriction}
        label="the restriction"
        empty={{ title: '', description: '' }}
        unavailableOffline={['approving or releasing the restriction']}
      >
        {(data) =>
          facility ? (
            <RestrictionView restriction={data} facility={facility} />
          ) : (
            <StateView variant="loading" label="the facility" />
          )
        }
      </QueryBoundary>
    </section>
  );
}
