import type { TimelineEntry } from '@sportspark/contracts';
import { DomainError, encodeCursor, z } from '@sportspark/contracts';
import { isPermissionError } from '../support.shared';

/**
 * Keyset merge of the timeline's sources (SUP-03, SPK-SUPPORT-001). Every source yields its items
 * newest first in its own keyset order and is consumed only from its head, so a page is a prefix
 * of every source: each item appears exactly once across pages, whatever the page size. The next
 * page continues every source after the last item it contributed; the positions travel together
 * in one opaque cursor.
 */

/** A source's own keyset position: an instant and an id, or (opaque cursor, offset) for a module's paged read. */
export const SourcePositionSchema = z.union([
  z.object({ a: z.string().max(40), i: z.string().max(200) }).strict(),
  z.object({ c: z.string().max(2048).nullable(), k: z.number().int().min(0).max(10_000) }).strict(),
]);
export type SourcePosition = z.infer<typeof SourcePositionSchema>;

/** `x`: the source is exhausted. Absent: start from the source's newest item. */
export const TimelineCursorSchema = z
  .object({
    v: z.literal(2),
    s: z.record(z.string().max(64), z.union([z.literal('x'), SourcePositionSchema])),
  })
  .strict();
export type TimelineCursorValue = z.infer<typeof TimelineCursorSchema>;

/** One item of a source; `entry` null: consumed but not shown (not permitted, outside scope). */
export interface SourceItem {
  at: string;
  id: string;
  position: SourcePosition;
  entry: TimelineEntry | null;
  /** The owning module refused this record to the viewer (counts toward `not_permitted`). */
  refused?: boolean;
}

export interface SourceBatch {
  items: SourceItem[];
  /** Where the next batch starts (null with `exhausted`). */
  next: SourcePosition | null;
  exhausted: boolean;
}

export type SourceFetch = (from: SourcePosition | null, limit: number) => Promise<SourceBatch>;

export type SourceStatus = 'ok' | 'not_permitted' | 'unavailable';

/** Newest first: a later instant, then the greater id, comes first. */
export function compareDesc(a: { at: string; id: string }, b: { at: string; id: string }): number {
  const ta = new Date(a.at).getTime();
  const tb = new Date(b.at).getTime();
  if (ta !== tb) return tb - ta;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/** A buffered source: fetches lazily, is consumed only from its head. */
export class TimelineSource {
  private buffer: SourceItem[] = [];
  private fetchFrom: SourcePosition | null;
  private exhausted: boolean;
  private consumed: SourcePosition | null;
  private emitted = 0;
  private attempted = 0;
  private refused = 0;
  status: SourceStatus = 'ok';

  constructor(
    readonly name: string,
    start: SourcePosition | 'x' | undefined,
    private readonly fetch: SourceFetch,
    private readonly batchSize: number,
    private readonly onFailure: (source: string, error: unknown) => void,
  ) {
    this.exhausted = start === 'x';
    this.fetchFrom = start && start !== 'x' ? start : null;
    this.consumed = this.fetchFrom;
  }

  async peek(): Promise<SourceItem | null> {
    while (this.buffer.length === 0 && !this.exhausted && this.status === 'ok') {
      try {
        const batch = await this.fetch(this.fetchFrom, this.batchSize);
        this.buffer.push(...batch.items);
        this.fetchFrom = batch.next;
        this.exhausted = batch.exhausted || batch.next === null;
      } catch (error) {
        // A source the viewer may not read contributes nothing (§4.10); another failure makes
        // it unavailable for this page. Its position stays, so the next page tries again.
        this.status = isPermissionError(error) ? 'not_permitted' : 'unavailable';
        if (this.status === 'unavailable') this.onFailure(this.name, error);
        this.buffer = [];
      }
    }
    return this.buffer[0] ?? null;
  }

  take(): SourceItem {
    const item = this.buffer.shift();
    if (!item) throw new DomainError('INTERNAL_ERROR', `timeline source ${this.name} is empty`);
    this.consumed = item.position;
    this.attempted += 1;
    if (item.refused) this.refused += 1;
    if (item.entry) this.emitted += 1;
    return item;
  }

  /** Whether nothing remains after the consumed position. */
  get done(): boolean {
    return this.status === 'ok' && this.exhausted && this.buffer.length === 0;
  }

  cursorValue(): SourcePosition | 'x' | undefined {
    if (this.done) return 'x';
    return this.consumed ?? undefined;
  }

  report(): { source: string; status: SourceStatus; count: number } {
    // Every record the source offered on this page was refused: the viewer may not read it.
    const status =
      this.status === 'ok' && this.attempted > 0 && this.refused === this.attempted
        ? 'not_permitted'
        : this.status;
    return { source: this.name, status, count: this.emitted };
  }
}

/**
 * Merges the sources newest first into at most `limit` entries; returns the next cursor when any
 * source still has an entry to show.
 */
export async function mergeSources(
  sources: readonly TimelineSource[],
  limit: number,
): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
  const entries: TimelineEntry[] = [];
  const head = async (): Promise<TimelineSource | null> => {
    let best: TimelineSource | null = null;
    let bestItem: SourceItem | null = null;
    for (const source of sources) {
      const item = await source.peek();
      if (!item) continue;
      if (!bestItem || compareDesc(item, bestItem) < 0) {
        best = source;
        bestItem = item;
      }
    }
    return best;
  };
  while (entries.length < limit) {
    const source = await head();
    if (!source) break;
    const item = source.take();
    if (item.entry) entries.push(item.entry);
  }
  // More only if some source still holds an entry to show (consume hidden items on the way).
  let more = false;
  for (;;) {
    const source = await head();
    if (!source) break;
    const item = await source.peek();
    if (item?.entry) {
      more = true;
      break;
    }
    source.take();
  }
  if (!more) return { entries, nextCursor: null };
  const s: TimelineCursorValue['s'] = {};
  for (const source of sources) {
    const value = source.cursorValue();
    if (value !== undefined) s[source.name] = value;
  }
  return { entries, nextCursor: encodeCursor({ v: 2, s } satisfies TimelineCursorValue) };
}

/**
 * A source read in one call (bounded by the support policy) and paged in memory: all its items,
 * newest first, after `from`.
 */
export function oneShot(load: () => Promise<SourceItem[]>): SourceFetch {
  let cached: Promise<SourceItem[]> | null = null;
  return async (from) => {
    cached ??= load().then((items) => [...items].sort(compareDesc));
    const all = await cached;
    const start = from && 'a' in from ? { at: from.a, id: from.i } : null;
    const items = start ? all.filter((item) => compareDesc(item, start) > 0) : all;
    return { items, next: null, exhausted: true };
  };
}

/** A keyset position of an instant and an id (for sources that keep their own keyset). */
export function atPosition(at: string, id: string): SourcePosition {
  return { a: at, i: id };
}
