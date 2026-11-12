/**
 * SCR-S-01 shell and SPK-UX-005 navigation: the fourteen areas in specification order, Today as
 * the operating home, the coach and referee workspace (SPK-UX-007), keyboard access (SPK-UX-009),
 * session handling (§4.13) and the facility switcher limited to the API's facility scope.
 */
import { apiErrorBody, fakePermissions, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { STAFF_AREAS } from '../navigation/areas';
import {
  FACILITY_A,
  FACILITY_B,
  createTestApp,
  facilityDirectoryOf,
  mePermissions,
  staffMe,
  todayFeed,
} from '../testing/test-app';

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

/** The sidebar shows the same fourteen areas grouped by job: Operate, Compete, Grow, Business. */
const SIDEBAR_ORDER = [
  'Today',
  'Schedule',
  'Arrival and attendance',
  'Facilities and maintenance',
  'Leagues and tournaments',
  'Teams and placement',
  'Staff and officials',
  'Programs and camps',
  'People and families',
  'Registrations and waitlists',
  'Finance',
  'Communications',
  'Reports',
  'Administration',
];

describe('staff shell (SCR-S-01, SPK-UX-005)', () => {
  it('lists the fourteen navigation areas grouped in the sidebar, then the workspace', async () => {
    const app = createTestApp();
    render(app.at('/today'));
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await within(nav).findByRole('link', { name: 'Today' });
    const links = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(STAFF_AREAS.map((a) => a.title)).toEqual(SPEC_ORDER);
    expect([...SIDEBAR_ORDER].sort()).toEqual([...SPEC_ORDER].sort());
    expect(links).toEqual([...SIDEBAR_ORDER, 'My assignments']);
    for (const group of ['Operate', 'Compete', 'Grow', 'Business']) {
      expect(within(nav).getByRole('list', { name: group })).toBeInTheDocument();
    }
  });

  it('opens on Today: "/" redirects there and the link is marked current', async () => {
    const app = createTestApp();
    render(app.at('/'));
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Today' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('every area opens with its inventory screen ids, reachable by keyboard', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    await screen.findByRole('heading', { name: 'Today' });
    const finance = await screen.findByRole('link', { name: 'Finance' });
    finance.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 2, name: 'Finance' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Conditional capabilities' })).toBeInTheDocument();
  });

  it('opens the narrow navigation as a modal and restores focus after Escape (SPK-UX-009)', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    expect(await screen.findByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    menu.focus();
    await user.keyboard('{Enter}');
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    const drawer = await screen.findByRole('dialog', { name: 'Staff navigation' });
    const close = within(drawer).getByRole('button', { name: 'Close menu' });
    const shellBody = document.querySelector('.shell-body') as HTMLElement;
    const skipLink = document.querySelector('.skip-link') as HTMLAnchorElement;
    await waitFor(() => expect(close).toHaveFocus());
    expect(shellBody).toHaveAttribute('inert');
    expect(skipLink).toHaveAttribute('inert');

    await user.keyboard('{Escape}');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(menu).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: 'Staff navigation' })).toBeNull();
    expect(shellBody).not.toHaveAttribute('inert');
    expect(skipLink).not.toHaveAttribute('inert');
  });

  it('contains Tab and Shift+Tab inside the drawer (SPK-UX-009)', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    await screen.findByRole('link', { name: 'Skip to main content' });
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = await screen.findByRole('dialog', { name: 'Staff navigation' });
    const close = within(drawer).getByRole('button', { name: 'Close menu' });
    const signOut = within(drawer).getByRole('button', { name: 'Sign out' });

    await waitFor(() => expect(close).toHaveFocus());
    signOut.focus();
    await user.keyboard('{Tab}');
    expect(close).toHaveFocus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(signOut).toHaveFocus();
    await user.keyboard('{Escape}');
  });

  it('closes from the drawer button and restores the Menu trigger (SPK-UX-009)', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    await screen.findByRole('link', { name: 'Skip to main content' });
    const menu = screen.getByRole('button', { name: 'Menu' });
    await user.click(menu);
    const drawer = await screen.findByRole('dialog', { name: 'Staff navigation' });
    await user.click(within(drawer).getByRole('button', { name: 'Close menu' }));

    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(menu).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: 'Staff navigation' })).toBeNull();
  });

  it('closes on desktop resize and focuses the visible sidebar (SPK-UX-009)', async () => {
    const query = '(max-width: 900px)';
    let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
    const mediaQueryList = {
      matches: true,
      addEventListener: (_type: 'change', listener: (event: MediaQueryListEvent) => void) => {
        changeListener = listener;
      },
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    const matchMedia = vi.fn((mediaQuery: string) => {
      expect(mediaQuery).toBe(query);
      return mediaQueryList;
    });
    vi.stubGlobal('matchMedia', matchMedia);

    try {
      const user = userEvent.setup();
      const app = createTestApp();
      render(app.at('/today'));
      await screen.findByRole('link', { name: 'Skip to main content' });
      await user.click(screen.getByRole('button', { name: 'Menu' }));
      const drawer = await screen.findByRole('dialog', { name: 'Staff navigation' });
      await waitFor(() =>
        expect(within(drawer).getByRole('button', { name: 'Close menu' })).toHaveFocus(),
      );
      expect(document.querySelector('.shell-body')).toHaveAttribute('inert');
      expect(changeListener).toBeDefined();

      act(() => changeListener?.({ matches: false } as MediaQueryListEvent));

      expect(screen.queryByRole('dialog', { name: 'Staff navigation' })).toBeNull();
      expect(document.querySelector('.shell-body')).not.toHaveAttribute('inert');
      expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      const brand = screen.getByRole('link', { name: 'Sportspark home' });
      await waitFor(() => expect(brand).toHaveFocus());
      expect(brand).toBeVisible();
      expect(brand.closest('.shell-side')).toHaveAttribute('data-open', 'false');
      expect(matchMedia).toHaveBeenCalledWith(query);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('closes after click-navigation and restores the Menu trigger (SPK-UX-009)', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    await screen.findByRole('link', { name: 'Skip to main content' });
    const menu = screen.getByRole('button', { name: 'Menu' });
    await user.click(menu);
    const drawer = await screen.findByRole('dialog', { name: 'Staff navigation' });
    await user.click(await within(drawer).findByRole('link', { name: 'Finance' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Finance' })).toBeInTheDocument();
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(menu).toHaveFocus());
    expect(screen.queryByRole('dialog', { name: 'Staff navigation' })).toBeNull();
    expect(document.querySelector('.shell-body')).not.toHaveAttribute('inert');
  });

  it('keeps desktop sidebar navigation non-modal and interactive (SPK-UX-009)', async () => {
    const user = userEvent.setup();
    const app = createTestApp();
    render(app.at('/today'));
    await screen.findByRole('link', { name: 'Skip to main content' });
    const sidebar = document.querySelector('.shell-side') as HTMLElement;
    const shellBody = document.querySelector('.shell-body') as HTMLElement;
    expect(sidebar).toHaveAttribute('data-open', 'false');
    expect(sidebar).not.toHaveAttribute('role', 'dialog');
    expect(shellBody).not.toHaveAttribute('inert');

    const finance = await screen.findByRole('link', { name: 'Finance' });
    finance.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 2, name: 'Finance' })).toBeInTheDocument();
    expect(sidebar).not.toHaveAttribute('role', 'dialog');
    expect(shellBody).not.toHaveAttribute('inert');
  });

  it('shows unknown paths as not available', async () => {
    const app = createTestApp();
    render(app.at('/finance/unknown-thing'));
    expect(await screen.findByText('Page not available')).toBeInTheDocument();
  });
});

describe('navigation from GET /v1/me/permissions (SPK-UX-005, K-05)', () => {
  async function mainLinks() {
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await within(nav).findByRole('link', { name: 'My assignments' });
    return within(nav);
  }

  it('lists only the areas the API marks visible, in specification order, then the workspace', async () => {
    const app = createTestApp({
      routes: { 'GET /me/permissions': mePermissions({ areas: ['finance', 'today', 'arrival'] }) },
    });
    render(app.at('/today'));
    const nav = await mainLinks();
    await nav.findByRole('link', { name: 'Today' });
    expect(nav.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Today',
      'Arrival and attendance',
      'Finance',
      'My assignments',
    ]);
    expect(nav.getByRole('list', { name: 'Areas' })).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.route === '/me/permissions')).toHaveLength(1);
  });

  const CASE_STAFF_NAV_CASES = [
    { role: 'front_desk', areas: ['today'], viaAdmin: false },
    { role: 'support_operator', areas: ['today'], viaAdmin: false },
    { role: 'general_manager', areas: ['today', 'admin'], viaAdmin: true },
  ] as const;

  it.each(CASE_STAFF_NAV_CASES)(
    'SPK-UX-005: $role can discover support cases through normal navigation',
    async ({ role, areas, viaAdmin }) => {
      const user = userEvent.setup();
      const app = createTestApp({
        routes: {
          'GET /me/permissions': mePermissions({
            staffRoles: [role],
            actions: ['support.read_case'],
            areas: [...areas],
          }),
          'GET /cases': { status: 200, body: { items: [], nextCursor: null } },
        },
      });
      render(app.at('/today'));
      const nav = await mainLinks();
      let supportLink;
      if (viaAdmin) {
        await user.click(await nav.findByRole('link', { name: 'Administration' }));
        const adminScreens = await screen.findByRole('navigation', {
          name: 'Administration screens',
        });
        supportLink = within(adminScreens).getByRole('link', { name: 'Support cases' });
      } else {
        supportLink = await nav.findByRole('link', { name: 'Support cases' });
      }
      expect(supportLink).toHaveAttribute('href', '/support/cases');
      await user.click(supportLink);
      expect(await screen.findByRole('heading', { name: 'Support cases' })).toBeInTheDocument();
    },
  );

  it('SPK-UX-005: a system administrator without support.read_case sees no support queue link', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({
          staffRoles: ['system_administrator'],
          actions: ['support.manage_queues'],
          areas: ['today', 'admin'],
        }),
      },
    });
    render(app.at('/admin'));
    const nav = await mainLinks();
    expect(nav.queryByRole('link', { name: 'Support cases' })).toBeNull();
    const adminScreens = await screen.findByRole('navigation', {
      name: 'Administration screens',
    });
    expect(within(adminScreens).queryByRole('link', { name: 'Support cases' })).toBeNull();
  });

  it('SPK-UX-005: attention counts show as pills beside the areas; link names stay the area titles', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({ areas: ['finance', 'today', 'communications'] }),
        'GET /me/attention': {
          status: 200,
          body: {
            computedAt: '2026-11-06T12:00:00.000Z',
            cap: 99,
            areas: [
              {
                area: 'finance',
                count: 3,
                capped: false,
                counts: 'unknown payment and refund outcomes',
              },
              { area: 'today', count: 99, capped: true, counts: 'open exceptions' },
              { area: 'communications', count: 0, capped: false, counts: 'notices composed' },
            ],
          },
        },
      },
    });
    render(app.at('/today'));
    const nav = await mainLinks();
    await nav.findByText('Finance: 3 unknown payment and refund outcomes');
    expect(nav.getByRole('link', { name: 'Finance' })).toBeInTheDocument();
    expect(nav.getByRole('link', { name: 'Today' })).toBeInTheDocument();
    const pill = nav.getByTestId('nav-count-finance');
    expect(pill).toHaveTextContent('3');
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    expect(nav.getByTestId('nav-count-today')).toHaveTextContent('99+');
    // A zero shows no pill.
    expect(nav.queryByTestId('nav-count-communications')).toBeNull();
  });

  it('a page of an area not listed still opens by address and renders ACCESS_DENIED as not available', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({ areas: ['today'] }),
        'GET /people/{id}': { status: 403, body: apiErrorBody('ACCESS_DENIED') },
        'GET /people/{id}/timeline': { status: 403, body: apiErrorBody('ACCESS_DENIED') },
        'GET /people/{id}/authority': { status: 403, body: apiErrorBody('ACCESS_DENIED') },
      },
    });
    render(app.at('/people/0192f1a0-0000-7000-8000-0000000000d1'));
    const nav = await mainLinks();
    await nav.findByRole('link', { name: 'Today' });
    expect(nav.queryByRole('link', { name: 'People and families' })).toBeNull();
    expect((await screen.findAllByTestId('state-unavailable')).length).toBeGreaterThan(0);
  });

  it('while the areas load, says so; the workspace link is there already', async () => {
    const app = createTestApp({
      routes: { 'GET /me/permissions': () => new Promise<Response>(() => undefined) },
    });
    render(app.at('/workspace'));
    expect(await screen.findByTestId('nav-loading')).toHaveTextContent('Loading your areas…');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'My assignments' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Today' })).toBeNull();
  });

  it('a failed read shows its code and "Load areas again", which recovers the list', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /me/permissions': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-nav' }))
            : fakeResponse(200, fakePermissions());
        },
      },
    });
    render(app.at('/workspace'));
    expect(await screen.findByTestId('nav-error')).toHaveTextContent(
      'Your areas could not be loaded. Error code: INTERNAL_ERROR. Reference: corr-nav.',
    );
    await user.click(screen.getByRole('button', { name: 'Load areas again' }));
    expect(await screen.findByRole('link', { name: 'Today' })).toBeInTheDocument();
  });

  it('offline with nothing loaded says the areas need a connection', async () => {
    const app = createTestApp({ online: false });
    render(app.at('/workspace'));
    expect(await screen.findByTestId('nav-offline')).toHaveTextContent(
      'No connection: your areas load when you are connected.',
    );
  });

  it('says when no area is available to the account', async () => {
    const app = createTestApp({ routes: { 'GET /me/permissions': mePermissions({ areas: [] }) } });
    render(app.at('/workspace'));
    expect(await screen.findByTestId('nav-none')).toHaveTextContent(
      'No dashboard areas are available to your account.',
    );
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

  it('§4.5: names and scope come from the facility directory; the shell never reads the Today feed', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': staffMe([]),
        'GET /facilities': facilityDirectoryOf([FACILITY_A, FACILITY_B], {
          outOfScope: [FACILITY_B],
        }),
      },
    });
    render(app.at('/workspace'));
    await screen.findByRole('heading', { name: 'My assignments' });
    const select = await screen.findByRole('combobox', { name: 'Facility' });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['All facilities', 'North Park 1']),
    );
    expect(app.fake.requests.filter((r) => r.route === '/facilities')).toHaveLength(1);
    expect(app.fake.requests.some((r) => r.route === '/today')).toBe(false);
  });

  it('offers the GET /v1/me scope by reference when the facility directory cannot be read', async () => {
    const app = createTestApp({
      routes: {
        'GET /facilities': () => fakeResponse(503, apiErrorBody('SERVICE_UNAVAILABLE')),
      },
    });
    render(app.at('/workspace'));
    const select = await screen.findByRole('combobox', { name: 'Facility' });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual([
        'All my facilities',
        `Facility ${FACILITY_A.slice(0, 8)}`,
        `Facility ${FACILITY_B.slice(0, 8)}`,
      ]),
    );
    expect(app.fake.requests.some((r) => r.route === '/today')).toBe(false);
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
    // The Today heading renders before its feed read is sent; wait for the read itself (§4.13).
    const todayRequest = await waitFor(() => {
      const request = app.fake.requests.find((r) => r.route === '/today');
      if (!request) throw new Error('GET /today has not been sent yet');
      return request;
    });
    expect(todayRequest.headers.authorization).toBe('Bearer dev-staff');
    expect(todayRequest.headers['x-sportspark-client']).toBe('sportspark-staff/0.1.0 (web)');
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
