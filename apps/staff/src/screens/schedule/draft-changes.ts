/**
 * Schedule draft changes as the API models them (SPK-SCHED-005, `DraftChangeInput` and
 * `DraftChange` in packages/contracts/src/api/scheduling.ts): create, move, cancel, resize,
 * resource_change, each naming its target event except a create of a new event. Helpers here turn
 * the saved form back into input for autosave, describe a change in words (old and new details,
 * facility local time), and convert a previewed series edit into per-event changes (SPK-SCHED-007).
 */
import { useQueries } from '@tanstack/react-query';
import { apiQueryKey, type ApiError, type ApiResponse, type Schema } from '@sportspark/api-client';
import { useApi } from '../../providers/AppProviders';
import { EVENT_KIND_LABEL } from '../../features/schedule-facilities/labels';
import { namesOf } from '../../features/schedule-facilities/inventory';
import { formatInstant, formatRange } from '../../features/schedule-facilities/time';

export type DraftChangeInput = Schema<'DraftChangeInput'>;
export type DraftChange = Schema<'DraftChange'>;
export type ScheduleEvent = Schema<'Event'>;
export type SeriesEditPreview = Schema<'SeriesEditPreview'>;

export const CHANGE_KIND_LABEL: Record<DraftChangeInput['kind'], string> = {
  create: 'New event',
  move: 'Move',
  cancel: 'Cancel',
  resize: 'Change length',
  resource_change: 'Relocate',
};

/** The saved change as autosave input (the API re-captures base revisions on save). */
export function toInput(change: DraftChange): DraftChangeInput {
  const input: DraftChangeInput = { kind: change.kind, proposed: change.proposed };
  if (change.targetEventId) input.targetEventId = change.targetEventId;
  if (change.resourceIds.length > 0) input.resourceIds = change.resourceIds;
  return input;
}

/** One line in words: what changes, from what, to what (SPK-SCHED-007 "show exactly which events change"). */
export function describeChange(
  change: DraftChangeInput,
  target: ScheduleEvent | undefined,
  names: ReadonlyMap<string, string>,
  timeZone: string,
): { title: string; detail: string } {
  const p = change.proposed ?? {};
  const title = p.title ?? target?.title ?? (change.targetEventId ? 'An event' : 'Untitled event');
  const before = target
    ? `${formatRange(target.scheduledStart, target.scheduledEnd, timeZone)} on ${namesOf(target.resourceIds, names)}`
    : null;
  const newStart = p.scheduledStart ?? target?.scheduledStart;
  const newEnd = p.scheduledEnd ?? target?.scheduledEnd;
  const resources = change.resourceIds?.length ? change.resourceIds : (target?.resourceIds ?? []);
  const after =
    newStart && newEnd
      ? `${formatRange(newStart, newEnd, timeZone)} on ${namesOf(resources, names)}`
      : 'time not set';
  switch (change.kind) {
    case 'create':
      return change.targetEventId
        ? { title: `Publish draft event: ${title}`, detail: before ?? 'Draft event' }
        : {
            title: `New ${p.kind ? EVENT_KIND_LABEL[p.kind].toLowerCase() : 'event'}: ${title}`,
            detail: after,
          };
    case 'cancel':
      return {
        title: `Cancel: ${title}`,
        detail: `${before ?? 'Event details not loaded'}${p.reason ? `. Reason: ${p.reason}` : ''}`,
      };
    case 'move':
      return { title: `Move: ${title}`, detail: `Was ${before ?? 'not loaded'}. Now ${after}.` };
    case 'resize':
      return {
        title: `Change length: ${title}`,
        detail: `Was ${before ?? 'not loaded'}. Now ${after}.`,
      };
    case 'resource_change':
      return {
        title: `Relocate: ${title}`,
        detail: `Was on ${target ? namesOf(target.resourceIds, names) : 'not loaded'}. Now on ${namesOf(resources, names)}.`,
      };
  }
}

/**
 * Turns a previewed series edit (POST /event-series/{id}/edits with preview: true) into draft
 * changes for exactly the listed events, so nothing is committed or announced before publication.
 */
export function changesFromSeriesPreview(preview: SeriesEditPreview): DraftChangeInput[] {
  return preview.affected.map((a) => {
    if (a.after === null) return { kind: 'cancel', targetEventId: a.eventId, proposed: {} };
    const beforeResources = a.before.resources
      .map((r) => r.id)
      .sort()
      .join(',');
    const afterResources = a.after.resources.map((r) => r.id);
    const resourcesChanged = afterResources.slice().sort().join(',') !== beforeResources;
    const timesChanged =
      a.after.scheduledStart !== a.before.scheduledStart ||
      a.after.scheduledEnd !== a.before.scheduledEnd;
    if (!timesChanged && resourcesChanged) {
      return { kind: 'resource_change', targetEventId: a.eventId, resourceIds: afterResources };
    }
    const change: DraftChangeInput = {
      kind: 'move',
      targetEventId: a.eventId,
      proposed: {
        scheduledStart: a.after.scheduledStart,
        scheduledEnd: a.after.scheduledEnd,
        ...(a.after.title !== a.before.title ? { title: a.after.title } : {}),
      },
    };
    if (resourcesChanged) change.resourceIds = afterResources;
    return change;
  });
}

export function previewLine(item: SeriesEditPreview['affected'][number], timeZone: string): string {
  const before = `${formatRange(item.before.scheduledStart, item.before.scheduledEnd, timeZone)} on ${item.before.resources.map((r) => r.name).join(', ')}`;
  if (item.after === null) return `Occurrence ${item.occurrenceIndex + 1}: ${before}, canceled`;
  const after = `${formatRange(item.after.scheduledStart, item.after.scheduledEnd, timeZone)} on ${item.after.resources.map((r) => r.name).join(', ')}`;
  return `Occurrence ${item.occurrenceIndex + 1}: was ${before}; becomes ${after}`;
}

export function savedAtLabel(iso: string, timeZone: string): string {
  return formatInstant(iso, timeZone);
}

/**
 * Current state of the events a draft targets (`GET /v1/events/{id}`, the same cache entries as
 * `useApiQuery`), to show old details and detect a base revision that is no longer current.
 */
export function useTargetEvents(ids: readonly string[]) {
  const api = useApi();
  const unique = [...new Set(ids)];
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: apiQueryKey('/events/{id}', { path: { id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.request('get', '/events/{id}', { path: { id }, signal }),
    })),
  });
  const map = new Map<string, { event?: ScheduleEvent; error: ApiError | null }>();
  unique.forEach((id, i) => {
    const r = results[i];
    map.set(id, {
      event: (r?.data as ApiResponse<ScheduleEvent> | undefined)?.data,
      error: (r?.error as ApiError | null | undefined) ?? null,
    });
  });
  return map;
}
