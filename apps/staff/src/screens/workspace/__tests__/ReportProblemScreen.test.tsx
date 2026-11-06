/**
 * Field-side "report a problem" (SPK-FAC-002 any staff reports a maintenance issue; SPK-UX-007
 * phone-first): where, what and how urgent, sent with the facilities module's existing
 * `POST /v1/maintenance-tasks` and an idempotency key; nothing is sent until all three are chosen;
 * offline it is not offered. The workspace phone tab bar links the workspace screens.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { oneFacilityMe } from '../../../features/operations/testing';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const FIELD_3 = '0192f1a0-0000-7000-8000-0000000004a3';

function resource(id: string, name: string) {
  return {
    id,
    facilityId: FACILITY_A,
    kind: 'field',
    name,
    parentResourceId: null,
    dimensions: {},
    compatibleFormats: [],
    defaultSetupMinutes: 0,
    defaultCleanupMinutes: 0,
    requiredEquipment: [],
    staffingConstraints: {},
    status: 'active',
    conflictUnitIds: [],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function app(online = true) {
  return createTestApp({
    online,
    routes: {
      'GET /me': oneFacilityMe(),
      'GET /resources': {
        status: 200,
        body: [
          resource('0192f1a0-0000-7000-8000-0000000004a1', 'Field 1'),
          resource(FIELD_3, 'Field 3 North'),
        ],
      },
      'POST /maintenance-tasks': {
        status: 201,
        body: { id: '0192f1a0-0000-7000-8000-0000000004b1' },
      },
    },
  });
}

describe('workspace: report a problem', () => {
  it('SPK-FAC-002: sends where, what and how urgent to facilities with an idempotency key', async () => {
    const user = userEvent.setup();
    const a = app();
    render(a.at('/workspace/report-problem'));
    const send = await screen.findByRole('button', { name: 'Send to facilities' });
    expect(send).toBeDisabled();
    const where = screen.getByRole('group', { name: 'Where' });
    await user.click(await within(where).findByRole('button', { name: 'Field 3 North' }));
    const what = screen.getByRole('group', { name: 'What' });
    await user.click(within(what).getByRole('button', { name: /Goal or net/ }));
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('Anything to add'), 'Net torn at the left post');
    const urgency = screen.getByRole('group', { name: 'How urgent' });
    await user.click(within(urgency).getByRole('button', { name: /Today/ }));
    expect(within(urgency).getByRole('button', { name: /Today/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(send);
    expect(
      await screen.findByText('Sent to facilities: Goal or net at Field 3 North'),
    ).toBeInTheDocument();
    const posted = a.fake.requests.find((r) => r.route === '/maintenance-tasks');
    expect(posted?.body).toEqual({
      facilityId: FACILITY_A,
      resourceId: FIELD_3,
      issue: 'Goal or net: Net torn at the left post',
      severity: 'high',
    });
    expect(posted?.headers['idempotency-key']).toMatch(/^key-/);
    const resources = a.fake.requests.find((r) => r.route === '/resources');
    expect(resources?.query).toEqual({ facilityId: FACILITY_A });
  });

  it('"Other" needs words; offline nothing can be sent', async () => {
    const user = userEvent.setup();
    render(app().at('/workspace/report-problem'));
    const where = await screen.findByRole('group', { name: 'Where' });
    await user.click(await within(where).findByRole('button', { name: 'Field 1' }));
    await user.click(screen.getByRole('button', { name: /Other/ }));
    await user.click(screen.getByRole('button', { name: /Unsafe now/ }));
    expect(screen.getByRole('button', { name: 'Send to facilities' })).toBeDisabled();
    await user.type(screen.getByLabelText(/What is wrong/), 'Broken bench');
    expect(screen.getByRole('button', { name: 'Send to facilities' })).toBeEnabled();
  });

  it('offline: nothing can be sent', async () => {
    render(app(false).at('/workspace/report-problem'));
    await screen.findByRole('heading', { name: 'Report a problem' });
    const send = screen.queryByRole('button', { name: 'Send to facilities' });
    if (send) expect(send).toBeDisabled();
  });

  it('SPK-UX-007: the workspace tab bar links the workspace screens and marks the current one', async () => {
    render(app().at('/workspace/report-problem'));
    const bar = await screen.findByRole('navigation', { name: 'Workspace tabs' });
    expect(within(bar).getByRole('link', { name: 'Issues' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(bar).getByRole('link', { name: 'Now' })).toHaveAttribute('href', '/workspace');
    await waitFor(() =>
      expect(within(bar).getByRole('link', { name: 'Fees' })).toHaveAttribute(
        'href',
        '/workspace/fees',
      ),
    );
  });

  it('the tab bar is not shown outside the workspace', async () => {
    render(app().at('/arrival'));
    await screen.findByRole('heading', { name: 'Arrival scanner' });
    expect(screen.queryByRole('navigation', { name: 'Workspace tabs' })).toBeNull();
  });
});
