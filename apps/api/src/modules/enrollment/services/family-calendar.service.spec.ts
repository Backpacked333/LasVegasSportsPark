import type { FamilyCalendarItem } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { overlapsOf } from './family-calendar.service';

const item = (id: string, personId: string, start: string, end: string): FamilyCalendarItem => ({
  id,
  personId,
  kind: 'session_booking',
  enrollmentId: null,
  sessionBookingId: id,
  offeringId: '01a16c09-0000-7000-8000-0000000000aa',
  sessionId: null,
  title: 'Activity',
  start,
  end,
  status: 'confirmed',
  facilityId: null,
  timezone: null,
});

describe('SPK-YOUTH-007 overlap highlighting', () => {
  it('flags every intersecting pair (half-open ranges) across the family', () => {
    const items = [
      item('a', 'p1', '2026-11-10T17:00:00.000Z', '2026-11-10T18:00:00.000Z'),
      item('b', 'p2', '2026-11-10T17:30:00.000Z', '2026-11-10T18:30:00.000Z'),
      item('c', 'p1', '2026-11-10T18:00:00.000Z', '2026-11-10T19:00:00.000Z'),
      item('d', 'p3', '2026-11-11T09:00:00.000Z', '2026-11-11T10:00:00.000Z'),
    ];
    expect(overlapsOf(items)).toEqual([
      {
        itemIds: ['a', 'b'],
        personIds: ['p1', 'p2'],
        start: '2026-11-10T17:30:00.000Z',
        end: '2026-11-10T18:00:00.000Z',
      },
      {
        itemIds: ['b', 'c'],
        personIds: ['p2', 'p1'],
        start: '2026-11-10T18:00:00.000Z',
        end: '2026-11-10T18:30:00.000Z',
      },
    ]);
  });

  it('reports nothing for back-to-back commitments', () => {
    expect(
      overlapsOf([
        item('a', 'p1', '2026-11-10T17:00:00.000Z', '2026-11-10T18:00:00.000Z'),
        item('b', 'p1', '2026-11-10T18:00:00.000Z', '2026-11-10T19:00:00.000Z'),
      ]),
    ).toEqual([]);
  });
});
