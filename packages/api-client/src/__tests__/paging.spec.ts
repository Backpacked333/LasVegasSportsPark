/**
 * Keyset paging helpers (§4.5, §4.8; SPK-UX-008 "nothing silently cut off"): the API's cursor is
 * passed through untouched, pages merge in order without repeating an item, and the age of a list
 * is its oldest page.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  idOf,
  mergePages,
  nextCursorOf,
  pagedQueryKey,
  pagesReceivedAt,
  withCursor,
  type PageItem,
  type PagedGetPath,
} from '../paging';
import { apiQueryKey } from '../freshness';
import type { Schema } from '../types';

describe('cursor paging helpers', () => {
  it('keys a paged read under the list prefix, apart from a single-page read', () => {
    const query = { limit: 20 };
    const key = pagedQueryKey('/me/bookings', { query });
    expect(key).toEqual(['api', '/me/bookings', null, query, 'pages']);
    expect(key.slice(0, 2)).toEqual(['api', '/me/bookings']);
    expect(key).not.toEqual(apiQueryKey('/me/bookings', { query }));
  });

  it("adds the API's cursor to the query unchanged, and none for the first page", () => {
    expect(withCursor({ limit: 20 }, null)).toEqual({ limit: 20 });
    expect(withCursor({ limit: 20, cursor: 'stale' }, undefined)).toEqual({ limit: 20 });
    expect(withCursor({ limit: 20 }, 'eyJpZCI6IjEifQ')).toEqual({
      limit: 20,
      cursor: 'eyJpZCI6IjEifQ',
    });
    expect(withCursor(undefined, 'c1')).toEqual({ cursor: 'c1' });
    const original = { limit: 5 };
    withCursor(original, 'c2');
    expect(original).toEqual({ limit: 5 });
  });

  it('stops at nextCursor null', () => {
    expect(nextCursorOf({ nextCursor: 'c3' })).toBe('c3');
    expect(nextCursorOf({ nextCursor: null })).toBeUndefined();
    expect(nextCursorOf(undefined)).toBeUndefined();
  });

  it('merges pages in order and shows an item repeated at a page boundary once', () => {
    const pages = [
      { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' },
      { items: [{ id: 'b' }, { id: 'c' }], nextCursor: null },
    ];
    expect(mergePages(pages).map(idOf)).toEqual(['a', 'b', 'b', 'c']);
    expect(mergePages(pages, idOf).map(idOf)).toEqual(['a', 'b', 'c']);
    expect(mergePages([])).toEqual([]);
  });

  it('gives a list the age of its oldest page (§4.15)', () => {
    const older = new Date('2026-10-24T11:00:00.000Z');
    const newer = new Date('2026-10-24T12:00:00.000Z');
    expect(pagesReceivedAt([{ receivedAt: newer }, { receivedAt: older }])).toEqual(older);
    expect(pagesReceivedAt([])).toBeNull();
  });

  it('types paged paths and their items from the OpenAPI document', () => {
    expectTypeOf<'/me/bookings'>().toMatchTypeOf<PagedGetPath>();
    expectTypeOf<'/me/pos-receipts'>().toMatchTypeOf<PagedGetPath>();
    expectTypeOf<PageItem<'/me/memberships'>>().toEqualTypeOf<Schema<'Membership'>>();
    // A single-record read is not a paged path.
    expectTypeOf<'/me/permissions'>().not.toMatchTypeOf<PagedGetPath>();
  });
});
