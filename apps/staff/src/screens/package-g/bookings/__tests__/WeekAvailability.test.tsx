/**
 * New-booking week grid (SCR-S-51; SPK-SCHED-002/003, SPK-SCHED-008): free blocks per day and
 * hour by space type from `GET /v1/resource-availability` (counts of spaces, never a hold);
 * choosing a cell picks its facility-local day for the offering's own free times.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../../testing/test-app';
import {
  RESOURCE_A,
  RESOURCE_B,
  catalogRoutes,
  offering,
  ok,
  page,
} from '../../participation/__tests__/fixtures';

const ACTIONS = [
  'enrollment.read_booking',
  'enrollment.request_booking',
  'enrollment.decide_booking',
  'scheduling.read_schedule',
];

/** 18:00 local (01:00Z next day, PST) on Nov 2 and Nov 3, 2026. */
const SLOT_NOV_2 = '2026-11-03T02:00:00.000Z';
const SLOT_NOV_3 = '2026-11-04T02:00:00.000Z';

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...catalogRoutes(),
    'GET /me/permissions': mePermissions({ enabled: ['rentals'], actions: ACTIONS }),
    'GET /bookings': page([]),
    'GET /offerings': page([offering()]),
    'GET /offerings/{id}/booking-availability': ok({
      offeringId: offering().id,
      timezone: 'America/Los_Angeles',
      durationMinutes: 60,
      resourceCount: 1,
      resources: [],
    }),
    'GET /resource-availability': ok({
      facilityId: offering().facilityId,
      window: { start: '2026-11-02T08:00:00.000Z', end: '2026-11-09T08:00:00.000Z' },
      durationMinutes: 60,
      stepMinutes: 60,
      resources: [
        {
          resourceId: RESOURCE_A,
          name: 'Pitch 1',
          kind: 'pitch',
          parentResourceId: null,
          slots: [
            { start: SLOT_NOV_2, end: '2026-11-03T03:00:00.000Z' },
            { start: SLOT_NOV_3, end: '2026-11-04T03:00:00.000Z' },
          ],
        },
        {
          resourceId: RESOURCE_B,
          name: 'Pitch 2',
          kind: 'pitch',
          parentResourceId: null,
          slots: [{ start: SLOT_NOV_2, end: '2026-11-03T03:00:00.000Z' }],
        },
      ],
    }),
    ...extra,
  };
}

describe('new booking week grid', () => {
  it('SPK-SCHED-003: counts free spaces per facility-local day and hour, by space type, and picks a day', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/rentals/new'));
    const form = await screen.findByRole('form', { name: 'New rental' });
    await user.selectOptions(within(form).getByLabelText(/^Offering/), offering().id);
    // the grid starts at the chosen facility-local day
    fireEvent.change(within(form).getByLabelText(/^Date \(America\/Los_Angeles\)/), {
      target: { value: '2026-11-02' },
    });
    const grid = await within(form).findByRole('region', { name: 'Free blocks this week' });
    expect(await within(grid).findByRole('button', { name: /18:00: 2 free$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const nov3 = within(grid).getByRole('button', { name: /18:00: 1 free$/ });
    expect(within(grid).getAllByText('Booked').length).toBeGreaterThan(0);
    await user.click(nov3);
    expect(within(form).getByLabelText(/^Date \(America\/Los_Angeles\)/)).toHaveValue('2026-11-03');
    await user.selectOptions(within(grid).getByLabelText('Space type'), 'room');
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/resource-availability' && r.query.resourceKind === 'room',
        ),
      ).toBe(true),
    );
    const first = app.fake.requests.find(
      (r) => r.route === '/resource-availability' && r.query.start === '2026-11-02T08:00:00.000Z',
    );
    expect(first?.query).toMatchObject({
      start: '2026-11-02T08:00:00.000Z',
      end: '2026-11-09T08:00:00.000Z',
      durationMinutes: '60',
      stepMinutes: '60',
    });
  });

  it('is not offered to a role that may not read the schedule', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({
          enabled: ['rentals'],
          actions: ACTIONS.filter((a) => a !== 'scheduling.read_schedule'),
        }),
      }),
    });
    render(app.at('/schedule/rentals/new'));
    const form = await screen.findByRole('form', { name: 'New rental' });
    await user.selectOptions(within(form).getByLabelText(/^Offering/), offering().id);
    expect(within(form).queryByRole('region', { name: 'Free blocks this week' })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/resource-availability')).toBe(false);
  });
});
