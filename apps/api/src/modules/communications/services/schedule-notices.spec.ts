import { newId, type EventDetails, type EventPayload } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import type { EventChanged } from '../../scheduling';
import { describe as describeNotice, noticeKindFor, when, where } from './schedule-notices';

type Payload = EventPayload<typeof EventChanged>;

const details = (overrides: Partial<EventDetails> = {}): EventDetails => ({
  title: 'U10 game',
  kind: 'game',
  scheduledStart: '2026-11-07T18:00:00.000Z',
  scheduledEnd: '2026-11-07T19:00:00.000Z',
  timezone: 'America/Los_Angeles',
  facilityId: newId(),
  resources: [{ id: newId(), name: 'Pitch 1' }],
  status: 'published',
  ...overrides,
});

const payload = (overrides: Partial<Payload>): Payload => ({
  eventId: newId(),
  facilityId: newId(),
  change: 'moved',
  before: details(),
  after: details({
    scheduledStart: '2026-11-07T19:00:00.000Z',
    scheduledEnd: '2026-11-07T20:00:00.000Z',
  }),
  sourceType: 'fixture',
  sourceId: newId(),
  seriesId: null,
  commitments: [],
  publicationId: null,
  closureId: null,
  reason: null,
  ...overrides,
});

describe('schedule notice composition (SPK-COMMS-002, SPK-COMMS-005)', () => {
  it('maps scheduling changes to notice kinds; drafts never produce customer notices (SPK-SCHED-005)', () => {
    expect(noticeKindFor(payload({ change: 'created', before: null }))).toBe('schedule_published');
    expect(
      noticeKindFor(payload({ change: 'published', before: details({ status: 'draft' }) })),
    ).toBe('schedule_published');
    expect(noticeKindFor(payload({ change: 'moved' }))).toBe('schedule_changed');
    expect(noticeKindFor(payload({ change: 'resource_changed' }))).toBe('schedule_changed');
    expect(
      noticeKindFor(payload({ change: 'canceled', after: details({ status: 'canceled' }) })),
    ).toBe('cancellation');
    expect(
      noticeKindFor(
        payload({ change: 'created', before: null, after: details({ status: 'draft' }) }),
      ),
    ).toBeNull();
    expect(
      noticeKindFor(
        payload({
          change: 'moved',
          before: details({ status: 'draft' }),
          after: details({ status: 'draft' }),
        }),
      ),
    ).toBeNull();
    expect(
      noticeKindFor(
        payload({
          change: 'canceled',
          before: details({ status: 'draft' }),
          after: details({ status: 'canceled' }),
        }),
      ),
    ).toBeNull();
  });

  it('shows old and new practical details in facility-local time (SPK-COMMS-005, SPK-SCHED-008)', () => {
    const p = payload({ reason: 'Referee availability' });
    const text = describeNotice('schedule_changed', p);
    expect(text.title).toBe('Schedule changed: U10 game');
    expect(text.body).toContain('Was: Sat, Nov 7, 10:00 AM to 11:00 AM at Pitch 1.');
    expect(text.body).toContain('Now: Sat, Nov 7, 11:00 AM to 12:00 PM at Pitch 1.');
    expect(text.body).toContain('Reason: Referee availability');
    const canceled = describeNotice('cancellation', payload({ change: 'canceled', after: null }));
    expect(canceled.title).toBe('Canceled: U10 game');
    expect(canceled.body).toContain('has been canceled');
    expect(when(null)).toBe('an unknown time');
    expect(where(details({ resources: [] }))).toBe('an unassigned space');
  });
});
