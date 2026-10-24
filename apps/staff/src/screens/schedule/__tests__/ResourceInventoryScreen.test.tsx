/**
 * SCR-S-07 Resource inventory and configurations: SPK-SCHED-001 (facility, spaces, dimensions,
 * formats, buffers, equipment, staffing, hours), SPK-SCHED-002 (whole-space and subdivision
 * relationships, derived conflict units, arrangements), DEC-001 pending, SPK-UX-008 states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HALF_A,
  HALF_B,
  INVENTORY,
  PITCH,
  UNIT_A,
  UNIT_B,
  UNIT_ROOM,
  oneFacilityRoutes,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /resources': { status: 200, body: INVENTORY },
    'GET /conflict-units': {
      status: 200,
      body: [
        {
          id: UNIT_A,
          facilityId: FACILITY_A,
          name: 'North half',
          resourceIds: [PITCH, HALF_A],
          createdAt: '2026-10-01T00:00:00.000Z',
        },
        {
          id: UNIT_B,
          facilityId: FACILITY_A,
          name: 'South half',
          resourceIds: [PITCH, HALF_B],
          createdAt: '2026-10-01T00:00:00.000Z',
        },
        {
          id: UNIT_ROOM,
          facilityId: FACILITY_A,
          name: 'Party room',
          resourceIds: [],
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    },
    'GET /resource-configurations': {
      status: 200,
      body: [
        {
          id: 'cfg-1',
          facilityId: FACILITY_A,
          name: 'Two halves',
          description: null,
          active: true,
          memberResourceIds: [HALF_A, HALF_B],
          revision: 2,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    },
    'GET /operating-hours': {
      status: 200,
      body: [
        {
          id: 'h-1',
          facilityId: FACILITY_A,
          resourceId: null,
          weekday: 6,
          opensAt: '08:00',
          closesAt: '22:00',
        },
      ],
    },
    ...overrides,
  };
}

describe('SCR-S-07 ResourceInventoryScreen', () => {
  it('shows spaces as a tree with dimensions, formats, buffers and the conflict units the API derives', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/resources'));
    const list = await screen.findByRole('list', { name: 'Spaces' });
    const items = within(list).getAllByRole('listitem');
    expect(
      items.map(
        (i) =>
          within(i).getByText(/^(Pitch 1|Pitch 1 North|Pitch 1 South|Party room)$/).textContent,
      ),
    ).toEqual(['Party room', 'Pitch 1', 'Pitch 1 North', 'Pitch 1 South']);
    const pitch = screen.getByRole('listitem', { name: 'Pitch 1' });
    expect(pitch).toHaveTextContent('Formats: 11v11');
    expect(pitch).toHaveTextContent('Setup 15 min, cleanup 10 min');
    expect(pitch).toHaveTextContent('Dimensions: length 100, width 64');
    expect(
      await within(pitch).findByText(/Conflict units: North half, South half/),
    ).toBeInTheDocument();
    expect(pitch).toHaveTextContent('Conflicts with Pitch 1 North, Pitch 1 South');
    const north = screen.getByRole('listitem', { name: 'Pitch 1 North' });
    expect(north).toHaveTextContent('Subdivision, inside Pitch 1');
    expect(north).toHaveTextContent('Conflicts with Pitch 1');
    expect(north).not.toHaveTextContent('Pitch 1 South');
    expect(within(pitch).getByText('Inventory status: active')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-001/)).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Arrangements' })).toHaveTextContent(
      'Pitch 1 North + Pitch 1 South',
    );
    expect(await screen.findByRole('list', { name: 'Operating hours' })).toHaveTextContent(
      'Saturday 08:00 to 22:00, whole facility',
    );
  });

  it('validation failure: a subdivision must be inside a whole space before anything is sent', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /resources': { status: 201, body: INVENTORY[1] } }),
    });
    render(app.at('/schedule/resources'));
    await screen.findByRole('list', { name: 'Spaces' });
    const form = screen.getByRole('form', { name: 'Add a space' });
    await user.selectOptions(within(form).getByLabelText('Kind'), 'subdivision');
    await user.type(within(form).getByLabelText('Name'), 'Pitch 1 East');
    await user.click(within(form).getByRole('button', { name: 'Add space' }));
    expect(within(form).getByRole('list', { name: 'Problems to correct' })).toHaveTextContent(
      'A subdivision must be inside a whole space: choose it.',
    );
    expect(app.fake.requests.some((r) => r.method === 'POST' && r.route === '/resources')).toBe(
      false,
    );
    await user.selectOptions(within(form).getByLabelText('Inside (whole space)'), PITCH);
    await user.type(within(form).getByLabelText('Default setup minutes'), '5');
    await user.click(within(form).getByRole('button', { name: 'Add space' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.method === 'POST' && r.route === '/resources')).toBe(
        true,
      ),
    );
    expect(
      app.fake.requests.find((r) => r.method === 'POST' && r.route === '/resources')?.body,
    ).toEqual({
      facilityId: FACILITY_A,
      kind: 'subdivision',
      name: 'Pitch 1 East',
      parentResourceId: PITCH,
      defaultSetupMinutes: 5,
    });
  });

  it('the API refusing a space shows its field messages and keeps the input', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /resources': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              nextAction: 'correct_input',
              message: 'Request validation failed.',
              details: [
                {
                  path: 'name',
                  message: 'A resource with this name or window already exists in the facility.',
                  code: 'custom',
                },
              ],
            }),
          ),
      }),
    });
    render(app.at('/schedule/resources'));
    await screen.findByRole('list', { name: 'Spaces' });
    const form = screen.getByRole('form', { name: 'Add a space' });
    await user.selectOptions(within(form).getByLabelText('Kind'), 'pitch');
    await user.type(within(form).getByLabelText('Name'), 'Pitch 1');
    await user.click(within(form).getByRole('button', { name: 'Add space' }));
    expect(
      await within(form).findByText(
        'name: A resource with this name or window already exists in the facility.',
      ),
    ).toBeInTheDocument();
    expect(
      within(form).getByText('Error code: VALIDATION_FAILED. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Name')).toHaveValue('Pitch 1');
  });

  it('editing a space sends the expected revision; a stale revision offers Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /resources/{id}': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at('/schedule/resources'));
    await screen.findByRole('list', { name: 'Spaces' });
    await user.click(screen.getByRole('button', { name: 'Edit Pitch 1' }));
    const form = screen.getByRole('form', { name: 'Edit Pitch 1' });
    await user.clear(within(form).getByLabelText('Default cleanup minutes'));
    await user.type(within(form).getByLabelText('Default cleanup minutes'), '20');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Error code: STALE_REVISION. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    const patch = app.fake.requests.find(
      (r) => r.route === '/resources/{id}' && r.method === 'PATCH',
    );
    expect(patch?.params).toEqual({ id: PITCH });
    expect(patch?.body).toMatchObject({ expectedRevision: 1, defaultCleanupMinutes: 20 });
    // Unchanged structured fields are not sent (SPK-SCHED-001).
    expect(patch?.body).not.toHaveProperty('dimensions');
    expect(patch?.body).not.toHaveProperty('requiredEquipment');
    // Reload is a working action that re-reads the inventory (SPK-UX-008 stale version).
    const reads = app.fake.requests.filter((r) => r.route === '/resources').length;
    await user.click(within(form).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/resources').length).toBe(reads + 1),
    );
    expect(within(form).getByLabelText('Default cleanup minutes')).toHaveValue('20');
  });

  it('SPK-SCHED-001: renaming a space with structured equipment and dimensions leaves both out of the PATCH', async () => {
    const user = userEvent.setup();
    const structured = INVENTORY.map((r) =>
      r.id === PITCH
        ? {
            ...r,
            requiredEquipment: [{ type: 'goal', count: 2 }],
            dimensions: { configurations: ['11v11', '7v7'], pitchNumber: '07' },
          }
        : r,
    );
    const app = createTestApp({
      routes: routes({
        'GET /resources': { status: 200, body: structured },
        'PATCH /resources/{id}': { status: 200, body: structured[0] },
      }),
    });
    render(app.at('/schedule/resources'));
    await screen.findByRole('list', { name: 'Spaces' });
    await user.click(screen.getByRole('button', { name: 'Edit Pitch 1' }));
    const form = screen.getByRole('form', { name: 'Edit Pitch 1' });
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Pitch One');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/resources/{id}')).toBe(true),
    );
    const patch = app.fake.requests.find((r) => r.route === '/resources/{id}');
    expect(patch?.body).toMatchObject({ name: 'Pitch One' });
    expect(patch?.body).not.toHaveProperty('dimensions');
    expect(patch?.body).not.toHaveProperty('requiredEquipment');
  });

  it('SPK-SCHED-001: an edited dimension keeps each existing value type', async () => {
    const user = userEvent.setup();
    const structured = INVENTORY.map((r) =>
      r.id === PITCH ? { ...r, dimensions: { length: 100, pitchNumber: '07' } } : r,
    );
    const app = createTestApp({
      routes: routes({
        'GET /resources': { status: 200, body: structured },
        'PATCH /resources/{id}': { status: 200, body: structured[0] },
      }),
    });
    render(app.at('/schedule/resources'));
    await screen.findByRole('list', { name: 'Spaces' });
    await user.click(screen.getByRole('button', { name: 'Edit Pitch 1' }));
    const form = screen.getByRole('form', { name: 'Edit Pitch 1' });
    const field = within(form).getByLabelText(/Dimensions or supported configurations/);
    await user.clear(field);
    await user.type(field, 'length: 105{Enter}pitchNumber: 08');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/resources/{id}')).toBe(true),
    );
    const patch = app.fake.requests.find((r) => r.route === '/resources/{id}');
    expect(patch?.body).toMatchObject({ dimensions: { length: 105, pitchNumber: '08' } });
  });

  it('first setup: no spaces yet explains what to add', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /resources': { status: 200, body: [] },
        'GET /resource-configurations': { status: 200, body: [] },
      }),
    });
    render(app.at('/schedule/resources'));
    expect(await screen.findByRole('heading', { name: 'No spaces yet' })).toBeInTheDocument();
    expect(screen.getByText(/This is the first setup/)).toBeInTheDocument();
  });

  it('operating hours: refuses a closing time before opening, then adds the window', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /operating-hours': {
          status: 201,
          body: {
            id: 'h-2',
            facilityId: FACILITY_A,
            resourceId: PITCH,
            weekday: 0,
            opensAt: '09:00',
            closesAt: '24:00',
          },
        },
      }),
    });
    render(app.at('/schedule/resources'));
    const form = await screen.findByRole('form', { name: 'Add operating hours' });
    await within(form).findByRole('option', { name: 'Pitch 1' });
    await user.selectOptions(within(form).getByLabelText('Applies to'), PITCH);
    await user.selectOptions(within(form).getByLabelText('Day'), '0');
    await user.type(within(form).getByLabelText('Opens (HH:MM)'), '09:00');
    await user.type(within(form).getByLabelText('Closes (HH:MM)'), '08:00');
    await user.click(within(form).getByRole('button', { name: 'Add hours' }));
    expect(within(form).getByText('Opening must be before closing.')).toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Closes (HH:MM)'));
    await user.type(within(form).getByLabelText('Closes (HH:MM)'), '24:00');
    await user.click(within(form).getByRole('button', { name: 'Add hours' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/operating-hours' && r.method === 'POST'),
      ).toBe(true),
    );
    expect(
      app.fake.requests.find((r) => r.route === '/operating-hours' && r.method === 'POST')?.body,
    ).toEqual({
      facilityId: FACILITY_A,
      resourceId: PITCH,
      weekday: 0,
      opensAt: '09:00',
      closesAt: '24:00',
    });
  });

  it('permission restriction: an inventory the viewer may not read is not available', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /resources': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')) }),
    });
    render(app.at('/schedule/resources'));
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
  });
});
