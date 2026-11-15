/**
 * Rental-group rosters in the customer app (SPK-COND-005, proposed amendment PA-09; capability
 * `rental_rosters`, DEC-103 pending; waivers of SPK-REG-011): the renter's roster on the booking
 * (who is coming, who is invited, whose waiver is not accepted; add, invite, remove) and the
 * invited person's screen (read, join for themselves or their child, decline, then the waiver).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { createRouterMock } from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import {
  basket,
  booking,
  G,
  ok,
  peopleRoutes,
  switchesOn,
} from '../../../features/package-g/__tests__/fixtures';
import { BookingDetailScreen } from '../BookingDetailScreen';
import { RENTER_REMOVAL_REASON } from '../BookingRosterSection';
import {
  parseInvitationCode,
  RosterInvitationScreen,
  RosterInvitationsScreen,
} from '../RosterInvitationScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const MEMBER_SELF = '0192f1a0-0000-7000-8000-00000000c101';
const MEMBER_FRIEND = '0192f1a0-0000-7000-8000-00000000c102';
const MEMBER_GUEST = '0192f1a0-0000-7000-8000-00000000c103';
const MEMBER_INVITED = '0192f1a0-0000-7000-8000-00000000c104';
const FRIEND = '0192f1a0-0000-7000-8000-00000000c201';
const INVITATION = '0192f1a0-0000-7000-8000-00000000c301';
const WAIVER_VERSION = '0192f1a0-0000-7000-8000-00000000c401';
const TOKEN = 'one-time-code-0123456789';
const T = '2026-10-20T10:00:00.000Z';

function member(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    bookingId: G.booking,
    personId: G.self,
    displayName: 'Alex Rivera',
    invitedContact: null,
    status: 'joined',
    waiverStatus: 'current',
    addedByPersonId: G.self,
    addedAt: T,
    joinedAt: T,
    removedAt: null,
    removalReason: null,
    invitation: null,
    revision: 1,
    ...over,
  };
}

function roster(members: unknown[], over: Record<string, unknown> = {}) {
  return {
    bookingId: G.booking,
    waiver: { state: 'evaluated', policyKeys: ['rental-waiver'], blocksBooking: false },
    members,
    counts: { joined: 0, invited: 0, waiverOutstanding: 0 },
    ...over,
  };
}

function invitationView(over: Record<string, unknown> = {}) {
  return {
    id: INVITATION,
    bookingId: G.booking,
    memberId: MEMBER_GUEST,
    recipientPersonId: G.self,
    recipientContact: null,
    message: 'Thursday five-a-side',
    status: 'pending',
    expiresAt: '2026-11-03T10:00:00.000Z',
    acceptedAt: null,
    declinedAt: null,
    revokedAt: null,
    invitedByPersonId: FRIEND,
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
    invitedByName: 'Jo Friend',
    requiredWaiverKeys: [],
    ...over,
  };
}

function detailRoutes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...peopleRoutes(),
    ...switchesOn('rentals', 'rental_rosters'),
    'GET /bookings/{id}': ok(booking()),
    'GET /baskets/{id}': ok(basket()),
    ...extra,
  };
}

describe('rental roster on the booking (SPK-COND-005, proposed)', () => {
  afterEach(settleApps);
  beforeEach(() => jest.clearAllMocks());

  it('SPK-COND-005: the renter sees who is coming, who is invited and whose waiver is not accepted, and that it does not block the booking', async () => {
    const app = createTestApp({
      routes: detailRoutes({
        'GET /bookings/{id}/roster': ok(
          roster(
            [
              member(MEMBER_SELF),
              member(MEMBER_FRIEND, {
                personId: FRIEND,
                displayName: 'Jo Friend',
                waiverStatus: 'missing',
              }),
              member(MEMBER_GUEST, {
                personId: null,
                displayName: null,
                invitedContact: { kind: 'email', value: 'guest@example.test' },
                status: 'invited',
                waiverStatus: 'not_evaluated',
                joinedAt: null,
              }),
              // somebody staff invited by name: the renter is told nothing about who they are
              member(MEMBER_INVITED, {
                personId: null,
                displayName: null,
                invitedContact: null,
                status: 'invited',
                waiverStatus: 'not_evaluated',
                joinedAt: null,
              }),
            ],
            { counts: { joined: 2, invited: 2, waiverOutstanding: 1 } },
          ),
        ),
      }),
    });
    render(<BookingDetailScreen bookingId={G.booking} />, { wrapper: app.wrapper });
    const section = await screen.findByTestId('booking-roster');
    expect(
      await within(section).findByText('2 coming, 2 invited, 1 without an accepted waiver.'),
    ).toBeOnTheScreen();
    expect(
      within(section).getByLabelText('Alex Rivera, Coming, Waiver accepted'),
    ).toBeOnTheScreen();
    expect(
      within(section).getByLabelText('Jo Friend, Coming, Waiver not accepted yet'),
    ).toBeOnTheScreen();
    // somebody who is only invited: the contact the renter typed, or nothing but "invited";
    // never a name, and no waiver is said about them (security review M-1)
    expect(
      within(section).getByLabelText('guest@example.test, Invited, not answered yet'),
    ).toBeOnTheScreen();
    expect(
      within(section).getByLabelText('Invited person, Invited, not answered yet'),
    ).toBeOnTheScreen();
    expect(within(section).queryByLabelText(/Invited, not answered yet, Waiver/)).toBeNull();
    expect(within(section).getByText(/It does not block your booking/)).toBeOnTheScreen();
    expect(within(section).getByText(/it is not a registration/)).toBeOnTheScreen();
  });

  it('the renter adds themselves and their child, invites somebody by email with the code shown once, and removes somebody', async () => {
    let members: unknown[] = [];
    const app = createTestApp({
      routes: detailRoutes({
        'GET /bookings/{id}/roster': () => fakeResponse(200, roster(members)),
        'POST /bookings/{id}/roster': (req) => {
          const personId = (req.body as { personId: string }).personId;
          const added = member(personId === G.self ? MEMBER_SELF : MEMBER_FRIEND, {
            personId,
            displayName: personId === G.self ? 'Alex Rivera' : 'Sam Rivera',
          });
          members = [...members, added];
          return fakeResponse(201, added);
        },
        'POST /bookings/{id}/roster/invitations': () =>
          fakeResponse(201, {
            ...invitationView({
              recipientPersonId: null,
              recipientContact: { kind: 'email', value: 'guest@example.test' },
            }),
            token: TOKEN,
          }),
        'POST /bookings/{id}/roster/members/{memberId}/remove': (req) => {
          members = members.filter((m) => (m as { id: string }).id !== req.params.memberId);
          return fakeResponse(200, member(req.params.memberId ?? '', { status: 'removed' }));
        },
      }),
    });
    render(<BookingDetailScreen bookingId={G.booking} />, { wrapper: app.wrapper });
    const section = await screen.findByTestId('booking-roster');
    expect(await within(section).findByText('Nobody is on the roster yet.')).toBeOnTheScreen();
    // themselves, and the child they register for
    const addSelf = await within(section).findByRole('button', { name: 'Add yourself' });
    await act(async () => {
      fireEvent.press(addSelf);
    });
    expect(
      await within(section).findByLabelText('Alex Rivera, Coming, Waiver accepted'),
    ).toBeOnTheScreen();
    const addChild = await within(section).findByRole('button', { name: 'Add Sam' });
    await act(async () => {
      fireEvent.press(addChild);
    });
    await waitFor(() =>
      expect(within(section).queryByRole('button', { name: 'Add Sam' })).toBeNull(),
    );
    const adds = app.fake.requests.filter(
      (r) => r.method === 'POST' && r.route === '/bookings/{id}/roster',
    );
    expect(adds.map((r) => r.body)).toEqual([{ personId: G.self }, { personId: G.child }]);

    // an invitation needs an email address; the code is shown once, to pass on
    await act(async () => {
      fireEvent.press(within(section).getByRole('button', { name: 'Create invitation' }));
    });
    expect(within(section).getByText(/Enter their email address\./)).toBeOnTheScreen();
    fireEvent.changeText(
      within(section).getByLabelText('Invite somebody by email'),
      'guest@example.test',
    );
    await act(async () => {
      fireEvent.press(within(section).getByRole('button', { name: 'Create invitation' }));
    });
    const issued = await within(section).findByTestId('roster-invitation-issued');
    expect(within(issued).getByText(`Invitation code: ${INVITATION}.${TOKEN}`)).toBeOnTheScreen();
    expect(within(issued).getByText(/Nothing is sent for you/)).toBeOnTheScreen();
    expect(
      app.fake.requests.find((r) => r.route === '/bookings/{id}/roster/invitations')?.body,
    ).toEqual({ recipientContact: { kind: 'email', value: 'guest@example.test' } });

    await act(async () => {
      fireEvent.press(within(section).getByRole('button', { name: 'Remove Sam Rivera' }));
    });
    await waitFor(() =>
      expect(within(section).queryByRole('button', { name: 'Remove Sam Rivera' })).toBeNull(),
    );
    const removal = app.fake.requests.find(
      (r) => r.route === '/bookings/{id}/roster/members/{memberId}/remove',
    );
    expect(removal?.body).toEqual({ reason: RENTER_REMOVAL_REASON, expectedRevision: 1 });
    expect(removal?.headers['idempotency-key']).toEqual(expect.any(String));
  });

  it('SPK-COND-005 with rental rosters turned off, or on a party: no roster is shown and the API is not asked', async () => {
    const off = createTestApp({
      routes: { ...detailRoutes(), ...switchesOn('rentals') },
    });
    const first = render(<BookingDetailScreen bookingId={G.booking} />, { wrapper: off.wrapper });
    await screen.findByTestId('booking-times');
    await waitFor(() =>
      expect(off.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
    expect(screen.queryByTestId('booking-roster')).toBeNull();
    expect(off.fake.requests.some((r) => r.route === '/bookings/{id}/roster')).toBe(false);
    first.unmount();
    await settleApps();

    const party = createTestApp({
      routes: detailRoutes({
        'GET /bookings/{id}': ok(booking({ kind: 'party', guestCount: 10 })),
      }),
    });
    render(<BookingDetailScreen bookingId={G.booking} />, { wrapper: party.wrapper });
    await screen.findByTestId('booking-times');
    await waitFor(() =>
      expect(party.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
    expect(screen.queryByTestId('booking-roster')).toBeNull();
    expect(party.fake.requests.some((r) => r.route === '/bookings/{id}/roster')).toBe(false);
  });
});

describe('joining a rental roster (SPK-COND-005, proposed)', () => {
  afterEach(settleApps);
  beforeEach(() => jest.clearAllMocks());

  const waiver = (status: 'missing' | 'current') => ({
    policyKey: 'rental-waiver',
    title: 'Rental waiver',
    status,
    reason: status === 'missing' ? 'never_accepted' : null,
    currentVersion: {
      policyVersionId: WAIVER_VERSION,
      version: 2,
      title: 'Rental waiver',
      effectiveFrom: T,
    },
    acceptance: null,
    validUntil: null,
    lapsedAt: null,
    rule: { reacceptOnNewVersion: false, renewEveryMonths: null, enforcement: 'warn' },
    evaluatedAt: T,
    history: [],
    overrides: [],
  });

  function inviteRoutes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
    return {
      ...peopleRoutes(),
      ...switchesOn('rental_rosters', 'liability_waivers'),
      'GET /me/booking-roster-invitations': ok([invitationView()]),
      'GET /booking-roster-invitations/{id}': ok(invitationView()),
      ...extra,
    };
  }

  it('SPK-COND-005: the invited person reads what they are invited to and joins for themselves; the waiver the rental asks for is then shown to accept', async () => {
    const app = createTestApp({
      routes: inviteRoutes({
        'GET /booking-roster-invitations/{id}': ok(
          invitationView({ requiredWaiverKeys: ['rental-waiver'] }),
        ),
        'POST /booking-roster-invitations/{id}/accept': ok({
          invitation: invitationView({ status: 'accepted', acceptedAt: T }),
          member: member(MEMBER_GUEST, { waiverStatus: 'missing' }),
        }),
        'GET /people/{id}/waivers': (req) =>
          fakeResponse(200, {
            personId: req.params.id,
            evaluated: true,
            waivers: [waiver('missing')],
          }),
        'GET /policy-versions/{id}': ok({
          id: WAIVER_VERSION,
          kind: 'waiver',
          key: 'rental-waiver',
          version: 2,
          title: 'Rental waiver',
          content: { text: 'I accept the risks of playing here.' },
          effectiveFrom: T,
          effectiveTo: null,
          approvalStatus: 'approved',
          approvedAt: T,
          retiredAt: null,
          retiredReason: null,
          revision: 2,
          createdAt: T,
          updatedAt: T,
        }),
      }),
    });
    render(<RosterInvitationScreen invitationId={INVITATION} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Rental: Court rental')).toBeOnTheScreen();
    expect(screen.getByLabelText('Invited by: Jo Friend')).toBeOnTheScreen();
    expect(screen.getByLabelText('Message: Thursday five-a-side')).toBeOnTheScreen();
    expect(screen.getByLabelText('Waiting for your answer')).toBeOnTheScreen();
    expect(screen.getByText('Open until 3 Nov 2026.')).toBeOnTheScreen();
    // an invitation that names the person is answered for themselves: no choice of who joins
    expect(screen.queryByRole('radio', { name: 'I am joining' })).toBeNull();
    // Joining waits for the account read that says who is signed in; it can follow the invitation.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Join the roster' })).toBeEnabled(),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Join the roster' }));
    });
    expect(await screen.findByLabelText('You joined the roster')).toBeOnTheScreen();
    const sent = app.fake.requests.find(
      (r) => r.route === '/booking-roster-invitations/{id}/accept',
    );
    // signed in as the person it names: neither a code nor another person is sent
    expect(sent?.body).toEqual({});
    const waiverSection = await screen.findByTestId('roster-waiver');
    expect(
      await within(waiverSection).findByLabelText('Waiver not accepted yet'),
    ).toBeOnTheScreen();
    expect(
      await within(waiverSection).findByText('I accept the risks of playing here.'),
    ).toBeOnTheScreen();
    expect(
      within(waiverSection).getByRole('button', { name: 'Accept "Rental waiver"' }),
    ).toBeOnTheScreen();
  });

  it('an invitation code opens an invitation sent to an email address, which is answered for a child; the code is sent with the answer and never put in a route', async () => {
    const app = createTestApp({
      routes: inviteRoutes({
        'GET /me/booking-roster-invitations': ok([]),
        // the code opens the invitation in the body of a POST: never in an address
        'POST /booking-roster-invitations/{id}/open': (req) =>
          (req.body as { token?: string } | undefined)?.token === TOKEN
            ? fakeResponse(
                200,
                invitationView({
                  recipientPersonId: null,
                  recipientContact: { kind: 'email', value: 'guest@example.test' },
                }),
              )
            : fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
        'POST /booking-roster-invitations/{id}/accept': ok({
          invitation: invitationView({ status: 'accepted', acceptedAt: T }),
          member: member(MEMBER_GUEST, { personId: G.child, displayName: 'Sam Rivera' }),
        }),
      }),
    });
    render(<RosterInvitationsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('No invitations waiting')).toBeOnTheScreen();
    fireEvent.changeText(await screen.findByLabelText('Invitation code'), 'not a code');
    fireEvent.press(screen.getByRole('button', { name: 'Open invitation' }));
    expect(screen.getByText(/That is not an invitation code\./)).toBeOnTheScreen();
    fireEvent.changeText(screen.getByLabelText('Invitation code'), `${INVITATION}.${TOKEN}`);
    fireEvent.press(screen.getByRole('button', { name: 'Open invitation' }));
    expect(await screen.findByLabelText('Rental: Court rental')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'I am joining' })).toBeChecked();
    // The child's option comes from the family read, which can arrive after the invitation.
    fireEvent.press(await screen.findByRole('radio', { name: 'Sam is joining' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Join the roster' }));
    });
    expect(await screen.findByLabelText('Sam joined the roster')).toBeOnTheScreen();
    expect(
      app.fake.requests.find((r) => r.route === '/booking-roster-invitations/{id}/accept')?.body,
    ).toEqual({ token: TOKEN, personId: G.child });
    expect(mockRouter.push).not.toHaveBeenCalled();
    // §4.14 (security review L-1): the code travels in a request body only. No address carries
    // it (path or query string), and the invitation is not read by its address with a code.
    const opened = app.fake.requests.filter(
      (r) => r.route === '/booking-roster-invitations/{id}/open',
    );
    expect(opened.length).toBeGreaterThan(0);
    for (const request of opened) expect(request.body).toEqual({ token: TOKEN });
    expect(app.fake.requests.some((r) => r.route === '/booking-roster-invitations/{id}')).toBe(
      false,
    );
    for (const request of app.fake.requests) {
      expect(request.path).not.toContain(TOKEN);
      expect(JSON.stringify(request.query)).not.toContain(TOKEN);
    }
    expect(parseInvitationCode(`${INVITATION}.${TOKEN}`)).toEqual({ id: INVITATION, token: TOKEN });
    expect(parseInvitationCode(TOKEN)).toBeNull();
  });

  it('SPK-COND-005: an invitation that names a child the person registers for is answered for that child and nobody else', async () => {
    const app = createTestApp({
      routes: inviteRoutes({
        'GET /booking-roster-invitations/{id}': ok(invitationView({ recipientPersonId: G.child })),
        'POST /booking-roster-invitations/{id}/accept': ok({
          invitation: invitationView({
            recipientPersonId: G.child,
            status: 'accepted',
            acceptedAt: T,
          }),
          member: member(MEMBER_GUEST, { personId: G.child, displayName: 'Sam Rivera' }),
        }),
      }),
    });
    render(<RosterInvitationScreen invitationId={INVITATION} />, { wrapper: app.wrapper });
    // The child's name comes from the family read, which can arrive after the invitation.
    expect(await screen.findByLabelText('For: Sam')).toBeOnTheScreen();
    // it names its joiner: there is no choice of who joins
    expect(screen.queryByRole('radio', { name: 'I am joining' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Join the roster' })).toBeEnabled(),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Join the roster' }));
    });
    expect(await screen.findByLabelText('Sam joined the roster')).toBeOnTheScreen();
    // neither a code nor another person is sent: the invitation says who joins
    expect(
      app.fake.requests.find((r) => r.route === '/booking-roster-invitations/{id}/accept')?.body,
    ).toEqual({});
  });

  it('declining closes the invitation; a list row opens the invitation by its id only', async () => {
    const app = createTestApp({
      routes: inviteRoutes({
        'POST /booking-roster-invitations/{id}/decline': ok(
          invitationView({ status: 'declined', declinedAt: T }),
        ),
      }),
    });
    const list = render(<RosterInvitationsScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByTestId(`roster-invitation-row-${INVITATION}`));
    expect(mockRouter.push).toHaveBeenCalledWith(`/booking-roster-invitations/${INVITATION}`);
    list.unmount();
    await settleApps();

    const second = createTestApp({
      routes: inviteRoutes({
        'POST /booking-roster-invitations/{id}/decline': ok(
          invitationView({ status: 'declined', declinedAt: T }),
        ),
      }),
    });
    render(<RosterInvitationScreen invitationId={INVITATION} />, { wrapper: second.wrapper });
    const declineButton = await screen.findByRole('button', { name: 'Decline' });
    await act(async () => {
      fireEvent.press(declineButton);
    });
    expect(await screen.findByLabelText('Declined')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Join the roster' })).toBeNull();
    expect(
      second.fake.requests.find((r) => r.route === '/booking-roster-invitations/{id}/decline')
        ?.body,
    ).toEqual({});
  });

  it('SPK-COND-005 with rental rosters turned off: the invitation screens say so and read nothing else', async () => {
    const app = createTestApp({ routes: { ...inviteRoutes(), ...switchesOn() } });
    render(<RosterInvitationsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Rental rosters are not in use')).toBeOnTheScreen();
    expect(
      app.fake.requests.some((r) => (r.route ?? '').includes('booking-roster-invitations')),
    ).toBe(false);
  });
});
