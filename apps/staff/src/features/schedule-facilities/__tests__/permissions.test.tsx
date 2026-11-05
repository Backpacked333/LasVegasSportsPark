/**
 * SPK-UX-008 permission restriction on the schedule and facilities screens (SCR-S-04, SCR-S-06,
 * SCR-S-07, SCR-S-41, SCR-S-42): commands are offered from the role view of
 * `GET /v1/me/permissions` at the record's facility; an action the roles do not include reads "Not
 * available to you" and names the permission, while the records stay readable. Nothing is hidden
 * while the permission read is unknown (the command's own ACCESS_DENIED still decides), and a
 * CAPABILITY_DISABLED answer reads as turned off, never as "not available to you".
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@sportspark/api-client';
import { FACILITY_A, FACILITY_B, createTestApp, mePermissions } from '../../../testing/test-app';
import { CommandError } from '../CommandError';
import {
  INVENTORY,
  PITCH,
  SCHEDULE_FACILITY_ACTIONS,
  asset,
  closure,
  draft,
  event,
  oneFacilityRoutes,
  page,
  restriction,
  scopedPermissions,
  task,
} from '../test-fixtures';

const without = (...ids: string[]) =>
  scopedPermissions(SCHEDULE_FACILITY_ACTIONS.filter((a) => !ids.includes(a)));

const MOVE = {
  sequence: 1,
  kind: 'move' as const,
  targetEventId: 'e-game',
  baseEventRevision: 1,
  proposed: {
    scheduledStart: '2026-10-25T02:00:00.000Z',
    scheduledEnd: '2026-10-25T03:30:00.000Z',
  },
  resourceIds: [],
};

/** A preventive schedule at facility A (`PreventiveSchedule`), active. */
const PREVENTIVE = {
  id: 'pm-1',
  facilityId: FACILITY_A,
  resourceId: PITCH,
  assetId: null,
  name: 'Monthly turf grooming',
  recurrence: { frequency: 'weekly' as const, interval: 4, startDate: '2026-10-26', count: 6 },
  localStartTime: '06:00',
  durationMinutes: 120,
  timezone: 'America/Los_Angeles',
  taskTemplate: {
    issue: 'Groom turf',
    severity: 'low' as const,
    requiresInspection: false,
    assignedOwnerPersonId: null,
  },
  restrictionKind: 'closed' as const,
  leadTimeDays: 14,
  status: 'active' as const,
  lastGeneratedAt: null,
  lastGeneratedThrough: null,
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

/** A pending closure whose impact lists one published game to resolve (SCR-S-06). */
const PENDING_WITH_IMPACT = closure({
  id: 'c1',
  impact: {
    interval: { start: '2026-10-25T00:00:00.000Z', end: '2026-10-25T06:00:00.000Z' },
    affectedEvents: [
      {
        eventId: 'e1',
        title: 'U12 Red v Blue',
        kind: 'game',
        status: 'published',
        scheduledStart: '2026-10-25T01:00:00.000Z',
        scheduledEnd: '2026-10-25T02:30:00.000Z',
        sourceType: 'fixture',
        sourceId: 'e1-fixture',
        resourceIds: [PITCH],
        reservationIds: [],
        commitments: [],
      },
    ],
    sourceRecords: [{ sourceType: 'fixture', sourceId: 'e1-fixture', eventIds: ['e1'] }],
    customers: [],
    obligations: [],
    messages: [],
    summary: {
      games: 1,
      programs: 0,
      rentals: 0,
      other: 0,
      teams: 0,
      people: 0,
      equipment: 0,
      customers: 0,
      obligations: 0,
      messages: 0,
    },
  },
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /conflict-units': { status: 200, body: [] },
    'GET /resource-configurations': { status: 200, body: [] },
    'GET /operating-hours': { status: 200, body: [] },
    'GET /schedule-drafts/{id}': {
      status: 200,
      body: draft({ id: 'd1', changes: [MOVE] }),
    },
    'GET /events/{id}': { status: 200, body: event({ id: 'e-game', title: 'U12 Red v Blue' }) },
    'GET /events': page([]),
    'GET /closures': { status: 200, body: [closure({ id: 'c1' })] },
    'GET /closures/{id}': { status: 200, body: closure({ id: 'c1' }) },
    'GET /maintenance-restrictions': { status: 200, body: [] },
    'GET /maintenance-restrictions/{id}': {
      status: 200,
      body: restriction({ id: 'r-1' }),
    },
    'GET /maintenance-tasks/{id}': { status: 200, body: task({ id: 't-1' }) },
    'GET /maintenance-tasks/{id}/inspections': { status: 200, body: [] },
    'GET /assets': { status: 200, body: [] },
    ...overrides,
  };
}

const notAvailable = (permission: string) =>
  new RegExp(`Your role does not include the permission ${permission.replace('.', '\\.')}`);

describe('schedule and facilities: permission restriction from GET /v1/me/permissions', () => {
  it('SCR-S-04: without scheduling.manage_drafts the draft reads only, naming the permission', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': without('scheduling.manage_drafts') }),
    });
    render(app.at('/schedule/drafts/d1'));
    expect(await screen.findByTestId('draft-change-1')).toBeInTheDocument();
    expect(
      await screen.findByText(/Editing schedule drafts is not available to you at this facility/),
    ).toHaveTextContent(notAvailable('scheduling.manage_drafts'));
    expect(screen.queryByRole('button', { name: 'Add new event to draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Validate' })).toBeNull();
    expect(screen.getByLabelText('Draft name')).toBeDisabled();
  });

  it('SCR-S-04: without scheduling.publish_schedule the draft is edited but not published from here', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': without('scheduling.publish_schedule') }),
    });
    render(app.at('/schedule/drafts/d1'));
    expect(
      await screen.findByText(/Publishing schedules is not available to you/),
    ).toHaveTextContent(notAvailable('scheduling.publish_schedule'));
    expect(screen.queryByRole('link', { name: 'Review and publish' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add new event to draft' })).toBeInTheDocument();
  });

  it('SCR-S-05: without scheduling.publish_schedule the review shows the draft but no Publish command', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': without('scheduling.publish_schedule') }),
    });
    render(app.at('/schedule/drafts/d1/publish'));
    expect(
      await screen.findByText(/Publishing schedules is not available to you/),
    ).toHaveTextContent(notAvailable('scheduling.publish_schedule'));
    expect(screen.queryByRole('button', { name: /^Publish \d+ change/ })).toBeNull();
  });

  it('SCR-S-06: an action allowed only at another facility is not offered here; closures stay listed', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({
          actions: [{ id: 'scheduling.manage_closures', facilityIds: [FACILITY_B] }],
        }),
      }),
    });
    render(app.at('/schedule/closures'));
    expect(await screen.findByRole('list', { name: 'Closures' })).toBeInTheDocument();
    expect(
      screen.getByText(/Previewing and creating closures is not available to you/),
    ).toHaveTextContent(notAvailable('scheduling.manage_closures'));
    expect(screen.queryByRole('button', { name: 'Preview impact' })).toBeNull();
  });

  it('SCR-S-06: without scheduling.manage_closures a pending closure is neither applied nor withdrawn here', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': without('scheduling.manage_closures') }),
    });
    render(app.at('/schedule/closures/c1'));
    expect(
      await screen.findByText(/Applying or withdrawing this closure is not available to you/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply closure' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw closure' })).toBeNull();
  });

  it('SCR-S-07: without scheduling.manage_inventory the inventory reads only', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': without('scheduling.manage_inventory') }),
    });
    render(app.at('/schedule/resources'));
    expect(await screen.findByRole('list', { name: 'Spaces' })).toBeInTheDocument();
    expect(
      screen.getByText(/Changing the resource inventory is not available to you/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add operating hours' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add an arrangement' })).toBeNull();
  });

  it('SCR-S-41: without facilities.manage_maintenance_task the task is shown without its lifecycle', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': without('facilities.manage_maintenance_task') }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    expect(await screen.findByText('Torn net on north goal')).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Assigning, updating, resolving or closing maintenance tasks is not available to you/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Record inspection' })).toBeInTheDocument();
  });

  it('SCR-S-42: without facilities.release_to_service an active restriction is not released here', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': without('facilities.release_to_service') }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    expect(
      await screen.findByText(/Releasing areas to service is not available to you/),
    ).toHaveTextContent(notAvailable('facilities.release_to_service'));
    expect(screen.queryByRole('button', { name: 'Release to service' })).toBeNull();
  });

  it('SCR-S-04: without scheduling.manage_drafts no draft is opened from the list; drafts stay listed', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': without('scheduling.manage_drafts'),
        'GET /schedule-drafts': { status: 200, body: [draft({ id: 'd1' })] },
      }),
    });
    render(app.at('/schedule/drafts'));
    expect(await screen.findByRole('list', { name: 'Schedule drafts' })).toHaveTextContent(
      'Week 9 changes',
    );
    expect(
      await screen.findByText(/Opening schedule drafts is not available to you/),
    ).toHaveTextContent(notAvailable('scheduling.manage_drafts'));
    expect(screen.queryByRole('button', { name: 'Open draft' })).toBeNull();
    expect(screen.queryByLabelText('Draft name')).toBeNull();
  });

  it('SCR-S-06: without scheduling.manage_drafts no resolution draft is built; the impact stays readable', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': without('scheduling.manage_drafts'),
        'GET /closures/{id}': { status: 200, body: PENDING_WITH_IMPACT },
      }),
    });
    render(app.at('/schedule/closures/c1'));
    expect(await screen.findByText('U12 Red v Blue')).toBeInTheDocument();
    expect(
      await screen.findByText(/Building a resolution draft is not available to you/),
    ).toHaveTextContent(notAvailable('scheduling.manage_drafts'));
    expect(screen.queryByRole('heading', { name: 'Build a resolution' })).toBeNull();
    // Applying is a different permission and is still offered.
    expect(screen.getByRole('button', { name: 'Apply closure' })).toBeInTheDocument();
  });

  it('SCR-S-41: without facilities.report_issue no issue is reported here; tasks stay listed', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': without('facilities.report_issue'),
        'GET /maintenance-tasks': page([task({ id: 't-1' })]),
        'GET /preventive-schedules': { status: 200, body: [] },
      }),
    });
    render(app.at('/facilities/maintenance'));
    expect(await screen.findByTestId('task-t-1')).toHaveTextContent('Torn net on north goal');
    expect(
      await screen.findByText(/Reporting maintenance issues is not available to you/),
    ).toHaveTextContent(notAvailable('facilities.report_issue'));
    expect(screen.queryByRole('form', { name: 'Report an issue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Report issue' })).toBeNull();
  });

  it('SCR-S-41: without facilities.manage_asset assets are listed with no register, edit or retire command', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': without('facilities.manage_asset'),
        'GET /maintenance-tasks': page([]),
        'GET /preventive-schedules': { status: 200, body: [] },
        'GET /assets': { status: 200, body: [asset({ id: 'as-1', name: 'North goal' })] },
      }),
    });
    render(app.at('/facilities/maintenance'));
    const assets = await screen.findByRole('list', { name: 'Assets' });
    expect(assets).toHaveTextContent('North goal');
    expect(
      await screen.findByText(/Registering, editing or retiring assets is not available to you/),
    ).toHaveTextContent(notAvailable('facilities.manage_asset'));
    expect(within(assets).queryByRole('button', { name: 'Edit North goal' })).toBeNull();
    expect(within(assets).queryByRole('button', { name: 'Retire North goal' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Register an asset' })).toBeNull();
  });

  it('SCR-S-41: with facilities.manage_asset each asset offers Edit and Retire', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-tasks': page([]),
        'GET /preventive-schedules': { status: 200, body: [] },
        'GET /assets': { status: 200, body: [asset({ id: 'as-1', name: 'North goal' })] },
      }),
    });
    render(app.at('/facilities/maintenance'));
    const assets = await screen.findByRole('list', { name: 'Assets' });
    expect(within(assets).getByRole('button', { name: 'Edit North goal' })).toBeInTheDocument();
    expect(within(assets).getByRole('button', { name: 'Retire North goal' })).toBeInTheDocument();
  });

  it('SCR-S-41: without facilities.schedule_preventive_maintenance schedules are listed with no generate, pause or end command', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': without('facilities.schedule_preventive_maintenance'),
        'GET /maintenance-tasks': page([]),
        'GET /preventive-schedules': { status: 200, body: [PREVENTIVE] },
      }),
    });
    render(app.at('/facilities/maintenance'));
    const list = await screen.findByRole('list', { name: 'Preventive schedules' });
    expect(list).toHaveTextContent('Monthly turf grooming');
    expect(
      await screen.findByText(
        /Creating, generating, pausing or ending preventive maintenance is not available to you/,
      ),
    ).toHaveTextContent(notAvailable('facilities.schedule_preventive_maintenance'));
    expect(
      within(list).queryByRole('button', {
        name: 'Generate due occurrences of Monthly turf grooming',
      }),
    ).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Pause Monthly turf grooming' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'End Monthly turf grooming' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New preventive schedule' })).toBeNull();
  });

  it('SCR-S-41: without facilities.record_inspection inspections are listed but none is recorded here', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': without('facilities.record_inspection') }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    expect(await screen.findByRole('heading', { name: 'No inspections recorded' })).toBeVisible();
    expect(
      await screen.findByText(/Recording inspections is not available to you/),
    ).toHaveTextContent(notAvailable('facilities.record_inspection'));
    expect(screen.queryByRole('button', { name: 'Record inspection' })).toBeNull();
    // Task work is a different permission and is still offered.
    expect(screen.getByRole('button', { name: 'Assign to me' })).toBeInTheDocument();
  });

  it('SCR-S-42: without facilities.apply_restriction no restriction is applied here; restrictions stay listed', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': without('facilities.apply_restriction'),
        'GET /maintenance-restrictions': { status: 200, body: [restriction({ id: 'r-1' })] },
      }),
    });
    render(app.at('/facilities/restrictions'));
    expect(await screen.findByRole('list', { name: 'Restrictions' })).toHaveTextContent(
      'Turf repair',
    );
    expect(
      await screen.findByText(/Applying operating restrictions is not available to you/),
    ).toHaveTextContent(notAvailable('facilities.apply_restriction'));
    expect(screen.queryByRole('region', { name: 'Apply an operating restriction' })).toBeNull();
  });

  it('SCR-S-42: without facilities.apply_restriction a proposed restriction is neither approved nor withdrawn here', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': without('facilities.apply_restriction'),
        'GET /maintenance-restrictions/{id}': {
          status: 200,
          body: restriction({ id: 'r-1', status: 'proposed', approvedAt: null, revision: 1 }),
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    expect(await screen.findByText('Turf repair', { exact: false })).toBeInTheDocument();
    expect(
      await screen.findByText(/Approving or withdrawing restrictions is not available to you/),
    ).toHaveTextContent(notAvailable('facilities.apply_restriction'));
    expect(screen.queryByRole('button', { name: 'Approve and make effective' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw restriction' })).toBeNull();
  });

  it('nothing is hidden while the permission read failed: the command itself decides', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      }),
    });
    render(app.at('/schedule/closures/c1'));
    // Wait for the failed state itself, not only for the request to have been sent.
    await waitFor(() =>
      expect(
        app.queryClient.getQueryCache().find({ queryKey: ['api', '/me/permissions'], exact: false })
          ?.state.status,
      ).toBe('error'),
    );
    expect(await screen.findByRole('button', { name: 'Apply closure' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw closure' })).toBeInTheDocument();
    expect(screen.queryByText(/is not available to you/)).toBeNull();
  });
});

describe('CommandError on the schedule and facilities screens', () => {
  it('CAPABILITY_DISABLED reads as turned off, never as "not available to you"', () => {
    const error = new ApiError({
      kind: 'api',
      status: 403,
      code: 'ACCESS_DENIED',
      message: 'This organization has not enabled rentals.',
      nextAction: 'contact_support_or_request_access',
      correlationId: 'corr-1',
      details: {
        code: 'CAPABILITY_DISABLED',
        capability: 'rentals',
        applicabilityReferences: ['DEC-016', 'DEC-076'],
      },
    });
    render(<CommandError error={error} action="Booking the space" />);
    const state = screen.getByTestId('state-turned-off');
    expect(state).toHaveTextContent('Rentals turned off');
    expect(state).toHaveTextContent('(DEC-016, DEC-076)');
    expect(screen.queryByText('Not available to you')).toBeNull();
  });

  it('ACCESS_DENIED names the permission the role lacks', () => {
    const error = new ApiError({
      kind: 'api',
      status: 403,
      code: 'ACCESS_DENIED',
      message: 'Access denied.',
      nextAction: 'contact_support_or_request_access',
      correlationId: 'corr-2',
      details: { action: 'scheduling.manage_closures' },
    });
    render(<CommandError error={error} action="Withdrawing the closure" />);
    expect(screen.getByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(notAvailable('scheduling.manage_closures'))).toBeInTheDocument();
  });
});
