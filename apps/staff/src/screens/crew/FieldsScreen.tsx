/**
 * Field crew · Fields (staff redesign Phase 8 item 7; SPK-FAC-001, SPK-FAC-002, SPK-READY-001
 * field readiness, SPK-UX-006 escalation). The crew's phone home (Fields · Tasks · Report · Queue ·
 * More): today's pitches ordered by their first use, each with its checklist (lines marked, goals
 * anchored, nets up, corner flags out; facilities migration 0975).
 *
 * - A tick is saved at once (`POST /v1/field-preparations` with the revision) and shown before the
 *   answer; a failure puts the tick back and says so, with Try again. Unticking an item of a ready
 *   pitch reopens it.
 * - "Mark ready" is enabled only when every item is ticked. It shows Ready at once with a 5 s Undo;
 *   the command (`POST /v1/field-preparations/{id}/ready`) goes when the Undo window closes. It
 *   drives the "Field ✓" check of Today's starts (S 1a / S 3a); a pitch not ready 15 minutes before
 *   its first use is a red issue on the manager's Today (field-readiness.ts).
 * - "Report a problem" creates a maintenance task for the pitch (`POST /v1/maintenance-tasks`);
 *   the photo is Proposed: tasks keep evidence by reference only and the API takes no upload.
 * - Offline the list is read from cache and the checklist is disabled with its reason (it is not
 *   attendance, so it does not queue, §4.15). Viewers without facilities.prepare_field read only.
 * Reads: `GET /v1/facilities/{id}/operating-status`, `GET /v1/events` for the facility day and
 * `GET /v1/field-preparations`. Times are the facility's (SPK-SCHED-008).
 */
import type { Schema } from '@sportspark/api-client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import {
  FacilityGate,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { localDayToInstant, nextDay } from '../../features/registration-finance/format';
import { useApp, useNow } from '../../providers/AppProviders';
import { BottomSheet } from '../../ui/BottomSheet';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { StatusBadge, type HandoffTone } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import {
  FIELD_CHECKLIST,
  fieldDays,
  NOT_READY_ALERT_MS,
  progressOf,
  type FieldDay,
  type FieldPreparation,
  type FieldPreparationItem,
} from '../today/field-readiness';
import { clockOf, CrewHero, dayLabelOf, ProposedTag } from './crew-ui';
import './crew.css';

const PREPARATIONS_KEY = ['api', '/field-preparations'] as const;

/** One-tap issues for "Report a problem", with the severity the task gets. */
export const FIELD_PROBLEMS: readonly {
  label: string;
  severity: Schema<'MaintenanceTask'>['severity'];
}[] = [
  { label: 'Lines faded', severity: 'low' },
  { label: 'Goal damaged', severity: 'high' },
  { label: 'Net torn', severity: 'medium' },
  { label: 'Corner flag missing', severity: 'low' },
  { label: 'Surface damage', severity: 'high' },
  { label: 'Other', severity: 'medium' },
];

function statusOf(day: FieldDay, now: Date): { tone: HandoffTone; label: string } {
  if (day.closed) return { tone: 'danger', label: 'Closed' };
  const progress = progressOf(day.preparation);
  if (progress.ready) return { tone: 'success', label: 'Ready' };
  if (!day.firstUse) return { tone: 'neutral', label: 'Not used today' };
  if (!day.nextUse) return { tone: 'neutral', label: 'Done for today' };
  if (day.nextUse) {
    const until = new Date(day.nextUse.scheduledStart).getTime() - now.getTime();
    if (until <= NOT_READY_ALERT_MS) {
      return {
        tone: 'danger',
        label:
          until <= 0
            ? 'Not ready · in use'
            : `Not ready · starts in ${Math.ceil(until / 60_000)} min`,
      };
    }
  }
  return { tone: 'warning', label: `Not ready · ${progress.done} of ${progress.total}` };
}

function ReportProblem({
  facility,
  day,
  onClose,
}: {
  facility: FacilityContext;
  day: FieldDay;
  onClose: () => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const noteId = useId();
  const photoId = useId();
  const [problem, setProblem] = useState<(typeof FIELD_PROBLEMS)[number] | null>(null);
  const [note, setNote] = useState('');
  const report = useApiCommand('post', '/maintenance-tasks', {
    invalidate: [['api', '/maintenance-tasks']],
  });
  const submit = () => {
    if (!problem) return;
    const issue = `${problem.label} on ${day.pitch.name}${note.trim() ? `: ${note.trim()}` : '.'}`;
    void report
      .submit({
        body: {
          facilityId: facility.id,
          resourceId: day.pitch.resourceId,
          issue,
          severity: problem.severity,
        },
      })
      .then(() => {
        onClose();
        toast.show({ tone: 'success', message: `Task created for ${day.pitch.name}` });
      })
      .catch(() => toast.show({ tone: 'error', message: 'The task was not created. Try again.' }));
  };
  return (
    <BottomSheet
      open
      onClose={onClose}
      titleId={titleId}
      title={`Report a problem · ${day.pitch.name}`}
      locked={report.isProcessing}
      footer={
        <Button onClick={submit} busy={report.isProcessing} disabled={!problem}>
          Create task
        </Button>
      }
    >
      <div className="issue-chips" role="group" aria-label="What is wrong">
        {FIELD_PROBLEMS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="issue-chip"
            aria-pressed={problem?.label === p.label}
            onClick={() => setProblem(p)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="crew-meta" htmlFor={noteId}>
        What did you see? (optional)
      </label>
      <textarea
        id={noteId}
        className="crew-textarea"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button variant="secondary" disabled aria-describedby={photoId}>
        <Icon name="photo_camera" size={18} /> Add a photo
      </Button>
      <p className="crew-meta" id={photoId}>
        <ProposedTag /> Photos wait for file uploads; a task keeps evidence by reference only.
      </p>
    </BottomSheet>
  );
}

function FieldCard({
  facility,
  day,
  now,
  canPrepare,
}: {
  facility: FacilityContext;
  day: FieldDay;
  now: Date;
  canPrepare: boolean;
}) {
  const { online } = useApp();
  const toast = useToast();
  const offlineId = useId();
  const server = day.preparation;
  const [ticked, setTicked] = useState<FieldPreparationItem[] | null>(null);
  const [readyLocal, setReadyLocal] = useState(false);
  const [reporting, setReporting] = useState(false);
  const record = useApiCommand('post', '/field-preparations', { invalidate: [PREPARATIONS_KEY] });
  const ready = useApiCommand('post', '/field-preparations/{id}/ready', {
    invalidate: [PREPARATIONS_KEY],
  });
  const current = ticked ?? server?.checkedItems ?? [];
  const progress = progressOf(server);
  const isReady = readyLocal || progress.ready;
  const allTicked = FIELD_CHECKLIST.every((i) => current.includes(i.key));
  const disabled = !online || !canPrepare || !!day.closed;
  const latest = useRef<FieldPreparation | null>(server);
  useEffect(() => {
    // Never step back to an older revision than a write here already returned.
    if (server && (!latest.current || server.revision >= latest.current.revision)) {
      latest.current = server;
    }
    // The read caught up with what was ticked here.
    if (
      ticked &&
      server &&
      FIELD_CHECKLIST.every((i) => ticked.includes(i.key) === server.checkedItems.includes(i.key))
    ) {
      setTicked(null);
    }
    if (server?.status === 'ready') setReadyLocal(false);
  }, [server, ticked]);

  const toggle = (item: FieldPreparationItem) => {
    if (disabled) return;
    const next = current.includes(item) ? current.filter((i) => i !== item) : [...current, item];
    setTicked(next);
    if (!next.includes(item)) setReadyLocal(false);
    void record
      .submit({
        body: {
          facilityId: facility.id,
          resourceId: day.pitch.resourceId,
          date: facility.localDate ?? '',
          checkedItems: next,
          ...(latest.current ? { expectedRevision: latest.current.revision } : {}),
        },
      })
      .then((res) => {
        // The next tick names this revision before the list is read again.
        latest.current = res;
      })
      .catch(() => {
        setTicked(null);
        toast.show({
          tone: 'error',
          message: `${day.pitch.name}: the tick did not save.`,
          action: { label: 'Try again', onClick: () => toggle(item) },
        });
      });
  };

  const markReady = () => {
    const prep = latest.current;
    if (!prep || !allTicked) return;
    setReadyLocal(true);
    toast.show({
      tone: 'success',
      message: `${day.pitch.name} is ready`,
      onUndo: () => setReadyLocal(false),
      onClose: (reason) => {
        if (reason === 'undo') return;
        void ready
          .submit({ path: { id: prep.id }, body: { expectedRevision: prep.revision } })
          .catch(() => {
            setReadyLocal(false);
            toast.show({
              tone: 'error',
              message: `${day.pitch.name} was not marked ready. Try again.`,
            });
          });
      },
    });
  };

  const status =
    isReady && !day.closed ? { tone: 'success' as const, label: 'Ready' } : statusOf(day, now);
  const zone = facility.timezone;
  return (
    <li
      className="crew-card"
      data-edge={
        status.tone === 'success' ? 'success' : status.tone === 'danger' ? 'danger' : 'warning'
      }
    >
      <div className="crew-card-head">
        <h3>{day.pitch.name}</h3>
        <StatusBadge tone={status.tone} label={status.label} size="sm" />
      </div>
      <p className="crew-meta">
        {day.closed
          ? `Closed: ${day.closed.reason}`
          : day.firstUse
            ? `First use ${clockOf(day.firstUse.scheduledStart, zone)} · ${day.firstUse.title}${day.uses.length > 1 ? ` · ${day.uses.length} uses today` : ''}`
            : 'Not used today'}
      </p>
      {day.closed ? null : (
        <ul className="field-checks" aria-label={`${day.pitch.name} checklist`}>
          {FIELD_CHECKLIST.map((item) => {
            const checked = current.includes(item.key);
            return (
              <li key={item.key}>
                <label
                  className="prep-check"
                  data-checked={checked || undefined}
                  data-disabled={disabled || undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || record.isProcessing}
                    aria-describedby={online ? undefined : offlineId}
                    onChange={() => toggle(item.key)}
                  />
                  {item.label}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {day.closed ? null : (
        <div className="crew-actions">
          <Button variant="secondary" onClick={() => setReporting(true)} disabled={!online}>
            <Icon name="report" size={18} /> Report a problem
          </Button>
          {canPrepare ? (
            <Button
              onClick={markReady}
              disabled={disabled || !allTicked || isReady || record.isProcessing}
              busy={ready.isProcessing}
            >
              {isReady ? '✓ Ready' : 'Mark ready'}
            </Button>
          ) : null}
        </div>
      )}
      {online ? null : (
        <p className="crew-meta" id={offlineId}>
          Ticking needs a connection.
        </p>
      )}
      {reporting ? (
        <ReportProblem facility={facility} day={day} onClose={() => setReporting(false)} />
      ) : null}
    </li>
  );
}

function Fields({ facility }: { facility: FacilityContext }) {
  const now = useNow(30_000);
  const permissions = usePermissions();
  const canPrepare = permissions.isPermitted('facilities.prepare_field', facility.id) === true;
  const day = facility.localDate;
  const window = useMemo(
    () =>
      day
        ? {
            start: localDayToInstant(day, facility.timezone) ?? '',
            end: localDayToInstant(nextDay(day), facility.timezone) ?? '',
          }
        : null,
    [day, facility.timezone],
  );
  const status = useApiQuery({
    path: '/facilities/{id}/operating-status',
    request: { path: { id: facility.id } },
    refetchInterval: 60_000,
  });
  const events = useApiQuery({
    path: '/events',
    request: {
      query: {
        facilityId: facility.id,
        start: window?.start ?? '',
        end: window?.end ?? '',
        limit: 200,
      },
    },
    enabled: window !== null,
    refetchInterval: 60_000,
  });
  const preparations = useApiQuery({
    path: '/field-preparations',
    request: { query: { facilityId: facility.id } },
    refetchInterval: 60_000,
  });
  const days = useMemo(
    () =>
      status.data && preparations.data
        ? fieldDays(status.data.resources, events.data?.items ?? [], preparations.data.items, now)
        : [],
    [status.data, preparations.data, events.data, now],
  );
  const readyCount = days.filter((d) => progressOf(d.preparation).ready).length;
  // Pitches still to be used today (a finished day needs no preparation).
  const used = days.filter((d) => d.nextUse && !d.closed);
  return (
    <>
      <CrewHero
        titleId="fields-title"
        kicker={`${dayLabelOf(now, facility.timezone)} · ${facility.name}`}
        title="Fields"
        aside={
          <Link className="button button-lime button-sm" to="/facilities/board">
            Tasks
          </Link>
        }
      >
        {days.length > 0 ? (
          <div className="crew-stats">
            <div className="crew-stat">
              <strong>{readyCount}</strong>
              <span>Ready</span>
            </div>
            <div
              className="crew-stat"
              data-tone={used.some((d) => !progressOf(d.preparation).ready) ? 'warning' : undefined}
            >
              <strong>{used.filter((d) => !progressOf(d.preparation).ready).length}</strong>
              <span>To prepare</span>
            </div>
            <div className="crew-stat">
              <strong>{days.filter((d) => d.closed).length}</strong>
              <span>Closed</span>
            </div>
          </div>
        ) : null}
      </CrewHero>
      <QueryBoundary
        query={preparations}
        label="today's fields"
        loading={
          <SkeletonGroup label="today's fields" className="crew">
            <Skeleton height={300} radius={20} />
            <Skeleton height={300} radius={20} />
          </SkeletonGroup>
        }
        empty={{ title: '', description: '' }}
        unavailableOffline={['ticking the checklist', 'marking a field ready']}
      >
        {() =>
          status.data === undefined ? (
            <SkeletonGroup label="today's fields" className="crew">
              <Skeleton height={300} radius={20} />
            </SkeletonGroup>
          ) : days.length === 0 ? (
            <section className="crew-card">
              <p className="crew-empty">This facility has no pitches.</p>
            </section>
          ) : (
            <ul className="crew-stack" aria-label="Fields by first use">
              {days.map((d) => (
                <FieldCard
                  key={d.pitch.resourceId}
                  facility={facility}
                  day={d}
                  now={now}
                  canPrepare={canPrepare}
                />
              ))}
            </ul>
          )
        }
      </QueryBoundary>
    </>
  );
}

export function FieldsScreen() {
  return (
    <section aria-labelledby="fields-title" className="crew ops-screen">
      <FacilityGate purpose="prepare its fields">
        {(facility) => <Fields facility={facility} />}
      </FacilityGate>
    </section>
  );
}
