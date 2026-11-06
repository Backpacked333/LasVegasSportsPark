/**
 * SCR-S-28 "Sessions now" rail (SPK-ENTRY-005, SPK-SCHED-008, CAT-01 session location): each
 * session names where it is (reserved resources by name, else the location label) and its
 * configured capacity beside the observed fill; a service without locations still lists sessions.
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { OFFERING, SESSION_1, oneFacilityMe } from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';
import { sessionCapacity, sessionPlace } from '../SessionsNow';

const BASE = {
  sessionId: SESSION_1,
  offeringId: OFFERING,
  offeringName: 'Junior skills',
  sequence: 2,
  title: null,
  scheduledStart: '2026-10-24T16:00:00.000Z',
  scheduledEnd: '2026-10-24T17:00:00.000Z',
  status: 'scheduled' as const,
  facilityId: FACILITY_A,
  timezone: 'America/Los_Angeles',
};

describe('SessionsNow', () => {
  beforeEach(() => window.localStorage.clear());

  it('CAT-01: shows the reserved pitch and the configured places of each session', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': oneFacilityMe(),
        'GET /sessions': {
          status: 200,
          body: {
            items: [
              {
                ...BASE,
                location: {
                  source: 'scheduling_event',
                  label: 'North half',
                  resources: [{ id: '0192f1a0-0000-7000-8000-000000000991', name: 'Pitch 3' }],
                },
                capacity: { source: 'session', units: [{ unit: 'session_seats', limit: 12 }] },
              },
            ],
            nextCursor: null,
          },
        },
      },
    });
    render(app.at('/arrival'));
    const list = await screen.findByRole('list', { name: 'Sessions now and next' });
    expect(within(list).getByText('Pitch 3 · 12 places')).toBeInTheDocument();
  });

  it('falls back to the label, and to nothing when the service predates session locations', () => {
    expect(
      sessionPlace({
        ...BASE,
        location: { source: 'offering', label: 'Main complex', resources: [] },
        capacity: { source: 'offering', units: [{ unit: 'seats', limit: 1 }] },
      }),
    ).toBe('Main complex');
    expect(
      sessionCapacity({
        ...BASE,
        location: { source: 'none', label: null, resources: [] },
        capacity: { source: 'offering', units: [{ unit: 'seats', limit: 1 }] },
      }),
    ).toBe('1 place');
    const legacy = BASE as unknown as Parameters<typeof sessionPlace>[0];
    expect(sessionPlace(legacy)).toBeNull();
    expect(sessionCapacity(legacy)).toBeNull();
  });
});
