/**
 * Release checks of a restriction (API migration 0909, SPK-FAC-004): the checklist the hero and the
 * release section show includes the restriction's own checks with their state in text, the task
 * owner is named, staff with `facilities.manage_release_checklist` add and confirm checks (each
 * command with an idempotency key and the item's revision), and reopening asks for a reason. The
 * page header shows the facility-local day counts (SPK-SCHED-008).
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HALF_A,
  INVENTORY,
  SCHEDULE_FACILITY_ACTIONS,
  closure,
  oneFacilityRoutes,
  restriction,
  scopedPermissions,
  task,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const ACTIVE = restriction({
  id: 'r-1',
  taskId: 't-1',
  schedulingClosureId: 'c-1',
  revision: 4,
});

const actor = {
  kind: 'staff',
  accountId: null,
  personId: null,
  actorLabel: 'Sam Cole',
};

function item(over: Record<string, unknown>) {
  return {
    id: 'i-1',
    restrictionId: 'r-1',
    position: 0,
    label: 'Net replaced and tensioned',
    createdBy: actor,
    completedAt: null,
    completedBy: null,
    completionNote: null,
    revision: 1,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    ...over,
  };
}

const CHECKLIST = {
  restrictionId: 'r-1',
  restrictionStatus: 'active',
  complete: false,
  taskOwner: { personId: '0192f1a0-0000-7000-8000-00000000d0d0', displayName: 'Luis Ortega' },
  items: [
    item({}),
    item({
      id: 'i-2',
      position: 1,
      label: 'Area walked, no debris',
      completedAt: '2026-10-24T12:30:00.000Z',
      completedBy: actor,
      revision: 2,
    }),
  ],
};

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /me/permissions': scopedPermissions([
      ...SCHEDULE_FACILITY_ACTIONS,
      'facilities.manage_release_checklist',
    ]),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /assets': { status: 200, body: [] },
    'GET /maintenance-restrictions': { status: 200, body: [ACTIVE] },
    'GET /maintenance-restrictions/{id}': { status: 200, body: ACTIVE },
    'GET /maintenance-restrictions/{id}/release-checklist': { status: 200, body: CHECKLIST },
    'GET /maintenance-tasks/{id}': {
      status: 200,
      body: task({ id: 't-1', status: 'resolved', requiresInspection: false }),
    },
    'GET /closures/{id}': {
      status: 200,
      body: closure({ id: 'c-1', source: 'maintenance', status: 'active', resourceId: HALF_A }),
    },
    'GET /facilities/{id}/operating-status': {
      status: 200,
      body: { facilityId: FACILITY_A, at: '2026-10-24T12:00:00.000Z', resources: [] },
    },
    'GET /facilities/{id}/day-summary': {
      status: 200,
      body: {
        facilityId: FACILITY_A,
        date: '2026-10-24',
        timezone: 'America/Los_Angeles',
        window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
        schedule: null,
        restrictions: { active: 1, approved: 0, proposed: 0, unreleasedAfterEnd: 0 },
        maintenance: { openTasks: 8, overdueTasks: 2 },
      },
    },
    ...overrides,
  };
}

describe('release checks (SPK-FAC-004, migration 0909)', () => {
  it('the hero lists the restriction’s own checks with their state and names the task owner', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/restrictions'));
    const hero = await screen.findByTestId('active-restriction-r-1');
    const checks = within(hero).getByRole('list', { name: 'Release to service checklist' });
    expect(await within(checks).findByText('Net replaced and tensioned')).toBeInTheDocument();
    expect(checks).toHaveTextContent('Not yet: Net replaced and tensioned');
    expect(checks).toHaveTextContent('Done: Area walked, no debris');
    expect(hero).toHaveTextContent('assigned to Luis Ortega');
  });

  it('confirms a check with its revision and an idempotency key', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /maintenance-restrictions/{id}/checklist-items/{itemId}/complete': {
          status: 200,
          body: CHECKLIST,
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    const editor = await screen.findByRole('region', {
      name: 'Release checks for this restriction',
    });
    await user.click(
      within(editor).getByRole('button', { name: 'Confirm: Net replaced and tensioned' }),
    );
    await waitFor(() =>
      expect(
        app.fake.requests.find(
          (r) => r.route === '/maintenance-restrictions/{id}/checklist-items/{itemId}/complete',
        ),
      ).toBeTruthy(),
    );
    const sent = app.fake.requests.find(
      (r) => r.route === '/maintenance-restrictions/{id}/checklist-items/{itemId}/complete',
    );
    expect(sent?.params).toEqual({ id: 'r-1', itemId: 'i-1' });
    expect(sent?.body).toEqual({ expectedRevision: 1 });
    expect(sent?.headers['idempotency-key']).toBeTruthy();
  });

  it('adds a check and asks for a reason before reopening one', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /maintenance-restrictions/{id}/checklist-items': {
          status: 201,
          body: item({ id: 'i-3', label: 'Goal anchored' }),
        },
        'POST /maintenance-restrictions/{id}/checklist-items/{itemId}/reopen': {
          status: 200,
          body: CHECKLIST,
        },
      }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    const editor = await screen.findByRole('region', {
      name: 'Release checks for this restriction',
    });
    await user.type(within(editor).getByLabelText('New release check'), 'Goal anchored');
    await user.click(within(editor).getByRole('button', { name: 'Add check' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/maintenance-restrictions/{id}/checklist-items')
          ?.body,
      ).toEqual({ label: 'Goal anchored' }),
    );
    await user.click(within(editor).getByRole('button', { name: 'Reopen' }));
    const reopen = within(editor).getByRole('button', { name: 'Reopen check' });
    expect(reopen).toBeDisabled();
    await user.type(
      within(editor).getByLabelText(/Reason to reopen/),
      'Debris found near the goal',
    );
    await user.click(reopen);
    await waitFor(() =>
      expect(
        app.fake.requests.find(
          (r) => r.route === '/maintenance-restrictions/{id}/checklist-items/{itemId}/reopen',
        )?.body,
      ).toEqual({ reason: 'Debris found near the goal', expectedRevision: 2 }),
    );
  });

  it('without the permission the checks are shown but not editable', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': scopedPermissions(SCHEDULE_FACILITY_ACTIONS) }),
    });
    render(app.at('/facilities/restrictions/r-1'));
    await screen.findByRole('button', { name: 'Release to service' });
    const checks = screen.getByRole('list', { name: 'Release to service checklist' });
    expect(await within(checks).findByText('Net replaced and tensioned')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Release checks for this restriction' }),
    ).toBeNull();
  });

  it('SPK-SCHED-008: the page header counts the day’s restrictions and open tasks, never a section it may not read', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/restrictions'));
    const line = await screen.findByTestId('day-summary');
    expect(line).toHaveTextContent('Today: 1 active restriction · 8 open tasks');
    expect(line).not.toHaveTextContent('activities');
  });
});
