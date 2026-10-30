/**
 * SCR-S-54 Session packages (Package G; SPK-COND-002, SPK-AT-020, ENR-11, DEC-016, DEC-074,
 * POL-039, POL-007): the turned-off notice with packages still listed, packages in pages with
 * credits, expiry in facility time and filters, the redemption history with the session and what a
 * cancellation did with the credit, reversal with a reason (REDEMPTION_ALREADY_REVERSED), a
 * redemption that lost the race for the last credit (PACKAGE_CREDITS_EXHAUSTED), the package
 * definitions read-only, permission restrictions and the empty state.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../../testing/test-app';
import {
  ENTITLEMENT_ID,
  MEMBER_ID,
  PACKAGE_OFFERING_ID,
  PICKUP_OFFERING_ID,
  REDEMPTION_ID,
  REVERSAL_ID,
  SESSION_BOOKING_ID,
  SESSION_ID,
  apiError,
  entitlement,
  entitlementRoutes,
  ok,
  packageOffering,
  page,
  session,
  sessionBooking,
} from '../../participation/__tests__/fixtures';

const ACTIONS = [
  'enrollment.read_package_entitlement',
  'enrollment.reverse_package_redemption',
  'enrollment.book_session',
];

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...entitlementRoutes(),
    'GET /me/permissions': mePermissions({ enabled: ['session_packages'], actions: ACTIONS }),
    'GET /offerings': page([packageOffering()]),
    'GET /package-entitlements': page([entitlement()]),
    'GET /session-bookings/{id}': ok(sessionBooking()),
    ...extra,
  };
}

const PATH = '/finance/session-packages';

async function packageItem() {
  const list = await screen.findByRole('list', { name: 'Session packages' });
  return within(list).getAllByRole('listitem')[0] as HTMLElement;
}

describe('SCR-S-54 Session packages', () => {
  it('DEC-016: opens from the Finance navigation turned off by default, naming DEC-016 and DEC-074, with packages still listed', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes(), 'GET /me/permissions': mePermissions({ actions: ACTIONS }) },
    });
    render(app.at('/finance'));
    const nav = await screen.findByRole('navigation', { name: 'Finance' });
    await user.click(within(nav).getByRole('link', { name: 'Session packages (SCR-S-54)' }));
    const pageEl = await screen.findByTestId('package-g-session-packages');
    expect(pageEl).toHaveAccessibleName('Session packages');
    const off = await within(pageEl).findByTestId('state-turned-off');
    expect(off).toHaveTextContent('Session packages turned off');
    expect(off).toHaveTextContent('(DEC-016, DEC-074)');
    const item = await packageItem();
    expect(within(item).getByText('7 of 10 left (3 used)')).toBeInTheDocument();
    // New redemptions are not offered while off; reversal stays available.
    expect(
      within(item).queryByRole('button', { name: 'Book a session with a credit…' }),
    ).toBeNull();
  });

  it('SPK-COND-002: shows whose package it is, credits, expiry in facility time and the eligible sessions', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'GET /package-entitlements': page([entitlement()], 'next-1') }),
    });
    render(app.at(PATH));
    const item = await packageItem();
    expect(
      await within(item).findByRole('heading', { name: 'Ten-session pass: Ken Ito' }),
    ).toBeInTheDocument();
    expect(within(item).getByText('active')).toBeInTheDocument();
    expect(within(item).getByText('Mon, Mar 1, 00:00 PST')).toBeInTheDocument();
    expect(await within(item).findByText('Friday pickup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more session packages' })).toBeInTheDocument();
    expect(screen.getByTestId('state-pending-decision')).toHaveTextContent('POL-039, POL-007');

    await user.selectOptions(screen.getByLabelText('State'), 'expired');
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/package-entitlements' && r.query.status === 'expired',
        ),
      ).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText('Package'), PACKAGE_OFFERING_ID);
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/package-entitlements' && r.query.offeringId === PACKAGE_OFFERING_ID,
        ),
      ).toBe(true),
    );
  });

  it('a package without expiry says the package chose none, never a default', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /package-entitlements': page([entitlement({ expiresAt: null })]) }),
    });
    render(app.at(PATH));
    const item = await packageItem();
    expect(within(item).getByText('No expiry (the package chose none)')).toBeInTheDocument();
  });

  it('lists redemptions with the session and what a cancellation did with the credit, and reverses one with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /session-bookings/{id}': ok(
          sessionBooking({ status: 'canceled', creditDisposition: 'retained_pending_policy' }),
        ),
        'POST /package-redemptions/{id}/reverse': ok(
          entitlement({ redeemedCount: 2, remainingCredits: 8 }),
        ),
      }),
    });
    render(app.at(PATH));
    const item = await packageItem();
    await user.click(within(item).getByRole('button', { name: 'Show redemptions (1)' }));
    const redemptions = within(item).getByRole('list', { name: 'Redemptions' });
    expect(
      await within(redemptions).findByText(
        /booking canceled; credit kept: no approved policy returns it \(POL-007, POL-039 pending\)/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(redemptions).getByRole('button', { name: /^Reverse the redemption of/ }),
    );
    const form = within(redemptions).getByRole('form', { name: /^Reverse the redemption of/ });
    await user.click(within(form).getByRole('button', { name: 'Reverse the redemption' }));
    expect(
      within(form).getByText('A reason is required; the correction is audited.'),
    ).toBeInTheDocument();
    await user.type(
      within(form).getByLabelText(/^Reason for reversing/),
      'Session canceled by staff',
    );
    await user.click(within(form).getByRole('button', { name: 'Reverse the redemption' }));
    expect(await within(item).findByText('Credit returned: 8 credits left')).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/package-redemptions/{id}/reverse');
    expect(call?.params.id).toBe(REDEMPTION_ID);
    expect(call?.body).toEqual({ reason: 'Session canceled by staff' });
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('a reversed redemption offers no second reversal; REDEMPTION_ALREADY_REVERSED reads in words with Reload', async () => {
    const user = userEvent.setup();
    const reversedPackage = entitlement({
      redemptions: [
        ...entitlement().redemptions,
        {
          id: REVERSAL_ID,
          sessionBookingId: SESSION_BOOKING_ID,
          kind: 'reversal',
          reversesRedemptionId: REDEMPTION_ID,
          reason: 'Corrected',
          redeemedAt: '2026-10-12T17:00:00.000Z',
        },
      ],
    });
    const app = createTestApp({
      routes: routes({ 'GET /package-entitlements': page([reversedPackage]) }),
    });
    const first = render(app.at(PATH));
    const item = await packageItem();
    await user.click(within(item).getByRole('button', { name: 'Show redemptions (2)' }));
    const redemptions = within(item).getByRole('list', { name: 'Redemptions' });
    expect(within(redemptions).getByText('Reversed; the credit was returned.')).toBeInTheDocument();
    expect(
      within(redemptions).queryByRole('button', { name: /^Reverse the redemption/ }),
    ).toBeNull();
    first.unmount();

    const raced = createTestApp({
      routes: routes({
        'POST /package-redemptions/{id}/reverse': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'This redemption was already reversed.',
          nextAction: 'reload_current_state',
          details: { code: 'REDEMPTION_ALREADY_REVERSED' },
        }),
      }),
    });
    render(raced.at(PATH));
    const second = await packageItem();
    await user.click(within(second).getByRole('button', { name: 'Show redemptions (1)' }));
    await user.click(within(second).getByRole('button', { name: /^Reverse the redemption of/ }));
    const form = within(second).getByRole('form', { name: /^Reverse the redemption of/ });
    await user.type(within(form).getByLabelText(/^Reason for reversing/), 'Duplicate');
    await user.click(within(form).getByRole('button', { name: 'Reverse the redemption' }));
    expect(
      await within(form).findByText('This redemption was already reversed; its credit is back.'),
    ).toBeInTheDocument();
    const before = raced.fake.requests.filter((r) => r.route === '/package-entitlements').length;
    await user.click(within(form).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        raced.fake.requests.filter((r) => r.route === '/package-entitlements').length,
      ).toBeGreaterThan(before),
    );
  });

  it('SPK-AT-020: redeeming a credit books a covered session; losing the race for the last credit shows its code', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const app = createTestApp({
      routes: routes({
        'GET /offerings/{id}/sessions': ok([session()]),
        'POST /session-bookings': () => {
          posts += 1;
          return posts === 1
            ? fakeResponse(409, {
                code: 'RESOURCE_CONFLICT',
                message: 'This package has no credit left.',
                correlationId: 'c-race',
                nextAction: 'resolve_conflict',
                details: { code: 'PACKAGE_CREDITS_EXHAUSTED', remainingCredits: 0 },
              })
            : fakeResponse(201, sessionBooking());
        },
      }),
    });
    render(app.at(PATH));
    const item = await packageItem();
    await user.click(within(item).getByRole('button', { name: 'Book a session with a credit…' }));
    const form = within(item).getByRole('form', { name: 'Book a session with a credit' });
    await user.click(await within(form).findByRole('radio', { name: 'Friday pickup' }));
    await user.click(
      await within(form).findByRole('radio', { name: /Fri, Oct 30, 18:00 to 19:30 PDT/ }),
    );
    await user.click(within(form).getByRole('button', { name: 'Book the session' }));
    expect(
      await within(form).findByText('Error code: RESOURCE_CONFLICT. Reference: c-race'),
    ).toBeInTheDocument();
    expect(within(form).getByText(/another booking may have used it/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Book the session' }));
    expect(
      await within(item).findByText('Session booked (confirmed); one credit used'),
    ).toBeInTheDocument();
    expect(
      app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/session-bookings')[1]
        ?.body,
    ).toEqual({
      offeringId: PICKUP_OFFERING_ID,
      sessionId: SESSION_ID,
      participantPersonId: MEMBER_ID,
      packageEntitlementId: ENTITLEMENT_ID,
    });
  });

  it('an exhausted package offers no redemption', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /package-entitlements': page([
          entitlement({ status: 'exhausted', redeemedCount: 10, remainingCredits: 0 }),
        ]),
      }),
    });
    render(app.at(PATH));
    const item = await packageItem();
    expect(within(item).getByText('exhausted')).toBeInTheDocument();
    expect(
      within(item).queryByRole('button', { name: 'Book a session with a credit…' }),
    ).toBeNull();
  });

  it('shows the package definitions read-only: credits, eligible sessions and expiry', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(PATH));
    const list = await screen.findByRole('list', { name: 'Package offerings' });
    expect(
      await within(list).findByText('180 days after the package is issued'),
    ).toBeInTheDocument();
    expect(within(list).getByText('10')).toBeInTheDocument();
    expect(within(list).getByText('Price: Not priced')).toBeInTheDocument();
  });

  it('empty: no package matches; a refused read is not available; missing permission reads not available to you', async () => {
    const app = createTestApp({ routes: routes({ 'GET /package-entitlements': page([]) }) });
    const { unmount } = render(app.at(PATH));
    expect(await screen.findByText('No session packages')).toBeInTheDocument();
    unmount();

    const denied = createTestApp({
      routes: routes({ 'GET /package-entitlements': apiError(403, 'ACCESS_DENIED') }),
    });
    const second = render(denied.at(PATH));
    const section = (await screen.findByRole('heading', { name: 'Session packages held' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(section).findByTestId('state-unavailable')).toHaveTextContent(
      'Not available',
    );
    second.unmount();

    const noRole = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['session_packages'], actions: [] }),
      }),
    });
    render(noRole.at(PATH));
    expect(
      await screen.findByText(/Reading session packages is not available to you/),
    ).toHaveTextContent('enrollment.read_package_entitlement');
    expect(noRole.fake.requests.some((r) => r.route === '/package-entitlements')).toBe(false);
  });
});
