/**
 * SPK-UX-008 permission restriction on the schedule and facilities screens (SCR-S-04, SCR-S-06,
 * SCR-S-07, SCR-S-41, SCR-S-42): commands are offered from the role view of
 * `GET /v1/me/permissions` at the record's facility; an action the roles do not include reads "Not
 * available to you" and names the permission, while the records stay readable. Nothing is hidden
 * while the permission read is unknown (the command's own ACCESS_DENIED still decides), and a
 * CAPABILITY_DISABLED answer reads as turned off, never as "not available to you".
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@sportspark/api-client';
import { FACILITY_B, createTestApp, mePermissions } from '../../../testing/test-app';
import { CommandError } from '../CommandError';
import {
  INVENTORY,
  SCHEDULE_FACILITY_ACTIONS,
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

  it('nothing is hidden while the permission read failed: the command itself decides', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      }),
    });
    render(app.at('/schedule/closures/c1'));
    expect(await screen.findByRole('button', { name: 'Apply closure' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw closure' })).toBeInTheDocument();
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
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
