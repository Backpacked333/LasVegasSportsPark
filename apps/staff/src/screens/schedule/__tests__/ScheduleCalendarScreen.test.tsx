/**
 * SCR-S-03 Schedule calendar and resource view: SPK-SCHED-001/002 (whole pitch and subdivision
 * relationships, shared space), SPK-SCHED-003 (occupied interval with buffers), SPK-SCHED-008
 * (facility-local day window and times), SPK-FAC-003 (restrictions shown), SPK-UX-008 states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HALF_A,
  HALF_B,
  INVENTORY,
  PITCH,
  closure,
  event,
  oneFacilityRoutes,
  page,
} from '../../../features/schedule-facilities/test-fixtures';
import {
  FACILITY_A,
  FACILITY_B,
  createTestApp,
  staffMe,
  todayFeed,
} from '../../../testing/test-app';

const GAME = event({
  id: 'e-game',
  title: 'U12 Red v Blue',
  resourceIds: [PITCH],
  setupMinutes: 15,
  cleanupMinutes: 10,
});
const SMALL = event({
  id: 'e-small',
  title: '7v7 adult league',
  resourceIds: [HALF_B],
  scheduledStart: '2026-10-24T17:00:00.000Z',
  scheduledEnd: '2026-10-24T18:00:00.000Z',
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /events': page([GAME, SMALL]),
    'GET /closures': {
      status: 200,
      body: [
        closure({
          id: 'c-1',
          resourceId: HALF_A,
          source: 'maintenance',
          status: 'active',
          reason: 'Goal mouth repair',
          interval: { start: '2026-10-24T15:00:00.000Z', end: '2026-10-24T23:00:00.000Z' },
        }),
      ],
    },
    ...overrides,
  };
}

describe('SCR-S-03 ScheduleCalendarScreen', () => {
  it('SPK-SCHED-008: asks the API for the facility-local day and shows facility-local times', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    expect(await screen.findByTestId('calendar-event-e-game')).toHaveTextContent(
      '18:00 to 19:30 PDT',
    );
    const request = app.fake.requests.find((r) => r.route === '/events');
    expect(request?.query).toMatchObject({
      facilityId: FACILITY_A,
      start: '2026-10-24T07:00:00.000Z',
      end: '2026-10-25T07:00:00.000Z',
    });
    expect(
      screen.getByText(/Times are facility local time \(America\/Los_Angeles/),
    ).toBeInTheDocument();
  });

  it('SPK-SCHED-002/003: a whole-pitch booking blocks both halves, with its occupied interval including buffers', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    const pitch = await screen.findByTestId(`calendar-resource-${PITCH}`);
    expect(within(pitch).getByText('U12 Red v Blue')).toBeInTheDocument();
    expect(
      within(pitch).getByText(
        /Space occupied .*17:45 to 19:40 PDT \(setup 15 min, cleanup 10 min\)/,
      ),
    ).toBeInTheDocument();
    // The pitch is blocked by the south half's own booking too.
    expect(
      within(pitch).getByText('Blocked by shared space: 7v7 adult league'),
    ).toBeInTheDocument();
    const north = screen.getByTestId(`calendar-resource-${HALF_A}`);
    expect(within(north).getByText('Blocked by shared space: U12 Red v Blue')).toBeInTheDocument();
    expect(
      within(north).getByRole('heading', { name: /Pitch 1 North Subdivision, part of Pitch 1/ }),
    ).toBeInTheDocument();
    // The halves do not block each other.
    expect(within(north).queryByText(/7v7 adult league/)).toBeNull();
  });

  it('SPK-FAC-003: shows a maintenance restriction on the subdivision and on the whole pitch, as text', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    const north = await screen.findByTestId(`calendar-resource-${HALF_A}`);
    expect(
      within(north).getByText('Maintenance restriction: Goal mouth repair'),
    ).toBeInTheDocument();
    expect(within(north).getByText('active: space closed')).toBeInTheDocument();
    const pitch = screen.getByTestId(`calendar-resource-${PITCH}`);
    expect(within(pitch).getByText(/on Pitch 1 North/)).toBeInTheDocument();
    expect(within(north).getByRole('link', { name: 'Closure impact' })).toHaveAttribute(
      'href',
      '/schedule/closures/c-1',
    );
  });

  it('moves by facility-local days with keyboard-operable controls', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    await screen.findByTestId('calendar-event-e-game');
    await user.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/events').at(-1)?.query.start).toBe(
        '2026-10-25T07:00:00.000Z',
      ),
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'Week');
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/events').at(-1)?.query.end).toBe(
        // Seven local days from 2026-10-25: local midnight of 2026-11-01 is still PDT.
        '2026-11-01T07:00:00.000Z',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/events').at(-1)?.query).toMatchObject({
        start: '2026-11-01T07:00:00.000Z',
        // The week holds the 25-hour day of 2026-11-01 and ends at midnight PST.
        end: '2026-11-08T08:00:00.000Z',
      }),
    );
  });

  it('stale version: a refresh that brings a changed published revision shows a banner, not a silent swap', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    await screen.findByTestId('calendar-event-e-game');
    app.fake.set(
      'GET /events',
      page([
        { ...GAME, revision: 2, publishedRevision: 2, title: 'U12 Red v Blue (moved)' },
        SMALL,
      ]),
    );
    await app.queryClient.invalidateQueries({ queryKey: ['api', '/events'] });
    expect(await screen.findByTestId('schedule-changed')).toHaveTextContent('Schedule changed');
    expect(screen.getByText('U12 Red v Blue')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the latest' }));
    expect(await screen.findByText('U12 Red v Blue (moved)')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-changed')).toBeNull();
  });

  it('an explicit Refresh shows the latest schedule straight away, without the banner', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    await screen.findByTestId('calendar-event-e-game');
    app.fake.set(
      'GET /events',
      page([
        { ...GAME, revision: 2, publishedRevision: 2, title: 'U12 Red v Blue (moved)' },
        SMALL,
      ]),
    );
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('U12 Red v Blue (moved)')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-changed')).toBeNull();
    expect(screen.queryByText('U12 Red v Blue')).toBeNull();
  });

  it('empty: says nothing is booked and still shows the spaces', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /events': page([]), 'GET /closures': { status: 200, body: [] } }),
    });
    render(app.at('/schedule/calendar'));
    expect(
      await screen.findByRole('heading', { name: 'No events in this range' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`calendar-resource-${PITCH}`)).toHaveTextContent(
      'Free for the whole range.',
    );
  });

  it('first setup: no resources offers the resource inventory', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /resources': { status: 200, body: [] },
        'GET /resource-configurations': { status: 200, body: [] },
      }),
    });
    render(app.at('/schedule/calendar'));
    await user.click(await screen.findByRole('button', { name: 'Set up resources' }));
    expect(await screen.findByRole('heading', { name: 'Resource inventory' })).toBeInTheDocument();
  });

  it('permission restriction (facility scope): ACCESS_DENIED is shown as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /events': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
          ),
      }),
    });
    render(app.at('/schedule/calendar'));
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    expect(screen.queryByText('U12 Red v Blue')).toBeNull();
  });

  it('error: shows the code and reference with a retry', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'GET /resources': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')) }),
    });
    render(app.at('/schedule/calendar'));
    expect(
      await screen.findByText('Error code: INTERNAL_ERROR. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    app.fake.set('GET /resources', { status: 200, body: INVENTORY });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('calendar-event-e-game')).toBeInTheDocument();
  });

  it('asks which facility when the viewer works in more than one', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'GET /me': staffMe([FACILITY_A, FACILITY_B]),
        'GET /today': todayFeed(),
      },
    });
    render(app.at('/schedule/calendar'));
    await user.click(await screen.findByRole('button', { name: 'Use North Park 1' }));
    expect(await screen.findByTestId('calendar-event-e-game')).toBeInTheDocument();
  });

  it('offline: keeps the cached schedule with its age and disables refresh', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/calendar'));
    await screen.findByTestId('calendar-event-e-game');
    act(() => app.connectivity.set(false));
    expect((await screen.findAllByText('You are offline')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByText('U12 Red v Blue')).toBeInTheDocument();
  });
});
