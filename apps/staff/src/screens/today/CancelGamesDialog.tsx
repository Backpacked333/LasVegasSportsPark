/**
 * S 3b Cancel for weather (from "Cancel game" in the session drawer). Lightning never hits one
 * field, so it offers every activity starting in the same window (from the game's start, two
 * hours), outdoor ones (pitches and their halves) ticked and indoor ones unticked. On the right,
 * the message families get (mobile 3g wording) with an optional added line; the red button states
 * the count. Confirming closes the dialog and shows "4 games cancelled · Undo (2:00)": the
 * cancellations are sent when the undo window closes (`pending-cancellations`), each through its
 * owning module:
 *
 * - a league game: `PATCH /v1/fixtures/{id}` with action cancel (competition; the expected
 *   revision read from `GET /v1/fixtures/{id}`);
 * - a class session: `POST /v1/sessions/{id}/cancel` (catalog);
 * - a booked rental or party: `POST /v1/bookings/{id}/cancel` (enrollment: refunds follow the
 *   booking's terms);
 * - any other published event: `POST /v1/events/{id}/cancel` (scheduling).
 *
 * The families' message is produced by the owning modules' notices; the reason and the added line
 * travel as the command's reason. "Pick a date now" names the make-up date in the reason; it does
 * not reschedule anything (Proposed).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApi, useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { useToast } from '../../ui/Toast';
import { useFocusTrap } from '../../ui/useFocusTrap';
import { TODAY_INVALIDATE, useTodayCommands } from './today-commands';
import { scheduleCancellation, undoCancellation, UNDO_WINDOW_MS } from './pending-cancellations';
import { shortTime, type ResourceStatus, type ScheduledEvent } from './today-model';

const WINDOW_MS = 2 * 3_600_000;
const CANCELLABLE = new Set<ScheduledEvent['kind']>([
  'game',
  'practice',
  'session',
  'rental',
  'party',
  'pickup',
]);

export type CancelReason = 'lightning' | 'heat' | 'field_closed' | 'other';
const REASONS: readonly {
  value: CancelReason;
  label: string;
  icon?: IconName;
  families: string;
}[] = [
  {
    value: 'lightning',
    label: 'Lightning',
    icon: 'thunderstorm',
    families: 'Lightning in the area.',
  },
  { value: 'heat', label: 'Heat', families: 'It is too hot to play safely.' },
  { value: 'field_closed', label: 'Field closed', families: 'The field is closed.' },
  { value: 'other', label: 'Other', families: 'It cannot go ahead.' },
];

export interface CancelCandidate {
  event: ScheduledEvent;
  indoor: boolean;
  space: string;
}

/** Every activity starting in the origin's window, outdoor first by start; indoor ones flagged. */
export function cancelCandidates(
  origin: ScheduledEvent,
  events: readonly ScheduledEvent[],
  resources: readonly ResourceStatus[],
): CancelCandidate[] {
  const from = new Date(origin.scheduledStart).getTime();
  const to = from + WINDOW_MS;
  const kindOf = new Map(resources.map((r) => [r.resourceId, r]));
  const outdoor = (id: string) => {
    const r = kindOf.get(id);
    return r ? r.kind === 'pitch' || r.kind === 'subdivision' : true;
  };
  return events
    .filter((e) => e.status === 'published' && CANCELLABLE.has(e.kind))
    .filter((e) => {
      const t = new Date(e.scheduledStart).getTime();
      return e.id === origin.id || (t >= from && t < to);
    })
    .map((e) => ({
      event: e,
      indoor: !e.resourceIds.some(outdoor),
      space: e.resourceIds
        .map((id) => kindOf.get(id)?.name)
        .filter(Boolean)
        .join(', '),
    }))
    .sort(
      (a, b) =>
        Number(a.indoor) - Number(b.indoor) ||
        a.event.scheduledStart.localeCompare(b.event.scheduledStart),
    );
}

/** "Desert Foxes v Lions" style short title for the list. */
function listTitle(title: string): string {
  return title.replace(/\s+vs\s+/i, ' v ');
}

/** The design counts everything on a cancelled field as "games" (S 3b: "Cancel 4 games"). */
function noun(events: readonly ScheduledEvent[]): string {
  return events.length === 1 ? 'game' : 'games';
}

export function CancelGamesDialog({
  origin,
  events,
  resources,
  timeZone,
  onClose,
}: {
  origin: ScheduledEvent;
  events: readonly ScheduledEvent[];
  resources: readonly ResourceStatus[];
  timeZone: string;
  onClose: () => void;
}) {
  const { online, services } = useApp();
  const api = useApi();
  const toast = useToast();
  const commands = useTodayCommands();
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, true, onClose);

  const candidates = useMemo(
    () => cancelCandidates(origin, events, resources),
    [origin, events, resources],
  );
  const outdoor = candidates.filter((c) => !c.indoor);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set([origin.id, ...outdoor.map((c) => c.event.id)]),
  );
  const [reason, setReason] = useState<CancelReason>('lightning');
  const [makeup, setMakeup] = useState<'later' | 'date'>('later');
  const [makeupDate, setMakeupDate] = useState('');
  const [line, setLine] = useState('');

  const chosen = candidates.filter((c) => selected.has(c.event.id)).map((c) => c.event);
  const details = useQueries({
    queries: chosen.map((e) => ({
      queryKey: ['api', '/events/{id}/detail', { path: { id: e.id } }],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await api.request('get', '/events/{id}/detail', { path: { id: e.id }, signal })).data,
      staleTime: 60_000,
    })),
  });
  const people = details.reduce(
    (n, q) => n + ((q.data as Schema<'EventDetail'> | undefined)?.attendees.total ?? 0),
    0,
  );
  const staff = details.reduce(
    (n, q) => n + ((q.data as Schema<'EventDetail'> | undefined)?.staff.assignments.length ?? 0),
    0,
  );
  const bookings = chosen.filter((e) => e.sourceType === 'enrollment.booking').length;

  const allOutdoor = outdoor.length > 0 && outdoor.every((c) => selected.has(c.event.id));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleOutdoor = () =>
    setSelected((current) => {
      const next = new Set(current);
      for (const c of outdoor) {
        if (allOutdoor) next.delete(c.event.id);
        else next.add(c.event.id);
      }
      return next;
    });

  const reasonText = REASONS.find((r) => r.value === reason)!.families;
  const makeupText =
    makeup === 'date' && makeupDate
      ? `Make-up on ${new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${makeupDate}T12:00:00`))}.`
      : 'No make-up date yet.';
  const preview = `${reasonText} ${makeupText} You don't need to come.`;
  const commandReason = [reasonText, makeupText, line.trim()].filter(Boolean).join(' ');
  const windowEnd = new Date(new Date(origin.scheduledStart).getTime() + WINDOW_MS).toISOString();
  const count = chosen.length;
  const what = noun(chosen);

  const send = async (batch: readonly ScheduledEvent[]) => {
    const failures: string[] = [];
    for (const event of batch) {
      const key = `cancel:${event.id}`;
      try {
        if (event.sourceType === 'fixture' && event.sourceId) {
          const fixture = (
            await api.request('get', '/fixtures/{id}', { path: { id: event.sourceId } })
          ).data;
          await commands.send(
            key,
            'patch',
            '/fixtures/{id}',
            {
              path: { id: event.sourceId },
              body: { action: 'cancel', expectedRevision: fixture.revision, reason: commandReason },
            },
            { refresh: false },
          );
        } else if (event.kind === 'session' && event.sourceType === 'offering') {
          const list = (
            await api.request('get', '/sessions', {
              query: {
                facilityId: event.facilityId,
                from: event.scheduledStart,
                to: event.scheduledEnd,
              },
            })
          ).data;
          const session = list.items.find((s) => s.schedulingEventId === event.id);
          if (!session) throw new Error('its class session was not found');
          await commands.send(
            key,
            'post',
            '/sessions/{id}/cancel',
            {
              path: { id: session.sessionId },
              body: { reason: commandReason },
            },
            { refresh: false },
          );
        } else if (event.sourceType === 'enrollment.booking' && event.sourceId) {
          const booking = (
            await api.request('get', '/bookings/{id}', { path: { id: event.sourceId } })
          ).data;
          await commands.send(
            key,
            'post',
            '/bookings/{id}/cancel',
            {
              path: { id: event.sourceId },
              body: { expectedRevision: booking.revision, reason: commandReason },
            },
            { refresh: false },
          );
        } else {
          await commands.send(
            key,
            'post',
            '/events/{id}/cancel',
            {
              path: { id: event.id },
              body: { expectedRevision: event.revision, reason: commandReason },
            },
            { refresh: false },
          );
        }
      } catch (cause) {
        const message = (cause as { message?: string }).message ?? 'it was refused';
        failures.push(`${event.title}: ${message}`);
      }
    }
    // One refresh for the whole batch.
    await Promise.all(
      TODAY_INVALIDATE.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
    if (failures.length === 0) {
      toast.show({
        tone: 'success',
        message: `${batch.length} ${noun(batch)} cancelled. Families are being told.`,
      });
    } else {
      toast.show({
        tone: 'error',
        message: `${batch.length - failures.length} of ${batch.length} cancelled. Not cancelled: ${failures.join('; ')}`,
        durationMs: 12_000,
      });
    }
  };

  const confirm = () => {
    const batch = [...chosen];
    const id = scheduleCancellation(
      batch.map((e) => e.id),
      services.now().getTime(),
      () => send(batch),
    );
    toast.show({
      message: `${batch.length} ${noun(batch)} cancelled`,
      onUndo: () => {
        undoCancellation(id);
      },
      durationMs: UNDO_WINDOW_MS,
      countdown: true,
    });
    onClose();
  };

  return createPortal(
    <div className="ui-overlay ui-overlay-center">
      <div className="ui-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        className="cancel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="cancel-games"
      >
        <div className="cancel-head">
          <h3 id={titleId}>Cancel games</h3>
          <p>
            Families are told within a minute by push and email. This can be undone for 2 minutes.
          </p>
          <button type="button" className="ui-drawer-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="cancel-body">
          <div className="cancel-left">
            <fieldset className="cancel-field">
              <legend>Reason</legend>
              <div className="chip-row" role="radiogroup" aria-label="Reason">
                {REASONS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    role="radio"
                    aria-checked={reason === r.value}
                    className="choice-chip"
                    onClick={() => setReason(r.value)}
                  >
                    {r.icon ? <Icon name={r.icon} size={18} /> : null}
                    {r.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="cancel-field">
              <legend>Which games</legend>
              <ul className="cancel-list">
                {outdoor.length > 0 ? (
                  <li className="cancel-row cancel-row-all">
                    <label>
                      <input type="checkbox" checked={allOutdoor} onChange={toggleOutdoor} />
                      <b>
                        All outdoor, {shortTime(origin.scheduledStart, timeZone, true)}–
                        {shortTime(windowEnd, timeZone, true)}
                      </b>
                    </label>
                    <span className="caption">
                      {outdoor.length} {noun(outdoor.map((c) => c.event))}
                    </span>
                  </li>
                ) : null}
                {candidates.map((c) => (
                  <li className="cancel-row" key={c.event.id} data-indoor={c.indoor || undefined}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(c.event.id)}
                        onChange={() => toggle(c.event.id)}
                      />
                      <span>
                        {listTitle(c.event.title)} ·{' '}
                        {shortTime(c.event.scheduledStart, timeZone, true)}
                        {c.space ? ` ${c.space}` : ''}
                        {c.indoor ? ' · indoor' : ''}
                      </span>
                    </label>
                    {c.event.sourceType === 'enrollment.booking' ? (
                      <span className="cancel-refund">refund per terms</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </fieldset>
            <div className="cancel-field">
              <span className="cancel-label" id={`${titleId}-makeup`}>
                Make-up
              </span>
              <SegmentedControl
                label="Make-up"
                value={makeup}
                onChange={setMakeup}
                segments={[
                  { value: 'later', label: 'Decide later' },
                  { value: 'date', label: 'Pick a date now' },
                ]}
              />
              {makeup === 'date' ? (
                <label className="cancel-date">
                  <span>Make-up date</span>
                  <input
                    type="date"
                    value={makeupDate}
                    onChange={(e) => setMakeupDate(e.target.value)}
                  />
                </label>
              ) : null}
            </div>
          </div>
          <div className="cancel-right">
            <span className="cancel-label">What families will see</span>
            <div className="push-preview" aria-label="Message preview">
              <div className="push-card">
                <span className="push-icon" aria-hidden="true">
                  <Icon name="sports_soccer" size={20} />
                </span>
                <span>
                  <b>✕ {origin.title} is cancelled</b>
                  <span>
                    {preview}
                    {line.trim() ? ` ${line.trim()}` : ''}
                  </span>
                </span>
              </div>
              <span className="push-note">Each family sees their own game's name</span>
            </div>
            <label className="cancel-field cancel-line">
              <span className="cancel-label">Add a line (optional)</span>
              <textarea
                value={line}
                maxLength={300}
                onChange={(e) => setLine(e.target.value)}
                placeholder="e.g. Fields reopen at 1 PM if the storm passes."
              />
            </label>
            <p className="cancel-warning">
              <span aria-hidden="true">▲</span>{' '}
              {bookings > 0
                ? `${bookings} paid ${bookings === 1 ? 'booking is' : 'bookings are'} refunded under ${bookings === 1 ? 'its' : 'their'} terms. `
                : ''}
              Coaches and referees are told too.
            </p>
          </div>
        </div>
        <div className="cancel-foot">
          <span className="caption">
            {count} {what} · {people} {people === 1 ? 'person' : 'people'} · {staff} staff
          </span>
          <span className="spacer" />
          <Button variant="secondary" onClick={onClose}>
            Keep games
          </Button>
          <Button
            className="button-danger"
            disabled={count === 0 || !online}
            title={online ? undefined : 'Needs a connection'}
            onClick={confirm}
          >
            Cancel {count} {what} and notify
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
