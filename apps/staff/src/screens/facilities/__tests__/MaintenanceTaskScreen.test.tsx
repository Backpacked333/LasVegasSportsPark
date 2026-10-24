/**
 * SCR-S-41 maintenance task: SPK-FAC-002 (assign, resolve with a resolution, evidence, inspection),
 * SPK-FAC-004 (closing never reopens a field while restrictions remain), SPK-UX-008 (validation
 * failure, stale version, permission restriction).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY,
  ME_PERSON,
  oneFacilityRoutes,
  restriction,
  task,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

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

const patches = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'PATCH' && r.route === '/maintenance-tasks/{id}');

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
