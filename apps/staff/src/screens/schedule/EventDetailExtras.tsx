/**
 * The schedule detail rail's extras for one event (SCR-S-03; SPK-SCHED-003/005/006/009,
 * SPK-READY-001, SPK-COMMS-003/005):
 *
 * - `EventFacts` reads `GET /v1/events/{id}/detail` (staff, `scheduling.read_event_detail`): the
 *   committed teams with their names and roster sizes, the staff assignments by name, role and
 *   status, attendee counts (never names) and, for a fixture's event, competition's readiness
 *   (`GET /v1/fixtures/{id}/readiness`, each check as glyph and text). A section the owning module
 *   did not answer says "not identified"; nothing is shown as zero that nobody counted.
 * - `DirectChange` moves or cancels a published event at once (`POST /v1/events/{id}/move`,
 *   `/cancel`): the API writes a single-change draft and publishes it with every publication
 *   check, notice and operation, so a conflict refuses the change and names the colliding events.
 *   Times are entered in facility-local time (SPK-SCHED-008). Offered only to roles that publish.
 * - `MessageAttendees` opens the communications composer with the event's teams and participants
 *   as the audience definition; communications resolves recipients from current permissions and
 *   applies the channel policy (pending DEC-012, DEC-062).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import {
  LocalDateTimeField,
  localFromInstant,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import { useActionAllowed } from '../../features/schedule-facilities/permission';
import { useCommandReload } from '../../features/schedule-facilities/reload';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { Composer } from '../communications/MessageComposerScreen';

type Event = Schema<'Event'>;
type EventDetail = Schema<'EventDetail'>;
type Readiness = Schema<'FixtureReadiness'>;

const READINESS: Record<Readiness['status'], { tone: StatusTone; label: string }> = {
  ready: { tone: 'success', label: 'Ready' },
  warning: { tone: 'warning', label: 'Warning' },
  unknown: { tone: 'pending', label: 'Unknown' },
  blocked: { tone: 'danger', label: 'Blocked' },
};

const GLYPH: Record<Readiness['status'], string> = {
  ready: '✓',
  warning: '▲',
  unknown: '◷',
  blocked: '✕',
};

const words = (value: string) => value.replace(/_/g, ' ');

export const EVENT_DETAIL_KEY = ['api', '/events/{id}/detail'] as const;

function ReadinessFacts({ fixtureId }: { fixtureId: string }) {
  const readiness = useApiQuery({
    path: '/fixtures/{id}/readiness',
    request: { path: { id: fixtureId } },
  });
  const value = readiness.data;
  return (
    <>
      <dt>Readiness</dt>
      <dd data-testid="event-readiness">
        {value ? (
          <span className="tl-readiness">
            <StatusBadge
              tone={READINESS[value.status].tone}
              label={READINESS[value.status].label}
            />
            {value.checks.map((c) => (
              <span key={c.name} className="tl-check" data-status={c.status}>
                <span aria-hidden="true">{GLYPH[c.status]}</span> {words(c.name)}
                <span className="visually-hidden">: {READINESS[c.status].label}</span>
              </span>
            ))}
          </span>
        ) : readiness.error ? (
          'Not available to you'
        ) : (
          'Checking…'
        )}
      </dd>
    </>
  );
}

function teamsLine(detail: EventDetail): string {
  return detail.teams
    .map((t) => {
      const name = t.teamName ?? `${words(t.role)} (name not available)`;
      return t.rosterSize === null ? name : `${name} (${t.rosterSize})`;
    })
    .join(' · ');
}

/** Teams, staff, attendees and readiness for the selected event. */
export function EventFacts({ event }: { event: Event }) {
  const allowed = useActionAllowed('scheduling.read_event_detail', event.facilityId);
  const detail = useApiQuery({
    path: '/events/{id}/detail',
    request: { path: { id: event.id } },
    enabled: allowed,
  });
  if (!allowed) return null;
  const d = detail.data;
  if (!d) {
    return detail.error ? (
      <p className="caption tl-extras-note">Teams, staff and attendees could not be loaded.</p>
    ) : null;
  }
  return (
    <dl className="tl-facts tl-extras" aria-label="Teams, staff and attendees">
      {d.teams.length > 0 ? (
        <>
          <dt>Teams</dt>
          <dd>{teamsLine(d)}</dd>
        </>
      ) : null}
      <dt>Staff</dt>
      <dd>
        {!d.staff.identified ? (
          'Not identified'
        ) : d.staff.assignments.length === 0 ? (
          'No staff assigned'
        ) : (
          <ul className="tl-staff">
            {d.staff.assignments.map((a) => (
              <li key={a.assignmentId}>
                {a.displayName ?? 'Name not available'} · {words(a.role)}{' '}
                <span className="caption">({words(a.status)})</span>
              </li>
            ))}
          </ul>
        )}
      </dd>
      <dt>Attendees</dt>
      <dd>
        {d.attendees.total} expected
        {d.attendees.total > 0 ? (
          <span className="caption">
            {' '}
            (
            {Object.entries(d.attendees.byVia)
              .filter(([, n]) => n > 0)
              .map(([via, n]) => `${n} by ${via}`)
              .join(', ')}
            )
          </span>
        ) : null}
      </dd>
      {d.fixtureId ? <ReadinessFacts fixtureId={d.fixtureId} /> : null}
    </dl>
  );
}

/** Direct move or cancel of a published event: one change, published at once with every check. */
export function DirectChange({ event, timezone }: { event: Event; timezone: string }) {
  const { online } = useApp();
  const mayPublish = useActionAllowed('scheduling.publish_schedule', event.facilityId);
  const [mode, setMode] = useState<'none' | 'move' | 'cancel'>('none');
  const [start, setStart] = useState<LocalDateTime>(() =>
    localFromInstant(event.scheduledStart, timezone),
  );
  const [end, setEnd] = useState<LocalDateTime>(() =>
    localFromInstant(event.scheduledEnd, timezone),
  );
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const keys = [['api', '/events'], EVENT_DETAIL_KEY, ['api', '/schedule-drafts']] as const;
  const move = useApiCommand('post', '/events/{id}/move', { invalidate: keys });
  const cancel = useApiCommand('post', '/events/{id}/cancel', { invalidate: keys });
  const reloadMove = useCommandReload(move.reset, keys);
  const reloadCancel = useCommandReload(cancel.reset, keys);
  if (!mayPublish || event.status !== 'published') return null;

  const startAt = toInstant(start, timezone);
  const endAt = toInstant(end, timezone);
  const order =
    startAt.ok && endAt.ok && Date.parse(startAt.instant) >= Date.parse(endAt.instant)
      ? 'The end must be after the start.'
      : null;
  const submitMove = () => {
    setAttempted(true);
    if (!startAt.ok || !endAt.ok || order) return;
    void move
      .submit({
        path: { id: event.id },
        body: {
          scheduledStart: startAt.instant,
          scheduledEnd: endAt.instant,
          expectedRevision: event.revision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      })
      .then(() => setMode('none'))
      .catch(() => undefined);
  };
  const submitCancel = () => {
    setAttempted(true);
    if (!reason.trim()) return;
    void cancel
      .submit({
        path: { id: event.id },
        body: { reason: reason.trim(), expectedRevision: event.revision },
      })
      .then(() => setMode('none'))
      .catch(() => undefined);
  };
  const open = (next: 'move' | 'cancel') => {
    setAttempted(false);
    move.reset();
    cancel.reset();
    setMode(mode === next ? 'none' : next);
  };
  return (
    <div className="tl-direct">
      <div className="tl-detail-actions tl-direct-actions">
        <Button
          variant="secondary"
          className="button-sm"
          aria-expanded={mode === 'move'}
          disabled={!online}
          onClick={() => open('move')}
        >
          <Icon name="schedule" size={17} />
          Move now
        </Button>
        <Button
          variant="secondary"
          className="button-sm"
          aria-expanded={mode === 'cancel'}
          disabled={!online}
          onClick={() => open('cancel')}
        >
          <Icon name="event_busy" size={17} />
          Cancel event
        </Button>
        {!online ? <p className="caption">Changing the schedule needs a connection.</p> : null}
      </div>
      {mode === 'move' ? (
        <form
          className="tl-direct-form"
          aria-label="Move this event"
          onSubmit={(e) => {
            e.preventDefault();
            submitMove();
          }}
        >
          <p className="caption">
            Published at once: the change is checked like a draft publication, and people are told
            the old and new times.
          </p>
          <LocalDateTimeField
            label="New start"
            value={start}
            onChange={setStart}
            timeZone={timezone}
            required
            showErrors={attempted}
          />
          <LocalDateTimeField
            label="New end"
            value={end}
            onChange={setEnd}
            timeZone={timezone}
            required
            showErrors={attempted}
          />
          {attempted && order ? (
            <span className="error-text" role="alert">
              {order}
            </span>
          ) : null}
          <label htmlFor={`move-reason-${event.id}`}>Reason (optional)</label>
          <input
            id={`move-reason-${event.id}`}
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit" busy={move.isProcessing} disabled={!online}>
            Move and publish
          </Button>
          {move.error ? (
            <CommandError
              error={move.error}
              onRetry={() => void move.resend().catch(() => undefined)}
              onReload={reloadMove}
              action="Moving the event"
            />
          ) : null}
        </form>
      ) : null}
      {mode === 'cancel' ? (
        <form
          className="tl-direct-form"
          aria-label="Cancel this event"
          onSubmit={(e) => {
            e.preventDefault();
            submitCancel();
          }}
        >
          <label htmlFor={`cancel-reason-${event.id}`}>Reason people are told</label>
          <input
            id={`cancel-reason-${event.id}`}
            value={reason}
            maxLength={2000}
            aria-invalid={attempted && !reason.trim() ? true : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          {attempted && !reason.trim() ? (
            <span className="error-text" role="alert">
              Enter the reason for canceling.
            </span>
          ) : null}
          <Button
            type="submit"
            className="button-danger"
            busy={cancel.isProcessing}
            disabled={!online}
          >
            Cancel and notify
          </Button>
          {cancel.error ? (
            <CommandError
              error={cancel.error}
              onRetry={() => void cancel.resend().catch(() => undefined)}
              onReload={reloadCancel}
              action="Canceling the event"
            />
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

/** "Message attendees": the composer with the event's teams and participants as the audience. */
export function MessageAttendees({ event }: { event: Event }) {
  const allowed = useActionAllowed('scheduling.read_event_detail', event.facilityId);
  const mayCompose = useActionAllowed('communications.compose', event.facilityId);
  const [open, setOpen] = useState(false);
  const detail = useApiQuery({
    path: '/events/{id}/detail',
    request: { path: { id: event.id } },
    enabled: allowed,
  });
  const audience = detail.data?.messageAudience;
  if (!allowed || !mayCompose || !audience) return null;
  const empty = audience.teamEntryIds.length + audience.subjectPersonIds.length === 0;
  return (
    <div className="tl-message">
      <Button
        variant="secondary"
        className="button-sm"
        aria-expanded={open}
        disabled={empty}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chat" size={17} />
        Message attendees
      </Button>
      {empty ? <span className="caption">Nobody is committed to this event yet.</span> : null}
      {open && !empty ? (
        <div className="tl-composer">
          <Composer
            defaults={{
              teamEntryIds: audience.teamEntryIds,
              subjectPersonIds: audience.subjectPersonIds,
              subject: { type: 'event', id: event.id },
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
