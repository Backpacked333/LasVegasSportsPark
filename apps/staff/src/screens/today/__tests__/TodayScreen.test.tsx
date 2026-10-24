/**
 * SCR-S-01 Today workspace (SPK-UX-006, SPK-UX-008): issues with title, severity as text, affected
 * record, owner, age, deadline, next permitted actions and resolution history; recovery-required
 * financial issues pinned first; "Acknowledge" only where the API lists it, with the expected
 * revision and an idempotency key; only current and upcoming activities in facility-local time;
 * field status; sources and facilities the viewer may not read shown as not available.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, TEST_NOW, createTestApp, todayFeed } from '../../../testing/test-app';
import { EXCEPTION_ID, PAYMENT_ID, exceptionItem, scheduledEvent } from './fixtures';

/** A Today feed whose single facility day runs from 07:00 to 23:00 UTC on the test date. */
function feedWithDay(items: unknown[] = [], visible = true) {
  const feed = todayFeed(items, [FACILITY_A]);
  feed.body.facilities = [
    {
      facilityId: FACILITY_A,
      name: 'North Park 1',
      timezone: 'America/Los_Angeles',
      localDate: '2026-10-24',
      window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-24T23:00:00.000Z' },
      activities: { total: 3, published: 2, canceled: 1, visible },
    },
  ];
  return feed;
}

const OPERATING_STATUS = {
  status: 200,
  body: {
    facilityId: FACILITY_A,
    at: TEST_NOW.toISOString(),
    resources: [
      {
        resourceId: 'res-1',
        name: 'Pitch 1',
        kind: 'pitch',
        parentResourceId: null,
        inventoryStatus: 'active',
        conflictUnitIds: [],
        status: 'in_service',
        restrictions: [],
      },
      {
        resourceId: 'res-2',
        name: 'Pitch 2',
        kind: 'pitch',
        parentResourceId: null,
        inventoryStatus: 'restricted',
        conflictUnitIds: [],
        status: 'restricted',
        restrictions: [
          {
            restrictionId: 'x-1',
            kind: 'closed',
            reason: 'Goal frame repair',
            interval: { start: '2026-10-24T08:00:00.000Z', end: '2026-10-24T18:00:00.000Z' },
            taskId: null,
            resourceId: 'res-2',
            affectedConflictUnitIds: [],
          },
        ],
      },
    ],
  },
};

describe('SCR-S-01 TodayScreen issues', () => {
  it('SPK-UX-006: lists each issue with severity text, affected record, owner, age, next actions and history', async () => {
    const feed = todayFeed([exceptionItem()]);
    feed.body.sources = [
      { source: 'coverage', facilityId: null, status: 'not_permitted', count: 0 },
    ] as never;
    const app = createTestApp({ routes: { 'GET /today': feed } });
    render(app.at('/today'));
    const row = await screen.findByTestId(`today-item-exception:${EXCEPTION_ID}`);
    expect(within(row).getByText('Payment outcome unknown for checkout')).toBeInTheDocument();
    expect(within(row).getByText('Severity: critical')).toBeInTheDocument();
    expect(within(row).getByText('Status: open')).toBeInTheDocument();
    expect(within(row).getByText('Overdue')).toBeInTheDocument();
    expect(
      within(row).getByText(
        new RegExp(
          `Affects payment_attempt ${PAYMENT_ID} · Owner: finance · North Park 1 · Open 1 h 30 min`,
        ),
      ),
    ).toBeInTheDocument();
    // The lifecycle verbs are offered as buttons, the domain action as the next step.
    expect(
      within(row).getByText('Next: Reconcile the payment with the provider'),
    ).toBeInTheDocument();
    expect(within(row).getByText('Resolution history (1)')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /Open exception/ })).toHaveAttribute(
      'href',
      `/today/exceptions/${EXCEPTION_ID}`,
    );
    expect(screen.getByText('Evaluated just now')).toBeInTheDocument();
    const notIncluded = screen.getByRole('region', { name: 'Issue sources not included' });
    expect(within(notIncluded).getByText('Not available to you')).toBeInTheDocument();
  });

  it('pins money-moved-but-not-fulfilled financial issues first, with their owner', async () => {
    const recovery = exceptionItem({
      id: 'exception:0192f1a0-0000-7000-8000-0000000000e2',
      category: 'finance.fulfillment_incomplete',
      title: 'Payment received but the registration could not be fulfilled',
      severity: 'high',
      details: { exceptionId: '0192f1a0-0000-7000-8000-0000000000e2', revision: 1 },
      nextActions: [],
    });
    const other = exceptionItem({ severity: 'critical', nextActions: [] });
    const app = createTestApp({ routes: { 'GET /today': todayFeed([other, recovery]) } });
    render(app.at('/today'));
    const list = await screen.findByRole('list', { name: 'Open issues' });
    const rows = within(list).getAllByRole('listitem', { name: /./ });
    expect(rows[0]).toHaveAccessibleName(
      'Payment received but the registration could not be fulfilled',
    );
    expect(within(rows[0] as HTMLElement).getByText('Recovery required')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText(/Owner: finance/)).toBeInTheDocument();
  });

  it('offers Acknowledge only where the API lists it, with the expected revision and a key', async () => {
    const user = userEvent.setup();
    const readOnly = exceptionItem({
      id: 'exception:0192f1a0-0000-7000-8000-0000000000e3',
      title: 'Delivery failed',
      details: { exceptionId: '0192f1a0-0000-7000-8000-0000000000e3', revision: 1 },
      nextActions: [],
    });
    const app = createTestApp({
      routes: {
        'GET /today': todayFeed([exceptionItem(), readOnly]),
        'POST /exceptions/{id}/acknowledge': { status: 200, body: { status: 'acknowledged' } },
      },
    });
    render(app.at('/today'));
    await screen.findByRole('list', { name: 'Open issues' });
    expect(screen.queryByRole('button', { name: 'Acknowledge: Delivery failed' })).toBeNull();
    await user.click(
      screen.getByRole('button', { name: 'Acknowledge: Payment outcome unknown for checkout' }),
    );
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/exceptions/{id}/acknowledge')).toBe(true),
    );
    const ack = app.fake.requests.find((r) => r.route === '/exceptions/{id}/acknowledge');
    expect(ack?.params).toEqual({ id: EXCEPTION_ID });
    expect(ack?.body).toEqual({ expectedRevision: 4 });
    expect(ack?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    // Today is re-read after the command.
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/today').length).toBeGreaterThan(1),
    );
  });

  it('reports STALE_REVISION on acknowledge with "Reload", which re-reads Today', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /today': todayFeed([exceptionItem()]),
        'POST /exceptions/{id}/acknowledge': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      },
    });
    render(app.at('/today'));
    await user.click(
      await screen.findByRole('button', {
        name: 'Acknowledge: Payment outcome unknown for checkout',
      }),
    );
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    const before = app.fake.requests.filter((r) => r.route === '/today').length;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/today').length).toBeGreaterThan(before),
    );
  });

  it('says there are no open issues, with the time of the last evaluation', async () => {
    const app = createTestApp();
    render(app.at('/today'));
    expect(await screen.findByRole('heading', { name: 'No open issues' })).toBeInTheDocument();
    expect(screen.getByText(/Last evaluated/)).toBeInTheDocument();
  });

  it('shows ACCESS_DENIED as not available', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
          ),
      },
    });
    render(app.at('/today'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText(/ACCESS_DENIED/)).toBeNull();
  });

  it('shows other failures with their code and a retry', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': () =>
          fakeResponse(
            503,
            apiErrorBody('INTEGRATION_UNAVAILABLE', {
              nextAction: 'retry_later',
              correlationId: 'corr-t',
            }),
          ),
      },
    });
    render(app.at('/today'));
    expect(
      await screen.findByText('Error code: INTEGRATION_UNAVAILABLE. Reference: corr-t'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('SCR-S-01 TodayScreen activities and field status', () => {
  it('SPK-UX-006: shows only current and upcoming activities, from now to the end of the facility day', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': feedWithDay(),
        'GET /events': {
          status: 200,
          body: {
            items: [
              // Overlaps the window start but has ended: excluded.
              scheduledEvent('ended', '2026-10-24T10:00:00.000Z', '2026-10-24T12:00:00.000Z'),
              scheduledEvent('now', '2026-10-24T11:30:00.000Z', '2026-10-24T13:00:00.000Z'),
              scheduledEvent('later', '2026-10-24T17:00:00.000Z', '2026-10-24T18:30:00.000Z'),
            ],
            nextCursor: null,
          },
        },
        'GET /facilities/{id}/operating-status': OPERATING_STATUS,
      },
    });
    render(app.at('/today'));
    const list = await screen.findByRole('list', {
      name: 'Current and upcoming activities, North Park 1',
    });
    const events = app.fake.requests.find((r) => r.route === '/events');
    expect(events?.query).toMatchObject({
      facilityId: FACILITY_A,
      start: TEST_NOW.toISOString(),
      end: '2026-10-24T23:00:00.000Z',
    });
    expect(within(list).queryByText('Activity ended')).toBeNull();
    const now = within(list).getByText('Activity now').closest('li') as HTMLElement;
    expect(within(now).getByText('In progress')).toBeInTheDocument();
    expect(within(now).getByText('Status: published')).toBeInTheDocument();
    // Facility-local time (America/Los_Angeles) with the zone named.
    expect(
      within(now).getByText(/04:30 AM to 06:00 AM PDT|04:30 to 06:00 PDT/),
    ).toBeInTheDocument();
    const later = within(list).getByText('Activity later').closest('li') as HTMLElement;
    expect(within(later).getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('3 activities today: 2 published, 1 canceled.')).toBeInTheDocument();
  });

  it('shows field status as machine states with the restriction reason, never colour alone', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': feedWithDay(),
        'GET /events': { status: 200, body: { items: [], nextCursor: null } },
        'GET /facilities/{id}/operating-status': OPERATING_STATUS,
      },
    });
    render(app.at('/today'));
    const list = await screen.findByRole('list', { name: 'Field status, North Park 1' });
    const pitch2 = within(list).getByText('Pitch 2').closest('li') as HTMLElement;
    expect(within(pitch2).getByText('Status: restricted')).toBeInTheDocument();
    expect(within(pitch2).getByText(/closed: Goal frame repair until/)).toBeInTheDocument();
    const pitch1 = within(list).getByText('Pitch 1').closest('li') as HTMLElement;
    expect(within(pitch1).getByText('Status: in_service')).toBeInTheDocument();
    expect(screen.getByText('No more activities today at this facility.')).toBeInTheDocument();
  });

  it('shows a facility schedule the viewer may not read as not available, without asking for it', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': feedWithDay([], false),
        'GET /facilities/{id}/operating-status': () =>
          fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      },
    });
    render(app.at('/today'));
    expect(
      await screen.findByText("You may not read this facility's schedule."),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/events')).toBe(false);
    expect(screen.getByText('Activity counts are not available to you.')).toBeInTheDocument();
    // Field status denied: not available, never an error with the code.
    await waitFor(() => expect(screen.getAllByText('Not available').length).toBeGreaterThan(0));
    // Expected arrivals have no API read yet.
    expect(screen.getByText(/The API does not publish expected arrivals yet/)).toBeInTheDocument();
  });

  it('labels every control (SPK-UX-009)', async () => {
    const app = createTestApp({ routes: { 'GET /today': todayFeed([exceptionItem()]) } });
    render(app.at('/today'));
    await screen.findByRole('list', { name: 'Open issues' });
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAccessibleName();
    for (const link of screen.getAllByRole('link')) expect(link).toHaveAccessibleName();
  });
});
