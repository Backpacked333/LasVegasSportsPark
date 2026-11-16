/**
 * Uniforms of a class or a team (SPK-REG-012, proposed amendment PA-07; capability `uniforms`,
 * pending DEC-101): the list with size, paid state and hand-over; hand-over as a command with the
 * expected revision; undoing it only by a recorded correction with a reason; the list stays
 * readable with the capability off. The route is registered at integration, so the screen is
 * rendered here at its intended path.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  UNIFORM_ORDER_ID,
  uniformOrder,
} from '../../../features/registration-finance/__tests__/extras-fixtures';
import {
  ENROLLMENT_ID,
  OFFERING_ID,
  apiError,
  nameRoutes,
  ok,
} from '../../../features/registration-finance/__tests__/fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { OfferingUniformsScreen } from '../OfferingUniformsScreen';

const TEAM_ENTRY_ID = '0192f1a0-0000-7000-8000-000000004501';
const SECOND_ID = '0192f1a0-0000-7000-8000-000000004302';
const THIRD_ID = '0192f1a0-0000-7000-8000-000000004303';

const ORDERS = [
  uniformOrder(),
  uniformOrder({
    id: SECOND_ID,
    participantPersonId: '0192f1a0-0000-7000-8000-000000000311',
    participantDisplayName: 'Blake Stone',
    size: 'YL',
    status: 'handed_over',
    handedOverAt: '2026-10-22T17:30:00.000Z',
    handedOverBy: 'Front desk 1',
    revision: 3,
  }),
  uniformOrder({
    id: THIRD_ID,
    participantPersonId: '0192f1a0-0000-7000-8000-000000000312',
    participantDisplayName: 'Casey Lund',
    size: 'YS',
    status: 'ordered',
    paidAt: null,
    revision: 1,
  }),
];

function setup(
  extra: Record<string, FakeHandler> = {},
  options: { enabled?: boolean; path?: string; online?: boolean } = {},
) {
  const app = createTestApp({
    online: options.online,
    routes: {
      ...nameRoutes(),
      'GET /me/permissions': mePermissions({
        enabled: options.enabled === false ? [] : ['uniforms'],
      }),
      'GET /uniform-orders': ok(ORDERS),
      ...extra,
    },
  });
  const Wrapper = app.wrapper;
  render(
    <Wrapper>
      <MemoryRouter
        initialEntries={[options.path ?? `/programs/offerings/${OFFERING_ID}/uniforms`]}
      >
        <Routes>
          <Route
            path="/programs/offerings/:offeringId/uniforms"
            element={<OfferingUniformsScreen />}
          />
        </Routes>
      </MemoryRouter>
    </Wrapper>,
  );
  return app;
}

const rowOf = async (name: string) => {
  const table = await screen.findByRole('table', { name: 'Uniforms ordered' });
  return within(table).getByRole('row', { name: new RegExp(name) });
};

describe('Uniforms of a class or team (SPK-REG-012)', () => {
  it('SPK-REG-012: lists each uniform with its size, paid state and hand-over, and names the pending decision', async () => {
    const app = setup();
    expect(await screen.findByRole('heading', { name: 'Uniforms' })).toBeInTheDocument();
    expect(screen.getByText(/pending DEC-101/)).toBeInTheDocument();
    const alex = await rowOf('Alex Rivera');
    expect(within(alex).getByText('Club kit, size YM')).toBeInTheDocument();
    expect(within(alex).getByText('paid')).toBeInTheDocument();
    expect(within(alex).getByText('Not handed over')).toBeInTheDocument();
    expect(within(alex).getByRole('link', { name: 'Registration' })).toHaveAttribute(
      'href',
      `/registrations/enrollments/${ENROLLMENT_ID}`,
    );
    const blake = await rowOf('Blake Stone');
    expect(within(blake).getByText('handed over')).toBeInTheDocument();
    expect(within(blake).getByText(/by Front desk 1$/)).toBeInTheDocument();
    const casey = await rowOf('Casey Lund');
    expect(within(casey).getByText('ordered')).toBeInTheDocument();
    expect(within(casey).getByText('Awaiting payment')).toBeInTheDocument();
    // Only a paid uniform can be handed over; only a handed-over one can be undone.
    expect(within(casey).queryByRole('button')).not.toBeInTheDocument();
    expect(within(alex).getByRole('button', { name: 'Hand over to Alex Rivera' })).toBeEnabled();
    expect(screen.getByText(/3 uniforms ordered, 1 handed over/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/uniform-orders')?.query).toEqual({
      offeringId: OFFERING_ID,
    });
  });

  it('SPK-REG-012: the list of one team names the team entry, and the filter narrows what is shown', async () => {
    const user = userEvent.setup();
    const app = setup(
      {},
      { path: `/programs/offerings/${OFFERING_ID}/uniforms?team=${TEAM_ENTRY_ID}` },
    );
    await rowOf('Alex Rivera');
    expect(app.fake.requests.find((r) => r.route === '/uniform-orders')?.query).toEqual({
      offeringId: OFFERING_ID,
      teamEntryId: TEAM_ENTRY_ID,
    });
    const filters = screen.getByRole('group', { name: 'Uniform filters' });
    await user.selectOptions(within(filters).getByLabelText('Show'), 'to_hand_over');
    const table = screen.getByRole('table', { name: 'Uniforms ordered' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Alex Rivera')).toBeInTheDocument();
    await user.selectOptions(within(filters).getByLabelText('Show'), 'handed_over');
    expect(
      within(screen.getByRole('table', { name: 'Uniforms ordered' })).getByText('Blake Stone'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Alex Rivera')).not.toBeInTheDocument();
  });

  it('SPK-REG-012: handing over is a command with the expected revision and an idempotency key', async () => {
    const user = userEvent.setup();
    const app = setup({
      'POST /uniform-orders/{id}/hand-over': ok(
        uniformOrder({
          status: 'handed_over',
          handedOverAt: '2026-10-24T12:00:00.000Z',
          revision: 3,
        }),
      ),
    });
    const alex = await rowOf('Alex Rivera');
    await user.click(within(alex).getByRole('button', { name: 'Hand over to Alex Rivera' }));
    await waitFor(() => {
      const command = app.fake.requests.find((r) => r.route === '/uniform-orders/{id}/hand-over');
      expect(command?.params).toMatchObject({ id: UNIFORM_ORDER_ID });
      expect(command?.body).toEqual({ expectedRevision: 2 });
      expect(command?.headers['idempotency-key']).toMatch(/^key-/);
    });
  });

  it('SPK-REG-012: a hand-over is undone only by a recorded correction with a reason', async () => {
    const user = userEvent.setup();
    const app = setup({
      'POST /uniform-orders/{id}/hand-over-corrections': ok(uniformOrder({ revision: 4 })),
    });
    const blake = await rowOf('Blake Stone');
    await user.click(
      within(blake).getByRole('button', { name: 'Undo the hand-over to Blake Stone' }),
    );
    const form = within(blake).getByRole('form', { name: 'Undo the hand-over to Blake Stone' });
    const record = within(form).getByRole('button', { name: 'Record the correction' });
    // No reason, no correction.
    expect(record).toBeDisabled();
    expect(within(form).getByText(/the hand-over record is kept/)).toBeInTheDocument();
    await user.type(
      within(form).getByLabelText(/^Reason for undoing the hand-over to Blake Stone/),
      'Recorded against the wrong child',
    );
    await user.click(record);
    await waitFor(() => {
      const command = app.fake.requests.find(
        (r) => r.route === '/uniform-orders/{id}/hand-over-corrections',
      );
      expect(command?.params).toMatchObject({ id: SECOND_ID });
      expect(command?.body).toEqual({
        reason: 'Recorded against the wrong child',
        expectedRevision: 3,
      });
    });
  });

  it('SPK-REG-012: a hand-over the API refuses (changed since it was loaded) is shown, never assumed done', async () => {
    const user = userEvent.setup();
    setup({
      'POST /uniform-orders/{id}/hand-over': apiError(409, 'STALE_REVISION', {
        message: 'The record changed since it was loaded.',
        nextAction: 'reload',
      }),
    });
    const alex = await rowOf('Alex Rivera');
    await user.click(within(alex).getByRole('button', { name: 'Hand over to Alex Rivera' }));
    expect(await within(alex).findByText(/STALE_REVISION/)).toBeInTheDocument();
    expect(within(alex).getByText('Not handed over')).toBeInTheDocument();
  });

  it('SPK-REG-012: with uniforms turned off the orders stay listed under the turned-off notice and hand-over is not offered', async () => {
    setup({}, { enabled: false });
    expect(await screen.findByTestId('state-turned-off')).toHaveTextContent(/DEC-101/);
    expect(
      screen.getByText(/Uniforms already ordered stay listed; hand-over is not offered\./),
    ).toBeInTheDocument();
    const alex = await rowOf('Alex Rivera');
    expect(within(alex).queryByRole('button')).not.toBeInTheDocument();
    const blake = await rowOf('Blake Stone');
    expect(within(blake).queryByRole('button')).not.toBeInTheDocument();
  });

  it('SPK-REG-012: an offering with no uniform ordered says so', async () => {
    setup({ 'GET /uniform-orders': ok([]) });
    expect(await screen.findByRole('heading', { name: 'No uniforms ordered' })).toBeInTheDocument();
  });

  it('SPK-REG-012: the list is not available to a viewer the API refuses', async () => {
    setup({
      'GET /uniform-orders': apiError(403, 'ACCESS_DENIED', {
        nextAction: 'contact_support_or_request_access',
      }),
    });
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Uniforms ordered' })).not.toBeInTheDocument();
  });
});
