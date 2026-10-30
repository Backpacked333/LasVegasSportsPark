/**
 * SCR-S-14 offering setup (SPK-CAT-001, SPK-CAT-003, SPK-PAY-001, SPK-SCHED-008, §4.9): edits
 * with the expected revision, sessions in facility time, cancel with a reason, price rule versions
 * in minor units, copy as a draft, and the staff-details restriction; the facility zone from the
 * facility directory (K-04) and the responsible manager from the staff directory (ID-04).
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  MANAGER_ID,
  facilitiesRoute,
} from '../../../features/registration-finance/__tests__/fixtures';
import { FACILITY_A, createTestApp, todayFeed } from '../../../testing/test-app';
import {
  NOW,
  OFFERING_B_ID,
  OFFERING_ID,
  apiError,
  entitlement,
  offering,
  ok,
} from '../../../features/registration-finance/__tests__/fixtures';

const SESSION_ID = '0192f1a0-0000-7000-8000-000000002001';
const session = {
  id: SESSION_ID,
  offeringId: OFFERING_ID,
  sequence: 1,
  title: 'Week 1',
  scheduledStart: '2026-11-02T01:00:00.000Z',
  scheduledEnd: '2026-11-02T02:30:00.000Z',
  schedulingEventId: null,
  capacityOverride: null,
  status: 'scheduled',
  canceledAt: null,
  cancelReason: null,
  revision: 2,
  createdAt: NOW,
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /offerings/{id}': ok(offering()),
    'GET /offerings/{id}/sessions': ok([session]),
    'GET /offerings/{id}/price-rules': ok([]),
    'GET /policy-versions': () => fakeResponse(200, { items: [], nextCursor: null }),
    'GET /entitlement-definitions': ok([entitlement()]),
    ...extra,
  };
}

describe('SCR-S-14 OfferingSetupScreen', () => {
  it('shows the configuration, sessions in the facility time zone and links to publication', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    expect(await screen.findByRole('heading', { name: 'Spring academy U10' })).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Publication and registration/ })).toHaveAttribute(
      'href',
      `/programs/offerings/${OFFERING_ID}/publication`,
    );
    const sessions = await screen.findByRole('list', { name: 'Sessions' });
    // 01:00 UTC on 2 November is 17:00 Pacific on 1 November, with the zone named.
    expect(within(sessions).getByText(/Nov 1, 2026, 05:00 PM PST/)).toBeInTheDocument();
    expect(within(sessions).getByText('scheduled')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No price rule' })).toBeInTheDocument();
  });

  it('saves a change with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /offerings/{id}': ok(offering({ name: 'Spring academy U10 B' }, { revision: 5 })),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const form = await screen.findByRole('form', { name: 'Offering configuration' });
    const name = within(form).getByLabelText(/^Offering name/);
    await user.clear(name);
    await user.type(name, 'Spring academy U10 B');
    await user.click(within(form).getByRole('button', { name: 'Save offering' }));
    expect(await screen.findByText('Offering saved (revision 5).')).toBeInTheDocument();
    const patch = app.fake.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      expectedRevision: 4,
      name: 'Spring academy U10 B',
      capacityUnits: [{ unit: 'seats', limit: 20 }],
      registrationOpensAt: '2026-10-20T16:00:00.000Z',
      cancellationPolicyVersionId: null,
    });
  });

  it('adds a session entered in facility time and cancels one with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /offerings/{id}/sessions': ok({ ...session, id: `${SESSION_ID.slice(0, -1)}2` }, 201),
        'POST /sessions/{id}/cancel': ok({
          ...session,
          status: 'canceled',
          cancelReason: 'Field closed',
        }),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const add = await screen.findByRole('form', { name: 'Add a session' });
    await user.type(
      within(add).getByLabelText(/^Session starts \(facility time, America\/Los_Angeles\)/),
      '2026-11-09T17:00',
    );
    await user.type(within(add).getByLabelText(/^Session ends/), '2026-11-09T18:30');
    await user.click(within(add).getByRole('button', { name: 'Add session' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/offerings/{id}/sessions' && r.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(
      app.fake.requests.find((r) => r.method === 'POST' && r.route === '/offerings/{id}/sessions')
        ?.body,
    ).toEqual({
      scheduledStart: '2026-11-10T01:00:00.000Z',
      scheduledEnd: '2026-11-10T02:30:00.000Z',
    });

    await user.click(screen.getByRole('button', { name: 'Cancel Week 1' }));
    const cancelForm = screen.getByRole('form', { name: 'Cancel Week 1' });
    expect(within(cancelForm).getByRole('button', { name: 'Cancel the session' })).toBeDisabled();
    await user.type(
      within(cancelForm).getByLabelText(/^Reason for canceling Week 1/),
      'Field closed',
    );
    await user.click(within(cancelForm).getByRole('button', { name: 'Cancel the session' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/sessions/{id}/cancel')?.body).toEqual({
        reason: 'Field closed',
        expectedRevision: 2,
      }),
    );
  });

  it('SPK-PAY-001: creates a price rule version in minor units with its taxes', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /offerings/{id}/price-rules': ok({}, 201) }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const form = await screen.findByRole('form', { name: 'New price rule version' });
    const f = within(form);
    await user.type(f.getByLabelText(/^Base price/), '125.50');
    await user.type(f.getByLabelText(/^Currency/), 'usd');
    await user.type(f.getByLabelText(/^Effective from/), '2026-10-25T00:00');
    await user.click(f.getByRole('button', { name: 'Add a tax or fee' }));
    await user.type(f.getByLabelText('Charge 1 code'), 'STATE');
    await user.type(f.getByLabelText('Charge 1 label'), 'State tax');
    await user.type(f.getByLabelText('Charge 1 rate or amount'), '825');
    await user.click(f.getByRole('button', { name: 'Create price rule version' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find(
          (r) => r.route === '/offerings/{id}/price-rules' && r.method === 'POST',
        )?.body,
      ).toEqual({
        effectiveFrom: '2026-10-25T07:00:00.000Z',
        basePriceMinor: 12550,
        currency: 'USD',
        chargeLines: [
          { code: 'STATE', label: 'State tax', kind: 'tax', inclusive: false, basisPoints: 825 },
        ],
      }),
    );
  });

  it('SPK-CAT-003: copies the offering as a new draft and opens it', async () => {
    const user = userEvent.setup();
    const copied = offering(
      { id: OFFERING_B_ID, name: 'Spring academy U10 (copy)' },
      { copiedFromOfferingId: OFFERING_ID },
    );
    const app = createTestApp({
      routes: routes({
        'POST /offerings/{id}/copy': ok(copied, 201),
        'GET /offerings/{id}': (request) =>
          fakeResponse(200, request.params.id === OFFERING_B_ID ? copied : offering()),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    await user.click(await screen.findByText('Copy as a new draft'));
    const form = screen.getByRole('form', { name: 'Copy as a new draft' });
    await user.click(within(form).getByLabelText('Copy the sessions, shifted to the new dates'));
    await user.click(within(form).getByRole('button', { name: 'Create the copy' }));
    expect(
      await screen.findByRole('heading', { name: 'Spring academy U10 (copy)' }),
    ).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/offerings/{id}/copy')?.body).toEqual({
      copySessions: true,
      name: 'Spring academy U10 (copy)',
    });
    expect(screen.getByRole('link', { name: 'the original offering' })).toBeInTheDocument();
  });

  it('treats an offering without staff details as not available for setup', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /offerings/{id}': ok(offering({}, null)) }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    expect(await screen.findByText('Setup not available')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Offering configuration' })).toBeNull();
  });

  it('shows the API error code when saving fails', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'PATCH /offerings/{id}': apiError(400, 'VALIDATION_FAILED', {
          message: 'A published offering must keep its required configuration.',
          nextAction: 'correct_input',
          details: [{ path: 'capacityUnits', message: 'At least one capacity unit is required.' }],
        }),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const form = await screen.findByRole('form', { name: 'Offering configuration' });
    await user.click(within(form).getByRole('button', { name: 'Remove capacity unit 1' }));
    await user.click(within(form).getByRole('button', { name: 'Save offering' }));
    expect(await screen.findByText(/Error code: VALIDATION_FAILED/)).toBeInTheDocument();
    expect(screen.getAllByText('At least one capacity unit is required.').length).toBeGreaterThan(
      0,
    );
  });

  it('SPK-SCHED-008: takes the facility zone from the facility directory when the Today feed names none', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /today': todayFeed([], []),
        'GET /facilities': facilitiesRoute,
        'GET /offerings/{id}': ok(offering({ facility: null as never })),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const add = await screen.findByRole('form', { name: 'Add a session' });
    expect(
      within(add).getByLabelText(/^Session starts \(facility time, America\/Los_Angeles\)/),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/facilities')).toBe(true);
  });

  it('ID-04: chooses the responsible manager from the staff directory of the facility', async () => {
    const user = userEvent.setup();
    const OTHER = '0192f1a0-0000-7000-8000-000000000304';
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': ok({
          items: [
            {
              personId: MANAGER_ID,
              displayName: 'Pat Lee',
              roles: ['program_manager'],
              facilityIds: [FACILITY_A],
              scopes: [{ role: 'program_manager', facilityIds: [FACILITY_A] }],
            },
            {
              personId: OTHER,
              displayName: 'Jo Park',
              roles: ['league_manager', 'front_desk'],
              facilityIds: [],
              scopes: [],
            },
          ],
          nextCursor: null,
        }),
        'PATCH /offerings/{id}': ok(offering()),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const form = await screen.findByRole('form', { name: 'Offering configuration' });
    const select = await within(form).findByLabelText('Responsible manager (staff directory)');
    expect(select).toHaveValue(MANAGER_ID);
    await user.selectOptions(select, OTHER);
    expect(within(form).getByLabelText(/^Responsible manager \(person reference\)/)).toHaveValue(
      OTHER,
    );
    expect(
      within(form).getByRole('option', { name: 'Jo Park (league manager, front desk)' }),
    ).toBeVisible();
    expect(app.fake.requests.find((r) => r.route === '/staff-directory')?.query).toMatchObject({
      facilityId: FACILITY_A,
    });
    await user.click(within(form).getByRole('button', { name: 'Save offering' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.method === 'PATCH')?.body).toMatchObject({
        responsibleManagerPersonId: OTHER,
      }),
    );
  });

  it('keeps the person reference when the staff directory is not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /staff-directory': apiError(403, 'ACCESS_DENIED', {
          nextAction: 'contact_support_or_request_access',
        }),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const form = await screen.findByRole('form', { name: 'Offering configuration' });
    expect(
      await within(form).findByText(/The staff directory is not available \(ACCESS_DENIED\)/),
    ).toBeInTheDocument();
    expect(within(form).queryByLabelText('Responsible manager (staff directory)')).toBeNull();
    expect(within(form).getByLabelText(/^Responsible manager \(person reference\)/)).toHaveValue(
      MANAGER_ID,
    );
  });
});
