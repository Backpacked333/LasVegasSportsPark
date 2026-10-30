/**
 * SCR-S-53 Memberships (Package G; SPK-COND-001, ENR-12, DEC-016, DEC-072, POL-038, DEC-007): the
 * turned-off notice with memberships still readable, the offerings' definitions read-only (included
 * sessions per period, never unlimited unless stated; term; renewal notice), members in pages, a
 * member's suspension entered in facility time and ended with its revision (SUSPENSION_OVERLAP),
 * an included session booked with the membership (MEMBERSHIP_SESSIONS_USED), renewal into a
 * basket with nothing charged until checkout (CAPABILITY_DISABLED reads turned off), permission
 * restrictions and the not-found presentation. The sessions booked with the membership (each in
 * its own offering's zone), a partly filled "until" said at the field, and "Try again" after no
 * answer resending the suspension with the same key and body (§4.9).
 */
import {
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../../testing/test-app';
import {
  MEMBER_ID,
  MEMBERSHIP_ENROLLMENT_ID,
  MEMBERSHIP_NEXT_OFFERING_ID,
  MEMBERSHIP_OFFERING_ID,
  PICKUP_OFFERING_ID,
  SESSION_ID,
  SUSPENSION_ID,
  apiError,
  enrollment,
  entitlementRoutes,
  membershipOffering,
  ok,
  page,
  session,
  sessionBooking,
  suspension,
} from '../../participation/__tests__/fixtures';

const ACTIONS = [
  'enrollment.manage_membership_suspension',
  'enrollment.renew_membership',
  'enrollment.book_session',
  'enrollment.read_session_booking',
];

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...entitlementRoutes(),
    'GET /me/permissions': mePermissions({ enabled: ['memberships'], actions: ACTIONS }),
    'GET /offerings': page([
      membershipOffering(),
      membershipOffering({ id: MEMBERSHIP_NEXT_OFFERING_ID, name: 'Adult membership 2027' }),
    ]),
    'GET /enrollments': page([enrollment()]),
    'GET /enrollments/{id}': ok(enrollment()),
    'GET /session-bookings': ok([]),
    ...extra,
  };
}

const DETAIL = `/finance/memberships/${MEMBERSHIP_ENROLLMENT_ID}`;

function setLocal(group: HTMLElement, date: string, time: string) {
  fireEvent.change(within(group).getByLabelText('Date'), { target: { value: date } });
  fireEvent.change(within(group).getByLabelText('Time'), { target: { value: time } });
}

describe('SCR-S-53 Memberships', () => {
  it('DEC-016: opens from the Finance navigation turned off by default, naming DEC-016 and DEC-072, with memberships still readable', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: { ...routes(), 'GET /me/permissions': mePermissions() } });
    render(app.at('/finance'));
    const nav = await screen.findByRole('navigation', { name: 'Finance' });
    await user.click(within(nav).getByRole('link', { name: 'Memberships (SCR-S-53)' }));
    const pageEl = await screen.findByTestId('package-g-memberships');
    expect(pageEl).toHaveAccessibleName('Memberships');
    const off = await within(pageEl).findByTestId('state-turned-off');
    expect(off).toHaveTextContent('Memberships turned off');
    expect(off).toHaveTextContent('(DEC-016, DEC-072)');
    expect(off).toHaveTextContent('suspensions can still be recorded and ended');
    expect(
      await within(pageEl).findByRole('list', { name: 'Membership offerings' }),
    ).toBeInTheDocument();
  });

  it('SPK-COND-001: shows what each membership includes exactly as its definition states, and its members', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/finance/memberships'));
    const list = await screen.findByRole('list', { name: 'Membership offerings' });
    const first = within(list).getAllByRole('listitem')[0] as HTMLElement;
    expect(
      await within(first).findByText(/2 sessions per week \(weeks start Monday\) of/),
    ).toBeInTheDocument();
    expect(await within(first).findByText('Friday pickup')).toBeInTheDocument();
    expect(within(first).getByText('365 days from confirmation')).toBeInTheDocument();
    expect(within(first).getByText('30 days before the term ends')).toBeInTheDocument();
    expect(within(first).queryByText(/Unlimited/)).toBeNull();
    expect(
      within(first).getByText(
        /\$120\.00 \(as the catalog prices it; member pricing is not built, DEC-007\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('state-pending-decision')).toHaveTextContent('POL-038, DEC-007');

    await user.click(
      within(first).getByRole('button', { name: 'Show members of Adult membership' }),
    );
    const members = await screen.findByRole('list', { name: 'Members of Adult membership' });
    expect(await within(members).findByRole('link', { name: 'Ken Ito' })).toHaveAttribute(
      'href',
      DETAIL,
    );
    expect(within(members).getByText('confirmed')).toBeInTheDocument();
    expect(within(members).getByText(/Confirmed Tue, Sep 15, 10:00 PDT/)).toBeInTheDocument();
    expect(
      app.fake.requests.some(
        (r) => r.route === '/enrollments' && r.query.offeringId === MEMBERSHIP_OFFERING_ID,
      ),
    ).toBe(true);
  });

  it('suspends in facility time with a reason, then ends the suspension with its revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/membership-suspensions': { status: 201, body: suspension() },
        'POST /membership-suspensions/{id}/end': ok(
          suspension({
            status: 'ended',
            endedAt: '2026-10-24T12:00:00.000Z',
            endedReason: 'Recovered',
            revision: 2,
          }),
        ),
      }),
    });
    render(app.at(DETAIL));
    const form = await screen.findByRole('form', { name: 'Suspend the membership' });
    await user.click(within(form).getByRole('button', { name: 'Suspend the membership' }));
    expect(within(form).getByText('Enter a date and a time.')).toBeInTheDocument();
    expect(within(form).getByText('A reason is required; it is audited.')).toBeInTheDocument();
    expect(
      app.fake.requests.some((r) => r.route === '/enrollments/{id}/membership-suspensions'),
    ).toBe(false);
    setLocal(
      within(form).getByRole('group', { name: 'Suspended from (America/Los_Angeles)' }),
      '2026-11-10',
      '00:00',
    );
    await user.type(within(form).getByLabelText(/^Reason for suspending/), 'Injury');
    await user.click(within(form).getByRole('button', { name: 'Suspend the membership' }));
    const recorded = await screen.findByRole('list', { name: 'Suspensions recorded here' });
    expect(
      within(recorded).getByText(/From Tue, Nov 10, 00:00 PST until ended/),
    ).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/enrollments/{id}/membership-suspensions')?.body,
    ).toEqual({
      from: '2026-11-10T08:00:00.000Z',
      reason: 'Injury',
    });

    await user.click(within(recorded).getByRole('button', { name: /^End the suspension from/ }));
    const end = within(recorded).getByRole('form', { name: /^End the suspension from/ });
    await user.type(within(end).getByLabelText(/^Reason for ending the suspension/), 'Recovered');
    await user.click(within(end).getByRole('button', { name: 'End the suspension' }));
    await waitFor(() => expect(within(recorded).getByText('ended')).toBeInTheDocument());
    const call = app.fake.requests.find((r) => r.route === '/membership-suspensions/{id}/end');
    expect(call?.params.id).toBe(SUSPENSION_ID);
    expect(call?.body).toEqual({ reason: 'Recovered', expectedRevision: 1 });
  });

  it('SUSPENSION_OVERLAP: an overlapping period is refused with its code and the input kept', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/membership-suspensions': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'The membership is already suspended in that period.',
          nextAction: 'resolve_conflict',
          details: { code: 'SUSPENSION_OVERLAP' },
        }),
      }),
    });
    render(app.at(DETAIL));
    const form = await screen.findByRole('form', { name: 'Suspend the membership' });
    setLocal(
      within(form).getByRole('group', { name: 'Suspended from (America/Los_Angeles)' }),
      '2026-11-10',
      '00:00',
    );
    await user.type(within(form).getByLabelText(/^Reason for suspending/), 'Injury');
    await user.click(within(form).getByRole('button', { name: 'Suspend the membership' }));
    expect(
      await within(form).findByText('Error code: RESOURCE_CONFLICT. Reference: corr-pg-1'),
    ).toBeInTheDocument();
    expect(within(form).getAllByText(/already suspended in that period/).length).toBeGreaterThan(0);
    expect(within(form).getByLabelText(/^Reason for suspending/)).toHaveValue('Injury');
  });

  it('books a session the membership includes, naming the membership; a used-up week reads in words', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'GET /offerings/{id}/sessions': ok([
          session(),
          session({
            id: 'past-session',
            scheduledStart: '2026-10-10T01:00:00.000Z',
            scheduledEnd: '2026-10-10T02:00:00.000Z',
          }),
        ]),
        'POST /session-bookings': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(409, {
                code: 'RESOURCE_CONFLICT',
                message: 'The membership has used every session it includes for this period.',
                correlationId: 'c-m',
                nextAction: 'resolve_conflict',
                details: {
                  code: 'MEMBERSHIP_SESSIONS_USED',
                  periodKey: 'week:2026-10-26',
                  limit: 2,
                },
              })
            : fakeResponse(
                201,
                sessionBooking({
                  entitlementBasis: 'membership',
                  membershipEnrollmentId: MEMBERSHIP_ENROLLMENT_ID,
                  packageEntitlementId: null,
                }),
              );
        },
      }),
    });
    render(app.at(DETAIL));
    await user.click(await screen.findByRole('button', { name: 'Book an included session…' }));
    const form = screen.getByRole('form', { name: 'Book an included session' });
    await user.click(await within(form).findByRole('radio', { name: 'Friday pickup' }));
    const choice = await within(form).findByRole('radio', {
      name: /Fri, Oct 30, 18:00 to 19:30 PDT/,
    });
    expect(within(form).queryByRole('radio', { name: /Oct 9/ })).toBeNull();
    await user.click(choice);
    await user.click(within(form).getByRole('button', { name: 'Book the session' }));
    expect(
      await within(form).findByText(
        'The membership has used every session it includes for this period.',
      ),
    ).toBeInTheDocument();
    expect(
      within(form).getByText('Error code: RESOURCE_CONFLICT. Reference: c-m'),
    ).toBeInTheDocument();
    const key1 = app.fake.requests.find((r) => r.route === '/session-bookings')?.headers[
      'idempotency-key'
    ];
    await user.click(within(form).getByRole('button', { name: 'Book the session' }));
    expect(await screen.findByText('Included session booked (confirmed)')).toBeInTheDocument();
    const posts = app.fake.requests.filter(
      (r) => r.method === 'POST' && r.route === '/session-bookings',
    );
    expect(posts[1]?.body).toEqual({
      offeringId: PICKUP_OFFERING_ID,
      sessionId: SESSION_ID,
      participantPersonId: MEMBER_ID,
      membershipEnrollmentId: MEMBERSHIP_ENROLLMENT_ID,
    });
    expect(posts[1]?.headers['idempotency-key']).not.toEqual(key1);
  });

  it('renews into a chosen membership offering (none preselected); nothing is charged until checkout', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/renew': { status: 201, body: { id: 'basket-r1', status: 'open' } },
      }),
    });
    render(app.at(DETAIL));
    const form = await screen.findByRole('form', { name: 'Renew the membership' });
    const select = await within(form).findByLabelText(/^Renew into/);
    expect(select).toHaveValue('');
    await user.click(within(form).getByRole('button', { name: 'Add the renewal to a basket' }));
    expect(
      within(form).getByText('Choose the membership offering the renewal buys.'),
    ).toBeInTheDocument();
    await user.selectOptions(select, MEMBERSHIP_NEXT_OFFERING_ID);
    await user.click(within(form).getByRole('button', { name: 'Add the renewal to a basket' }));
    const added = await screen.findByRole('group', { name: 'Renewal added' });
    expect(added).toHaveTextContent('Nothing is charged until checkout');
    expect(
      within(added).getByRole('link', { name: 'Continue to checkout in assisted registration' }),
    ).toHaveAttribute('href', '/registrations/assisted/basket-r1');
    expect(app.fake.requests.find((r) => r.route === '/enrollments/{id}/renew')?.body).toEqual({
      targetOfferingId: MEMBERSHIP_NEXT_OFFERING_ID,
    });
  });

  it('CAPABILITY_DISABLED: a renewal refused because memberships were turned off reads turned off', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/renew': {
          status: 403,
          body: capabilityDisabledBody('memberships', ['DEC-016', 'DEC-072']),
        },
      }),
    });
    render(app.at(DETAIL));
    const form = await screen.findByRole('form', { name: 'Renew the membership' });
    await user.selectOptions(
      await within(form).findByLabelText(/^Renew into/),
      MEMBERSHIP_NEXT_OFFERING_ID,
    );
    await user.click(within(form).getByRole('button', { name: 'Add the renewal to a basket' }));
    const off = await within(form).findByTestId('state-turned-off');
    expect(off).toHaveTextContent('Memberships turned off');
    expect(off).toHaveTextContent('ACCESS_DENIED (CAPABILITY_DISABLED)');
  });

  it('while memberships are off, renewal and included sessions are not offered; suspensions stay available', async () => {
    const on = createTestApp({ routes: routes() });
    const first = render(on.at(DETAIL));
    // The booking button needs what the membership includes, read from its definition.
    const includesOn = (await screen.findByRole('heading', { name: 'What it includes' }))
      .parentElement as HTMLElement;
    expect(await within(includesOn).findByText(/2 sessions per week/)).toBeInTheDocument();
    expect(
      within(includesOn).getByRole('button', { name: 'Book an included session…' }),
    ).toBeInTheDocument();
    first.unmount();

    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': mePermissions({ actions: ACTIONS }) }),
    });
    render(app.at(DETAIL));
    expect(
      await screen.findByText('Renewals are not taken while memberships are turned off.'),
    ).toBeInTheDocument();
    const includes = screen.getByRole('heading', { name: 'What it includes' })
      .parentElement as HTMLElement;
    expect(await within(includes).findByText(/2 sessions per week/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book an included session…' })).toBeNull();
    expect(screen.getByRole('form', { name: 'Suspend the membership' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'cancel or transfer this membership (SCR-S-27)' }),
    ).toHaveAttribute('href', `/registrations/enrollments/${MEMBERSHIP_ENROLLMENT_ID}`);
  });

  it('permission restriction: without the suspension permission it reads not available to you, naming it', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({
          enabled: ['memberships'],
          actions: ['enrollment.renew_membership'],
        }),
      }),
    });
    render(app.at(DETAIL));
    const denied = await screen.findByText(/Suspending memberships is not available to you/);
    expect(denied).toHaveTextContent('enrollment.manage_membership_suspension');
    expect(screen.queryByRole('form', { name: 'Suspend the membership' })).toBeNull();
  });

  it('§4.10: a membership the API does not show is "not available"; another enrollment is not a membership', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /enrollments/{id}': apiError(404, 'NOT_FOUND') }),
    });
    const { unmount } = render(app.at(DETAIL));
    const pageEl = await screen.findByTestId('package-g-memberships');
    expect(await within(pageEl).findByTestId('state-unavailable')).toHaveTextContent(
      'Not available',
    );
    unmount();
    const other = createTestApp({
      routes: routes({ 'GET /enrollments/{id}': ok(enrollment({ intent: 'individual_league' })) }),
    });
    render(other.at(DETAIL));
    expect(await screen.findByText('This enrollment is not a membership.')).toBeInTheDocument();
  });
  it('lists the sessions booked with the membership, each in its own offering’s zone, and what a cancellation did', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /session-bookings': ok([
          sessionBooking({
            entitlementBasis: 'membership',
            membershipEnrollmentId: MEMBERSHIP_ENROLLMENT_ID,
            packageEntitlementId: null,
          }),
          sessionBooking({
            id: '0192f1a0-0000-7000-8000-0000000002e9',
            status: 'canceled',
            entitlementBasis: 'membership',
            membershipEnrollmentId: MEMBERSHIP_ENROLLMENT_ID,
            packageEntitlementId: null,
            creditDisposition: 'returned',
            scheduledStart: '2026-10-24T01:00:00.000Z',
            scheduledEnd: '2026-10-24T02:30:00.000Z',
          }),
          // A package booking of the same member is not this membership's.
          sessionBooking({ id: '0192f1a0-0000-7000-8000-0000000002ea' }),
        ]),
      }),
    });
    render(app.at(DETAIL));
    const list = await screen.findByRole('list', { name: 'Sessions booked with this membership' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(await within(list).findAllByText('Friday pickup')).toHaveLength(2);
    expect(within(list).getByText(/Fri, Oct 16, 18:00 to 19:30 PDT/)).toBeInTheDocument();
    expect(within(list).getByText('canceled')).toBeInTheDocument();
    expect(within(list).getByText('credit returned')).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/session-bookings' && r.method === 'GET')?.query,
    ).toEqual({ participantPersonId: MEMBER_ID });
    expect(
      screen.getByText(/the count used against each period's limit and earlier suspensions/),
    ).toBeInTheDocument();
  });

  it('no session booked with the membership reads empty; without the read permission it is not available to you', async () => {
    const app = createTestApp({ routes: routes() });
    const first = render(app.at(DETAIL));
    expect(await screen.findByText('No session booked with this membership')).toBeInTheDocument();
    first.unmount();
    const noRead = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({
          enabled: ['memberships'],
          actions: ACTIONS.filter((a) => a !== 'enrollment.read_session_booking'),
        }),
      }),
    });
    render(noRead.at(DETAIL));
    expect(
      await screen.findByText(/Reading session bookings is not available to you/),
    ).toHaveTextContent('enrollment.read_session_booking');
    expect(noRead.fake.requests.some((r) => r.route === '/session-bookings')).toBe(false);
  });

  it('a partly filled "Suspended until" is said at its field and nothing is sent', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(DETAIL));
    const form = await screen.findByRole('form', { name: 'Suspend the membership' });
    setLocal(
      within(form).getByRole('group', { name: 'Suspended from (America/Los_Angeles)' }),
      '2026-11-10',
      '00:00',
    );
    const until = within(form).getByRole('group', {
      name: 'Suspended until (optional; leave empty until ended) (America/Los_Angeles)',
    });
    fireEvent.change(within(until).getByLabelText('Date'), { target: { value: '2026-11-20' } });
    await user.type(within(form).getByLabelText(/^Reason for suspending/), 'Injury');
    await user.click(within(form).getByRole('button', { name: 'Suspend the membership' }));
    expect(within(until).getByRole('alert')).toHaveTextContent('Enter a date and a time.');
    expect(within(until).getByLabelText('Time')).toHaveAttribute('aria-invalid', 'true');
    expect(
      app.fake.requests.some((r) => r.route === '/enrollments/{id}/membership-suspensions'),
    ).toBe(false);
  });

  it('§4.9: a suspension after a lost connection reads "Outcome not known yet"; Try again resends the same key and body', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/membership-suspensions': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('connection dropped');
          return fakeResponse(201, suspension());
        },
      }),
    });
    render(app.at(DETAIL));
    const form = await screen.findByRole('form', { name: 'Suspend the membership' });
    setLocal(
      within(form).getByRole('group', { name: 'Suspended from (America/Los_Angeles)' }),
      '2026-11-10',
      '00:00',
    );
    await user.type(within(form).getByLabelText(/^Reason for suspending/), 'Injury');
    await user.click(within(form).getByRole('button', { name: 'Suspend the membership' }));
    const unknown = await within(form).findByTestId('state-outcome-unknown');
    expect(within(unknown).getByText('Outcome not known yet')).toBeInTheDocument();
    await user.click(within(unknown).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('list', { name: 'Suspensions recorded here' }),
    ).toBeInTheDocument();
    const [first, second] = app.fake.requests.filter(
      (r) => r.route === '/enrollments/{id}/membership-suspensions',
    );
    expect(second?.body).toEqual({ from: '2026-11-10T08:00:00.000Z', reason: 'Injury' });
    expect(second?.body).toEqual(first?.body);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });
});
