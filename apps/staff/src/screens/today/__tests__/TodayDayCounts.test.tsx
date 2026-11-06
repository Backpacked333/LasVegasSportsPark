/**
 * Today (SCR-S-01): the sport colour of league play (API migration 0304) and the facility-local day
 * counts of restrictions, closures and open tasks from `GET /v1/facilities/{id}/day-summary`
 * (SPK-SCHED-008); a section the viewer may not read is left out, never shown as 0.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp, todayFeed } from '../../../testing/test-app';
import { scheduledEvent } from './fixtures';

function feed() {
  const value = todayFeed([], [FACILITY_A]);
  value.body.facilities = [
    {
      facilityId: FACILITY_A,
      name: 'North Park 1',
      timezone: 'America/Los_Angeles',
      localDate: '2026-10-24',
      window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-24T23:00:00.000Z' },
      activities: { total: 2, published: 2, canceled: 0, visible: true },
    },
  ];
  return value;
}

const summary = (restrictions: unknown, maintenance: unknown): FakeHandler => ({
  status: 200,
  body: {
    facilityId: FACILITY_A,
    date: '2026-10-24',
    timezone: 'America/Los_Angeles',
    window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
    schedule: {
      facilityId: FACILITY_A,
      window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
      activities: { total: 2, published: 2, draft: 0, canceled: 0, byKind: {}, bySport: {} },
      closures: { active: 1, pending: 0 },
    },
    restrictions,
    maintenance,
  },
});

function routes(daySummary: FakeHandler) {
  return {
    'GET /today': feed(),
    'GET /events': {
      status: 200,
      body: {
        items: [
          {
            ...scheduledEvent('hoops', '2026-10-24T17:00:00.000Z', '2026-10-24T18:00:00.000Z'),
            sport: 'basketball',
          },
          scheduledEvent('soccer', '2026-10-24T18:00:00.000Z', '2026-10-24T19:00:00.000Z'),
        ],
        nextCursor: null,
      },
    },
    'GET /facilities/{id}/operating-status': {
      status: 200,
      body: { facilityId: FACILITY_A, at: '2026-10-24T12:00:00.000Z', resources: [] },
    },
    'GET /facilities/{id}/day-summary': daySummary,
  };
}

describe('Today: sport colour and day counts', () => {
  it('migration 0304: basketball league play has its own kind colour and names its sport', async () => {
    const app = createTestApp({
      routes: routes(
        summary(
          { active: 1, approved: 0, proposed: 0, unreleasedAfterEnd: 0 },
          { openTasks: 3, overdueTasks: 0 },
        ),
      ),
    });
    render(app.at('/today'));
    const list = await screen.findByRole('list', {
      name: 'Current and upcoming activities, North Park 1',
    });
    const hoops = within(list).getByText('Activity hoops').closest('li') as HTMLElement;
    expect(hoops.querySelector('.kind-tag')).toHaveAttribute('data-kind', 'basketball');
    expect(hoops).toHaveTextContent('Basketball');
    const soccer = within(list).getByText('Activity soccer').closest('li') as HTMLElement;
    expect(soccer.querySelector('.kind-tag')).toHaveAttribute('data-kind', 'league');
  });

  it('SPK-SCHED-008: shows the day’s restrictions, closures and open tasks', async () => {
    const app = createTestApp({
      routes: routes(
        summary(
          { active: 1, approved: 0, proposed: 0, unreleasedAfterEnd: 0 },
          { openTasks: 3, overdueTasks: 0 },
        ),
      ),
    });
    render(app.at('/today'));
    expect(await screen.findByTestId(`day-counts-${FACILITY_A}`)).toHaveTextContent(
      '1 active restriction · 1 closure · 3 open tasks',
    );
    const query = app.fake.requests.find((r) => r.route === '/facilities/{id}/day-summary');
    expect(query?.query).toEqual({ date: '2026-10-24' });
  });

  it('§4.10: sections the viewer may not read are left out, not shown as 0', async () => {
    const app = createTestApp({ routes: routes(summary(null, null)) });
    render(app.at('/today'));
    const counts = await screen.findByTestId(`day-counts-${FACILITY_A}`);
    expect(counts).toHaveTextContent('1 closure');
    expect(counts).not.toHaveTextContent('restriction');
    expect(counts).not.toHaveTextContent('task');
  });
});
