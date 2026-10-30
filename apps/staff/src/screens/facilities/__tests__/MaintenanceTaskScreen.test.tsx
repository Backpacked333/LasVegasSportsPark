/**
 * SCR-S-41 maintenance task: SPK-FAC-002 (assign to me or to a staff member from the staff
 * directory, owner names from the staff directory, resolve with a resolution, evidence,
 * inspection), SPK-FAC-004 (closing never reopens a field while restrictions remain), SPK-UX-008
 * (validation failure, stale version, permission restriction, a failed name read with its code).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY,
  ME_PERSON,
  oneFacilityRoutes,
  page,
  restriction,
  task,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp, staffMe } from '../../../testing/test-app';

const OPEN = task({
  id: 't-1',
  status: 'open',
  revision: 2,
  requiresInspection: true,
  openRestrictionIds: ['r-1'],
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /maintenance-tasks/{id}': { status: 200, body: OPEN },
    'GET /maintenance-tasks/{id}/inspections': { status: 200, body: [] },
    'GET /maintenance-restrictions': {
      status: 200,
      body: [restriction({ id: 'r-1', taskId: 't-1' })],
    },
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /assets': { status: 200, body: [] },
    'PATCH /maintenance-tasks/{id}': { status: 200, body: { ...OPEN, revision: 3 } },
    ...overrides,
  };
}

const JO = '0192f1a0-0000-7000-8000-0000000000e1';
const SAM = '0192f1a0-0000-7000-8000-0000000000e2';
const STAFF_JO = {
  personId: JO,
  displayName: 'Jo Park',
  roles: ['facilities_operator' as const],
  facilityIds: [FACILITY_A],
  scopes: [{ role: 'facilities_operator' as const, facilityIds: [FACILITY_A] }],
};
const STAFF_SAM = {
  personId: SAM,
  displayName: 'Sam Lee',
  roles: ['scheduler' as const],
  facilityIds: [],
  scopes: [{ role: 'scheduler' as const, facilityIds: [] }],
};
const NAME_JO = {
  personId: JO,
  canonicalPersonId: JO,
  givenName: 'Jo',
  familyName: 'Park',
  displayName: 'Jo Park',
  kind: 'adult' as const,
};

const patches = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'PATCH' && r.route === '/maintenance-tasks/{id}');

/** `GET /me` for a facilities operator at facility A (the role SCR-S-41 is built for). */
function facilitiesOperatorMe() {
  const me = staffMe([FACILITY_A]);
  return {
    ...me,
    body: { ...me.body, principal: { ...me.body.principal, staffRoles: ['facilities_operator'] } },
  };
}

describe('SCR-S-41 MaintenanceTaskScreen', () => {
  it('shows the task record and that closing does not return the area to service (SPK-FAC-004)', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    expect(await screen.findByText('Torn net on north goal')).toBeInTheDocument();
    expect(screen.getByText('Severity: high')).toBeInTheDocument();
    expect(screen.getByText('Status: open')).toBeInTheDocument();
    expect(await screen.findByText('Pitch 1 North')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Closing does not return the area to service: 1 restriction still needs an authorized release/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('An inspection is required: the area cannot be released until one passes.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('list', { name: 'Restrictions of this task' }),
    ).toHaveTextContent('active: area restricted');
  });

  it('assigns the task to the viewer with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await user.click(await screen.findByRole('button', { name: 'Assign to me' }));
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]?.body).toEqual({
      assignedOwnerPersonId: ME_PERSON,
      expectedRevision: 2,
    });
  });

  it('SPK-FAC-002: assigns the task to a staff member chosen from the staff directory of its facility', async () => {
    const user = userEvent.setup();
    const assigned = {
      ...OPEN,
      status: 'assigned' as const,
      revision: 3,
      assignedOwnerPersonId: JO,
    };
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': page([STAFF_JO, STAFF_SAM]),
        'GET /person-names': { status: 200, body: { items: [NAME_JO] } },
        'PATCH /maintenance-tasks/{id}': () => {
          app.fake.set('GET /maintenance-tasks/{id}', { status: 200, body: assigned });
          return fakeResponse(200, assigned);
        },
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    expect(await screen.findByTestId('task-owner')).toHaveTextContent('unassigned');
    const picker = await screen.findByRole('group', { name: 'Assign to from the staff directory' });
    const select = within(picker).getByLabelText('Assign to');
    await waitFor(() => expect(select).toBeEnabled());
    expect(
      within(select).getByRole('option', { name: 'Jo Park (facilities operator)' }),
    ).toBeVisible();
    expect(app.fake.requests.find((r) => r.route === '/staff-directory')?.query).toMatchObject({
      facilityId: FACILITY_A,
    });
    await user.click(screen.getByRole('button', { name: 'Assign to the chosen staff member' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a staff member to assign.');
    expect(patches(app)).toHaveLength(0);
    await user.selectOptions(select, JO);
    await user.click(screen.getByRole('button', { name: 'Assign to the chosen staff member' }));
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]?.body).toEqual({ assignedOwnerPersonId: JO, expectedRevision: 2 });
    await waitFor(() => expect(screen.getByTestId('task-owner')).toHaveTextContent('Jo Park'));
  });

  it('SPK-FAC-002: a facilities operator, whom GET /v1/person-names gives no other staff names, sees the owner named from the staff directory', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me': facilitiesOperatorMe(),
        'GET /maintenance-tasks/{id}': {
          status: 200,
          body: { ...OPEN, status: 'assigned', assignedOwnerPersonId: JO },
        },
        'GET /staff-directory': page([STAFF_JO, STAFF_SAM]),
        'GET /person-names': { status: 200, body: { items: [] } },
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await waitFor(() => expect(screen.getByTestId('task-owner')).toHaveTextContent('Jo Park'));
    expect(screen.getByTestId('task-owner')).not.toHaveTextContent('name not available');
    expect(app.fake.requests.some((r) => r.route === '/person-names')).toBe(false);
  });

  it('a new search clears the choice: Assign never sends a person the list no longer shows as chosen', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': (request) =>
          fakeResponse(200, {
            items: request.query.query === 'Sam' ? [STAFF_SAM] : [STAFF_JO, STAFF_SAM],
            nextCursor: null,
          }),
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    const select = await screen.findByLabelText('Assign to');
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, JO);
    expect(select).toHaveValue(JO);
    await user.type(screen.getByLabelText('Find staff by name'), 'Sam');
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Assign to')).queryByRole('option', {
          name: 'Jo Park (facilities operator)',
        }),
      ).toBeNull(),
    );
    expect(screen.getByLabelText('Assign to')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Assign to the chosen staff member' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a staff member to assign.');
    expect(patches(app)).toHaveLength(0);
  });

  it('a failed name read shows its error code with Try again, never "name not available"', async () => {
    const user = userEvent.setup();
    let failing = true;
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-tasks/{id}': {
          status: 200,
          body: { ...OPEN, status: 'assigned', assignedOwnerPersonId: JO },
        },
        'GET /staff-directory': page([]),
        'GET /person-names': () =>
          failing
            ? fakeResponse(503, apiErrorBody('SERVICE_UNAVAILABLE', { nextAction: 'retry_later' }))
            : fakeResponse(200, { items: [NAME_JO] }),
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await waitFor(() =>
      expect(screen.getByTestId('task-owner')).toHaveTextContent(
        'assigned: the name could not be loaded (SERVICE_UNAVAILABLE).',
      ),
    );
    expect(screen.getByTestId('task-owner')).not.toHaveTextContent('name not available');
    failing = false;
    await user.click(
      within(screen.getByTestId('task-owner')).getByRole('button', { name: 'Try again' }),
    );
    await waitFor(() => expect(screen.getByTestId('task-owner')).toHaveTextContent('Jo Park'));
  });

  it('a failed staff directory read for an owner the name read leaves out shows the directory error with Try again', async () => {
    const user = userEvent.setup();
    let failing = true;
    const app = createTestApp({
      routes: routes({
        'GET /me': facilitiesOperatorMe(),
        'GET /maintenance-tasks/{id}': {
          status: 200,
          body: { ...OPEN, status: 'assigned', assignedOwnerPersonId: JO },
        },
        'GET /staff-directory': () =>
          failing
            ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR'))
            : fakeResponse(200, { items: [STAFF_JO], nextCursor: null }),
        'GET /person-names': { status: 200, body: { items: [] } },
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    const owner = await screen.findByTestId('task-owner');
    await waitFor(() =>
      expect(owner).toHaveTextContent('the name could not be loaded (INTERNAL_ERROR)'),
    );
    failing = false;
    await user.click(within(owner).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('task-owner')).toHaveTextContent('Jo Park'));
  });

  it('finds staff by name prefix and loads more staff with the API cursor', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': (request) =>
          request.query.cursor === 'staff-2'
            ? fakeResponse(200, { items: [STAFF_SAM], nextCursor: null })
            : fakeResponse(200, { items: [STAFF_JO], nextCursor: 'staff-2' }),
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await user.click(await screen.findByRole('button', { name: 'Load more staff' }));
    const select = screen.getByLabelText('Assign to');
    expect(
      await within(select).findByRole('option', { name: 'Sam Lee (scheduler)' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Find staff by name'), 'Jo');
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/staff-directory').at(-1)?.query,
      ).toMatchObject({ facilityId: FACILITY_A, query: 'Jo' }),
    );
  });

  it('without the staff directory (ACCESS_DENIED) another owner cannot be chosen; Assign to me stays', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { details: { action: 'identity.read_staff_directory' } }),
          ),
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    expect(await screen.findByText('Staff directory not available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign to me' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Assign to')).toBeNull();
    // No assign command for a choice the screen does not offer.
    expect(screen.queryByRole('button', { name: 'Assign to the chosen staff member' })).toBeNull();
    expect(screen.queryByText('Choose a staff member to assign.')).toBeNull();
  });

  it('an owner the API will not name reads "assigned (name not available)"; a refused owner shows the API message', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-tasks/{id}': {
          status: 200,
          body: { ...OPEN, status: 'assigned', assignedOwnerPersonId: SAM },
        },
        'GET /staff-directory': page([STAFF_JO]),
        'GET /person-names': { status: 200, body: { items: [] } },
        'PATCH /maintenance-tasks/{id}': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message: 'The assigned owner must be an active adult person of this organization.',
              details: { path: 'assignedOwnerPersonId' },
            }),
          ),
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await waitFor(() =>
      expect(screen.getByTestId('task-owner')).toHaveTextContent('assigned (name not available)'),
    );
    const select = screen.getByLabelText('Assign to');
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, JO);
    await user.click(screen.getByRole('button', { name: 'Assign to the chosen staff member' }));
    expect(
      await screen.findByText(
        'assignedOwnerPersonId: The assigned owner must be an active adult person of this organization.',
      ),
    ).toBeInTheDocument();
  });

  it('validation failure: resolving needs a resolution summary; then it is sent with evidence', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await user.click(await screen.findByRole('button', { name: 'Mark resolved' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A resolution summary is required to resolve the task.',
    );
    expect(patches(app)).toHaveLength(0);
    await user.type(screen.getByLabelText('Resolution summary'), 'Net replaced');
    const lifecycle = screen.getByRole('region', { name: 'Work on this task' });
    await user.click(within(lifecycle).getByRole('button', { name: 'Add evidence reference' }));
    await user.type(
      within(lifecycle).getByLabelText('Reference'),
      'storage://photos/net-after.jpg',
    );
    await user.click(screen.getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]?.body).toEqual({
      status: 'resolved',
      resolution: {
        summary: 'Net replaced',
        evidence: [{ kind: 'photo', reference: 'storage://photos/net-after.jpg' }],
      },
      expectedRevision: 2,
    });
  });

  it('records an inspection outcome', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /maintenance-tasks/{id}/inspections': {
          status: 201,
          body: {
            id: 'i-1',
            taskId: 't-1',
            inspector: {
              kind: 'staff',
              accountId: null,
              personId: ME_PERSON,
              actorLabel: 'Facilities lead',
            },
            outcome: 'passed',
            notes: 'Net secure',
            inspectedAt: '2026-10-24T12:00:00.000Z',
            createdAt: '2026-10-24T12:00:00.000Z',
          },
        },
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await user.click(await screen.findByLabelText('Passed'));
    await user.type(screen.getByLabelText('Notes'), 'Net secure');
    await user.click(screen.getByRole('button', { name: 'Record inspection' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.method === 'POST' && r.route === '/maintenance-tasks/{id}/inspections',
        ),
      ).toBe(true),
    );
    expect(
      app.fake.requests.find(
        (r) => r.method === 'POST' && r.route === '/maintenance-tasks/{id}/inspections',
      )?.body,
    ).toEqual({
      outcome: 'passed',
      expectedRevision: 2,
      notes: 'Net secure',
    });
  });

  it('stale version: STALE_REVISION offers Reload and refetches the task', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /maintenance-tasks/{id}': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await user.click(await screen.findByRole('button', { name: 'Start work' }));
    expect(
      await screen.findByText('Error code: STALE_REVISION. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    const before = app.fake.requests.filter(
      (r) => r.route === '/maintenance-tasks/{id}' && r.method === 'GET',
    ).length;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/maintenance-tasks/{id}' && r.method === 'GET')
          .length,
      ).toBeGreaterThan(before),
    );
  });

  it('permission restriction: a task change the viewer may not make names the permission', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /maintenance-tasks/{id}': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              details: { action: 'facilities.manage_maintenance_task' },
            }),
          ),
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    await user.click(await screen.findByRole('button', { name: 'Start work' }));
    expect(
      await screen.findByText(/the permission facilities\.manage_maintenance_task/),
    ).toBeInTheDocument();
  });

  it('a task the viewer may not see is not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /maintenance-tasks/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
      }),
    });
    render(app.at('/facilities/maintenance/tasks/t-1'));
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
    expect(
      app.fake.requests.every(
        (r) => r.query.facilityId === undefined || r.query.facilityId === FACILITY_A,
      ),
    ).toBe(true);
  });
});
