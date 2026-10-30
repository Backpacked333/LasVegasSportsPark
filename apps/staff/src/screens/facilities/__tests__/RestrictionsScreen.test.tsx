/**
 * SCR-S-42 Operating restrictions and release to service: SPK-FAC-003 (an approved restriction
 * affects availability for a whole pitch or a subdivision), SPK-FAC-004 (authorized release; a
 * required inspection gates it), SPK-AT-021 (turf restriction closes a subdivision; authorized
 * reopening), SPK-SCHED-009 (open closure resolution as recovery required), FAC-01 withdrawal of a
 * restriction that never took effect, DEC-001 pending.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HALF_A,
  HALF_B,
  INVENTORY,
  PITCH,
  UNIT_A,
  UNIT_B,
  closure,
  oneFacilityRoutes,
  restriction,
  task,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const ACTIVE = restriction({
  id: 'r-1',
  taskId: 't-1',
  schedulingClosureId: 'c-1',
  operationId: 'op-1',
  revision: 4,
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /assets': { status: 200, body: [] },
    'GET /maintenance-restrictions': { status: 200, body: [ACTIVE] },
    'GET /maintenance-restrictions/{id}': { status: 200, body: ACTIVE },
    'GET /maintenance-tasks/{id}': {
      status: 200,
      body: task({
        id: 't-1',
        status: 'resolved',
        requiresInspection: true,
        latestInspection: null,
      }),
    },
    'GET /closures/{id}': {
      status: 200,
      body: closure({
        id: 'c-1',
        source: 'maintenance',
        status: 'active',
        resourceId: HALF_A,
        resolution: {
          mode: 'leave_for_resolution',
          canceledEventIds: [],
          unresolvedEventIds: ['e-1', 'e-2'],
        },
      }),
    },
    'GET /operations/{id}': {
      status: 200,
      body: {
        id: 'op-1',
        kind: 'facilities.approve_restriction',
        status: 'succeeded',
        correlationId: null,
        result: null,
        error: null,
        createdAt: '2026-10-24T12:00:00.000Z',
        updatedAt: '2026-10-24T12:00:00.000Z',
        completedAt: '2026-10-24T12:00:00.000Z',
      },
    },
    'GET /facilities/{id}/operating-status': {
      status: 200,
      body: {
        facilityId: FACILITY_A,
        at: '2026-10-24T12:00:00.000Z',
        resources: [
          {
            resourceId: PITCH,
            name: 'Pitch 1',
            kind: 'pitch',
            parentResourceId: null,
            inventoryStatus: 'active',
            conflictUnitIds: [UNIT_A, UNIT_B],
            status: 'restricted',
            restrictions: [
              {
                restrictionId: 'r-1',
                kind: 'closed',
                reason: 'Turf repair',
                interval: ACTIVE.interval,
                taskId: 't-1',
                resourceId: HALF_A,
                affectedConflictUnitIds: [UNIT_A],
              },
            ],
          },
          {
            resourceId: HALF_A,
            name: 'Pitch 1 North',
            kind: 'subdivision',
            parentResourceId: PITCH,
            inventoryStatus: 'active',
            conflictUnitIds: [UNIT_A],
            status: 'restricted',
            restrictions: [
              {
                restrictionId: 'r-1',
                kind: 'closed',
                reason: 'Turf repair',
                interval: ACTIVE.interval,
                taskId: 't-1',
                resourceId: HALF_A,
                affectedConflictUnitIds: [UNIT_A],
              },
            ],
          },
          {
            resourceId: HALF_B,
            name: 'Pitch 1 South',
            kind: 'subdivision',
            parentResourceId: PITCH,
            inventoryStatus: 'active',
            conflictUnitIds: [UNIT_B],
            status: 'in_service',
            restrictions: [],
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('SCR-S-42 RestrictionsScreen', () => {
  it('SPK-AT-021: a turf restriction on one half restricts that half and the whole pitch, not the other half', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/restrictions'));
    const status = await screen.findByRole('list', { name: /Operating status at/ });
    const rows = within(status).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(
        /^Pitch 1closed: Turf repair, .* \(through shared space\).*restricted$/,
      ),
      expect.stringMatching(/^Pitch 1 Northclosed: Turf repair, .*restricted$/),
      expect.stringMatching(/^Pitch 1 South.*in_service$/),
    ]);
    expect(await screen.findByRole('list', { name: 'Restrictions' })).toHaveTextContent(
      'Pitch 1 North: Turf repair',
    );
  });

  it('applying a restriction needs the area, kind, reason and an explicit choice for booked events; approve or propose', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /maintenance-restrictions': {
          status: 201,
          body: restriction({ id: 'r-2', status: 'proposed' }),
        },
      }),
    });
    render(app.at('/facilities/restrictions?taskId=t-1'));
    const form = await screen.findByRole('region', { name: 'Apply an operating restriction' });
    expect(
      await within(form).findByRole('link', { name: 'Torn net on north goal' }),
    ).toBeInTheDocument();
    expect(within(form).getByText(/depends on DEC-001/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Propose for approval' }));
    const problems = within(form).getByRole('list', { name: 'Problems to correct' });
    expect(problems).toHaveTextContent('Choose the kind of restriction.');
    expect(problems).toHaveTextContent('Choose what happens to events already booked.');
    await user.click(within(form).getByLabelText(/^closed$/));
    for (const [group, date, time] of [
      ['From', '2026-10-25', '06:00'],
      ['Until', '2026-10-26', '06:00'],
    ] as const) {
      const field = within(form).getByRole('group', { name: `${group} (America/Los_Angeles)` });
      fireEvent.change(within(field).getByLabelText('Date'), { target: { value: date } });
      fireEvent.change(within(field).getByLabelText('Time'), { target: { value: time } });
    }
    await user.type(within(form).getByLabelText('Reason'), 'Re-seed goal mouth');
    await user.click(within(form).getByLabelText(/Leave them for resolution/));
    await user.click(within(form).getByRole('button', { name: 'Propose for approval' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.method === 'POST' && r.route === '/maintenance-restrictions',
        ),
      ).toBe(true),
    );
    expect(
      app.fake.requests.find((r) => r.method === 'POST' && r.route === '/maintenance-restrictions')
        ?.body,
    ).toEqual({
      facilityId: FACILITY_A,
      // The task's own space is the default affected area.
      resourceId: HALF_A,
      taskId: 't-1',
      kind: 'closed',
      interval: { start: '2026-10-25T13:00:00.000Z', end: '2026-10-26T13:00:00.000Z' },
      reason: 'Re-seed goal mouth',
      approve: false,
      resolutionMode: 'leave_for_resolution',
    });
    expect(
      await screen.findByRole('heading', { name: 'Operating restriction' }),
    ).toBeInTheDocument();
  });
});

describe('SCR-S-42 RestrictionDetailScreen', () => {
  it('shows the area it blocks, the inspection gate and the open closure resolution (recovery required)', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/restrictions/r-1'));
    expect(
      await screen.findByText(
        /Pitch 1 North, a subdivision: only this part is blocked, plus any booking of its whole pitch/,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('No inspection recorded')).toBeInTheDocument();
    expect(
      screen.getByText('A passed inspection is required before this area returns to service.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Recovery required: closure impact resolution still open'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Resolve on Closures' })).toHaveAttribute(
      'href',
      '/schedule/closures/c-1',
    );
    expect(await screen.findByText('Operation succeeded: Done')).toBeInTheDocument();
  });

  it('SCR-S-42: when the closure cannot be read, the booking impact says so instead of disappearing', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /closures/{id}': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
        'GET /operations/{id}': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    const impact = await screen.findByRole('region', { name: 'Booking impact' });
    expect(
      await within(impact).findByText(
        'Booking impact could not be loaded; open Closures to check for events awaiting resolution.',
      ),
    ).toBeInTheDocument();
    expect(within(impact).getByRole('link', { name: 'Open the closure' })).toHaveAttribute(
      'href',
      '/schedule/closures/c-1',
    );
    expect(
      await screen.findByText(/operation status not available \(INTERNAL_ERROR\)/),
    ).toBeInTheDocument();
  });

  it('SPK-FAC-004: release without a passed inspection is refused and says what is missing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /maintenance-restrictions/{id}/release': () =>
          fakeResponse(
            422,
            apiErrorBody('ELIGIBILITY_FAILED', {
              nextAction: 'review_eligibility_reasons',
              message: 'A passed inspection is required before this area returns to service.',
              details: {
                code: 'inspection_required',
                taskId: 't-1',
                taskStatus: 'resolved',
                latestInspection: {
                  id: 'i-1',
                  outcome: 'failed',
                  inspectedAt: '2026-10-24T11:00:00.000Z',
                },
              },
            }),
          ),
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    await user.click(await screen.findByRole('button', { name: 'Release to service' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the reason for the release.');
    await user.type(screen.getByLabelText('Reason for the release'), 'Repair complete');
    await user.click(screen.getByRole('button', { name: 'Release to service' }));
    const gate = await screen.findByTestId('inspection-required');
    expect(gate).toHaveTextContent('Release refused: a passed inspection is required');
    expect(gate).toHaveTextContent('The latest inspection failed.');
    expect(within(gate).getByRole('link', { name: 'Open the task' })).toHaveAttribute(
      'href',
      '/facilities/maintenance/tasks/t-1',
    );
    const release = app.fake.requests.find(
      (r) => r.route === '/maintenance-restrictions/{id}/release',
    );
    expect(release?.body).toEqual({ expectedRevision: 4, reason: 'Repair complete' });
  });

  it('release authority: ACCESS_DENIED names facilities.release_to_service', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /maintenance-restrictions/{id}/release': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { details: { action: 'facilities.release_to_service' } }),
          ),
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    await user.type(await screen.findByLabelText('Reason for the release'), 'Repair complete');
    await user.click(screen.getByRole('button', { name: 'Release to service' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/the permission facilities\.release_to_service/)).toBeInTheDocument();
  });

  it('stale version: an inspection recorded concurrently surfaces as STALE_REVISION with Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /maintenance-restrictions/{id}/release': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    await user.type(await screen.findByLabelText('Reason for the release'), 'Repair complete');
    await user.click(screen.getByRole('button', { name: 'Release to service' }));
    expect(
      await screen.findByText('Error code: STALE_REVISION. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('an approved restriction whose activation did not complete offers to resume it', async () => {
    const user = userEvent.setup();
    const approved = restriction({
      id: 'r-1',
      status: 'approved',
      revision: 2,
      schedulingClosureId: null,
      taskId: null,
    });
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': { status: 200, body: approved },
        'POST /maintenance-restrictions/{id}/approve': {
          status: 200,
          body: { ...approved, status: 'active', revision: 3 },
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    expect(await screen.findByText('approved: activation not complete')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume activation' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/maintenance-restrictions/{id}/approve'),
      ).toBe(true),
    );
    expect(
      app.fake.requests.find((r) => r.route === '/maintenance-restrictions/{id}/approve')?.body,
    ).toEqual({ expectedRevision: 2 });
  });

  it('a restriction the viewer may not see is not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
  });
});

describe('SCR-S-42 restriction withdrawal (FAC-01, SPK-FAC-004)', () => {
  const PROPOSED = restriction({
    id: 'r-2',
    status: 'proposed',
    revision: 1,
    approvedAt: null,
    schedulingClosureId: null,
    taskId: null,
  });

  it('withdraws a proposed restriction with a reason and the expected revision', async () => {
    const user = userEvent.setup();
    const withdrawn = {
      ...PROPOSED,
      status: 'withdrawn' as const,
      revision: 2,
      withdrawnAt: '2026-10-24T12:05:00.000Z',
      withdrawnBy: PROPOSED.approvedBy,
      withdrawalReason: 'Repair postponed',
    };
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': { status: 200, body: PROPOSED },
        'POST /maintenance-restrictions/{id}/withdraw': () => {
          app.fake.set('GET /maintenance-restrictions/{id}', { status: 200, body: withdrawn });
          return fakeResponse(200, withdrawn);
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-2'));
    await user.click(await screen.findByRole('button', { name: 'Withdraw restriction' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter the reason for withdrawing the restriction.',
    );
    expect(
      app.fake.requests.some((r) => r.route === '/maintenance-restrictions/{id}/withdraw'),
    ).toBe(false);
    await user.type(screen.getByLabelText('Reason for withdrawing'), 'Repair postponed');
    await user.click(screen.getByRole('button', { name: 'Withdraw restriction' }));
    expect(await screen.findByTestId('restriction-withdrawn')).toHaveTextContent(
      'withdrawn before it took effect',
    );
    const request = app.fake.requests.find(
      (r) => r.route === '/maintenance-restrictions/{id}/withdraw',
    );
    expect(request?.body).toEqual({ reason: 'Repair postponed', expectedRevision: 1 });
    expect(request?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    expect(screen.getByText('withdrawn: never took effect')).toBeInTheDocument();
    expect(screen.getByText(/by Facilities lead: Repair postponed$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and make effective' })).toBeNull();
  });

  it('an approved restriction is withdrawn together with its pending closure', async () => {
    const approved = restriction({
      id: 'r-3',
      status: 'approved',
      revision: 2,
      schedulingClosureId: 'c-9',
      taskId: null,
    });
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': { status: 200, body: approved },
        'GET /closures/{id}': {
          status: 200,
          body: closure({ id: 'c-9', source: 'maintenance', status: 'pending' }),
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-3'));
    expect(
      await screen.findByText(/before it takes effect, together with its planned closure/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw restriction' })).toBeEnabled();
  });

  it('an approved restriction whose closure is already applied offers resume and release, not withdrawal', async () => {
    const approved = restriction({
      id: 'r-3',
      status: 'approved',
      revision: 2,
      schedulingClosureId: 'c-9',
      taskId: null,
    });
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': { status: 200, body: approved },
        'GET /closures/{id}': {
          status: 200,
          body: closure({ id: 'c-9', source: 'maintenance', status: 'active' }),
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-3'));
    expect(await screen.findByTestId('withdraw-not-offered')).toHaveTextContent(
      'Its closure is already applied, so this restriction can no longer be withdrawn. Resume activation above, then release it to return the area to service.',
    );
    expect(screen.getByRole('button', { name: 'Resume activation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw restriction' })).toBeNull();
    expect(screen.queryByLabelText('Reason for withdrawing')).toBeNull();
  });

  it('INVALID_TRANSITION on an approved restriction says to resume activation, then release it', async () => {
    const user = userEvent.setup();
    const approved = restriction({
      id: 'r-3',
      status: 'approved',
      revision: 2,
      schedulingClosureId: 'c-9',
      taskId: null,
    });
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': { status: 200, body: approved },
        // The read still says pending; the closure was applied in the meantime.
        'GET /closures/{id}': {
          status: 200,
          body: closure({ id: 'c-9', source: 'maintenance', status: 'pending' }),
        },
        'POST /maintenance-restrictions/{id}/withdraw': () =>
          fakeResponse(409, apiErrorBody('INVALID_TRANSITION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/facilities/restrictions/r-3'));
    await user.type(await screen.findByLabelText('Reason for withdrawing'), 'Not needed');
    await user.click(screen.getByRole('button', { name: 'Withdraw restriction' }));
    const banner = await screen.findByTestId('withdraw-took-effect');
    expect(banner).toHaveTextContent('Already in effect: resume activation, then release it');
    expect(banner).not.toHaveTextContent('release it instead');
    expect(within(banner).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('already in effect (INVALID_TRANSITION): says to release it instead, with Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': { status: 200, body: PROPOSED },
        'POST /maintenance-restrictions/{id}/withdraw': () =>
          fakeResponse(409, apiErrorBody('INVALID_TRANSITION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/facilities/restrictions/r-2'));
    await user.type(await screen.findByLabelText('Reason for withdrawing'), 'Not needed');
    await user.click(screen.getByRole('button', { name: 'Withdraw restriction' }));
    const banner = await screen.findByTestId('withdraw-took-effect');
    expect(banner).toHaveTextContent('Already in effect: release it instead');
    const reads = app.fake.requests.filter(
      (r) => r.route === '/maintenance-restrictions/{id}',
    ).length;
    await user.click(within(banner).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/maintenance-restrictions/{id}').length,
      ).toBeGreaterThan(reads),
    );
    expect(screen.queryByTestId('withdraw-took-effect')).toBeNull();
  });

  it('withdraw refused for lack of authority names the permission', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions/{id}': { status: 200, body: PROPOSED },
        'POST /maintenance-restrictions/{id}/withdraw': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { details: { action: 'facilities.apply_restriction' } }),
          ),
      }),
    });
    render(app.at('/facilities/restrictions/r-2'));
    await user.type(await screen.findByLabelText('Reason for withdrawing'), 'Not needed');
    await user.click(screen.getByRole('button', { name: 'Withdraw restriction' }));
    expect(
      await screen.findByText(
        /Withdrawing the restriction is not available to you\. Your role does not include the permission facilities\.apply_restriction/,
      ),
    ).toBeInTheDocument();
  });

  it('an active restriction offers release, not withdrawal', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/restrictions/r-1'));
    expect(await screen.findByRole('button', { name: 'Release to service' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw restriction' })).toBeNull();
  });

  it('lists a withdrawn restriction with its reason', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-restrictions': {
          status: 200,
          body: [
            restriction({
              id: 'r-4',
              status: 'withdrawn',
              withdrawnAt: '2026-10-24T12:05:00.000Z',
              withdrawalReason: 'Repair postponed',
            }),
          ],
        },
      }),
    });
    render(app.at('/facilities/restrictions'));
    const list = await screen.findByRole('list', { name: 'Restrictions' });
    expect(list).toHaveTextContent('withdrawn: Repair postponed');
    expect(within(list).getByText('withdrawn: never took effect')).toBeInTheDocument();
  });
});
