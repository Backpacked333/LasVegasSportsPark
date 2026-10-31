/**
 * SCR-S-06 Closure impact and resolution: SPK-SCHED-009 (affected games, programs, rentals, staff,
 * customers, financial obligations, messages; preview before creating, `GET /v1/closure-impact`),
 * SPK-AT-009 (complete impact preview, approved resolution, consistent publication through one
 * draft), SPK-FAC-003 (a pending closure is withdrawn before it applies; a restriction's closure
 * only with its restriction), SPK-AT-021 (maintenance closures return to service by release),
 * POL-041 and DEC-009 pending, SPK-UX-008 stale (affected set changed).
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

const NOTICE_ID = '0192f1a0-0000-7000-8000-00000000a0a1';
/** The same impact with an obligation and an unsent message (SPK-SCHED-009). */
const IMPACT_WITH_MONEY = {
  ...IMPACT,
  obligations: [{ type: 'enrollment_charge', id: 'ob-1', eventIds: ['e1'] }],
  messages: [
    { notificationId: NOTICE_ID, eventId: 'e2', kind: 'schedule_reminder', status: 'queued' },
  ],
  summary: { ...IMPACT.summary, obligations: 1, messages: 1 },
};
const RILEY = {
  personId: 'p1',
  canonicalPersonId: 'p1',
  givenName: 'Riley',
  familyName: 'Chen',
  displayName: 'Riley Chen',
  kind: 'adult' as const,
};

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /closures/{id}': { status: 200, body: PENDING },
    'GET /resources': { status: 200, body: INVENTORY },
    ...overrides,
  };
}

describe('SCR-S-06 ClosureDetailScreen', () => {
  it('SPK-SCHED-009: lists what is affected, including customers, obligations and unsent messages', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /closures/{id}': { status: 200, body: { ...PENDING, impact: IMPACT_WITH_MONEY } },
        'GET /person-names': { status: 200, body: { items: [RILEY] } },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    const table = await screen.findByRole('table', { name: 'What this closure affects' });
    expect(within(table).getByRole('row', { name: 'Games 2' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'Teams 4' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /People committed .* 2/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'Customers 1' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'Financial obligations 1' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'Messages not yet sent 1' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Affected financial obligations' })).toHaveTextContent(
      'enrollment charge',
    );
    expect(
      screen.getByText(/A financial adjustment for these obligations is not available yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: 'Unsent messages about affected events' }),
    ).toHaveTextContent('schedule reminderAbout Adult 7v7 final · status queued');
    // Names are read on request, names only (§4.14).
    expect(app.fake.requests.some((r) => r.route === '/person-names')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Show the 1 customer' }));
    const customers = await screen.findByRole('list', { name: 'Affected customers' });
    expect(await within(customers).findByText('Riley Chen')).toBeInTheDocument();
    expect(customers).toHaveTextContent('committed to the event · U12 Red v Blue, Adult 7v7 final');
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

describe('SCR-S-06 closure withdrawal (SPK-FAC-003)', () => {
  it('withdraws a pending closure with a reason and the expected revision', async () => {
    const user = userEvent.setup();
    const withdrawn = closure({
      id: 'c1',
      status: 'withdrawn',
      revision: 3,
      impact: IMPACT,
      withdrawnAt: '2026-10-24T12:05:00.000Z',
      withdrawalReason: 'Pitch drained in time',
    });
    const app = createTestApp({
      routes: routes({
        'POST /closures/{id}/withdraw': () => {
          app.fake.set('GET /closures/{id}', { status: 200, body: withdrawn });
          return fakeResponse(200, withdrawn);
        },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    await user.click(await screen.findByRole('button', { name: 'Withdraw closure' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter the reason for withdrawing the closure.',
    );
    expect(app.fake.requests.some((r) => r.route === '/closures/{id}/withdraw')).toBe(false);
    await user.type(screen.getByLabelText('Reason for withdrawing'), 'Pitch drained in time');
    await user.click(screen.getByRole('button', { name: 'Withdraw closure' }));
    expect(await screen.findByTestId('closure-withdrawn')).toHaveTextContent(
      'nothing was closed and nobody was told',
    );
    const request = app.fake.requests.find((r) => r.route === '/closures/{id}/withdraw');
    expect(request?.body).toEqual({ reason: 'Pitch drained in time', expectedRevision: 2 });
    expect(request?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    expect(screen.getByText('withdrawn')).toBeInTheDocument();
    expect(screen.getByText(/: Pitch drained in time$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply closure' })).toBeNull();
  });

  it('a closure held by a restriction (RESOURCE_CONFLICT OWNED_BY_RESTRICTION) links to that restriction', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /closures/{id}/withdraw': () =>
          fakeResponse(
            409,
            apiErrorBody('RESOURCE_CONFLICT', {
              details: { code: 'OWNED_BY_RESTRICTION', closureId: 'c1', restrictionId: 'r7' },
            }),
          ),
      }),
    });
    render(app.at('/schedule/closures/c1'));
    await user.type(await screen.findByLabelText('Reason for withdrawing'), 'Not needed');
    await user.click(screen.getByRole('button', { name: 'Withdraw closure' }));
    const banner = await screen.findByTestId('owned-by-restriction');
    expect(banner).toHaveTextContent('withdraw the restriction instead');
    expect(within(banner).getByRole('link', { name: 'Open the restriction' })).toHaveAttribute(
      'href',
      '/facilities/restrictions/r7',
    );
  });

  it('a pending maintenance closure offers no withdraw here, only its restriction', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /closures/{id}': {
          status: 200,
          body: { ...PENDING, source: 'maintenance' as const },
        },
        'GET /maintenance-restrictions': {
          status: 200,
          body: [restriction({ id: 'r1', status: 'approved', schedulingClosureId: 'c1' })],
        },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    expect(
      await screen.findByText(/It is withdrawn together with its restriction/),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open the restriction' })).toHaveAttribute(
      'href',
      '/facilities/restrictions/r1',
    );
    expect(screen.queryByRole('button', { name: 'Withdraw closure' })).toBeNull();
  });

  it('withdraw refused for lack of authority names the permission; STALE_REVISION offers Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /closures/{id}/withdraw': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { details: { action: 'scheduling.manage_closures' } }),
          ),
      }),
    });
    render(app.at('/schedule/closures/c1'));
    await user.type(await screen.findByLabelText('Reason for withdrawing'), 'Not needed');
    await user.click(screen.getByRole('button', { name: 'Withdraw closure' }));
    expect(
      await screen.findByText(
        /Withdrawing the closure is not available to you\. Your role does not include the permission scheduling\.manage_closures/,
      ),
    ).toBeInTheDocument();
    app.fake.set('POST /closures/{id}/withdraw', () =>
      fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
    );
    await user.click(screen.getByRole('button', { name: 'Withdraw closure' }));
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByText(/Error code: STALE_REVISION/)).toBeNull());
  });
});

describe('SCR-S-06 closures list', () => {
  it('previews the impact (GET /v1/closure-impact) before creating, then creates the pending closure', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /closures': { status: 200, body: [] },
        'GET /closure-impact': { status: 200, body: IMPACT },
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
    const preview = await screen.findByTestId('closure-preview');
    expect(app.fake.requests.find((r) => r.route === '/closure-impact')?.query).toEqual({
      facilityId: FACILITY_A,
      resourceId: PITCH,
      start: '2026-10-25T00:00:00.000Z',
      end: '2026-10-25T06:00:00.000Z',
    });
    expect(preview).toHaveTextContent('Nothing has been created or closed.');
    expect(
      within(preview).getByRole('table', { name: 'What this closure would affect' }),
    ).toHaveTextContent('Customers1');
    expect(within(preview).getByRole('list', { name: 'Affected events' })).toHaveTextContent(
      'U12 Red v Blue',
    );
    expect(app.fake.requests.some((r) => r.method === 'POST' && r.route === '/closures')).toBe(
      false,
    );
    await user.click(within(preview).getByRole('button', { name: 'Create pending closure' }));
    expect(screen.getByRole('list', { name: 'Problems to correct' })).toHaveTextContent(
      'Enter the reason for the closure.',
    );
    await user.type(screen.getByLabelText('Reason'), 'Flooded turf');
    await user.click(screen.getByRole('button', { name: 'Create pending closure' }));
    expect(
      await screen.findByRole('heading', { name: 'Closure impact and resolution' }),
    ).toBeInTheDocument();
    const create = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/closures');
    expect(create?.body).toEqual({
      facilityId: FACILITY_A,
      resourceId: PITCH,
      interval: { start: '2026-10-25T00:00:00.000Z', end: '2026-10-25T06:00:00.000Z' },
      reason: 'Flooded turf',
      source: 'manual',
    });
    expect(create?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
  });

  it('a change after the preview asks for a new preview before anything is created', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /closures': { status: 200, body: [] },
        'GET /closure-impact': { status: 200, body: IMPACT },
      }),
    });
    render(app.at('/schedule/closures'));
    await user.click(await screen.findByLabelText('The whole facility'));
    for (const [group, time] of [
      ['From', '17:00'],
      ['Until', '23:00'],
    ] as const) {
      const field = screen.getByRole('group', { name: `${group} (America/Los_Angeles)` });
      fireEvent.change(within(field).getByLabelText('Date'), { target: { value: '2026-10-24' } });
      fireEvent.change(within(field).getByLabelText('Time'), { target: { value: time } });
    }
    await user.click(screen.getByRole('button', { name: 'Preview impact' }));
    expect(await screen.findByTestId('closure-preview')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/closure-impact')?.query).not.toHaveProperty(
      'resourceId',
    );
    const until = screen.getByRole('group', { name: 'Until (America/Los_Angeles)' });
    fireEvent.change(within(until).getByLabelText('Time'), { target: { value: '22:00' } });
    expect(await screen.findByTestId('preview-outdated')).toHaveTextContent(
      'Preview the impact again before creating the closure.',
    );
    expect(screen.queryByRole('button', { name: 'Create pending closure' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Preview impact' }));
    expect(await screen.findByTestId('closure-preview')).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/closure-impact').at(-1)?.query.end).toBe(
      '2026-10-25T05:00:00.000Z',
    );
  });

  it('a preview refused for lack of authority names the permission and creates nothing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /closures': { status: 200, body: [] },
        'GET /closure-impact': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { details: { action: 'scheduling.manage_closures' } }),
          ),
      }),
    });
    render(app.at('/schedule/closures'));
    await user.click(await screen.findByLabelText('The whole facility'));
    for (const [group, time] of [
      ['From', '17:00'],
      ['Until', '23:00'],
    ] as const) {
      const field = screen.getByRole('group', { name: `${group} (America/Los_Angeles)` });
      fireEvent.change(within(field).getByLabelText('Date'), { target: { value: '2026-10-24' } });
      fireEvent.change(within(field).getByLabelText('Time'), { target: { value: time } });
    }
    await user.click(screen.getByRole('button', { name: 'Preview impact' }));
    expect(
      await screen.findByText(/the permission scheduling\.manage_closures/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create pending closure' })).toBeNull();
  });

  it('lists a withdrawn closure with its reason, by status in text', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /closures': {
          status: 200,
          body: [
            closure({
              id: 'c2',
              status: 'withdrawn',
              withdrawnAt: '2026-10-24T12:05:00.000Z',
              withdrawalReason: 'Pitch drained in time',
            }),
          ],
        },
      }),
    });
    render(app.at('/schedule/closures'));
    const list = await screen.findByRole('list', { name: 'Closures' });
    expect(list).toHaveTextContent('withdrawn: Pitch drained in time');
    expect(within(list).getByText('withdrawn')).toBeInTheDocument();
  });
});
