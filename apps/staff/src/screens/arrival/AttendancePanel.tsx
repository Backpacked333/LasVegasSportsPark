/**
 * Observed attendance of one activity, shared by SCR-S-29 (front desk, program manager) and
 * SCR-W-04 (the assigned coach) (SPK-ENTRY-001, SPK-ENTRY-005, SPK-ENTRY-008, §4.7 invariant 9,
 * §4.15, SPK-AT-018).
 *
 * - `GET /v1/attendance` gives each person's current state, full history and name (ENT-01, names
 *   only); for a session the expected participants come from confirmed enrollments and session
 *   bookings, named through `GET /v1/person-names` (a person the viewer may not view keeps a short
 *   reference).
 * - A first observation is `POST /v1/attendance-observations`. Changing a recorded state is a
 *   correction, a new row that keeps actor, time and the required reason
 *   (`POST /v1/attendance-observations/{id}/corrections`); nothing is overwritten.
 * - Conflicting observations (for example two offline devices) are shown as conflicts for review,
 *   never resolved silently; each conflicting observation can be corrected with a reason.
 * - Counts are observed attendance, never verified occupancy (SPK-ENTRY-008).
 * - Offline, observations are queued against the roster as last loaded (its age shown) and
 *   synchronised once on reconnection; corrections need a connection.
 */
import type { Schema } from '@sportspark/api-client';
import { useCallback, useMemo, useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import {
  attendanceQuery,
  sameActivity,
  type ActivityRef,
} from '../../features/operations/activity';
import { useKeyedCommands } from '../../features/operations/commands';
import { nameOf, usePersonNames } from '../../features/operations/context';
import { CommandError } from '../../features/operations/feedback';
import { TextAreaField, fieldErrorsOf } from '../../features/operations/fields';
import { formatInstant } from '../../features/operations/format';
import { OBSERVED_STATE, OBSERVED_STATES } from '../../features/operations/labels';
import { useOfflineQueue } from '../../features/operations/offline/OfflineQueueProvider';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type ObservedState = Schema<'ObservedState'>;
type PersonAttendance = Schema<'PersonAttendance'>;
type HistoryItem = Schema<'AttendanceHistoryItem'>;

export interface AttendancePanelProps {
  activity: ActivityRef;
  /** Facility of the activity: where queued observations belong (§4.15 scoped roster). */
  facilityId: string | null;
  timezone: string | null;
  /** "Record attendance for <activity>" */
  title: string;
}

const ATTENDANCE_KEY = ['api', '/attendance'] as const;

export function AttendancePanel({ activity, facilityId, timezone, title }: AttendancePanelProps) {
  const { online, services } = useApp();
  const queue = useOfflineQueue();
  const now = useNow();
  const attendance = useApiQuery({
    path: '/attendance',
    request: { query: attendanceQuery(activity) },
  });
  const isSession = activity.type === 'session';
  const enrollments = useApiQuery({
    path: '/enrollments',
    request: {
      query: {
        offeringId: isSession ? activity.offeringId : undefined,
        status: 'confirmed',
        limit: 200,
      },
    },
    enabled: isSession,
  });
  const bookings = useApiQuery({
    path: '/session-bookings',
    request: {
      query: { sessionId: isSession ? activity.sessionId : undefined, status: 'confirmed' },
    },
    enabled: isSession,
  });
  const commands = useKeyedCommands({ invalidate: [ATTENDANCE_KEY] });

  const expectedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of enrollments.data?.items ?? []) ids.add(e.participantPersonId);
    for (const b of bookings.data ?? []) if (b) ids.add(b.participantPersonId);
    return ids;
  }, [enrollments.data, bookings.data]);

  const people = useMemo(() => {
    const byId = new Map<string, PersonAttendance | null>();
    for (const p of attendance.data?.people ?? []) byId.set(p.personId, p);
    for (const id of expectedIds) if (!byId.has(id)) byId.set(id, null);
    return [...byId.entries()].map(([personId, record]) => ({ personId, record }));
  }, [attendance.data, expectedIds]);

  // ENT-01: the attendance read names its people (after authorizing the read); the expected
  // participants without a record yet are named through the minimal names read.
  const unnamed = useMemo(
    () => people.filter((p) => !p.record?.displayName).map((p) => p.personId),
    [people],
  );
  const names = usePersonNames(unnamed);
  const labelOf = useCallback(
    (personId: string, record: PersonAttendance | null) =>
      record?.displayName ?? nameOf(names, personId),
    [names],
  );
  const sorted = useMemo(
    () =>
      [...people].sort((a, b) =>
        labelOf(a.personId, a.record).localeCompare(labelOf(b.personId, b.record)),
      ),
    [people, labelOf],
  );

  // One snapshot per roster load: queued items name the roster they were observed against.
  const takenAt = attendance.updatedAt;
  const snapshot = useMemo(
    () => (takenAt ? queue.newSnapshot(takenAt) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new reference only per load
    [takenAt?.getTime()],
  );
  const maxAge = services.config.offlineRosterMaxAgeMs ?? null;
  const rosterTooOld =
    maxAge !== null && takenAt !== null && now.getTime() - takenAt.getTime() > maxAge;

  const queuedHere = queue.mine.filter(
    (q) => q.item.kind === 'attendance' && sameActivity(q.item.activity, activity),
  );

  const record = (personId: string, observedState: ObservedState) => {
    if (!online) {
      if (!snapshot || !facilityId || rosterTooOld) return;
      queue.enqueue([
        {
          item: {
            kind: 'attendance',
            clientObservationId: queue.newObservationId(),
            observedAt: services.now().toISOString(),
            personId,
            activity,
            observedState,
          },
          facilityId,
          snapshot,
          context: title,
        },
      ]);
      return;
    }
    void commands.run(`record|${personId}`, 'post', '/attendance-observations', {
      body: { personId, activity, observedState },
    });
  };

  const counts = useMemo(() => {
    const c: Record<ObservedState | 'none' | 'conflict', number> = {
      present: 0,
      late: 0,
      left_early: 0,
      absent: 0,
      none: 0,
      conflict: 0,
    };
    for (const p of people) {
      if (!p.record || (p.record.status === 'recorded' && p.record.effectiveState === null))
        c.none += 1;
      else if (p.record.status === 'conflict') c.conflict += 1;
      else if (p.record.effectiveState) c[p.record.effectiveState] += 1;
    }
    return c;
  }, [people]);

  return (
    <section className="ops-section" aria-labelledby="attendance-panel-title">
      <h3 id="attendance-panel-title">{title}</h3>
      <QueryBoundary
        query={attendance}
        label="attendance"
        isEmpty={() =>
          people.length === 0 && !(isSession && (enrollments.isLoading || bookings.isLoading))
        }
        empty={{
          title: 'No participants to record',
          description:
            'Nobody is expected for this activity and nothing has been recorded yet. Expected participants appear here when they are enrolled or booked.',
        }}
        unavailableOffline={['corrections']}
      >
        {() => (
          <>
            <p data-testid="attendance-counts">
              Present {counts.present}, late {counts.late}, left early {counts.left_early}, absent{' '}
              {counts.absent}, not recorded {counts.none}
              {counts.conflict > 0 ? `, conflicting ${counts.conflict}` : ''}. Observed attendance,
              not verified occupancy.
            </p>
            {isSession && (enrollments.error || bookings.error) ? (
              <p className="caption">
                The expected participant list is not available to you; people with recorded
                observations are shown.
              </p>
            ) : null}
            {!online && rosterTooOld ? (
              <StateView
                variant="unavailable"
                title="Roster too old to queue against"
                description="This roster is older than the configured maximum roster age. Reconnect to refresh it before recording."
              />
            ) : null}
            {!online && maxAge === null ? (
              <StateView
                variant="pending-decision"
                subject="A maximum roster age for offline queuing"
                decisions={['DEC-033']}
                owner="Operations"
              />
            ) : null}
            <ul className="list" aria-label="Participants">
              {sorted.map(({ personId, record: rec }) => (
                <AttendanceRow
                  key={personId}
                  name={labelOf(personId, rec)}
                  personId={personId}
                  record={rec}
                  timezone={timezone}
                  online={online}
                  queueDisabled={!online && (rosterTooOld || !snapshot || !facilityId)}
                  queued={queuedHere
                    .filter((q) => q.item.kind === 'attendance' && q.item.personId === personId)
                    .map((q) => (q.item.kind === 'attendance' ? q.item.observedState : 'present'))}
                  onRecord={(state) => record(personId, state)}
                  commands={commands}
                />
              ))}
            </ul>
          </>
        )}
      </QueryBoundary>
    </section>
  );
}

function AttendanceRow({
  name,
  personId,
  record,
  timezone,
  online,
  queueDisabled,
  queued,
  onRecord,
  commands,
}: {
  name: string;
  personId: string;
  record: PersonAttendance | null;
  timezone: string | null;
  online: boolean;
  queueDisabled: boolean;
  queued: ObservedState[];
  onRecord: (state: ObservedState) => void;
  commands: ReturnType<typeof useKeyedCommands>;
}) {
  const [correcting, setCorrecting] = useState<{
    observationId: string;
    state: ObservedState;
  } | null>(null);
  const currentIds = record?.currentObservationIds ?? [];
  const conflict = record?.status === 'conflict';
  const recordOutcome = commands.outcome(`record|${personId}`);
  const history = record?.history ?? [];
  const current = history.filter((h) => currentIds.includes(h.id));

  // A first observation just recorded is the current one even before the attendance refetch
  // returns: a second tap corrects it with a reason instead of sending a second first observation,
  // which the API would keep as a conflict (SPK-ENTRY-005).
  const justRecorded =
    recordOutcome.status === 'success'
      ? (recordOutcome.data as { observation?: { id?: string; observedState?: ObservedState } })
          ?.observation
      : undefined;
  const headIds = currentIds.length > 0 ? currentIds : justRecorded?.id ? [justRecorded.id] : [];
  const effective = record?.effectiveState ?? justRecorded?.observedState ?? null;
  const choose = (state: ObservedState) => {
    if (headIds.length === 1 && online) {
      if (effective === state) return;
      setCorrecting({ observationId: headIds[0] as string, state });
      return;
    }
    onRecord(state);
  };

  return (
    <li aria-label={name}>
      <div className="row-text">
        <span className="row-title">{name}</span>
        {conflict ? (
          <StatusBadge tone="danger" label="Conflicting observations: kept for review" />
        ) : record?.effectiveState ? (
          <StatusBadge
            tone={OBSERVED_STATE[record.effectiveState].tone}
            label={OBSERVED_STATE[record.effectiveState].label}
          />
        ) : (
          <StatusBadge tone="neutral" label="Not recorded" />
        )}
        {queued.map((state, i) => (
          <StatusBadge
            key={`${state}-${i}`}
            tone="pending"
            label={`Queued on this device: ${OBSERVED_STATE[state].label} (not yet recorded)`}
          />
        ))}
      </div>
      {!conflict ? (
        <div className="ops-actions" role="group" aria-label={`Record attendance for ${name}`}>
          {OBSERVED_STATES.map((state) => (
            <Button
              key={state}
              variant={record?.effectiveState === state ? 'primary' : 'secondary'}
              aria-pressed={record?.effectiveState === state}
              aria-label={`${OBSERVED_STATE[state].label}: ${name}`}
              busy={recordOutcome.status === 'pending'}
              disabled={
                (!online && (queueDisabled || currentIds.length > 0)) ||
                commands.outcome(`correct|${currentIds[0] ?? ''}`).status === 'pending'
              }
              onClick={() => choose(state)}
            >
              {OBSERVED_STATE[state].label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="ops-actions">
          {current.map((h) => (
            <Button
              key={h.id}
              variant="secondary"
              disabled={!online}
              aria-label={`Correct the ${OBSERVED_STATE[h.observedState].label.toLowerCase()} observation of ${name}`}
              onClick={() => setCorrecting({ observationId: h.id, state: h.observedState })}
            >
              Correct “{OBSERVED_STATE[h.observedState].label}” by {h.recordedBy.actorLabel}
            </Button>
          ))}
        </div>
      )}
      {!online && currentIds.length > 0 ? (
        <span className="caption">Corrections need a connection.</span>
      ) : null}
      {recordOutcome.status === 'error' && recordOutcome.error ? (
        <CommandError error={recordOutcome.error} subject="This participant" />
      ) : null}
      {correcting ? (
        <CorrectionForm
          name={name}
          observationId={correcting.observationId}
          initialState={correcting.state}
          commands={commands}
          onDone={() => setCorrecting(null)}
        />
      ) : null}
      {history.length > 0 ? <History name={name} history={history} timezone={timezone} /> : null}
    </li>
  );
}

function CorrectionForm({
  name,
  observationId,
  initialState,
  commands,
  onDone,
}: {
  name: string;
  observationId: string;
  initialState: ObservedState;
  commands: ReturnType<typeof useKeyedCommands>;
  onDone: () => void;
}) {
  const [state, setState] = useState<ObservedState>(initialState);
  const [reason, setReason] = useState('');
  const [missingReason, setMissingReason] = useState(false);
  const key = `correct|${observationId}`;
  const outcome = commands.outcome(key);
  const apiErrors = fieldErrorsOf(outcome.error);

  const save = async () => {
    if (reason.trim().length === 0) {
      setMissingReason(true);
      return;
    }
    setMissingReason(false);
    const done = await commands.run(key, 'post', '/attendance-observations/{id}/corrections', {
      path: { id: observationId },
      body: { observedState: state, reason: reason.trim() },
    });
    if (done) onDone();
  };

  return (
    <form
      className="ops-form ops-section"
      aria-label={`Correct attendance for ${name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="ops-fieldset">
        <legend>Corrected state</legend>
        {OBSERVED_STATES.map((s) => (
          <label key={s} className="ops-check">
            <input
              type="radio"
              name={`state-${observationId}`}
              value={s}
              checked={state === s}
              onChange={() => setState(s)}
            />
            {OBSERVED_STATE[s].label}
          </label>
        ))}
      </fieldset>
      <TextAreaField
        label="Reason for the correction"
        value={reason}
        onChange={setReason}
        required
        hint="Kept with the correction, with your name and the time. The original observation is not changed."
        error={missingReason ? 'A reason is required for a correction.' : apiErrors.reason}
      />
      <div className="ops-actions">
        <Button type="submit" busy={outcome.status === 'pending'}>
          Save correction
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {outcome.status === 'error' && outcome.error && !apiErrors.reason ? (
        <CommandError
          error={outcome.error}
          onRetry={() => void save()}
          subject="This observation"
        />
      ) : null}
    </form>
  );
}

function History({
  name,
  history,
  timezone,
}: {
  name: string;
  history: HistoryItem[];
  timezone: string | null;
}) {
  return (
    <details>
      <summary>
        History for {name} ({history.length})
      </summary>
      <ol className="ops-history" aria-label={`Attendance history for ${name}`}>
        {history.map((h) => (
          <li key={h.id}>
            <StatusBadge
              tone={OBSERVED_STATE[h.observedState].tone}
              label={OBSERVED_STATE[h.observedState].label}
            />{' '}
            observed {formatInstant(h.observedAt, timezone)} by {h.recordedBy.actorLabel}
            {h.source === 'offline_sync' ? ' (synchronised from an offline device)' : ''}
            {h.correctsObservationId ? `; correction: ${h.correctionReason ?? ''}` : ''}
            {h.correctedByObservationId ? '; later corrected' : ''}
            {h.flags.includes('stale_snapshot') ? '; recorded against an old roster' : ''}
            {h.flags.includes('conflict') ? '; conflicts with another observation' : ''}
          </li>
        ))}
      </ol>
    </details>
  );
}
