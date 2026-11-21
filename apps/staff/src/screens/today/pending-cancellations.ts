/**
 * The 2-minute undo window of a weather cancellation (S 3b: toast "4 games cancelled · Undo
 * (2:00)"). A cancelled game, class or event cannot be brought back through the API (their
 * lifecycles end at `canceled`), so the undo window is a delayed send: the cancellations wait on
 * this device for two minutes and are sent when the window closes; Undo drops them before anything
 * is sent. Nothing is cancelled and nobody is told until then (Proposed; see the staff README).
 *
 * The batch lives in this module, not in a screen, so it is still sent if the viewer moves to
 * another page. While one waits, leaving the dashboard asks for confirmation (`beforeunload`).
 */
export const UNDO_WINDOW_MS = 2 * 60_000;

export interface PendingBatch {
  id: number;
  eventIds: string[];
  /** When the window closes (ms since epoch, from the injected clock). */
  sendAt: number;
}

type Listener = () => void;

let nextId = 1;
const batches = new Map<
  number,
  { batch: PendingBatch; timer: ReturnType<typeof setTimeout>; send: () => Promise<void> }
>();
const listeners = new Set<Listener>();
let snapshot: readonly PendingBatch[] = [];

function emit() {
  snapshot = [...batches.values()].map((b) => b.batch);
  for (const l of listeners) l();
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  if (batches.size === 0) return;
  event.preventDefault();
  event.returnValue = '';
}

function syncUnloadGuard() {
  if (typeof window === 'undefined') return;
  window.removeEventListener('beforeunload', onBeforeUnload);
  if (batches.size > 0) window.addEventListener('beforeunload', onBeforeUnload);
}

/** Waits `UNDO_WINDOW_MS`, then runs `send`; returns the batch id for `undo`. */
export function scheduleCancellation(
  eventIds: string[],
  now: number,
  send: () => Promise<void>,
): number {
  const id = nextId++;
  const timer = setTimeout(() => void flush(id), UNDO_WINDOW_MS);
  batches.set(id, { batch: { id, eventIds, sendAt: now + UNDO_WINDOW_MS }, timer, send });
  syncUnloadGuard();
  emit();
  return id;
}

/** Drops a waiting batch: nothing was sent. False when it was already sent. */
export function undoCancellation(id: number): boolean {
  const entry = batches.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  batches.delete(id);
  syncUnloadGuard();
  emit();
  return true;
}

/** Sends a waiting batch now (the window closed). */
export async function flush(id: number): Promise<void> {
  const entry = batches.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  batches.delete(id);
  syncUnloadGuard();
  emit();
  await entry.send();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pendingBatches(): readonly PendingBatch[] {
  return snapshot;
}

/** Tests: forget every waiting batch without sending. */
export function resetPendingCancellations(): void {
  for (const entry of batches.values()) clearTimeout(entry.timer);
  batches.clear();
  syncUnloadGuard();
  emit();
}
