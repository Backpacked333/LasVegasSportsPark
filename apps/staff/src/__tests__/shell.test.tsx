/**
 * SCR-S-01 shell and SPK-UX-005 navigation: the fourteen areas in specification order, Today as
 * the operating home, the coach and referee workspace (SPK-UX-007), keyboard access (SPK-UX-009),
 * session handling (§4.13) and the facility switcher limited to the API's facility scope.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { STAFF_AREAS } from '../navigation/areas';
import { FACILITY_A, FACILITY_B, createTestApp, staffMe, todayFeed } from '../testing/test-app';

const SPEC_ORDER = [
  'Today',
  'Schedule',
  'Leagues and tournaments',
  'Programs and camps',
  'Teams and placement',
  'People and families',
  'Registrations and waitlists',
  'Arrival and attendance',
  'Staff and officials',
  'Finance',
  'Communications',
  'Facilities and maintenance',
  'Reports',
  'Administration',
];

describe('staff shell (SCR-S-01, SPK-UX-005)', () => {
  it('lists the fourteen navigation areas in specification order, then the workspace', async () => {
    const app = createTestApp();
    render(app.at('/today'));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const links = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(STAFF_AREAS.map((a) => a.title)).toEqual(SPEC_ORDER);
    expect(links).toEqual([...SPEC_ORDER, 'My assignments']);
  });

  it('opens on Today: "/" redirects there and the link is marked current', async () => {
    const app = createTestApp();
    render(app.at('/'));
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  });

  it('every area opens with its inventory screen ids, reachable by keyboard', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    await screen.findByRole('heading', { name: 'Today' });
    const finance = screen.getByRole('link', { name: 'Finance' });
    finance.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 2, name: 'Finance' })).toBeInTheDocument();
    expect(screen.getByText(/Not built yet \(SCR-S-53 to SCR-S-55, SCR-S-57/)).toBeInTheDocument();
  });

  it('offers a skip link and a menu button that exposes its state for narrow screens', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    expect(await screen.findByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows unknown paths as not available', async () => {
    const app = createTestApp();
    render(app.at('/finance/unknown-thing'));
    expect(await screen.findByText('Page not available')).toBeInTheDocument();
  });
});

describe('facility switcher (scope from GET /v1/me)', () => {
  it('offers only the facilities in the principal scope and filters Today by the choice', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me': staffMe([FACILITY_A, FACILITY_B]),
        'GET /today': todayFeed([], [FACILITY_A, FACILITY_B]),
      },
    });
    render(app.at('/today'));
    const select = await screen.findByRole('combobox', { name: 'Facility' });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['All my facilities', 'North Park 1', 'North Park 2']),
    );
    await user.selectOptions(select, FACILITY_B);
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/today' && r.query.facilityId === FACILITY_B),
      ).toBe(true),
    );
  });

  it('shows a single facility as text and no switcher for a non-staff principal', async () => {
    const single = createTestApp({ routes: { 'GET /me': staffMe([FACILITY_A]) } });
    const { unmount } = render(single.at('/today'));
    expect(await screen.findByText('Facility: North Park 1')).toBeInTheDocument();
    unmount();

    const customer = createTestApp({ routes: { 'GET /me': staffMe([], 'customer') } });
    render(customer.at('/workspace'));
    await screen.findByRole('heading', { name: 'My assignments' });
    expect(screen.queryByRole('combobox', { name: 'Facility' })).toBeNull();
  });
});

describe('session (§4.13)', () => {
  it('sends a signed-out user to sign-in, where development builds offer the development sign-in', async () => {
    const app = createTestApp({ session: null });
    render(app.at('/today'));
    expect(await screen.findByRole('heading', { name: 'Development sign-in' })).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/today')).toHaveLength(0);
  });

  it('signs in with a local development token and opens Today', async () => {
    const user = userEvent.setup();
    const account = '0192f1a0-0000-7000-8000-0000000000ee';
    const app = createTestApp({
      session: null,
      routes: {
        'POST /dev/tokens': {
          status: 201,
          body: { token: 'dev-staff', accountId: account, expiresAt: '2026-10-24T20:00:00.000Z' },
        },
      },
    });
    render(app.at('/sign-in'));
    await user.type(await screen.findByLabelText('Account id'), account);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(await app.sessionStore.load()).toMatchObject({ token: 'dev-staff', accountId: account });
    const todayRequest = app.fake.requests.find((r) => r.route === '/today');
    expect(todayRequest?.headers.authorization).toBe('Bearer dev-staff');
    expect(todayRequest?.headers['x-sportspark-client']).toBe('sportspark-staff/0.1.0 (web)');
  });

  it('ends the session when the API answers AUTHENTICATION_REQUIRED', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': () =>
          fakeResponse(
            401,
            apiErrorBody('AUTHENTICATION_REQUIRED', { nextAction: 'authenticate' }),
          ),
      },
    });
    render(app.at('/today'));
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeInTheDocument();
    expect(await app.sessionStore.load()).toBeNull();
  });

  it('replaces the dashboard with "Update required" when the API says this build is unsupported', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': () =>
          fakeResponse(
            426,
            apiErrorBody('CLIENT_UPDATE_REQUIRED', { details: { minimumVersion: '0.4.0' } }),
          ),
      },
    });
    render(app.at('/today'));
    expect(await screen.findByTestId('update-required')).toBeInTheDocument();
    expect(screen.getByText(/Version 0\.4\.0 or later is required/)).toBeInTheDocument();
  });
});

describe('connectivity banner (SPK-UX-008 offline, SCR-W-10)', () => {
  it('states the age of what is shown and what needs a connection while offline', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ now: () => now });
    render(app.at('/today'));
    expect(await screen.findByText('No open issues')).toBeInTheDocument();
    now = new Date('2026-10-24T12:45:00.000Z');
    act(() => app.connectivity.set(false));
    const banner = await screen.findByTestId('connectivity-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(
      within(banner).getByText(/Showing information from 45 minutes ago\./),
    ).toBeInTheDocument();
    expect(within(banner).getByText(/assignment acceptance/)).toBeInTheDocument();
  });
});
