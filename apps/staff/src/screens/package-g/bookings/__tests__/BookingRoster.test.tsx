/**
 * SCR-S-51 group roster of a rental (SPK-COND-005, proposed amendment PA-09; capability
 * `rental_rosters`, DEC-103 pending), with each member's liability waiver (SPK-REG-011).
 */
import { type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../../testing/test-app';
import {
  BOOKING_ID,
  PARTY_BOOKING_ID,
  booking,
  catalogRoutes,
  ok,
  partyBooking,
} from '../../participation/__tests__/fixtures';

const MEMBER_A = '0192f1a0-0000-7000-8000-0000000007a1';
const MEMBER_B = '0192f1a0-0000-7000-8000-0000000007a2';
const MEMBER_C = '0192f1a0-0000-7000-8000-0000000007a3';
const MEMBER_D = '0192f1a0-0000-7000-8000-0000000007a4';
const PERSON_A = '0192f1a0-0000-7000-8000-0000000007b1';
const PERSON_B = '0192f1a0-0000-7000-8000-0000000007b2';
const PERSON_NEW = '0192f1a0-0000-7000-8000-0000000007b9';
const INVITATION = '0192f1a0-0000-7000-8000-0000000007c1';
const NOW = '2026-10-24T12:00:00.000Z';

function member(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    bookingId: BOOKING_ID,
    personId: PERSON_A,
    displayName: 'Ana Ortiz',
    invitedContact: null,
    status: 'joined',
    waiverStatus: 'current',
    addedByPersonId: null,
    addedAt: NOW,
    joinedAt: NOW,
    removedAt: null,
    removalReason: null,
    invitation: null,
    revision: 1,
    ...over,
  };
}

function roster(over: Record<string, unknown> = {}) {
  return {
    bookingId: BOOKING_ID,
    waiver: { state: 'evaluated', policyKeys: ['rental-waiver'], blocksBooking: false },
    members: [
      member(MEMBER_A),
      member(MEMBER_B, { personId: PERSON_B, displayName: 'Ben Cole', waiverStatus: 'missing' }),
      member(MEMBER_C, {
        personId: null,
        displayName: null,
        invitedContact: { kind: 'email', value: 'guest@example.test' },
        status: 'invited',
        waiverStatus: 'not_evaluated',
        joinedAt: null,
        invitation: { id: INVITATION, status: 'pending', expiresAt: '2026-11-07T12:00:00.000Z' },
      }),
      member(MEMBER_D, {
        displayName: 'Cy Dunn',
        status: 'removed',
        waiverStatus: 'not_evaluated',
        removedAt: NOW,
        removalReason: 'Cannot come',
      }),
    ],
    counts: { joined: 2, invited: 1, waiverOutstanding: 1 },
    ...over,
  };
}

const ACTIONS = [
  'enrollment.read_booking',
  'enrollment.read_booking_roster',
  'enrollment.manage_booking_roster',
  'enrollment.remove_booking_roster_member',
];

function routes(
  extra: Record<string, FakeHandler> = {},
  enabled: Array<'rentals' | 'rental_rosters' | 'parties'> = ['rentals', 'rental_rosters'],
  actions: string[] = ACTIONS,
): Record<string, FakeHandler> {
  return {
    ...catalogRoutes(),
    'GET /me/permissions': mePermissions({ enabled, actions }),
    'GET /bookings/{id}': ok(booking()),
    'GET /bookings/{id}/roster': ok(roster()),
    ...extra,
  };
}

const DETAIL = `/schedule/rentals/${BOOKING_ID}`;

describe('SCR-S-51 rental group roster', () => {
  it('SPK-COND-005: shows who is on the roster, who is invited and whose waiver is missing, and says a missing waiver does not block the booking', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(DETAIL));
    const panel = await screen.findByRole('region', { name: 'Group roster' });
    expect(
      await within(panel).findByText(
        '2 people on the roster, 1 invited, 1 without a current waiver.',
      ),
    ).toBeInTheDocument();
    const list = within(panel).getByRole('list', { name: 'Roster members' });
    const ana = within(list).getByRole('listitem', { name: 'Ana Ortiz' });
    expect(within(ana).getByText('On the roster')).toBeInTheDocument();
    expect(within(ana).getByText('Waiver current')).toBeInTheDocument();
    const ben = within(list).getByRole('listitem', { name: 'Ben Cole' });
    expect(within(ben).getByText('Waiver missing')).toBeInTheDocument();
    const guest = within(list).getByRole('listitem', {
      name: 'guest@example.test (invited, no record yet)',
    });
    expect(within(guest).getByText('Invited')).toBeInTheDocument();
    expect(within(guest).getByText('Waiver not evaluated')).toBeInTheDocument();
    expect(within(guest).getByText('Invitation pending')).toBeInTheDocument();
    const removed = within(panel).getByRole('list', { name: 'Removed from the roster' });
    expect(within(removed).getByText(/Cannot come/)).toBeInTheDocument();
    expect(within(panel).getByText(/does not block the booking/)).toBeInTheDocument();
    expect(within(panel).getByText(/grants nothing else/)).toBeInTheDocument();
    expect(within(panel).getByText('Proposed, DEC-103 pending')).toBeInTheDocument();
  });

  it('adds a person at the desk, invites a contact showing the one-time code once, and removes a member with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /bookings/{id}/roster': {
          status: 201,
          body: member('0192f1a0-0000-7000-8000-0000000007a9', {
            personId: PERSON_NEW,
            displayName: 'Dee Park',
            waiverStatus: 'missing',
          }),
        },
        'POST /bookings/{id}/roster/invitations': {
          status: 201,
          body: {
            id: INVITATION,
            bookingId: BOOKING_ID,
            memberId: MEMBER_C,
            recipientPersonId: null,
            recipientContact: { kind: 'email', value: 'new@example.test' },
            message: null,
            status: 'pending',
            expiresAt: '2026-11-07T12:00:00.000Z',
            acceptedAt: null,
            declinedAt: null,
            revokedAt: null,
            invitedByPersonId: null,
            revision: 1,
            createdAt: NOW,
            token: 'one-time-code-0123456789',
          },
        },
        'POST /bookings/{id}/roster/members/{memberId}/remove': {
          status: 200,
          body: member(MEMBER_B, { status: 'removed', removedAt: NOW, removalReason: 'Left' }),
        },
      }),
    });
    render(app.at(DETAIL));
    const panel = await screen.findByRole('region', { name: 'Group roster' });

    const add = await within(panel).findByRole('group', { name: 'Add a person to the roster' });
    const addButton = within(add).getByRole('button', { name: 'Add to roster' });
    expect(addButton).toBeDisabled();
    await user.type(within(add).getByLabelText(/Person reference/), PERSON_NEW);
    await user.click(addButton);
    expect(await within(panel).findByText('Dee Park added to the roster.')).toBeInTheDocument();
    const added = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/bookings/{id}/roster',
    );
    expect(added?.body).toEqual({ personId: PERSON_NEW });
    expect(added?.headers['idempotency-key']).toMatch(/^key-/);

    const invite = within(panel).getByRole('group', { name: 'Invite somebody to the roster' });
    await user.selectOptions(within(invite).getByLabelText(/How they are reached/), 'email');
    await user.type(
      within(invite).getByLabelText(/Email address or phone number/),
      'new@example.test',
    );
    await user.click(within(invite).getByRole('button', { name: 'Create invitation' }));
    const issued = await within(invite).findByRole('status', { name: 'Invitation created' });
    expect(within(issued).getByText(`${INVITATION}.one-time-code-0123456789`)).toBeInTheDocument();
    expect(within(issued).getByText(/DEC-012, DEC-062/)).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/bookings/{id}/roster/invitations')?.body,
    ).toEqual({ recipientContact: { kind: 'email', value: 'new@example.test' } });

    await user.click(within(panel).getByRole('button', { name: 'Remove Ben Cole' }));
    const remove = within(panel).getByRole('group', { name: 'Remove Ben Cole from the roster' });
    const confirm = within(remove).getByRole('button', { name: 'Remove from roster' });
    expect(confirm).toBeDisabled();
    await user.type(within(remove).getByLabelText(/Why are they removed/), 'Left');
    await user.click(confirm);
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/bookings/{id}/roster/members/{memberId}/remove',
        ),
      ).toBe(true),
    );
    const removal = app.fake.requests.find(
      (r) => r.route === '/bookings/{id}/roster/members/{memberId}/remove',
    );
    expect(removal?.params).toMatchObject({ id: BOOKING_ID, memberId: MEMBER_B });
    expect(removal?.body).toEqual({ reason: 'Left', expectedRevision: 1 });
  });

  it('SPK-REG-011 with liability waivers turned off, or no waiver required: the roster says why no waiver is evaluated', async () => {
    const off = createTestApp({
      routes: routes({
        'GET /bookings/{id}/roster': ok(
          roster({
            waiver: { state: 'capability_off', policyKeys: [], blocksBooking: false },
            members: [member(MEMBER_A, { waiverStatus: 'not_evaluated' })],
            counts: { joined: 1, invited: 0, waiverOutstanding: 0 },
          }),
        ),
      }),
    });
    render(off.at(DETAIL));
    const panel = await screen.findByRole('region', { name: 'Group roster' });
    expect(
      await within(panel).findByText('1 person on the roster, 0 invited.'),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        'Liability waivers are turned off for this organization, so none is evaluated.',
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Waiver not evaluated')).toBeInTheDocument();
  });

  it('a role that only reads sees the roster without the commands', async () => {
    const app = createTestApp({
      routes: routes({}, ['rentals', 'rental_rosters'], ['enrollment.read_booking']),
    });
    render(app.at(DETAIL));
    const panel = await screen.findByRole('region', { name: 'Group roster' });
    await within(panel).findByRole('list', { name: 'Roster members' });
    expect(within(panel).queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(within(panel).queryByRole('group', { name: 'Add a person to the roster' })).toBeNull();
    expect(
      within(panel).getByText('Adding to the roster is not available to your role.'),
    ).toBeInTheDocument();
  });

  it('SPK-COND-005 with rental rosters turned off: the panel is absent and the API is not asked; a party never has a roster', async () => {
    const off = createTestApp({ routes: routes({}, ['rentals']) });
    const first = render(off.at(DETAIL));
    await screen.findByRole('heading', { name: 'Occurrences and resources' });
    expect(screen.queryByRole('region', { name: 'Group roster' })).toBeNull();
    expect(off.fake.requests.some((r) => r.route === '/bookings/{id}/roster')).toBe(false);
    first.unmount();

    const party = createTestApp({
      routes: routes({ 'GET /bookings/{id}': ok(partyBooking()) }, [
        'rentals',
        'parties',
        'rental_rosters',
      ]),
    });
    render(party.at(`/schedule/parties/${PARTY_BOOKING_ID}`));
    await screen.findByRole('heading', { name: 'Occurrences and resources' });
    expect(screen.queryByRole('region', { name: 'Group roster' })).toBeNull();
    expect(party.fake.requests.some((r) => r.route === '/bookings/{id}/roster')).toBe(false);
  });
});
