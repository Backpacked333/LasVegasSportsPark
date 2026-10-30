/**
 * SCR-S-41 maintenance task (SPK-FAC-002, SPK-FAC-004). One task with its asset or space, issue,
 * severity, reporter, evidence, owner, due date, operating restrictions, resolution and inspections
 * (`GET /v1/maintenance-tasks/{id}`, `/inspections`, `GET /v1/maintenance-restrictions?taskId=`).
 *
 * Commands, each with the task's `expectedRevision` and an idempotency key per intent:
 * assign to me, to a staff member chosen from the staff directory (`GET /v1/staff-directory`), or
 * unassign, start work, resolve or close (a resolution summary is required), reopen,
 * edit severity, due date, inspection requirement and evidence (`PATCH /v1/maintenance-tasks/{id}`),
 * and record an inspection (`POST .../inspections`). The lifecycle offered follows the task's state
 * (open → assigned → in_progress → resolved → closed); whether the viewer may do it is the API's
 * answer (ACCESS_DENIED names the missing permission). Closing a task never returns its area to
 * service: unreleased restrictions are listed with the release they still need (SPK-FAC-004).
 * The owner's name comes from `GET /v1/person-names` (names only).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import { useCommandReload } from '../../features/schedule-facilities/reload';
import {
  ActionGate,
  NotAvailableToYou,
  useActionAllowed,
} from '../../features/schedule-facilities/permission';
import {
  useFacilityById,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import {
  RESTRICTION_BADGE,
  SEVERITY_BADGE,
  TASK_BADGE,
} from '../../features/schedule-facilities/labels';
import {
  LocalDateTimeField,
  emptyLocal,
  localFromInstant,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import {
  OwnerPicker,
  ownerLabel,
  useOwnerNames,
} from '../../features/schedule-facilities/staff-owner';
import { formatInstant, formatRange } from '../../features/schedule-facilities/time';
import {
  EvidenceEditor,
  RESTRICTIONS_KEY,
  TASKS_KEY,
  TASK_KEY,
  evidenceInput,
  useFacilityNames,
  useMyPersonId,
  whereLabel,
  type EvidenceDraft,
} from './maintenance-shared';
import { isOverdue } from './MaintenanceScreen';

type Task = Schema<'MaintenanceTask'>;
type Severity = Task['severity'];
type UpdateBody = Schema<'UpdateMaintenanceTaskBody'>;

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

function Lifecycle({ task, me }: { task: Task; me: string | null }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState('');
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  const [attempted, setAttempted] = useState<'resolved' | 'closed' | null>(null);
  const update = useApiCommand('patch', '/maintenance-tasks/{id}', {
    invalidate: [TASKS_KEY, TASK_KEY, RESTRICTIONS_KEY],
  });
  const [last, setLast] = useState<Omit<UpdateBody, 'expectedRevision'> | null>(null);
  const [owner, setOwner] = useState('');
  const [ownerAttempted, setOwnerAttempted] = useState(false);
  const send = (body: Omit<UpdateBody, 'expectedRevision'>) => {
    setLast(body);
    void update
      .submit({ path: { id: task.id }, body: { ...body, expectedRevision: task.revision } })
      .then(() => {
        setSummary('');
        setEvidence([]);
        setAttempted(null);
      })
      .catch(() => undefined);
  };
  const finish = (status: 'resolved' | 'closed') => {
    setAttempted(status);
    const hasResolution = summary.trim() !== '' || task.resolution !== null;
    if (!hasResolution) return;
    send({
      status,
      ...(summary.trim()
        ? {
            resolution: {
              summary: summary.trim(),
              ...(evidenceInput(evidence).length ? { evidence: evidenceInput(evidence) } : {}),
            },
          }
        : {}),
    });
  };
  const reload = () => {
    update.reset();
    void queryClient.invalidateQueries({ queryKey: TASK_KEY });
  };
  if (task.status === 'closed') {
    return <p>This task is closed. Report a new issue if the problem returns.</p>;
  }
  const s = task.status;
  const canResolve = s === 'open' || s === 'assigned' || s === 'in_progress';
  const disabled = !online || update.isProcessing;
  return (
    <section aria-labelledby="lifecycle-title">
      <h4 id="lifecycle-title">Work on this task</h4>
      <div className="field-row">
        {me && task.assignedOwnerPersonId !== me ? (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => send({ assignedOwnerPersonId: me })}
          >
            Assign to me
          </Button>
        ) : null}
        {task.assignedOwnerPersonId !== null && (s === 'assigned' || s === 'in_progress') ? (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => send({ assignedOwnerPersonId: null })}
          >
            Unassign
          </Button>
        ) : null}
        {s === 'open' || s === 'assigned' ? (
          <Button disabled={disabled} onClick={() => send({ status: 'in_progress' })}>
            Start work
          </Button>
        ) : null}
        {s === 'resolved' ? (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => send({ status: 'in_progress' })}
          >
            Reopen
          </Button>
        ) : null}
      </div>
      <OwnerPicker
        facilityId={task.facilityId}
        value={owner}
        onChange={setOwner}
        disabled={disabled}
        label="Assign to"
      />
      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() => {
          setOwnerAttempted(true);
          if (owner && owner !== task.assignedOwnerPersonId) send({ assignedOwnerPersonId: owner });
        }}
      >
        Assign to the chosen staff member
      </Button>
      {ownerAttempted && (!owner || owner === task.assignedOwnerPersonId) ? (
        <span className="error-text" role="alert">
          {owner ? 'This person already owns the task.' : 'Choose a staff member to assign.'}
        </span>
      ) : null}
      <label htmlFor="task-resolution">
        Resolution summary{task.resolution ? ' (replaces the recorded one)' : ''}
      </label>
      <textarea
        id="task-resolution"
        rows={3}
        value={summary}
        maxLength={4000}
        aria-invalid={attempted && !summary.trim() && !task.resolution ? true : undefined}
        onChange={(e) => setSummary(e.target.value)}
      />
      <EvidenceEditor value={evidence} onChange={setEvidence} idPrefix="resolution-evidence" />
      {attempted && !summary.trim() && !task.resolution ? (
        <span className="error-text" role="alert">
          A resolution summary is required to {attempted === 'resolved' ? 'resolve' : 'close'} the
          task.
        </span>
      ) : null}
      <div className="field-row">
        {canResolve ? (
          <Button disabled={disabled} onClick={() => finish('resolved')}>
            Mark resolved
          </Button>
        ) : null}
        <Button variant="secondary" disabled={disabled} onClick={() => finish('closed')}>
          Close task
        </Button>
      </div>
      {task.openRestrictionIds.length > 0 ? (
        <p className="caption">
          Closing does not return the area to service: {task.openRestrictionIds.length} restriction
          {task.openRestrictionIds.length === 1 ? '' : 's'} still need
          {task.openRestrictionIds.length === 1 ? 's' : ''} an authorized release.
        </p>
      ) : null}
      {update.error ? (
        <CommandError
          error={update.error}
          onRetry={last ? () => send(last) : undefined}
          onReload={reload}
          action="Updating the task"
        />
      ) : null}
    </section>
  );
}

function Details({ task, facility }: { task: Task; facility: FacilityContext }) {
  const { online } = useApp();
  const [severity, setSeverity] = useState<Severity>(task.severity);
  const [due, setDue] = useState<LocalDateTime>(
    task.dueAt ? localFromInstant(task.dueAt, facility.timezone) : emptyLocal(),
  );
  const [inspection, setInspection] = useState(task.requiresInspection);
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  const update = useApiCommand('patch', '/maintenance-tasks/{id}', {
    invalidate: [TASKS_KEY, TASK_KEY],
  });
  const reload = useCommandReload(update.reset, [TASK_KEY]);
  const dueAt = due.date || due.time ? toInstant(due, facility.timezone) : null;
  const submit = () => {
    if (dueAt && !dueAt.ok) return;
    void update
      .submit({
        path: { id: task.id },
        body: {
          expectedRevision: task.revision,
          ...(severity !== task.severity ? { severity } : {}),
          ...(dueAt?.ok
            ? dueAt.instant !== task.dueAt
              ? { dueAt: dueAt.instant }
              : {}
            : task.dueAt
              ? { dueAt: null }
              : {}),
          ...(inspection !== task.requiresInspection ? { requiresInspection: inspection } : {}),
          ...(evidenceInput(evidence).length ? { evidence: evidenceInput(evidence) } : {}),
        },
      })
      .then(() => setEvidence([]))
      .catch(() => undefined);
  };
  if (task.status === 'closed') return null;
  return (
    <section aria-labelledby="details-title">
      <h4 id="details-title">Edit details</h4>
      <fieldset>
        <legend>Severity</legend>
        {SEVERITIES.map((s) => (
          <label key={s}>
            <input
              type="radio"
              name="edit-severity"
              checked={severity === s}
              onChange={() => setSeverity(s)}
            />{' '}
            {s}
          </label>
        ))}
      </fieldset>
      <LocalDateTimeField label="Due" value={due} onChange={setDue} timeZone={facility.timezone} />
      <label>
        <input
          type="checkbox"
          checked={inspection}
          onChange={(e) => setInspection(e.target.checked)}
        />{' '}
        An inspection is required before the area returns to service
      </label>
      <EvidenceEditor value={evidence} onChange={setEvidence} idPrefix="edit-evidence" />
      <Button
        busy={update.isProcessing}
        disabled={!online || (dueAt !== null && !dueAt.ok)}
        onClick={submit}
      >
        Save details
      </Button>
      {update.error ? (
        <CommandError
          error={update.error}
          onRetry={submit}
          onReload={reload}
          action="Saving the task"
        />
      ) : null}
    </section>
  );
}

function Inspections({ task, facility }: { task: Task; facility: FacilityContext }) {
  const canRecord = useActionAllowed('facilities.record_inspection', task.facilityId);
  const { online } = useApp();
  const inspections = useApiQuery({
    path: '/maintenance-tasks/{id}/inspections',
    request: { path: { id: task.id } },
  });
  const [outcome, setOutcome] = useState<'' | 'passed' | 'failed'>('');
  const [notes, setNotes] = useState('');
  const [attempted, setAttempted] = useState(false);
  const record = useApiCommand('post', '/maintenance-tasks/{id}/inspections', {
    invalidate: [TASKS_KEY, TASK_KEY, ['api', '/maintenance-tasks/{id}/inspections']],
  });
  const reload = useCommandReload(record.reset, [
    TASK_KEY,
    ['api', '/maintenance-tasks/{id}/inspections'],
  ]);
  const submit = () => {
    setAttempted(true);
    if (!outcome) return;
    void record
      .submit({
        path: { id: task.id },
        body: {
          outcome,
          expectedRevision: task.revision,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      })
      .then(() => {
        setOutcome('');
        setNotes('');
        setAttempted(false);
      })
      .catch(() => undefined);
  };
  return (
    <section aria-labelledby="inspections-title">
      <h4 id="inspections-title">Inspections</h4>
      <p>
        {task.requiresInspection
          ? task.latestInspection?.outcome === 'passed'
            ? 'An inspection is required and the latest one passed.'
            : 'An inspection is required: the area cannot be released until one passes.'
          : 'No inspection is required for this task.'}
      </p>
      <QueryBoundary
        query={inspections}
        label="inspections"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No inspections recorded',
          description: 'Recorded outcomes appear here, newest first.',
        }}
      >
        {(list) => (
          <ul className="list" aria-label="Inspections">
            {/* The OpenAPI component is declared nullable; null entries are not inspections. */}
            {list
              .filter((i): i is NonNullable<typeof i> => i !== null)
              .sort((a, b) => b.inspectedAt.localeCompare(a.inspectedAt))
              .map((i) => (
                <li key={i.id}>
                  <StatusBadge
                    tone={i.outcome === 'passed' ? 'success' : 'danger'}
                    label={`Inspection ${i.outcome}`}
                  />
                  <span className="caption">
                    {formatInstant(i.inspectedAt, facility.timezone)} by{' '}
                    {i.inspector.actorLabel || 'staff'}
                    {i.notes ? ` · ${i.notes}` : ''}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </QueryBoundary>
      {(task.status !== 'closed' || task.requiresInspection) && !canRecord ? (
        <NotAvailableToYou what="Recording inspections" action="facilities.record_inspection" />
      ) : task.status !== 'closed' || task.requiresInspection ? (
        <div className="form">
          <fieldset>
            <legend>Record an inspection</legend>
            <label>
              <input
                type="radio"
                name="inspection-outcome"
                checked={outcome === 'passed'}
                onChange={() => setOutcome('passed')}
              />{' '}
              Passed
            </label>
            <label>
              <input
                type="radio"
                name="inspection-outcome"
                checked={outcome === 'failed'}
                onChange={() => setOutcome('failed')}
              />{' '}
              Failed (a resolved task goes back to work)
            </label>
          </fieldset>
          {attempted && !outcome ? <span className="error-text">Choose the outcome.</span> : null}
          <label htmlFor="inspection-notes">Notes</label>
          <textarea
            id="inspection-notes"
            rows={2}
            value={notes}
            maxLength={4000}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Button busy={record.isProcessing} disabled={!online} onClick={submit}>
            Record inspection
          </Button>
          {record.error ? (
            <CommandError
              error={record.error}
              onRetry={submit}
              onReload={reload}
              action="Recording an inspection"
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TaskRestrictions({ task, facility }: { task: Task; facility: FacilityContext }) {
  const restrictions = useApiQuery({
    path: '/maintenance-restrictions',
    request: { query: { facilityId: task.facilityId, taskId: task.id } },
  });
  const { resourceNames } = useFacilityNames(task.facilityId);
  return (
    <section aria-labelledby="task-restrictions-title">
      <h4 id="task-restrictions-title">Operating restrictions</h4>
      <QueryBoundary
        query={restrictions}
        label="restrictions"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No restrictions',
          description: 'No operating restriction is linked to this task.',
        }}
      >
        {(list) => (
          <ul className="list" aria-label="Restrictions of this task">
            {list.map((r) => (
              <li key={r.id}>
                <div className="row-text">
                  <Link className="row-title" to={`/facilities/restrictions/${r.id}`}>
                    {resourceNames.get(r.resourceId) ?? 'An area'}: {r.reason}
                  </Link>
                  <span className="caption">
                    {formatRange(r.interval.start, r.interval.end, facility.timezone)}
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
      {task.status !== 'closed' && task.openRestrictionIds.length === 0 ? (
        <Link to={`/facilities/restrictions?taskId=${task.id}`}>
          Apply an operating restriction for this task
        </Link>
      ) : null}
    </section>
  );
}

function TaskView({ task, facility }: { task: Task; facility: FacilityContext }) {
  const now = useNow();
  const me = useMyPersonId();
  const { assetNames, resourceNames } = useFacilityNames(task.facilityId);
  const ownerNames = useOwnerNames([task.assignedOwnerPersonId], me);
  const sev = SEVERITY_BADGE[task.severity];
  const st = TASK_BADGE[task.status];
  return (
    <div>
      <p>
        <strong>{task.issue}</strong>
      </p>
      <p>
        <StatusBadge tone={sev.tone} label={sev.label} />{' '}
        <StatusBadge tone={st.tone} label={`Status: ${st.label}`} />
        {isOverdue(task, now) ? (
          <>
            {' '}
            <StatusBadge tone="danger" label="Overdue" />
          </>
        ) : null}
      </p>
      <dl className="facts">
        <dt>Asset or space</dt>
        <dd>{whereLabel(task, assetNames, resourceNames)}</dd>
        <dt>Reporter</dt>
        <dd>
          {task.reporter.actorLabel || 'staff'}, {formatInstant(task.reportedAt, facility.timezone)}
        </dd>
        <dt>Owner</dt>
        <dd data-testid="task-owner">{ownerLabel(task.assignedOwnerPersonId, me, ownerNames)}</dd>
        <dt>Due</dt>
        <dd>{task.dueAt ? formatInstant(task.dueAt, facility.timezone) : 'No due date'}</dd>
        <dt>Evidence</dt>
        <dd>
          {task.evidence.length === 0
            ? 'None'
            : task.evidence.map((e) => `${e.kind}: ${e.label ?? e.reference}`).join('; ')}
        </dd>
        <dt>Resolution</dt>
        <dd>
          {task.resolution
            ? `${task.resolution.summary}${task.resolvedAt ? ` (${formatInstant(task.resolvedAt, facility.timezone)})` : ''}`
            : 'Not resolved'}
        </dd>
        {task.preventiveScheduleId ? (
          <>
            <dt>Origin</dt>
            <dd>Preventive maintenance, occurrence {(task.occurrenceIndex ?? 0) + 1}</dd>
          </>
        ) : null}
      </dl>
      <ActionGate
        action="facilities.manage_maintenance_task"
        facilityId={task.facilityId}
        what="Assigning, updating, resolving or closing maintenance tasks"
      >
        <Lifecycle key={`l-${task.revision}`} task={task} me={me} />
        <Details key={`d-${task.revision}`} task={task} facility={facility} />
      </ActionGate>
      <Inspections task={task} facility={facility} />
      <TaskRestrictions task={task} facility={facility} />
    </div>
  );
}

export function MaintenanceTaskScreen() {
  const { taskId = '' } = useParams();
  const task = useApiQuery({ path: '/maintenance-tasks/{id}', request: { path: { id: taskId } } });
  const facility = useFacilityById(task.data?.facilityId);
  return (
    <section aria-labelledby="task-title">
      <h3 id="task-title">Maintenance task</h3>
      <Link to="/facilities/maintenance">All tasks</Link>
      <QueryBoundary
        query={task}
        label="the task"
        empty={{ title: '', description: '' }}
        unavailableOffline={['updating the task or recording inspections']}
      >
        {(data) =>
          facility ? (
            <TaskView task={data} facility={facility} />
          ) : (
            <StateView variant="loading" label="the facility" />
          )
        }
      </QueryBoundary>
    </section>
  );
}
