/**
 * Keyset (cursor) paging over the API's paged lists (§4.5, §4.8): a paged read takes `limit` and an
 * opaque `cursor` and answers `{ items, nextCursor }`, where `nextCursor: null` means there is
 * nothing more. The cursor is the API's; the client never builds, decodes or edits one.
 *
 * Both apps' "load more" hooks (`useApiPages`) are built on these helpers, so a list never hides
 * that more exists (SPK-UX-008: nothing silently cut off) and never shows an item twice.
 */
import { apiQueryKey } from './freshness';
import type { PathsWithMethod, ResponseBody } from './types';

/** The shape every paged list response has (`pageSchema` in packages/contracts). */
export interface CursorPage<T> {
  items: readonly T[];
  nextCursor: string | null;
}

type GetPath = PathsWithMethod<'get'>;
type Defined<T> = Exclude<T, undefined>;

/** GET paths whose success body is a cursor page. */
export type PagedGetPath = {
  [P in GetPath]: Defined<ResponseBody<P, 'get'>> extends {
    items: readonly unknown[];
    nextCursor: string | null;
  }
    ? P
    : never;
}[GetPath];

/** The item type of a paged GET path, e.g. `PageItem<'/me/bookings'>` is the booking schema. */
export type PageItem<P extends PagedGetPath> =
  Defined<ResponseBody<P, 'get'>> extends { items: readonly (infer I)[] } ? I : never;

/**
 * Cache key of a paged read in both apps: the `apiQueryKey` of the list plus `'pages'`, so it is
 * invalidated by the same prefix (`['api', '/me/bookings']`) and never shares an entry with a
 * single-page read of the same path (their cached shapes differ).
 */
export function pagedQueryKey(
  path: string,
  options?: { path?: object; query?: object },
): readonly unknown[] {
  return [...apiQueryKey(path, options), 'pages'] as const;
}

/** The query of a page read: the caller's query with the API's cursor (none for the first page). */
export function withCursor<Q extends object>(
  query: Q | undefined,
  cursor: string | null | undefined,
): Q & { cursor?: string } {
  const base = { ...(query ?? {}) } as Q & { cursor?: string };
  if (cursor) base.cursor = cursor;
  else delete base.cursor;
  return base;
}

/** The cursor of the page after this one, or `undefined` when there is none (TanStack's stop). */
export function nextCursorOf(page: { nextCursor: string | null } | undefined): string | undefined {
  return page?.nextCursor ?? undefined;
}

/**
 * The items of the loaded pages in order. Keyset pages do not overlap, but a list that changes
 * between two page reads can repeat an item at the boundary; with `keyOf`, an item already shown
 * is not shown again (its first position wins).
 */
export function mergePages<T>(
  pages: readonly { items: readonly T[] }[],
  keyOf?: (item: T) => string,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const item of page.items) {
      if (keyOf) {
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(item);
    }
  }
  return out;
}

/** Key function for the usual `{ id }` records. */
export function idOf(item: unknown): string {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : JSON.stringify(item);
}

/**
 * The age of what a paged list shows: the oldest page's receipt time (§4.15). A page loaded an hour
 * ago is not made to look fresh by a page loaded just now.
 */
export function pagesReceivedAt(pages: readonly { receivedAt: Date }[]): Date | null {
  let oldest: Date | null = null;
  for (const page of pages) {
    if (!oldest || page.receivedAt.getTime() < oldest.getTime()) oldest = page.receivedAt;
  }
  return oldest;
}
