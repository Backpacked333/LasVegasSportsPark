/**
 * Optimistic attendance on the coach's tiles (staff S 2d; INTERACTIONS "Global behaviours": writes
 * are optimistic with a 5 s Undo, revert on failure; attendance queues offline; SPK-ENTRY-005,
 * §4.7 invariant 9, §4.15, SPK-AT-018).
 *
 * A mark shows at once and waits on the device while its Undo toast is up (5 s): taps in that
 * window (Here, then Late, then back to Unmarked) only change the waiting mark, and Undo drops it.
 * The mark is sent when its toast closes: timed out, dismissed, or replaced by another child's
 * toast. Observations are append-only, so a first mark is `POST /v1/attendance-observations` and
 * a change of a sent mark is a correction (`POST /v1/attendance-observations/{id}/corrections`)
 * with the reason "Changed on the coach's attendance tiles"; nothing is overwritten. One intent
 * per child and state, so a retry never doubles a mark.
 *
 * Offline, a first mark is queued on the device against the roster as last loaded (the arrival
 * screens' queue, `features/operations/offline`), counted on the Queue tab and sent in order on
 * reconnection; a change of a mark the service already holds needs a connection (corrections are
 * not queued), and the toast says so.
 *
 * Leaving the screen sends what is waiting at once (nothing is lost with the Undo window).
 */
import type { Schema } from '@sportspark/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntentSend } from '../../../api/useIntentSend';
import { sameActivity, type ActivityRef } from '../../../features/operations/activity';
import { serviceClockOf } from '../../../features/operations/offline/clock';
import { useOfflineQueue } from '../../../features/operations/offline/OfflineQueueProvider';
import { useApp } from '../../../providers/AppProviders';
import { useToast, type ToastCloseReason } from '../../../ui/Toast';
import { TILE_LABEL, nextOnTap, tileName, tileOf, type TileState } from './tile-model';

type PersonAttendance = Schema<'PersonAttendance'>;
type ObservedState = Schema<'ObservedState'>;

export const CORRECTION_REASON = "Changed on the coach's attendance tiles";

export interface TileChild {
  personId: string;
  name: string;
  record: PersonAttendance | null;
}

export interface TileView {
  state: TileState;
  /** When the shown state was observed (a late arrival's time). */
  at: string | null;
  /** Waiting for its Undo window to close. */
  waiting: boolean;
  /** Queued on this device (offline), not yet recorded. */
  queued: boolean;
  /** Sent, the service's answer not read back yet. */
  saving: boolean;
  /** Conflicting observations: reviewed in the detailed attendance, not on the tiles. */
  conflict: boolean;
}

interface Mark {
  state: TileState;
  at: string;
}

interface Sent extends Mark {
  observationId: string | null;
}

export function useTileAttendance({
  activity,
  facilityId,
  title,
  children,
  attendanceUpdatedAt,
  attendanceServerDate,
}: {
  activity: ActivityRef;
  facilityId: string;
  title: string;
  children: readonly TileChild[];
  attendanceUpdatedAt: Date | null;
  attendanceServerDate: Date | string | null;
}) {
  const { online, services } = useApp();
  const queue = useOfflineQueue();
  const toast = useToast();
  const { send } = useIntentSend([['api', '/attendance']]);
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const waiting = useRef(new Map<string, Mark>());
  const sent = useRef(new Map<string, Sent>());
  const chains = useRef(new Map<string, Promise<void>>());
  const toastFor = useRef<string | null>(null);

  // The latest inputs, for commits that run after a toast closes (possibly after unmount).
  const byId = useMemo(() => new Map(children.map((c) => [c.personId, c])), [children]);
  const latest = useRef({ byId, online, activity, facilityId, title });
  latest.current = { byId, online, activity, facilityId, title };

  // One roster snapshot per attendance load, dated on the service's clock (offline/clock.ts).
  const takenAt = attendanceUpdatedAt;
  const roster = useMemo(() => {
    if (!takenAt) return null;
    const clock = serviceClockOf(attendanceServerDate, takenAt);
    return { clock, snapshot: queue.newSnapshot(clock.at(takenAt)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new snapshot only per load
  }, [takenAt?.getTime()]);
  const rosterRef = useRef(roster);
  rosterRef.current = roster;
  const maxAge = services.config.offlineRosterMaxAgeMs ?? null;

  // A sent mark is dropped once the service's record shows it.
  useEffect(() => {
    let changed = false;
    for (const [personId, mark] of sent.current) {
      const child = byId.get(personId);
      if (child && tileOf(child.record?.effectiveState) === mark.state) {
        sent.current.delete(personId);
        changed = true;
      }
    }
    if (changed) bump();
  }, [byId, bump]);

  const queuedOf = useCallback(
    (personId: string): ObservedState | null => {
      const mine = queue.mine.filter(
        (q) =>
          q.item.kind === 'attendance' &&
          q.item.personId === personId &&
          sameActivity(q.item.activity, activity),
      );
      const last = mine[mine.length - 1];
      return last && last.item.kind === 'attendance' ? last.item.observedState : null;
    },
    [queue.mine, activity],
  );

  const headOf = (child: TileChild | undefined): { id: string | null; at: string | null } => {
    const ids = child?.record?.currentObservationIds ?? [];
    if (ids.length !== 1) return { id: null, at: null };
    const head = child?.record?.history.find((h) => h.id === ids[0]);
    return { id: ids[0] ?? null, at: head?.observedAt ?? null };
  };

  const view = useCallback(
    (personId: string): TileView => {
      const child = byId.get(personId);
      const conflict = child?.record?.status === 'conflict';
      const w = waiting.current.get(personId);
      const s = sent.current.get(personId);
      const queued = queuedOf(personId);
      const server = tileOf(child?.record?.effectiveState);
      const head = headOf(child);
      if (w)
        return { state: w.state, at: w.at, waiting: true, queued: false, saving: false, conflict };
      if (s)
        return { state: s.state, at: s.at, waiting: false, queued: false, saving: true, conflict };
      if (queued) {
        return {
          state: tileOf(queued),
          at: null,
          waiting: false,
          queued: true,
          saving: false,
          conflict,
        };
      }
      return { state: server, at: head.at, waiting: false, queued: false, saving: false, conflict };
    },

    [byId, queuedOf],
  );

  /** Whether the child has a mark the service holds (or one on its way): no way back to Unmarked. */
  const recorded = (personId: string): boolean => {
    const child = latest.current.byId.get(personId);
    return (
      (child?.record?.currentObservationIds.length ?? 0) > 0 ||
      sent.current.has(personId) ||
      queuedOf(personId) !== null
    );
  };

  const doCommit = useCallback(
    async (personId: string, mark: Mark): Promise<void> => {
      const {
        byId: children,
        online: isOnline,
        activity: ref,
        facilityId: facility,
      } = latest.current;
      const child = children.get(personId);
      const name = tileName(child?.name ?? 'This child');
      const server = tileOf(child?.record?.effectiveState);
      const previous = sent.current.get(personId);
      const head = previous?.observationId ? { id: previous.observationId } : headOf(child);
      const base = previous?.state ?? server;
      if (mark.state === base || mark.state === 'unmarked') return;
      const observedState = mark.state as ObservedState;
      if (!isOnline) {
        if (head.id) {
          toast.show({
            tone: 'warning',
            message: `${name}: changing a recorded mark needs a connection.`,
          });
          return;
        }
        const r = rosterRef.current;
        const tooOld =
          maxAge !== null &&
          r !== null &&
          services.now().getTime() - new Date(r.snapshot.takenAt).getTime() > maxAge;
        if (!r || tooOld) {
          toast.show({
            tone: 'warning',
            message: `${name} not queued: the roster is too old. Reconnect to refresh it.`,
          });
          return;
        }
        queue.enqueue([
          {
            item: {
              kind: 'attendance',
              clientObservationId: queue.newObservationId(),
              observedAt: r.clock.at(new Date(mark.at)),
              personId,
              activity: ref,
              observedState,
            },
            facilityId: facility,
            snapshot: r.snapshot,
            context: latest.current.title,
          },
        ]);
        return;
      }
      sent.current.set(personId, { ...mark, observationId: head.id });
      bump();
      try {
        if (head.id) {
          const corrected = await send(
            `correct|${head.id}|${observedState}`,
            'post',
            '/attendance-observations/{id}/corrections',
            { path: { id: head.id }, body: { observedState, reason: CORRECTION_REASON } },
          );
          const id = (corrected as { observation?: { id?: string } }).observation?.id ?? head.id;
          sent.current.set(personId, { ...mark, observationId: id });
        } else {
          const recordedObs = await send(
            `record|${personId}|${observedState}`,
            'post',
            '/attendance-observations',
            { body: { personId, activity: ref, observedState } },
          );
          const id = (recordedObs as { observation?: { id?: string } }).observation?.id ?? null;
          sent.current.set(personId, { ...mark, observationId: id });
        }
        bump();
      } catch (error) {
        sent.current.delete(personId);
        bump();
        const code = (error as { code?: string }).code;
        toast.show({
          tone: 'error',
          message: `${name}: ${TILE_LABEL[mark.state].word} didn't save.${code ? ` Code ${code}` : ''}`,
          action: {
            label: 'Try again',
            onClick: () => {
              waiting.current.set(personId, mark);
              bump();
              commit(personId);
            },
          },
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest inputs through refs
    [send, toast, queue, services, maxAge, bump],
  );

  const commit = useCallback(
    (personId: string) => {
      const mark = waiting.current.get(personId);
      if (!mark) return;
      waiting.current.delete(personId);
      bump();
      const before = chains.current.get(personId) ?? Promise.resolve();
      const next = before.then(() => doCommit(personId, mark)).catch(() => undefined);
      chains.current.set(personId, next);
    },
    [doCommit, bump],
  );

  const change = useCallback(
    (personId: string, state: TileState) => {
      const child = latest.current.byId.get(personId);
      if (!child || child.record?.status === 'conflict') return;
      const at = services.now().toISOString();
      waiting.current.set(personId, { state, at });
      bump();
      toastFor.current = personId;
      const label = TILE_LABEL[state];
      toast.show({
        message: `${tileName(child.name)} · ${label.glyph ? `${label.glyph} ` : ''}${label.word}`,
        onUndo: () => {
          waiting.current.delete(personId);
          bump();
        },
        onClose: (reason: ToastCloseReason) => {
          if (reason === 'undo') return;
          // A newer toast for the same child: its mark is still waiting, sent with that toast.
          if (reason === 'replaced' && toastFor.current === personId) return;
          commit(personId);
        },
      });
    },
    [services, toast, commit, bump],
  );

  const tap = useCallback(
    (personId: string) => {
      const current = view(personId).state;
      change(personId, nextOnTap(current, recorded(personId)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recorded reads refs
    [view, change],
  );

  const hold = useCallback(
    (personId: string) => {
      if (view(personId).state === 'absent') return;
      (globalThis.navigator as Navigator | undefined)?.vibrate?.(15);
      change(personId, 'absent');
    },
    [view, change],
  );

  // Leaving the screen: send what is waiting at once.
  useEffect(
    () => () => {
      for (const personId of [...waiting.current.keys()]) commit(personId);
    },
    [commit],
  );

  return { view, tap, hold };
}
