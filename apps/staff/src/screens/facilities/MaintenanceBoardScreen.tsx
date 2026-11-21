/**
 * Maintenance tasks board (staff redesign Phase 8 item 8, desk tablet 1180; SPK-FAC-002 tasks,
 * SPK-FAC-003 restrictions close the area through scheduling, SPK-UX-006). Three columns, To do
 * (open, assigned), Doing (in progress) and Done (resolved or closed in the last week), over
 * `GET /v1/maintenance-tasks`. Each card carries the photo (when the task's evidence names an image
 * by link), the field, the bookings it affects for the rest of today (`GET /v1/events` on that
 * pitch and its halves) and the assignee.
 *
 * - "Assign to me", "Start" and "Done" (`PATCH /v1/maintenance-tasks/{id}` with the revision,
 *   facilities.manage_maintenance_task) move the card at once with a 5 s Undo; the command goes when
 *   the Undo window closes (a task cannot step back through its machine). A failure brings the
 *   card back and says so.
 * - "Close field" (facilities.apply_restriction) lists the affected bookings first: each can be
 *   moved on the schedule's day timeline (the S 3e move, with its clash checks and Notify) or
 *   cancelled together with the S 3b dialog (CancelGamesDialog: its 2-minute Undo and the
 *   families' message). Then `POST /v1/maintenance-restrictions` closes the pitch for the chosen
 *   time, linked to the task; booked events are left for staff to resolve, never moved silently.
 * - The photo upload is Proposed: evidence is kept by reference only (no upload in the API).
 * Offline the board reads from cache and the commands are disabled with their reason.
 */
import type { Schema } from '@sportspark/api-client';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { usePersonName } from '../../api/person-names';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import {
  FacilityGate,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { localDayToInstant, nextDay } from '../../features/registration-finance/format';
import { useApp, useNow } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { StatusBadge, type HandoffTone } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import { CrewHero, ProposedTag, clockOf } from '../crew/crew-ui';
import { CancelGamesDialog } from '../today/CancelGamesDialog';
import { pitchOf } from '../today/field-readiness';
import type { ResourceStatus, ScheduledEvent } from '../today/today-model';
import '../crew/crew.css';

type Task = Schema<'MaintenanceTask'>;
type Column = 'todo' | 'doing' | 'done';

const TASKS_KEY = ['api', '/maintenance-tasks'] as const;
const WEEK = 7 * 86_400_000;

export const COLUMNS: readonly { id: Column; title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' },
];

export function columnOf(task: Pick<Task, 'status'>): Column {
  if (task.status === 'in_progress') return 'doing';
  if (task.status === 'resolved' || task.status === 'closed') return 'done';
  return 'todo';
}

const SEVERITY: Record<Task['severity'], { tone: HandoffTone; label: string }> = {
  critical: { tone: 'danger', label: 'Critical' },
  high: { tone: 'danger', label: 'High' },
  medium: { tone: 'warning', label: 'Medium' },
  low: { tone: 'neutral', label: 'Low' },
};

/** The bookings a task's pitch holds from now to the end of the day (the pitch and its halves). */
export function affectedEvents(
  task: Pick<Task, 'resourceId'>,
  events: readonly ScheduledEvent[],
  resources: readonly ResourceStatus[],
  now: Date,
): ScheduledEvent[] {
  if (!task.resourceId) return [];
  const pitch = pitchOf(task.resourceId, resources)?.resourceId ?? task.resourceId;
  const same = (id: string) =>
    id === task.resourceId || pitchOf(id, resources)?.resourceId === pitch;
  return events
    .filter(
      (e) =>
        e.status !== 'canceled' &&
        e.kind !== 'maintenance' &&
        new Date(e.scheduledEnd).getTime() > now.getTime() &&
        e.resourceIds.some(same),
    )
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
}

function photoOf(task: Task): string | null {
  const photo = task.evidence.find((e) => e.kind === 'photo' && /^https:\/\//.test(e.reference));
  return photo?.reference ?? null;
}

function Assignee({ personId }: { personId: string | null }) {
  const name = usePersonName(personId);
  if (!personId) return <span className="board-assignee">Nobody yet</span>;
  const full = name.data ? `${name.data.givenName} ${name.data.familyName}` : 'Assigned';
  return (
    <span className="board-assignee">
      <Avatar name={full} personKey={personId} size={24} decorative />
      {full}
    </span>
  );
}

function CloseField({
  facility,
  task,
  affected,
  events,
  resources,
  onClose,
}: {
  facility: FacilityContext;
  task: Task;
  affected: ScheduledEvent[];
  events: readonly ScheduledEvent[];
  resources: readonly ResourceStatus[];
  onClose: () => void;
}) {
  const now = useNow(60_000);
  const toast = useToast();
  const titleId = useId();
  const [hours, setHours] = useState<'2' | '4' | 'day'>('day');
  const [cancelling, setCancelling] = useState<ScheduledEvent | null>(null);
  const close = useApiCommand('post', '/maintenance-restrictions', {
    invalidate: [TASKS_KEY, ['api', '/facilities/{id}/operating-status']],
  });
  const name = resources.find((r) => r.resourceId === task.resourceId)?.name ?? 'the field';
  const until = () => {
    if (hours === 'day' && facility.localDate) {
      return localDayToInstant(nextDay(facility.localDate), facility.timezone) ?? '';
    }
    return new Date(now.getTime() + Number(hours === 'day' ? 8 : hours) * 3_600_000).toISOString();
  };
  const submit = () => {
    void close
      .submit({
        body: {
          facilityId: facility.id,
          resourceId: task.resourceId ?? undefined,
          taskId: task.id,
          kind: 'closed',
          interval: { start: now.toISOString(), end: until() },
          reason: task.issue.slice(0, 2000),
        },
      })
      .then(() => {
        onClose();
        toast.show({ tone: 'success', message: `${name} closed` });
      })
      .catch(() => toast.show({ tone: 'error', message: `${name} was not closed. Try again.` }));
  };
  if (cancelling) {
    return (
      <CancelGamesDialog
        origin={cancelling}
        events={events}
        resources={resources}
        timeZone={facility.timezone}
        onClose={() => setCancelling(null)}
      />
    );
  }
  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      locked={close.isProcessing}
      width={560}
      header={<h2 id={titleId}>Close {name}</h2>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it open
          </Button>
          <Button className="button-danger" onClick={submit} busy={close.isProcessing}>
            Close {name}
          </Button>
        </>
      }
    >
      <p>{task.issue}</p>
      {affected.length === 0 ? (
        <p className="crew-note" data-tone="success">
          Nothing is booked on {name} for the rest of today.
        </p>
      ) : (
        <>
          <p className="crew-meta">
            {affected.length} {affected.length === 1 ? 'booking' : 'bookings'} for the rest of
            today. Move or cancel them first; anything left stays booked for staff to resolve.
          </p>
          <ul className="close-field-list">
            {affected.map((e) => (
              <li key={e.id} className="crew-row">
                <span className="crew-time">{clockOf(e.scheduledStart, facility.timezone)}</span>
                <span className="crew-row-text">
                  <span className="crew-row-title">{e.title}</span>
                </span>
                <Link
                  className="button button-secondary button-sm"
                  to={`/schedule/calendar?date=${facility.localDate ?? ''}`}
                >
                  Move
                </Link>
              </li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => setCancelling(affected[0] ?? null)}>
            Cancel these…
          </Button>
        </>
      )}
      <SegmentedControl
        label="Close for"
        segments={[
          { value: '2', label: '2 hours' },
          { value: '4', label: '4 hours' },
          { value: 'day', label: 'Rest of today' },
        ]}
        value={hours}
        onChange={setHours}
      />
    </Dialog>
  );
}

function TaskCard({
  task,
  facility,
  affected,
  resources,
  events,
  onMove,
}: {
  task: Task;
  facility: FacilityContext;
  affected: ScheduledEvent[];
  resources: readonly ResourceStatus[];
  events: readonly ScheduledEvent[];
  onMove: (task: Task, change: 'assign' | 'start' | 'done') => void;
}) {
  const { online } = useApp();
  const permissions = usePermissions();
  const [closing, setClosing] = useState(false);
  const canManage =
    permissions.isPermitted('facilities.manage_maintenance_task', facility.id) === true;
  const canClose = permissions.isPermitted('facilities.apply_restriction', facility.id) === true;
  const field = task.resourceId
    ? (resources.find((r) => r.resourceId === task.resourceId)?.name ?? 'Space')
    : 'Equipment';
  const photo = photoOf(task);
  const column = columnOf(task);
  const severity = SEVERITY[task.severity];
  const closed = task.openRestrictionIds.length > 0;
  return (
    <li className="crew-card board-card" aria-label={`${field}: ${task.issue}`}>
      <div className="board-photo">
        {photo ? (
          <img src={photo} alt={`Photo of ${field}`} />
        ) : (
          <Icon name="photo_camera" size={26} />
        )}
      </div>
      <div className="crew-card-head">
        <StatusBadge tone="neutral" label={field} size="sm" />
        <StatusBadge tone={severity.tone} label={severity.label} size="sm" />
      </div>
      <p className="board-issue">{task.issue}</p>
      {task.resourceId && column !== 'done' ? (
        <p className="crew-meta">
          {closed
            ? '✕ Field closed for this task'
            : affected.length === 0
              ? 'No bookings affected today'
              : `▲ ${affected.length} ${affected.length === 1 ? 'booking' : 'bookings'} affected today`}
        </p>
      ) : null}
      <div className="board-foot">
        <Assignee personId={task.assignedOwnerPersonId} />
        {canManage && column === 'todo' && !task.assignedOwnerPersonId ? (
          <Button
            variant="secondary"
            className="button-sm"
            disabled={!online}
            onClick={() => onMove(task, 'assign')}
          >
            Assign to me
          </Button>
        ) : null}
        {canManage && column === 'todo' ? (
          <Button className="button-sm" disabled={!online} onClick={() => onMove(task, 'start')}>
            Start
          </Button>
        ) : null}
        {canManage && column === 'doing' ? (
          <Button className="button-sm" disabled={!online} onClick={() => onMove(task, 'done')}>
            Done
          </Button>
        ) : null}
        {canClose && task.resourceId && column !== 'done' && !closed ? (
          <Button
            variant="secondary"
            className="button-sm"
            disabled={!online}
            onClick={() => setClosing(true)}
          >
            Close field
          </Button>
        ) : null}
      </div>
      {closing ? (
        <CloseField
          facility={facility}
          task={task}
          affected={affected}
          events={events}
          resources={resources}
          onClose={() => setClosing(false)}
        />
      ) : null}
    </li>
  );
}

function Board({ facility }: { facility: FacilityContext }) {
  const now = useNow(60_000);
  const toast = useToast();
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const tasks = useApiQuery({
    path: '/maintenance-tasks',
    request: { query: { facilityId: facility.id, limit: 200 } },
    refetchInterval: 60_000,
  });
  const status = useApiQuery({
    path: '/facilities/{id}/operating-status',
    request: { path: { id: facility.id } },
  });
  const day = facility.localDate;
  const events = useApiQuery({
    path: '/events',
    request: {
      query: {
        facilityId: facility.id,
        start: day ? (localDayToInstant(day, facility.timezone) ?? '') : '',
        end: day ? (localDayToInstant(nextDay(day), facility.timezone) ?? '') : '',
        limit: 200,
      },
    },
    enabled: !!day,
  });
  const update = useApiCommand('patch', '/maintenance-tasks/{id}', { invalidate: [TASKS_KEY] });
  // Moves shown before their command goes (the Undo window).
  const [moved, setMoved] = useState<ReadonlyMap<string, Task['status']>>(new Map());
  const resources = useMemo(() => status.data?.resources ?? [], [status.data]);
  const dayEvents = useMemo(
    () => (events.data?.items ?? []).filter((e) => e.status !== 'canceled'),
    [events.data],
  );

  const onMove = (task: Task, change: 'assign' | 'start' | 'done') => {
    const personId = me.data?.principal.personId ?? null;
    const target: Task['status'] =
      change === 'assign' ? 'assigned' : change === 'start' ? 'in_progress' : 'resolved';
    setMoved((m) => new Map(m).set(task.id, target));
    const unmove = () =>
      setMoved((m) => {
        const next = new Map(m);
        next.delete(task.id);
        return next;
      });
    const field = resources.find((r) => r.resourceId === task.resourceId)?.name ?? 'Task';
    toast.show({
      message:
        change === 'assign'
          ? `${field}: assigned to you`
          : change === 'start'
            ? `${field}: moved to Doing`
            : `${field}: moved to Done`,
      onUndo: unmove,
      onClose: (reason) => {
        if (reason === 'undo') return;
        const body =
          change === 'assign'
            ? { assignedOwnerPersonId: personId, expectedRevision: task.revision }
            : change === 'start'
              ? {
                  status: 'in_progress' as const,
                  expectedRevision: task.revision,
                  ...(task.assignedOwnerPersonId || !personId
                    ? {}
                    : { assignedOwnerPersonId: personId }),
                }
              : {
                  status: 'resolved' as const,
                  resolution: { summary: 'Done on the field (tasks board).' },
                  expectedRevision: task.revision,
                };
        void update
          .submit({ path: { id: task.id }, body })
          .then(unmove)
          .catch(() => {
            unmove();
            toast.show({
              tone: 'error',
              message: `${field}: that change did not save. Try again.`,
            });
          });
      },
    });
  };

  return (
    <QueryBoundary
      query={tasks}
      label="maintenance tasks"
      loading={
        <SkeletonGroup label="maintenance tasks" className="board">
          <Skeleton height={320} radius={20} />
          <Skeleton height={320} radius={20} />
          <Skeleton height={320} radius={20} />
        </SkeletonGroup>
      }
      empty={{ title: '', description: '' }}
      unavailableOffline={['moving tasks', 'closing a field']}
    >
      {(data) => {
        const shown = data.items
          .map((t) => (moved.has(t.id) ? { ...t, status: moved.get(t.id)! } : t))
          .filter(
            (t) =>
              columnOf(t) !== 'done' ||
              now.getTime() - new Date(t.resolvedAt ?? t.closedAt ?? t.updatedAt).getTime() < WEEK,
          );
        return (
          <div className="board">
            {COLUMNS.map((col) => {
              const items = shown.filter((t) => columnOf(t) === col.id);
              return (
                <section key={col.id} className="board-col" aria-labelledby={`board-${col.id}`}>
                  <div className="board-col-head">
                    <h3 id={`board-${col.id}`}>{col.title}</h3>
                    <span className="board-count" aria-label={`${items.length} tasks`}>
                      {items.length}
                    </span>
                  </div>
                  {items.length === 0 ? (
                    <p className="crew-empty">
                      {col.id === 'todo'
                        ? 'Nothing waiting.'
                        : col.id === 'doing'
                          ? 'Nothing under way.'
                          : 'Nothing done this week.'}
                    </p>
                  ) : (
                    <ul className="crew-stack">
                      {items.map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          facility={facility}
                          affected={affectedEvents(t, dayEvents, resources, now)}
                          resources={resources}
                          events={dayEvents}
                          onMove={onMove}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        );
      }}
    </QueryBoundary>
  );
}

export function MaintenanceBoardScreen() {
  return (
    <section aria-labelledby="board-title" className="crew crew-wide ops-screen">
      <FacilityGate purpose="see its maintenance tasks">
        {(facility) => (
          <>
            <CrewHero
              titleId="board-title"
              kicker={`${facility.name} · maintenance`}
              title="Tasks"
              aside={
                <Link className="button button-lime button-sm" to="/workspace/report-problem">
                  Report a problem
                </Link>
              }
            >
              <p className="crew-kicker">
                Photos come with tasks once uploads exist <ProposedTag />
              </p>
            </CrewHero>
            <Board facility={facility} />
          </>
        )}
      </FacilityGate>
    </section>
  );
}
