/**
 * SPK-UX-002: five primary destinations in order (labels Home, Explore, Calendar, Teams and You:
 * PA-11, **Proposed**), and the facility pass, the notification inbox and a cart in progress
 * reachable from Home and from every destination without a tab. Renders the real app/ routes with
 * the root layout swapped for the test providers.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { createTestApp } from '../../testing/test-app';
import { DESTINATIONS } from '../destinations';
import { RootNavigator } from '../RootNavigator';

const EMPTY_INBOX = { status: 200, body: { items: [], nextCursor: null } };

function renderApp(initialUrl = '/', routes: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: { 'GET /me/inbox': EMPTY_INBOX, ...routes } });
  const TestRootLayout = () => (
    <app.wrapper>
      <RootNavigator />
    </app.wrapper>
  );
  const router = renderRouter(
    { appDir: 'app', overrides: { _layout: TestRootLayout } },
    { initialUrl },
  );
  return { app, router };
}

describe('primary navigation (SPK-UX-002)', () => {
  it('PA-11 SPK-UX-002: has exactly five tabs, in order, with accessible labels: Home, Explore, Calendar, Teams, You', async () => {
    renderApp();
    expect(DESTINATIONS.map((d) => d.title)).toEqual([
      'Home',
      'Explore',
      'Calendar',
      'Teams',
      'You',
    ]);
    // Route names stay, so links, the demo tour and pathnames keep working.
    expect(DESTINATIONS.map((d) => d.name)).toEqual([
      'index',
      'discover',
      'schedule',
      'teams',
      'account',
    ]);
    expect(DESTINATIONS.map((d) => d.accessibilityLabel)).toEqual([
      'Home: next activity, required actions and urgent changes',
      'Explore: leagues, programs, camps and other activities',
      'Calendar: your and your family’s activities, week by week',
      'Teams: your teams, games and standings',
      'You: family, registrations, payments, forms and settings',
    ]);
    for (const d of DESTINATIONS) {
      const tab = await screen.findByTestId(`tab-${d.name}`);
      expect(tab).toHaveProp('accessibilityLabel', d.accessibilityLabel);
    }
    // Neither the pass nor the inbox is a tab.
    expect(screen.queryByTestId('tab-pass')).toBeNull();
    expect(screen.queryByTestId('tab-inbox')).toBeNull();
  });

  const quickAccessCases = DESTINATIONS.flatMap((d) => {
    const path = d.name === 'index' ? '/' : `/${d.name}`;
    return [
      [d.title, path, 'Facility pass', '/pass'],
      [d.title, path, 'Notification inbox', '/inbox'],
    ] as const;
  });

  it.each(quickAccessCases)(
    'from the %s header (%s), "%s" opens %s',
    async (_title, path, buttonName, target) => {
      const { router } = renderApp(path);
      expect(router.getPathname()).toBe(path);
      fireEvent.press(await screen.findByRole('button', { name: buttonName }));
      expect(router.getPathname()).toBe(target);
      // Let the destination settle (the inbox loads from the fake API).
      if (target === '/inbox')
        expect(await screen.findByText('No notifications')).toBeOnTheScreen();
    },
  );

  it.each([
    ['/discover', 'Explore'],
    ['/schedule', 'Calendar'],
    ['/teams', 'Teams'],
    ['/account', 'You'],
  ])('PA-11: the destination at %s draws its own large title "%s"', async (path, title) => {
    renderApp(path);
    expect(await screen.findByRole('header', { name: title })).toBeOnTheScreen();
  });

  it('ADR-008: changing tab plays the selection haptic; pressing the tab already shown does not', async () => {
    const { app, router } = renderApp('/');
    fireEvent.press(await screen.findByTestId('tab-index'));
    expect(app.haptics.events).toEqual([]);
    fireEvent.press(screen.getByTestId('tab-schedule'));
    expect(router.getPathname()).toBe('/schedule');
    expect(app.haptics.events).toEqual(['selection']);
  });

  it('PA-11 SCR-C-19: /family-calendar opens Calendar with "Everyone" selected, its person chips and the week\'s clash', async () => {
    // The family's week as the API serves it: two Saturday sessions of a child that overlap.
    const self = '0192f1a0-0000-7000-8000-00000000a001';
    const child = '0192f1a0-0000-7000-8000-00000000a002';
    const item = (id: string, title: string, start: string, end: string) => ({
      id,
      personId: child,
      kind: 'enrollment_session',
      enrollmentId: null,
      sessionBookingId: null,
      bookingKind: null,
      offeringId: null,
      sessionId: null,
      title,
      place: null,
      start,
      end,
      status: 'confirmed',
      facilityId: null,
      timezone: 'America/Los_Angeles',
    });
    const skills = item(
      'enrollment:skills',
      'Junior Skills',
      '2026-10-24T17:00:00.000Z',
      '2026-10-24T18:00:00.000Z',
    );
    const swim = item(
      'enrollment:swim',
      'Swim club',
      '2026-10-24T17:30:00.000Z',
      '2026-10-24T18:30:00.000Z',
    );
    const { router } = renderApp('/family-calendar', {
      'GET /me': {
        status: 200,
        body: {
          principal: {
            kind: 'customer',
            organizationId: '0192f1a0-0000-7000-8000-00000000f001',
            accountId: '0192f1a0-0000-7000-8000-0000000000aa',
            personId: self,
            staffRoles: [],
            facilityIds: [],
          },
          person: {
            id: self,
            kind: 'adult',
            givenName: 'Alex',
            familyName: 'Morgan',
            dateOfBirth: null,
            status: 'active',
            mergedIntoPersonId: null,
            revision: 1,
            createdAt: '2026-10-20T12:00:00.000Z',
            updatedAt: '2026-10-20T12:00:00.000Z',
          },
          staffMemberships: [],
          authorities: [{ subjectPersonId: child, permissions: ['view'] }],
        },
      },
      'GET /me/family-calendar': {
        status: 200,
        body: {
          from: '2026-10-24T00:00:00.000Z',
          to: '2026-11-21T00:00:00.000Z',
          participantPersonIds: [self, child],
          items: [skills, swim],
          overlaps: [
            {
              itemIds: [skills.id, swim.id],
              personIds: [child],
              start: '2026-10-24T17:30:00.000Z',
              end: '2026-10-24T18:00:00.000Z',
            },
          ],
        },
      },
      'GET /me/fixtures': { status: 200, body: [] },
      'GET /me/team-entries': { status: 200, body: [] },
    });
    // The rendered destination: Calendar, with "Everyone" selected and the clash called out (M 1h).
    expect(
      await screen.findByLabelText(/^✕ Clash: .* is busy until 11:00, but .* starts at 10:30\.$/),
    ).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/schedule');
    expect(router.getSearchParams()).toEqual({ people: 'everyone' });
    expect(screen.getByRole('header', { name: 'Calendar' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Show activities for')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'Everyone' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeOnTheScreen();
    expect(screen.queryByLabelText('Link not available')).toBeNull();
  });

  it("offers the pass beside Home's greeting (SPK-UX-002 Home: quick access to pass; handoff 1b)", async () => {
    const { router } = renderApp('/');
    const pass = await screen.findAllByRole('button', { name: 'Facility pass' });
    fireEvent.press(pass[0] as never);
    expect(router.getPathname()).toBe('/pass');
  });

  it('resolves an unknown link to "Link not available" instead of following it (SCR-C-39)', async () => {
    renderApp('/no-such-screen/somewhere-unknown');
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
  });

  it('a known screen with a malformed id is "Link not available" too (SCR-C-39)', async () => {
    renderApp('/payments/somewhere-unknown');
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
  });
});
