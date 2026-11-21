/**
 * Moving or resizing a booking by dragging it (handoff S 3e; INTERACTIONS 1b rows 4 and 5, 1a row
 * 4; SPK-SCHED-005, SPK-SCHED-006, SPK-COMMS-005). Every move goes through the schedule's own
 * rules, with no new command:
 *
 * 1. The drop writes a one-change schedule draft (`POST /v1/schedule-drafts`: a `move`, `resize` or
 *    `resource_change` of the event, with the event revision the draft captures) and validates it
 *    (`POST /v1/schedule-drafts/{id}/validate`): the API's full conflict detection (conflict units,
 *    buffers, closures, operating hours, fixture obligations) answers before anyone is told.
 * 2. A refused move is discarded and the block snaps back, naming what it hits.
 * 3. A valid move waits, drawn where it was dropped, with a toast that stays until a choice:
 *    **Notify** publishes the draft (`POST /v1/schedule-drafts/{id}/publish`), which commits the
 *    move under the database exclusion constraint and sends the change notice with the old and new
 *    details; **Undo** discards the draft (`POST /v1/schedule-drafts/{id}/discard`). Families are
 *    not told before Notify. A draft left open (the page closed) stays in Drafts and on the grid
 *    as a dashed ghost with Publish and Delete.
 *
 * Bookings (rentals and parties) follow their event: enrollment's `booking_follow_event` handler
 * moves the booking's times and spaces once the publication commits.
 *
 * Offered only to roles that both manage drafts and publish (scheduling.manage_drafts,
 * scheduling.publish_schedule); others read why. Offline, nothing moves.
 */
import type { Schema } from '@sportspark/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { asApiError, useIntentSend } from '../../api/useIntentSend';
import { useActionAllowed } from '../../features/schedule-facilities/permission';
import { useApi, useApp } from '../../providers/AppProviders';
import { useToast } from '../../ui/Toast';
import { hourLabel, type TimelineBlock } from './schedule-model';

type DraftChangeInput = Schema<'DraftChangeInput'>;

export const SCHEDULE_INVALIDATE: readonly (readonly unknown[])[] = [
  ['api', '/events'],
  ['api', '/schedule-drafts'],
  ['api', '/events/{id}/detail'],
  ['api', '/bookings/{id}'],
  ['api', '/bookings'],
  ['api', '/today'],
  ['api', '/facilities/{id}/operating-status'],
];

export interface MoveProposal {
  block: TimelineBlock;
  start: number;
  end: number;
  resourceIds: readonly string[];
  /** A resize keeps the space and changes a boundary; a move may change both. */
  mode: 'move' | 'resize';
  /** The refund note a paid rental needs when it is shortened (INTERACTIONS 1b row 5). */
  note?: string;
}

export type PendingPhase = 'checking' | 'waiting' | 'publishing';

export interface PendingMove {
  eventId: string;
  start: number;
  end: number;
  resourceIds: readonly string[];
  phase: PendingPhase;
  draftId: string | null;
}

export interface MoveAbility {
  allowed: boolean;
  /** Why dragging is off, in a sentence (permission or connection); null when allowed. */
  reason: string | null;
}

/** Whether this viewer may move bookings by dragging, and why not. */
export function useMoveAbility(facilityId: string | null | undefined): MoveAbility {
  const { online } = useApp();
  const drafts = useActionAllowed('scheduling.manage_drafts', facilityId);
  const publish = useActionAllowed('scheduling.publish_schedule', facilityId);
  if (!drafts || !publish) {
    return {
      allowed: false,
      reason: 'Moving a booking needs a scheduler or a manager who publishes the schedule.',
    };
  }
  if (!online) return { allowed: false, reason: 'Moving a booking needs a connection.' };
  return { allowed: true, reason: null };
}

function changeOf(p: MoveProposal): DraftChangeInput {
  const event = p.block.event;
  if (!event) throw new Error('Only an event can be moved.');
  const start = new Date(p.start).toISOString();
  const end = new Date(p.end).toISOString();
  const sameTimes = p.start === p.block.start && p.end === p.block.end;
  const reason = p.note?.trim() ? { reason: p.note.trim() } : {};
  if (sameTimes) {
    return { kind: 'resource_change', targetEventId: event.id, resourceIds: [...p.resourceIds] };
  }
  if (p.mode === 'resize') {
    return {
      kind: 'resize',
      targetEventId: event.id,
      proposed: { scheduledStart: start, scheduledEnd: end, ...reason },
    };
  }
  return {
    kind: 'move',
    targetEventId: event.id,
    proposed: { scheduledStart: start, scheduledEnd: end, ...reason },
    resourceIds: [...p.resourceIds],
  };
}

/** What the first refusing issue of a validation says, in a sentence. */
export function refusalOf(draft: Schema<'ScheduleDraft'>): string {
  const issue = draft.validationResults?.issues.find((i) => i.severity === 'error');
  return issue?.detail?.message ?? issue?.message ?? 'The schedule refused the move.';
}

export function useScheduleMove(context: {
  facilityId: string;
  timeZone: string;
  spaceName: (id: string) => string;
  /** After a publication: show the latest schedule (the change is the viewer's own). */
  onPublished?: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const { send, refresh } = useIntentSend(SCHEDULE_INVALIDATE);
  const [pending, setPending] = useState<ReadonlyMap<string, PendingMove>>(new Map());
  const contextRef = useRef(context);
  contextRef.current = context;

  const update = useCallback((eventId: string, next: PendingMove | null) => {
    setPending((prev) => {
      const map = new Map(prev);
      if (next) map.set(eventId, next);
      else map.delete(eventId);
      return map;
    });
  }, []);

  // A move waiting for Notify or Undo is lost if the page closes before the choice: say so.
  const hasWaiting = [...pending.values()].some((p) => p.phase !== 'checking');
  useEffect(() => {
    if (!hasWaiting) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasWaiting]);

  const affected = useCallback(
    async (eventId: string): Promise<number | null> => {
      try {
        const detail = await api.get('/events/{id}/detail', { path: { id: eventId } });
        return detail.attendees.total;
      } catch {
        return null;
      }
    },
    [api],
  );

  const propose = useCallback(
    async (p: MoveProposal): Promise<void> => {
      const event = p.block.event;
      if (!event) return;
      const { facilityId, timeZone, spaceName } = contextRef.current;
      const intent = `${event.id}:${p.start}:${p.end}:${p.resourceIds.join(',')}`;
      update(event.id, {
        eventId: event.id,
        start: p.start,
        end: p.end,
        resourceIds: p.resourceIds,
        phase: 'checking',
        draftId: null,
      });
      let draft: Schema<'ScheduleDraft'>;
      try {
        draft = await send(
          `create:${intent}`,
          'post',
          '/schedule-drafts',
          {
            body: {
              facilityId,
              name: `${p.mode === 'resize' ? 'Resize' : 'Move'}: ${event.title}`.slice(0, 200),
              changes: [changeOf(p)],
              ...(p.note?.trim() ? { reason: p.note.trim() } : {}),
            },
          },
          { refresh: false },
        );
        draft = await send(
          `validate:${draft.id}`,
          'post',
          '/schedule-drafts/{id}/validate',
          { path: { id: draft.id }, body: {} },
          { refresh: false },
        );
      } catch (cause) {
        update(event.id, null);
        toast.show({
          tone: 'error',
          message: `${event.title} was not moved: ${asApiError(cause).message}`,
        });
        return;
      }
      if (draft.validationResults && !draft.validationResults.ok) {
        const why = refusalOf(draft);
        update(event.id, null);
        // Nothing to keep: the refused draft is discarded so it does not linger in Drafts.
        void send(
          `discard:${draft.id}`,
          'post',
          '/schedule-drafts/{id}/discard',
          { path: { id: draft.id }, body: { expectedRevision: draft.revision } },
          { refresh: false },
        ).catch(() => undefined);
        toast.show({ tone: 'error', message: `Not moved: ${why}` });
        return;
      }
      const checked = draft;
      update(event.id, {
        eventId: event.id,
        start: p.start,
        end: p.end,
        resourceIds: p.resourceIds,
        phase: 'waiting',
        draftId: checked.id,
      });
      const people = await affected(event.id);
      const where = p.resourceIds.map(spaceName).join(', ');
      const what = `${event.title} → ${where}, ${hourLabel(p.start, timeZone)}`;
      const count =
        people === null
          ? ''
          : people === 0
            ? ' Nobody is booked on it yet.'
            : ` ${people} ${people === 1 ? 'person' : 'people'} affected.`;
      const notifyLabel =
        people === null || people === 0
          ? 'Publish'
          : `Notify ${people} ${people === 1 ? 'person' : 'people'}`;

      const publish = async (): Promise<void> => {
        update(event.id, {
          eventId: event.id,
          start: p.start,
          end: p.end,
          resourceIds: p.resourceIds,
          phase: 'publishing',
          draftId: checked.id,
        });
        try {
          await send(`publish:${checked.id}`, 'post', '/schedule-drafts/{id}/publish', {
            path: { id: checked.id },
            body: {},
          });
          await refresh();
          contextRef.current.onPublished?.();
          update(event.id, null);
          toast.show({
            tone: 'success',
            message:
              people && people > 0
                ? `Moved. ${people} ${people === 1 ? 'person was' : 'people were'} told.`
                : 'Moved and published.',
          });
        } catch (cause) {
          update(event.id, null);
          void refresh();
          toast.show({
            tone: 'error',
            message: `The move was not published: ${asApiError(cause).message}`,
            action: { label: 'Try again', onClick: () => void propose(p) },
          });
        }
      };
      const undo = async (): Promise<void> => {
        update(event.id, null);
        try {
          await send(`discard:${checked.id}`, 'post', '/schedule-drafts/{id}/discard', {
            path: { id: checked.id },
            body: { expectedRevision: checked.revision },
          });
        } catch (cause) {
          toast.show({
            tone: 'error',
            message: `Undo did not reach the server: ${asApiError(cause).message}. The move is still a draft.`,
          });
        }
      };
      toast.show({
        tone: 'info',
        persistent: true,
        message: (
          <>
            <b>Next drop:</b> {what}.{count} Not told yet.
          </>
        ),
        action: { label: notifyLabel, primary: true, onClick: () => void publish() },
        onUndo: () => void undo(),
        onClose: (reason) => {
          // A newer toast replaced this one: the move stays a draft with Publish and Delete.
          if (reason === 'replaced') {
            update(event.id, null);
            void refresh();
          }
        },
      });
    },
    [affected, refresh, send, toast, update],
  );

  return useMemo(() => ({ pending, propose }), [pending, propose]);
}
