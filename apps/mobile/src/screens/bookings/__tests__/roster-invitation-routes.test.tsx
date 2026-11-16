/**
 * Rental roster invitation routes in the real navigator (SPK-COND-005, proposed; SPK-UX-001,
 * SCR-C-39, §4.14): `/booking-roster-invitations` lists the invitations that name the person,
 * `/booking-roster-invitations/[id]` reads one through
 * `GET /v1/booking-roster-invitations/{id}`, and a malformed id reads nothing. Route parameters
 * are opaque ids; an invitation code is never part of a route.
 */
import { renderRouter, screen } from 'expo-router/testing-library';
import { me } from '../../../features/money/testing/fixtures';
import { G, ok, page, switchesOn } from '../../../features/package-g/__tests__/fixtures';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp } from '../../../testing/test-app';

const INVITATION = '0192f1a0-0000-7000-8000-00000000c301';
const T = '2026-10-20T10:00:00.000Z';

const view = {
  id: INVITATION,
  bookingId: G.booking,
  memberId: '0192f1a0-0000-7000-8000-00000000c103',
  recipientPersonId: G.self,
  recipientContact: null,
  message: null,
  status: 'pending',
  expiresAt: '2026-11-03T10:00:00.000Z',
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
  invitedByPersonId: null,
  revision: 1,
  createdAt: T,
  booking: {
    id: G.booking,
    offeringName: 'Court rental',
    facilityId: G.facility,
    timezone: 'America/Los_Angeles',
    firstStart: '2026-10-24T17:00:00.000Z',
    lastEnd: '2026-10-24T18:00:00.000Z',
    occurrenceCount: 1,
  },
  invitedByName: null,
  requiredWaiverKeys: [],
};

function renderApp(initialUrl: string) {
  const app = createTestApp({
    routes: {
      ...switchesOn('rental_rosters'),
      'GET /me': ok(me()),
      'GET /me/inbox': ok(page([])),
      'GET /me/booking-roster-invitations': ok([view]),
      'GET /booking-roster-invitations/{id}': ok(view),
    },
  });
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

describe('rental roster invitation routes', () => {
  it('/booking-roster-invitations lists the invitations that name the person', async () => {
    const { app } = renderApp('/booking-roster-invitations');
    expect(await screen.findByTestId('screen-roster-invitations')).toBeOnTheScreen();
    expect(await screen.findByTestId(`roster-invitation-row-${INVITATION}`)).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/me/booking-roster-invitations')).toBe(true);
  });

  it('/booking-roster-invitations/[id] reads the invitation by its id', async () => {
    const { app } = renderApp(`/booking-roster-invitations/${INVITATION}`);
    expect(await screen.findByTestId('screen-roster-invitation')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Rental: Court rental')).toBeOnTheScreen();
    const read = app.fake.requests.find((r) => r.route === '/booking-roster-invitations/{id}');
    expect(read?.params.id).toBe(INVITATION);
    expect(read?.query.token).toBeUndefined();
  });

  it('a malformed id is not available and reads nothing', async () => {
    const { app } = renderApp('/booking-roster-invitations/not-an-id');
    expect(await screen.findByText(/not available/i)).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/booking-roster-invitations/{id}')).toBe(
      false,
    );
  });
});
