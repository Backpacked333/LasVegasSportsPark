/**
 * SCR-S-04 forms that add changes to a schedule draft (SPK-SCHED-005, SPK-SCHED-007,
 * SPK-SCHED-008, SPK-UX-009). Every time is entered in facility local time and resolved to UTC,
 * asking which occurrence when clocks go back and refusing a time that does not exist. Moving an
 * event is done with these fields, not by dragging, so keyboard users have the same path.
 *
 * For an event in a recurring series the user chooses the scope: this occurrence, this and future
 * occurrences, or the entire series. A wider scope is previewed with
 * `POST /v1/event-series/{id}/edits` and `preview: true` (nothing is committed), the exact events
 * that would change are listed, and they are added to the draft as individual changes so that
 * nothing is published or announced before the draft is (SPK-SCHED-005 "drafts do not send final
 * customer notices"). Past, played or attended occurrences keep their identity (the API leaves them
 * out of the preview).
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError } from '../../features/schedule-facilities/CommandError';
import type { FacilityContext } from '../../features/schedule-facilities/facility-scope';
import { namesOf, resourceNames } from '../../features/schedule-facilities/inventory';
import { EVENT_KIND_LABEL } from '../../features/schedule-facilities/labels';
import {
  LocalDateTimeField,
  emptyLocal,
  localFromInstant,
  toInstant,
  type LocalDateTime,
} from '../../features/schedule-facilities/LocalDateTimeField';
import { ResourceChecklist } from '../../features/schedule-facilities/ResourceChecklist';
import {
  formatRange,
  localDateOf,
  localDaysWindow,
  minutesBetween,
} from '../../features/schedule-facilities/time';
import {
  changesFromSeriesPreview,
  previewLine,
  type DraftChangeInput,
  type ScheduleEvent,
  type SeriesEditPreview,
} from './draft-changes';

type Resource = Schema<'Resource'>;
type EventKind = Schema<'Event'>['kind'];
type ChangeAction = 'move' | 'resize' | 'resource_change' | 'cancel';
type Scope = 'one' | 'this_and_future' | 'entire_series';

const EVENT_KINDS = Object.keys(EVENT_KIND_LABEL) as EventKind[];

function optionalMinutes(text: string): number | undefined | 'invalid' {
  if (text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 1440 ? n : 'invalid';
}

export function NewEventForm({
  facility,
  resources,
  onAdd,
  disabled,
}: {
  facility: FacilityContext;
  resources: readonly Resource[];
  onAdd: (changes: DraftChangeInput[]) => void;
  disabled: boolean;
}) {
  const tz = facility.timezone;
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'' | EventKind>('');
  const [format, setFormat] = useState('');
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [start, setStart] = useState<LocalDateTime>(emptyLocal());
  const [end, setEnd] = useState<LocalDateTime>(emptyLocal());
  const [setup, setSetup] = useState('');
  const [cleanup, setCleanup] = useState('');
  const [attempted, setAttempted] = useState(false);

  const startAt = toInstant(start, tz);
  const endAt = toInstant(end, tz);
  const setupMinutes = optionalMinutes(setup);
  const cleanupMinutes = optionalMinutes(cleanup);
  const order =
    startAt.ok && endAt.ok && startAt.instant >= endAt.instant
      ? 'The end must be after the start.'
      : null;
  const problems = {
    title: title.trim() ? null : 'Enter a title.',
    kind: kind ? null : 'Choose the kind of event.',
    resources: resourceIds.length > 0 ? null : 'Choose at least one space.',
    buffers:
      setupMinutes === 'invalid' || cleanupMinutes === 'invalid'
        ? 'Buffers are whole minutes from 0 to 1440.'
        : null,
  };
  const valid =
    startAt.ok && endAt.ok && !order && Object.values(problems).every((p) => p === null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (!valid || !startAt.ok || !endAt.ok || !kind) return;
    onAdd([
      {
        kind: 'create',
        resourceIds,
        proposed: {
          kind,
          title: title.trim(),
          scheduledStart: startAt.instant,
          scheduledEnd: endAt.instant,
          ...(format.trim() ? { format: format.trim() } : {}),
          ...(typeof setupMinutes === 'number' ? { setupMinutes } : {}),
          ...(typeof cleanupMinutes === 'number' ? { cleanupMinutes } : {}),
        },
      },
    ]);
    setTitle('');
    setFormat('');
    setResourceIds([]);
    setStart(emptyLocal());
    setEnd(emptyLocal());
    setSetup('');
    setCleanup('');
    setAttempted(false);
  };

  const show = (p: string | null) => (attempted ? p : null);
  return (
    <form className="form" onSubmit={submit} aria-labelledby="new-event-title" noValidate>
      <h4 id="new-event-title">Add a new event</h4>
      <label htmlFor="new-event-name">Title</label>
      <input
        id="new-event-name"
        value={title}
        maxLength={200}
        aria-invalid={show(problems.title) ? true : undefined}
        onChange={(e) => setTitle(e.target.value)}
      />
      {show(problems.title) ? <span className="error-text">{problems.title}</span> : null}
      <label htmlFor="new-event-kind">Kind</label>
      <select
        id="new-event-kind"
        value={kind}
        aria-invalid={show(problems.kind) ? true : undefined}
        onChange={(e) => setKind(e.target.value as '' | EventKind)}
      >
        <option value="">Choose…</option>
        {EVENT_KINDS.map((k) => (
          <option key={k} value={k}>
            {EVENT_KIND_LABEL[k]}
          </option>
        ))}
      </select>
      {show(problems.kind) ? <span className="error-text">{problems.kind}</span> : null}
      <label htmlFor="new-event-format">Format (optional, for example 7v7)</label>
      <input
        id="new-event-format"
        value={format}
        maxLength={50}
        onChange={(e) => setFormat(e.target.value)}
      />
      <ResourceChecklist
        legend="Spaces"
        resources={resources}
        value={resourceIds}
        onChange={setResourceIds}
        error={show(problems.resources)}
      />
      <LocalDateTimeField
        label="Starts"
        value={start}
        onChange={setStart}
        timeZone={tz}
        showErrors={attempted}
      />
      <LocalDateTimeField
        label="Ends"
        value={end}
        onChange={setEnd}
        timeZone={tz}
        showErrors={attempted}
      />
      {order ? <span className="error-text">{order}</span> : null}
      <label htmlFor="new-event-setup">Setup minutes (empty: the space's default)</label>
      <input
        id="new-event-setup"
        inputMode="numeric"
        value={setup}
        onChange={(e) => setSetup(e.target.value)}
      />
      <label htmlFor="new-event-cleanup">Cleanup minutes (empty: the space's default)</label>
      <input
        id="new-event-cleanup"
        inputMode="numeric"
        value={cleanup}
        onChange={(e) => setCleanup(e.target.value)}
      />
      {show(problems.buffers) ? <span className="error-text">{problems.buffers}</span> : null}
      <Button type="submit" disabled={disabled}>
        Add new event to draft
      </Button>
    </form>
  );
}

function eventOptionLabel(e: ScheduleEvent, names: ReadonlyMap<string, string>, tz: string) {
  return `${formatRange(e.scheduledStart, e.scheduledEnd, tz)} · ${e.title} · ${namesOf(e.resourceIds, names)}${e.seriesId ? ' · recurring' : ''}`;
}

export function ExistingEventForm({
  facility,
  resources,
  onAdd,
  disabled,
}: {
  facility: FacilityContext;
  resources: readonly Resource[];
  onAdd: (changes: DraftChangeInput[]) => void;
  disabled: boolean;
}) {
  const tz = facility.timezone;
  const now = useNow();
  const names = resourceNames(resources);
  const [day, setDay] = useState(facility.localDate ?? localDateOf(now, tz));
  const range = localDaysWindow(day, 1, tz);
  const events = useApiQuery({
    path: '/events',
    request: {
      query: {
        facilityId: facility.id,
        start: range.start,
        end: range.end,
        status: 'published',
        limit: 200,
      },
    },
  });
  const [eventId, setEventId] = useState('');
  const [action, setAction] = useState<'' | ChangeAction>('');
  const [scope, setScope] = useState<'' | Scope>('');
  const [start, setStart] = useState<LocalDateTime>(emptyLocal());
  const [end, setEnd] = useState<LocalDateTime>(emptyLocal());
  const [newResources, setNewResources] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [preview, setPreview] = useState<SeriesEditPreview | null>(null);
  const previewCommand = useApiCommand('post', '/event-series/{id}/edits');

  const event = events.data?.items.find((e) => e.id === eventId);
  const startAt = toInstant(start, tz);
  const endAt = toInstant(end, tz);

  const select = (id: string) => {
    setEventId(id);
    setPreview(null);
    setScope('');
    previewCommand.reset();
    const chosen = events.data?.items.find((e) => e.id === id);
    if (chosen) {
      setStart(localFromInstant(chosen.scheduledStart, tz));
      setEnd(localFromInstant(chosen.scheduledEnd, tz));
      setNewResources(chosen.resourceIds);
    }
  };

  const problem = (() => {
    if (!event) return 'Choose an event.';
    if (!action) return 'Choose what to change.';
    if (event.seriesId && !scope) return 'Choose which occurrences to change.';
    if (action === 'move' && (!startAt.ok || !endAt.ok)) return 'Enter a valid new start and end.';
    if (action === 'resize' && !endAt.ok) return 'Enter a valid new end.';
    if (
      (action === 'move' || action === 'resize') &&
      startAt.ok &&
      endAt.ok &&
      startAt.instant >= endAt.instant
    )
      return 'The end must be after the start.';
    if (action === 'resource_change' && newResources.length === 0)
      return 'Choose at least one space.';
    return null;
  })();

  const single = (): DraftChangeInput | null => {
    if (!event || !action) return null;
    switch (action) {
      case 'move':
        return startAt.ok && endAt.ok
          ? {
              kind: 'move',
              targetEventId: event.id,
              proposed: { scheduledStart: startAt.instant, scheduledEnd: endAt.instant },
              ...(newResources.join() !== event.resourceIds.join()
                ? { resourceIds: newResources }
                : {}),
            }
          : null;
      case 'resize':
        return endAt.ok
          ? { kind: 'resize', targetEventId: event.id, proposed: { scheduledEnd: endAt.instant } }
          : null;
      case 'resource_change':
        return { kind: 'resource_change', targetEventId: event.id, resourceIds: newResources };
      case 'cancel':
        return {
          kind: 'cancel',
          targetEventId: event.id,
          proposed: reason.trim() ? { reason: reason.trim() } : {},
        };
    }
  };

  const reset = () => {
    setEventId('');
    setAction('');
    setScope('');
    setReason('');
    setPreview(null);
    setAttempted(false);
    previewCommand.reset();
  };

  const requestPreview = () => {
    if (!event?.seriesId || !scope || scope === 'one' || !action) return;
    const changes =
      action === 'cancel'
        ? { cancel: true }
        : action === 'resource_change'
          ? { resourceIds: newResources }
          : action === 'resize' && endAt.ok
            ? { durationMinutes: minutesBetween(event.scheduledStart, endAt.instant) }
            : startAt.ok && endAt.ok
              ? {
                  localStartTime: start.time,
                  durationMinutes: minutesBetween(startAt.instant, endAt.instant),
                }
              : {};
    void previewCommand
      .submit({
        path: { id: event.seriesId },
        body: {
          scope,
          ...(event.occurrenceIndex !== null ? { occurrenceIndex: event.occurrenceIndex } : {}),
          preview: true,
          changes,
        },
      })
      .then(setPreview)
      .catch(() => undefined);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (problem) return;
    if (event?.seriesId && scope && scope !== 'one') {
      requestPreview();
      return;
    }
    const change = single();
    if (change) {
      onAdd([change]);
      reset();
    }
  };

  return (
    <form className="form" onSubmit={submit} aria-labelledby="existing-event-title" noValidate>
      <h4 id="existing-event-title">Change a published event</h4>
      <label htmlFor="existing-event-day">Day ({tz})</label>
      <input
        id="existing-event-day"
        type="date"
        value={day}
        onChange={(e) => {
          if (e.target.value) {
            setDay(e.target.value);
            reset();
          }
        }}
      />
      <label htmlFor="existing-event-select">Event</label>
      <select
        id="existing-event-select"
        value={eventId}
        disabled={!events.data}
        onChange={(e) => select(e.target.value)}
      >
        <option value="">
          {events.data
            ? events.data.items.length === 0
              ? 'No published events on this day'
              : 'Choose an event…'
            : events.error
              ? `Events could not be loaded (${events.error.code})`
              : 'Loading events…'}
        </option>
        {(events.data?.items ?? []).map((ev) => (
          <option key={ev.id} value={ev.id}>
            {eventOptionLabel(ev, names, tz)}
          </option>
        ))}
      </select>
      {event ? (
        <>
          <fieldset>
            <legend>Change</legend>
            {(
              [
                ['move', 'Move to another time (and optionally space)'],
                ['resize', 'Change when it ends'],
                ['resource_change', 'Relocate to other spaces'],
                ['cancel', 'Cancel it'],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="existing-event-action"
                  checked={action === value}
                  onChange={() => {
                    setAction(value);
                    setPreview(null);
                  }}
                />{' '}
                {label}
              </label>
            ))}
          </fieldset>
          {event.seriesId ? (
            <fieldset>
              <legend>Which occurrences (this event repeats)</legend>
              {(
                [
                  ['one', 'Only this occurrence'],
                  ['this_and_future', 'This and future occurrences'],
                  ['entire_series', 'The entire series'],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="existing-event-scope"
                    checked={scope === value}
                    onChange={() => {
                      setScope(value);
                      setPreview(null);
                    }}
                  />{' '}
                  {label}
                </label>
              ))}
              {scope && scope !== 'one' ? (
                <p className="caption">
                  A series change keeps each occurrence on its own date and changes the time of day,
                  length or spaces. You will see exactly which events change before anything is
                  added to the draft.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          {action === 'move' ? (
            <>
              <LocalDateTimeField
                label="New start"
                value={start}
                onChange={setStart}
                timeZone={tz}
                showErrors={attempted}
              />
              <LocalDateTimeField
                label="New end"
                value={end}
                onChange={setEnd}
                timeZone={tz}
                showErrors={attempted}
              />
              <ResourceChecklist
                legend="Spaces"
                resources={resources}
                value={newResources}
                onChange={setNewResources}
              />
            </>
          ) : null}
          {action === 'resize' ? (
            <LocalDateTimeField
              label="New end"
              value={end}
              onChange={setEnd}
              timeZone={tz}
              showErrors={attempted}
            />
          ) : null}
          {action === 'resource_change' ? (
            <ResourceChecklist
              legend="New spaces"
              resources={resources}
              value={newResources}
              onChange={setNewResources}
            />
          ) : null}
          {action === 'cancel' ? (
            <>
              <label htmlFor="existing-event-reason">
                Reason shown with the cancellation (optional)
              </label>
              <input
                id="existing-event-reason"
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
              />
            </>
          ) : null}
        </>
      ) : null}
      {attempted && problem ? (
        <span className="error-text" role="alert">
          {problem}
        </span>
      ) : null}
      <Button type="submit" disabled={disabled} busy={previewCommand.isProcessing}>
        {event?.seriesId && scope && scope !== 'one'
          ? 'Preview affected events'
          : 'Add change to draft'}
      </Button>
      {previewCommand.error ? (
        <CommandError
          error={previewCommand.error}
          onRetry={requestPreview}
          action="Previewing a series change"
        />
      ) : null}
      {preview ? (
        <section aria-labelledby="series-preview-title" data-testid="series-preview">
          <h5 id="series-preview-title">
            {preview.affected.length} event{preview.affected.length === 1 ? '' : 's'} would change
          </h5>
          <ul className="list" aria-label="Events that would change">
            {preview.affected.map((a) => (
              <li key={a.eventId}>{previewLine(a, tz)}</li>
            ))}
          </ul>
          <p className="caption">
            {preview.unchangedEventIds.length} other occurrence
            {preview.unchangedEventIds.length === 1 ? '' : 's'} (including past, played or attended
            ones) keep their details and identity.
          </p>
          <Button
            disabled={disabled || preview.affected.length === 0}
            onClick={() => {
              onAdd(changesFromSeriesPreview(preview));
              reset();
            }}
          >
            Add {preview.affected.length} change{preview.affected.length === 1 ? '' : 's'} to the
            draft
          </Button>
        </section>
      ) : null}
    </form>
  );
}
