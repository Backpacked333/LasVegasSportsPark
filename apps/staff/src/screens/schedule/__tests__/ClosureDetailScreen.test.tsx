/**
 * SCR-S-06 Closure impact and resolution: SPK-SCHED-009 (affected games, programs, rentals, staff,
 * customers, financial obligations, messages), SPK-AT-009 (complete impact preview, approved
 * resolution, consistent publication through one draft), SPK-AT-021 (maintenance closures return to
 * service by release), POL-041 and DEC-009 pending, SPK-UX-008 stale (affected set changed).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HALF_B,
  INVENTORY,
  PITCH,
  ROOM,
  closure,
  draft,
  oneFacilityRoutes,
  page,
  restriction,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

function affected(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    eventId: id,
    title,
    kind: 'game' as const,
    status: 'published' as const,
    scheduledStart: '2026-10-25T01:00:00.000Z',
    scheduledEnd: '2026-10-25T02:30:00.000Z',
    sourceType: 'fixture',
    sourceId: `${id}-fixture`,
    resourceIds: [PITCH],
    reservationIds: [],
    commitments: [
      { partyType: 'team' as const, partyId: 't1', role: 'home_team' },
      { partyType: 'team' as const, partyId: 't2', role: 'away_team' },
      { partyType: 'person' as const, partyId: 'p1', role: 'official' },
    ],
    ...over,
  };
}

const IMPACT = {
  interval: { start: '2026-10-25T00:00:00.000Z', end: '2026-10-25T06:00:00.000Z' },
  affectedEvents: [affected('e1', 'U12 Red v Blue'), affected('e2', 'Adult 7v7 final')],
  sourceRecords: [
    { sourceType: 'fixture', sourceId: 'e1-fixture', eventIds: ['e1'] },
    { sourceType: 'fixture', sourceId: 'e2-fixture', eventIds: ['e2'] },
  ],
  // SPK-SCHED-009: customers, financial obligations and unsent messages the closure affects.
  customers: [{ personId: 'p1', eventIds: ['e1', 'e2'], via: ['commitment' as const] }],
  obligations: [],
  messages: [],
  summary: {
    games: 2,
    programs: 0,
    rentals: 0,
    other: 0,
    teams: 4,
    people: 2,
    equipment: 0,
    customers: 1,
    obligations: 0,
    messages: 0,
  },
};
const PENDING = closure({ id: 'c1', impact: IMPACT, revision: 2 });

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /closures/{id}': { status: 200, body: PENDING },
    'GET /resources': { status: 200, body: INVENTORY },
    ...overrides,
  };
}

describe('SCR-S-06 ClosureDetailScreen', () => {
  it('SPK-SCHED-009: lists what is affected, and says which items the API does not list', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/closures/c1'));
    const table = await screen.findByRole('table', { name: 'What this closure affects' });
    expect(within(table).getByRole('row', { name: 'Games 2' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'Teams 4' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /People committed .* 2/ })).toBeInTheDocument();
    for (const label of ['Customers', 'Financial obligations', 'Messages']) {
      expect(
        within(table).getByRole('row', { name: new RegExp(`^${label} Not available here`) }),
      ).toBeInTheDocument();
    }
    const events = screen.getByRole('list', { name: 'Affected events' });
    expect(events).toHaveTextContent('U12 Red v Blue');
    await waitFor(() =>
      expect(events).toHaveTextContent(
        '18:00 to 19:30 PDT on Pitch 1 · 2 teams, 1 person · from a fixture',
      ),
    );
    expect(screen.getByText('pending: impact preview, not applied')).toBeInTheDocument();
  });

  it('apply needs an explicit choice, sends it with the expected revision, and reports a changed affected set', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /closures/{id}/apply': {
          status: 200,
          body: closure({
            id: 'c1',
            status: 'active',
            revision: 3,
            appliedAt: '2026-10-24T12:10:00.000Z',
            impact: {
              ...IMPACT,
              affectedEvents: [affected('e1', 'U12 Red v Blue'), affected('e3', 'Late booking')],
            },
            resolution: {
              mode: 'leave_for_resolution',
              canceledEventIds: [],
              unresolvedEventIds: ['e1', 'e3'],
            },
          }),
        },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    await user.click(await screen.findByRole('button', { name: 'Apply closure' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose what happens to the affected events.',
    );
    expect(app.fake.requests.some((r) => r.route === '/closures/{id}/apply')).toBe(false);
    await user.click(screen.getByLabelText(/Leave them for resolution/));
    await user.click(screen.getByRole('button', { name: 'Apply closure' }));
    expect(await screen.findByTestId('closure-applied')).toHaveTextContent(
      '0 event(s) canceled, 2 awaiting resolution.',
    );
    expect(screen.getByTestId('affected-set-changed')).toHaveTextContent(
      'The affected set changed since the preview: 1 more event affected, 1 no longer affected.',
    );
    const apply = app.fake.requests.find((r) => r.route === '/closures/{id}/apply');
    expect(apply?.body).toEqual({ mode: 'leave_for_resolution', expectedRevision: 2 });
    expect(screen.getAllByText('Awaiting resolution')).toHaveLength(2);
  });

  it('SPK-AT-009: builds one resolution draft (relocate one game, cancel another) published through the normal command', async () => {
    const user = userEvent.setup();
    const active = closure({
      id: 'c1',
      status: 'active',
      revision: 3,
      impact: IMPACT,
      resolution: {
        mode: 'leave_for_resolution',
        canceledEventIds: [],
        unresolvedEventIds: ['e1', 'e2'],
      },
    });
    const app = createTestApp({
      routes: routes({
        'GET /closures/{id}': { status: 200, body: active },
        'POST /schedule-drafts': {
          status: 201,
          body: draft({ id: 'd9', name: 'Closure resolution: Flooded turf' }),
        },
        'GET /schedule-drafts/{id}': {
          status: 200,
          body: draft({ id: 'd9', name: 'Closure resolution: Flooded turf' }),
        },
        'GET /events': page([]),
        'GET /maintenance-restrictions': { status: 200, body: [] },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    expect(await screen.findByText(/depends on POL-041, DEC-009/)).toBeInTheDocument();
    const first = screen.getByRole('group', { name: /^U12 Red v Blue:/ });
    await user.click(within(first).getByLabelText('Relocate to another space'));
    const spaces = within(first).getByRole('group', { name: 'Spaces for U12 Red v Blue' });
    await user.click(within(spaces).getByLabelText(/Party room/));
    await user.click(within(spaces).getByLabelText(/^Pitch 1 \(Pitch/));
    const second = screen.getByRole('group', { name: /^Adult 7v7 final:/ });
    await user.click(within(second).getByLabelText('Cancel'));
    await user.click(screen.getByRole('button', { name: 'Create resolution draft (2 changes)' }));
    expect(await screen.findByRole('heading', { name: 'Schedule draft' })).toBeInTheDocument();
    const create = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/schedule-drafts',
    );
    expect(create?.body).toEqual({
      facilityId: FACILITY_A,
      name: 'Closure resolution: Flooded turf',
      changes: [
        { kind: 'resource_change', targetEventId: 'e1', resourceIds: [ROOM] },
        { kind: 'cancel', targetEventId: 'e2', proposed: { reason: 'Closure: Flooded turf' } },
      ],
    });
  });

  it('validation failure: a reschedule needs a valid new time before any draft is created', async () => {
    const user = userEvent.setup();
    const active = closure({
      id: 'c1',
      status: 'active',
      impact: IMPACT,
      resolution: {
        mode: 'leave_for_resolution',
        canceledEventIds: [],
        unresolvedEventIds: ['e1'],
      },
    });
    const app = createTestApp({
      routes: routes({
        'GET /closures/{id}': { status: 200, body: active },
        'GET /maintenance-restrictions': { status: 200, body: [] },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    const first = await screen.findByRole('group', { name: /^U12 Red v Blue:/ });
    await user.click(within(first).getByLabelText('Reschedule'));
    const end = within(first).getByRole('group', {
      name: 'New end for U12 Red v Blue (America/Los_Angeles)',
    });
    fireEvent.change(within(end).getByLabelText('Time'), { target: { value: '17:00' } });
    await user.click(screen.getByRole('button', { name: /Create resolution draft/ }));
    expect(screen.getByRole('list', { name: 'Problems to correct' })).toHaveTextContent(
      'U12 Red v Blue: the end must be after the start.',
    );
    expect(
      app.fake.requests.some((r) => r.method === 'POST' && r.route === '/schedule-drafts'),
    ).toBe(false);
  });

  it('a maintenance closure returns to service by release on its restriction, not by lifting here', async () => {
    const maintenance = closure({
      id: 'c1',
      status: 'active',
      source: 'maintenance',
      resourceId: HALF_B,
      impact: { ...IMPACT, affectedEvents: [] },
    });
    const app = createTestApp({
      routes: routes({
        'GET /closures/{id}': { status: 200, body: maintenance },
        'GET /maintenance-restrictions': {
          status: 200,
          body: [restriction({ id: 'r1', schedulingClosureId: 'c1' })],
        },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    expect(await screen.findByRole('link', { name: 'Open the restriction' })).toHaveAttribute(
      'href',
      '/facilities/restrictions/r1',
    );
    expect(screen.queryByRole('button', { name: 'Lift closure' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Nothing is affected' })).toBeInTheDocument();
  });

  it('lifting a manual closure asks for confirmation and sends the expected revision', async () => {
    const user = userEvent.setup();
    const active = closure({
      id: 'c1',
      status: 'active',
      revision: 7,
      impact: { ...IMPACT, affectedEvents: [] },
    });
    const app = createTestApp({
      routes: routes({
        'GET /closures/{id}': { status: 200, body: active },
        'POST /closures/{id}/lift': {
          status: 200,
          body: { ...active, status: 'lifted', revision: 8 },
        },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    await user.click(await screen.findByRole('button', { name: 'Lift closure' }));
    await user.click(screen.getByRole('button', { name: 'Confirm lift' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/closures/{id}/lift')).toBe(true),
    );
    expect(app.fake.requests.find((r) => r.route === '/closures/{id}/lift')?.body).toEqual({
      expectedRevision: 7,
    });
  });

  it('apply refused for lack of authority names the permission', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /closures/{id}/apply': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { details: { action: 'scheduling.manage_closures' } }),
          ),
      }),
    });
    render(app.at('/schedule/closures/c1'));
    await user.click(await screen.findByLabelText(/Cancel them now/));
    await user.click(screen.getByRole('button', { name: 'Apply closure' }));
    expect(
      await screen.findByText(/the permission scheduling\.manage_closures/),
    ).toBeInTheDocument();
  });

  it('SPK-UX-008 stale version: an apply refused as STALE_REVISION offers a Reload button that re-reads the closure', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /closures/{id}/apply': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/schedule/closures/c1'));
    await user.click(await screen.findByLabelText(/Cancel them now/));
    await user.click(screen.getByRole('button', { name: 'Apply closure' }));
    await screen.findByText(/Error code: STALE_REVISION/);
    const reads = app.fake.requests.filter((r) => r.route === '/closures/{id}').length;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/closures/{id}').length).toBe(reads + 1),
    );
    expect(screen.queryByText(/Error code: STALE_REVISION/)).toBeNull();
  });

  it('a closure the viewer may not see is not available', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /closures/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')) }),
    });
    render(app.at('/schedule/closures/c1'));
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
  });
});

describe('SCR-S-06 closures list', () => {
  it('creates a closure from facility-local times as a pending impact preview', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /closures': { status: 200, body: [] },
        'POST /closures': { status: 201, body: PENDING },
      }),
    });
    render(app.at('/schedule/closures'));
    expect(await screen.findByRole('heading', { name: 'No closures' })).toBeInTheDocument();
    await user.click(screen.getByLabelText(/One space/));
    await user.click(
      within(screen.getByRole('group', { name: 'Space' })).getByLabelText(/^Pitch 1 \(Pitch/),
    );
    for (const [group, date, time] of [
      ['From', '2026-10-24', '17:00'],
      ['Until', '2026-10-24', '23:00'],
    ] as const) {
      const field = screen.getByRole('group', { name: `${group} (America/Los_Angeles)` });
      fireEvent.change(within(field).getByLabelText('Date'), { target: { value: date } });
      fireEvent.change(within(field).getByLabelText('Time'), { target: { value: time } });
    }
    await user.click(screen.getByRole('button', { name: 'Preview impact' }));
    expect(screen.getByRole('list', { name: 'Problems to correct' })).toHaveTextContent(
      'Enter the reason for the closure.',
    );
    await user.type(screen.getByLabelText('Reason'), 'Flooded turf');
    await user.click(screen.getByRole('button', { name: 'Preview impact' }));
    expect(
      await screen.findByRole('heading', { name: 'Closure impact and resolution' }),
    ).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.method === 'POST' && r.route === '/closures')?.body,
    ).toEqual({
      facilityId: FACILITY_A,
      resourceId: PITCH,
      interval: { start: '2026-10-25T00:00:00.000Z', end: '2026-10-25T06:00:00.000Z' },
      reason: 'Flooded turf',
      source: 'manual',
    });
  });
});
