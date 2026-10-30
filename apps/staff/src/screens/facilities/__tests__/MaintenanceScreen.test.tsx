/**
 * SCR-S-41 Assets and maintenance tasks: SPK-FAC-001 (maintainable assets), SPK-FAC-002 (task
 * fields: asset or space, issue, severity, reporter, evidence, owner, due date, restriction,
 * resolution, inspection), SPK-FAC-005 (preventive maintenance through the scheduling authority),
 * SPK-UX-008 (validation failure "severity missing", permission restriction, offline, empty).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HALF_A,
  INVENTORY,
  ME_PERSON,
  asset,
  oneFacilityRoutes,
  page,
  task,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp, staffMe } from '../../../testing/test-app';

const GOAL = asset({ id: 'as-1', name: 'North goal', resourceId: HALF_A, revision: 3 });
const OVERDUE = task({
  id: 't-1',
  issue: 'Torn net on north goal',
  assetId: 'as-1',
  severity: 'critical',
  dueAt: '2026-10-24T10:00:00.000Z',
  assignedOwnerPersonId: ME_PERSON,
  status: 'assigned',
  requiresInspection: true,
  openRestrictionIds: ['r-1'],
});
const LOW = task({
  id: 't-2',
  issue: 'Scoreboard bulb',
  severity: 'low',
  status: 'closed',
  resolution: { summary: 'Replaced' },
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /maintenance-tasks': page([LOW, OVERDUE]),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /assets': { status: 200, body: [GOAL] },
    'GET /preventive-schedules': { status: 200, body: [] },
    ...overrides,
  };
}

describe('SCR-S-41 MaintenanceScreen', () => {
  it('SPK-FAC-002: lists tasks with severity, status, owner, due date, inspection and restrictions in text', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/maintenance'));
    const row = await screen.findByTestId('task-t-1');
    expect(within(row).getByRole('link', { name: 'Torn net on north goal' })).toHaveAttribute(
      'href',
      '/facilities/maintenance/tasks/t-1',
    );
    expect(row).toHaveTextContent('Severity: critical');
    expect(row).toHaveTextContent('Status: assigned');
    expect(row).toHaveTextContent('Overdue');
    expect(row).toHaveTextContent('Inspection required');
    expect(row).toHaveTextContent('1 restriction not released');
    expect(await within(row).findByText(/North goal in Pitch 1 North/)).toBeInTheDocument();
    expect(await within(row).findByText(/Owner: you/)).toBeInTheDocument();
    // Open work first, closed last.
    const items = within(screen.getByRole('list', { name: 'Maintenance tasks' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveAttribute('data-testid', 'task-t-1');
    expect(app.fake.requests.find((r) => r.route === '/maintenance-tasks')?.query).toEqual({
      facilityId: FACILITY_A,
      limit: '50',
    });
  });

  it('names an owner the staff directory does not list through GET /v1/person-names, and loads more tasks with the API cursor', async () => {
    const user = userEvent.setup();
    const OWNER = '0192f1a0-0000-7000-8000-0000000000e1';
    const OTHERS = task({
      id: 't-3',
      issue: 'Divider jammed',
      status: 'assigned',
      assignedOwnerPersonId: OWNER,
    });
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-tasks': (request) =>
          request.query.cursor === 'tasks-2'
            ? fakeResponse(200, { items: [OTHERS], nextCursor: null })
            : fakeResponse(200, { items: [LOW, OVERDUE], nextCursor: 'tasks-2' }),
        'GET /person-names': {
          status: 200,
          body: {
            items: [
              {
                personId: OWNER,
                canonicalPersonId: OWNER,
                givenName: 'Jo',
                familyName: 'Park',
                displayName: 'Jo Park',
                kind: 'adult',
              },
            ],
          },
        },
      }),
    });
    render(app.at('/facilities/maintenance'));
    await screen.findByTestId('task-t-1');
    expect(screen.queryByTestId('task-t-3')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load more tasks' }));
    const row = await screen.findByTestId('task-t-3');
    expect(await within(row).findByText(/Owner: Jo Park/)).toBeInTheDocument();
    expect(
      app.fake.requests.filter((r) => r.route === '/maintenance-tasks').at(-1)?.query,
    ).toMatchObject({ facilityId: FACILITY_A, cursor: 'tasks-2' });
    expect(screen.queryByRole('button', { name: 'Load more tasks' })).toBeNull();
  });

  it('SPK-FAC-002: owners are named from the staff directory of the facility, which a facilities operator may read', async () => {
    const OWNER = '0192f1a0-0000-7000-8000-0000000000e1';
    const OTHERS = task({
      id: 't-3',
      issue: 'Divider jammed',
      status: 'assigned',
      assignedOwnerPersonId: OWNER,
    });
    const me = staffMe([FACILITY_A]);
    const app = createTestApp({
      routes: routes({
        'GET /me': {
          ...me,
          body: {
            ...me.body,
            principal: { ...me.body.principal, staffRoles: ['facilities_operator'] },
          },
        },
        'GET /maintenance-tasks': page([OTHERS]),
        'GET /staff-directory': page([
          {
            personId: OWNER,
            displayName: 'Jo Park',
            roles: ['facilities_operator'],
            facilityIds: [FACILITY_A],
            scopes: [{ role: 'facilities_operator', facilityIds: [FACILITY_A] }],
          },
        ]),
        // identity.read_person is not a facilities operator's: other staff names are left out.
        'GET /person-names': { status: 200, body: { items: [] } },
      }),
    });
    render(app.at('/facilities/maintenance'));
    const row = await screen.findByTestId('task-t-3');
    expect(await within(row).findByText(/Owner: Jo Park/)).toBeInTheDocument();
    expect(row).not.toHaveTextContent('name not available');
    expect(app.fake.requests.find((r) => r.route === '/staff-directory')?.query).toMatchObject({
      facilityId: FACILITY_A,
    });
  });

  it('an owner whose name read failed reads "name could not be loaded", not "not available"', async () => {
    const OWNER = '0192f1a0-0000-7000-8000-0000000000e1';
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-tasks': page([
          task({ id: 't-3', issue: 'Divider jammed', assignedOwnerPersonId: OWNER }),
        ]),
        'GET /staff-directory': page([]),
        'GET /person-names': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      }),
    });
    render(app.at('/facilities/maintenance'));
    const row = await screen.findByTestId('task-t-3');
    expect(
      await within(row).findByText(/Owner: assigned \(name could not be loaded\)/),
    ).toBeInTheDocument();
  });

  it('filters overdue tasks by sending only overdue=true', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/maintenance'));
    await screen.findByTestId('task-t-1');
    await user.click(screen.getByLabelText('Overdue only'));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/maintenance-tasks').at(-1)?.query.overdue,
      ).toBe('true'),
    );
  });

  it('validation failure: asset or space and severity are required before reporting; then the issue is sent', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /maintenance-tasks': {
          status: 201,
          body: task({ id: 't-9', issue: 'Divider stuck', severity: 'medium' }),
        },
      }),
    });
    render(app.at('/facilities/maintenance'));
    const form = await screen.findByRole('form', { name: 'Report an issue' });
    await user.type(within(form).getByLabelText('Issue'), 'Divider stuck');
    await user.click(within(form).getByRole('button', { name: 'Report issue' }));
    const problems = within(form).getByRole('list', { name: 'Problems to correct' });
    expect(problems).toHaveTextContent('Choose the asset or space.');
    expect(problems).toHaveTextContent('Choose a severity.');
    expect(
      app.fake.requests.some((r) => r.method === 'POST' && r.route === '/maintenance-tasks'),
    ).toBe(false);
    await within(form).findByRole('option', { name: 'Pitch 1 North' });
    await user.selectOptions(within(form).getByLabelText('Asset or space'), `resource:${HALF_A}`);
    await user.click(within(form).getByLabelText('medium'));
    await user.click(within(form).getByRole('button', { name: 'Add evidence reference' }));
    await user.type(within(form).getByLabelText('Reference'), 'https://example.test/photo-1');
    await user.click(within(form).getByRole('button', { name: 'Report issue' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('Reported: Divider stuck');
    const post = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/maintenance-tasks',
    );
    expect(post?.body).toEqual({
      facilityId: FACILITY_A,
      resourceId: HALF_A,
      issue: 'Divider stuck',
      severity: 'medium',
      requiresInspection: false,
      evidence: [{ kind: 'photo', reference: 'https://example.test/photo-1' }],
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('SPK-FAC-001: retiring an asset asks for confirmation and sends the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'DELETE /assets/{id}': { status: 200, body: { ...GOAL, status: 'retired', revision: 4 } },
      }),
    });
    render(app.at('/facilities/maintenance'));
    const assets = await screen.findByRole('list', { name: 'Assets' });
    expect(assets).toHaveTextContent('North goal');
    expect(assets).toHaveTextContent('Goal · G-01');
    await user.click(within(assets).getByRole('button', { name: 'Retire North goal' }));
    await user.click(within(assets).getByRole('button', { name: 'Confirm retire North goal' }));
    await waitFor(() => expect(app.fake.requests.some((r) => r.method === 'DELETE')).toBe(true));
    const del = app.fake.requests.find((r) => r.method === 'DELETE');
    expect(del?.route).toBe('/assets/{id}');
    expect(del?.body).toEqual({ expectedRevision: 3 });
  });

  it('SPK-FAC-005: generating preventive occurrences reports what was created', async () => {
    const user = userEvent.setup();
    const schedule = {
      id: 'pm-1',
      facilityId: FACILITY_A,
      resourceId: HALF_A,
      assetId: null,
      name: 'Monthly turf grooming',
      recurrence: {
        frequency: 'weekly' as const,
        interval: 4,
        byWeekday: [1],
        startDate: '2026-10-26',
        count: 6,
      },
      localStartTime: '06:00',
      durationMinutes: 120,
      timezone: 'America/Los_Angeles',
      taskTemplate: {
        issue: 'Groom turf',
        severity: 'low' as const,
        requiresInspection: true,
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
    const app = createTestApp({
      routes: routes({
        'GET /preventive-schedules': { status: 200, body: [schedule] },
        'POST /preventive-schedules/{id}/generate': {
          status: 200,
          body: {
            scheduleId: 'pm-1',
            operationId: 'op-9',
            horizon: '2026-11-07T12:00:00.000Z',
            generated: [
              {
                occurrenceIndex: 0,
                interval: { start: '2026-10-26T13:00:00.000Z', end: '2026-10-26T15:00:00.000Z' },
                taskId: 't-5',
                restrictionId: 'r-5',
              },
            ],
            alreadyGeneratedOccurrenceIndexes: [],
          },
        },
      }),
    });
    render(app.at('/facilities/maintenance'));
    const list = await screen.findByRole('list', { name: 'Preventive schedules' });
    expect(list).toHaveTextContent(
      'every 4 weeks on Monday from 2026-10-26, 6 times at 06:00 for 120 min',
    );
    expect(list).toHaveTextContent('Generated 14 days ahead');
    await user.click(
      within(list).getByRole('button', {
        name: 'Generate due occurrences of Monthly turf grooming',
      }),
    );
    // SCR-S-42: what happens to booked events is chosen explicitly, with no default.
    const choice = within(list).getByRole('group', {
      name: 'Generate occurrences of Monthly turf grooming',
    });
    await user.click(within(choice).getByRole('button', { name: 'Generate now' }));
    expect(within(choice).getByText('Choose what happens to the affected events.')).toBeVisible();
    expect(app.fake.requests.some((r) => r.route === '/preventive-schedules/{id}/generate')).toBe(
      false,
    );
    await user.click(within(choice).getByLabelText(/Leave them for resolution/));
    await user.click(within(choice).getByRole('button', { name: 'Generate now' }));
    expect(await within(list).findByRole('status')).toHaveTextContent(
      '1 occurrence generated (a task and a restriction each); 0 already existed.',
    );
    const post = app.fake.requests.find((r) => r.route === '/preventive-schedules/{id}/generate');
    expect(post?.body).toEqual({ resolutionMode: 'leave_for_resolution' });
    const created = within(list).getByRole('list', {
      name: 'Restrictions created by Monthly turf grooming',
    });
    expect(within(created).getByRole('link')).toHaveAttribute(
      'href',
      '/facilities/restrictions/r-5',
    );
  });

  it('permission restriction: tasks the viewer may not read are not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-tasks': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { details: { action: 'facilities.view_maintenance' } }),
          ),
      }),
    });
    render(app.at('/facilities/maintenance'));
    const tasks = await screen.findByRole('region', { name: 'Maintenance tasks' });
    expect(await within(tasks).findByTestId('state-unavailable')).toHaveTextContent(
      'Not available',
    );
  });

  it('empty and offline: no tasks is said plainly; offline disables reporting', async () => {
    const app = createTestApp({ routes: routes({ 'GET /maintenance-tasks': page([]) }) });
    render(app.at('/facilities/maintenance'));
    expect(
      await screen.findByRole('heading', { name: 'No maintenance tasks' }),
    ).toBeInTheDocument();
    act(() => app.connectivity.set(false));
    expect(await screen.findByText('Reporting an issue needs a connection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report issue' })).toBeDisabled();
  });
});
