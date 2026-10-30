/**
 * SCR-S-51 Rentals (Package G; SPK-COND-003, SPK-REG-001, SPK-REG-007, ENR-13, DEC-016, DEC-076):
 * the bookings list (only rentals, paged, booker names, facility-zone times, machine-state labels),
 * the turned-off notice with the list still readable, request-mode approval (expected revision,
 * idempotency key, RESOURCE_CONFLICT keeps it requested, CAPABILITY_DISABLED reads turned off),
 * decline with a reason, permission restrictions, not-found presentation, the offerings' booking
 * terms and definitions read-only, and booking a rental for a customer from free times.
 */
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakePermissions,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../../testing/test-app';
import {
  BOOKER_ID,
  BOOKING_ID,
  PARTY_BOOKING_ID,
  RESOURCE_A,
  RESOURCE_B,
  apiError,
  booking,
  catalogRoutes,
  offering,
  ok,
  page,
  partyBooking,
} from '../../participation/__tests__/fixtures';

const STAFF_ACTIONS = [
  'enrollment.read_booking',
  'enrollment.request_booking',
  'enrollment.decide_booking',
];

function permissions(enabled = true, actions: string[] = STAFF_ACTIONS) {
  return mePermissions({ enabled: enabled ? ['rentals'] : [], actions });
}

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...catalogRoutes(),
    'GET /me/permissions': permissions(),
    'GET /bookings': page([booking(), partyBooking()]),
    'GET /bookings/{id}': ok(booking()),
    ...extra,
  };
}

const DETAIL = `/schedule/rentals/${BOOKING_ID}`;

describe('SCR-S-51 Rentals', () => {
  it('DEC-016: opens from the Schedule navigation turned off by default, naming DEC-016 and DEC-076, with existing rentals still listed', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes(), 'GET /me/permissions': permissions(false) },
    });
    render(app.at('/schedule/calendar'));
    const nav = await screen.findByRole('navigation', { name: 'Schedule sections' });
    await user.click(within(nav).getByRole('link', { name: 'Rentals' }));
    const pageEl = await screen.findByTestId('package-g-rentals');
    expect(pageEl).toHaveAccessibleName('Rentals');
    const off = await within(pageEl).findByTestId('state-turned-off');
    expect(off).toHaveTextContent('Rentals turned off');
    expect(off).toHaveTextContent('(DEC-016, DEC-076)');
    expect(off).toHaveTextContent('Existing rentals stay listed');
    const list = await within(pageEl).findByRole('list', { name: 'Rental bookings' });
    expect(within(list).getByRole('link', { name: 'Pitch 1 hourly rental' })).toHaveAttribute(
      'href',
      DETAIL,
    );
  });

  it('shows the permissions read error with its code and "Try again", then the rentals; a refused read is not available', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-g' }))
            : fakeResponse(200, fakePermissions({ enabled: ['rentals'], actions: STAFF_ACTIONS }));
        },
      }),
    });
    const { unmount } = render(app.at('/schedule/rentals'));
    const pageEl = await screen.findByTestId('package-g-rentals');
    expect(
      await within(pageEl).findByText('Error code: INTEGRATION_UNAVAILABLE. Reference: c-g'),
    ).toBeInTheDocument();
    await user.click(within(pageEl).getByRole('button', { name: 'Try again' }));
    expect(
      await within(pageEl).findByRole('list', { name: 'Rental bookings' }),
    ).toBeInTheDocument();
    unmount();

    const refused = createTestApp({
      routes: routes({
        'GET /me/permissions': { status: 403, body: apiErrorBody('ACCESS_DENIED') },
      }),
    });
    render(refused.at('/schedule/rentals'));
    const refusedPage = await screen.findByTestId('package-g-rentals');
    expect(await within(refusedPage).findByTestId('state-unavailable')).toHaveTextContent(
      'Not available',
    );
    expect(within(refusedPage).queryByRole('list', { name: 'Rental bookings' })).toBeNull();
  });

  it('SPK-COND-003: lists only rentals with the booker, facility-zone times, state and what is outstanding', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /bookings': page([booking(), partyBooking()], 'cursor-2'),
      }),
    });
    render(app.at('/schedule/rentals'));
    const list = await screen.findByRole('list', { name: 'Rental bookings' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(within(row).getByText(/18:00 to 19:00 PST/)).toBeInTheDocument();
    expect(await within(row).findByText('Booked for Rosa Diaz')).toBeInTheDocument();
    expect(within(row).getByText('requested')).toBeInTheDocument();
    expect(within(row).getByText('Outstanding: approval')).toBeInTheDocument();
    expect(screen.queryByText('Birthday party package')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load more bookings' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'held');
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/bookings' && r.query.status === 'held'),
      ).toBe(true),
    );
  });

  it('says when the loaded pages hold no rentals and offers Load more', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /bookings': page([partyBooking()], 'cursor-2') }),
    });
    render(app.at('/schedule/rentals'));
    expect(await screen.findByText('No rentals on the pages loaded so far')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more bookings' })).toBeInTheDocument();
  });

  it('shows the bookings read error with its code and Try again', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'GET /bookings': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(503, {
                code: 'INTEGRATION_UNAVAILABLE',
                message: 'Down',
                correlationId: 'c-b',
                nextAction: 'retry_later',
              })
            : fakeResponse(200, { items: [booking()], nextCursor: null });
        },
      }),
    });
    render(app.at('/schedule/rentals'));
    expect(
      await screen.findByText('Error code: INTEGRATION_UNAVAILABLE. Reference: c-b'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Rental bookings' })).toBeInTheDocument();
  });

  it('SPK-REG-007: approves a request with the expected revision and one idempotency key, then reads it again', async () => {
    const user = userEvent.setup();
    let approved = false;
    const app = createTestApp({
      routes: routes({
        'GET /bookings/{id}': () =>
          fakeResponse(
            200,
            approved
              ? booking({ status: 'held', outstanding: ['payment'], basketId: 'b-1', revision: 4 })
              : booking(),
          ),
        'POST /bookings/{id}/approve': () => {
          approved = true;
          return fakeResponse(
            200,
            booking({ status: 'held', outstanding: ['payment'], revision: 4 }),
          );
        },
      }),
    });
    render(app.at(DETAIL));
    const decision = await screen.findByRole('group', { name: 'Approve the rental' });
    expect(screen.getByTestId('state-pending-decision')).toHaveTextContent('DEC-029, DEC-030');
    await user.click(within(decision).getByRole('button', { name: 'Approve the rental' }));
    expect(await screen.findByText('Approved: now held')).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/bookings/{id}/approve');
    expect(call?.body).toEqual({ expectedRevision: 3 });
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Continue to checkout in assisted registration' }),
      ).toHaveAttribute('href', '/registrations/assisted/b-1'),
    );
  });

  it('RESOURCE_CONFLICT: a slot taken before approval keeps the request requested and offers Reload', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const app = createTestApp({
      routes: routes({
        'GET /bookings/{id}': () => {
          reads += 1;
          return fakeResponse(200, booking());
        },
        'POST /bookings/{id}/approve': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'The requested time is not free.',
          nextAction: 'resolve_conflict',
          details: {
            conflicts: [{ occurrenceStart: '2026-11-02T02:00:00.000Z', resourceId: RESOURCE_A }],
          },
        }),
      }),
    });
    render(app.at(DETAIL));
    const decision = await screen.findByRole('group', { name: 'Approve the rental' });
    await user.click(within(decision).getByRole('button', { name: 'Approve the rental' }));
    expect(
      await within(decision).findByText('Error code: RESOURCE_CONFLICT. Reference: corr-pg-1'),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText('Nothing was reserved: the booking is still requested.'),
    ).toBeInTheDocument();
    expect(
      within(within(decision).getByRole('list', { name: 'Conflicting times' })).getByText(
        /18:00 PST: Pitch 1 is not free/,
      ),
    ).toBeInTheDocument();
    const before = reads;
    await user.click(within(decision).getByRole('button', { name: 'Reload the booking' }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    expect(screen.getAllByText('requested').length).toBeGreaterThan(0);
  });

  it('CAPABILITY_DISABLED: an approval refused because rentals were turned off reads turned off, not a failure', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /bookings/{id}/approve': {
          status: 403,
          body: capabilityDisabledBody('rentals', ['DEC-016', 'DEC-076']),
        },
      }),
    });
    render(app.at(DETAIL));
    const decision = await screen.findByRole('group', { name: 'Approve the rental' });
    await user.click(within(decision).getByRole('button', { name: 'Approve the rental' }));
    const off = await within(decision).findByTestId('state-turned-off');
    expect(off).toHaveTextContent('Rentals turned off');
    expect(off).toHaveTextContent('ACCESS_DENIED (CAPABILITY_DISABLED)');
  });

  it('declines only with a reason, sending it with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /bookings/{id}/decline': ok(
          booking({ status: 'declined', outstanding: [], revision: 4 }),
        ),
      }),
    });
    render(app.at(DETAIL));
    await user.click(await screen.findByRole('button', { name: 'Decline the request…' }));
    const form = screen.getByRole('form', { name: 'Decline the rental request' });
    await user.click(within(form).getByRole('button', { name: 'Decline the request' }));
    expect(within(form).getByText(/A reason is required/)).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/bookings/{id}/decline')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason for declining/), 'Pitch resurfacing');
    await user.click(within(form).getByRole('button', { name: 'Decline the request' }));
    expect(await screen.findByText('Declined: now declined')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/bookings/{id}/decline')?.body).toEqual({
      reason: 'Pitch resurfacing',
      expectedRevision: 3,
    });
  });

  it('while rentals are off, approval is not offered but declining and canceling stay available', async () => {
    const app = createTestApp({ routes: routes({ 'GET /me/permissions': permissions(false) }) });
    render(app.at(DETAIL));
    expect(await screen.findByText(/Approving needs rentals turned on/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve the rental' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Decline the request…' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Cancel the rental' })).toBeInTheDocument();
  });

  it('permission restriction: without enrollment.decide_booking approval reads not available to you', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': permissions(true, [
          'enrollment.read_booking',
          'enrollment.request_booking',
        ]),
      }),
    });
    render(app.at(DETAIL));
    const denied = await screen.findByText(/Approving rentals is not available to you/);
    expect(denied).toHaveTextContent('enrollment.decide_booking');
    expect(screen.queryByRole('button', { name: 'Decline the request…' })).toBeNull();
  });

  it('§4.10: a booking the API does not show is "not available", never implying it exists', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /bookings/{id}': apiError(404, 'NOT_FOUND') }),
    });
    render(app.at(DETAIL));
    const pageEl = await screen.findByTestId('package-g-rentals');
    expect(await within(pageEl).findByTestId('state-unavailable')).toHaveTextContent(
      'Not available',
    );
    expect(within(pageEl).queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('a malformed link is "Link not available" without any read', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/schedule/rentals/not-an-id'));
    expect(await screen.findByText('Link not available')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/bookings/{id}')).toBe(false);
  });

  it('a party opened under Rentals links to Parties', async () => {
    const app = createTestApp({ routes: routes({ 'GET /bookings/{id}': ok(partyBooking()) }) });
    render(app.at(`/schedule/rentals/${PARTY_BOOKING_ID}`));
    expect(await screen.findByRole('link', { name: 'open it under parties' })).toHaveAttribute(
      'href',
      `/schedule/parties/${PARTY_BOOKING_ID}`,
    );
  });

  it('offline: approving, declining and canceling need a connection', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(DETAIL));
    const decision = await screen.findByRole('group', { name: 'Approve the rental' });
    act(() => app.connectivity.set(false));
    await waitFor(() =>
      expect(within(decision).getByRole('button', { name: 'Approve the rental' })).toBeDisabled(),
    );
    expect(within(decision).getByText('Approving needs a connection.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel the rental' })).toBeDisabled();
  });

  it('POL-040: shows the offerings with their approved terms and definitions read-only, and what stays pending', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /offerings': page([offering()]) }),
    });
    render(app.at('/schedule/rentals/offerings'));
    const list = await screen.findByRole('list', { name: 'Rental offerings' });
    expect(
      await within(list).findByText(/By request: nothing is reserved until staff approve/),
    ).toBeInTheDocument();
    expect(
      within(list).getByText(
        /Deposit: the first installment of the approved installment policy “pol-005-deposit”/,
      ),
    ).toBeInTheDocument();
    expect(within(list).getByText('15 minutes')).toBeInTheDocument();
    expect(within(list).getByText("The reserved resources' own buffer")).toBeInTheDocument();
    expect(await within(list).findByText(/1 of/)).toBeInTheDocument();
    expect(within(list).getByText('No staff required by the definition')).toBeInTheDocument();
    expect(within(list).getByText('Price: Not priced')).toBeInTheDocument();
    expect(screen.getByTestId('state-pending-decision')).toHaveTextContent(
      'POL-040, DEC-029, DEC-030',
    );
    expect(screen.queryByRole('button', { name: /Save|Edit|Approve/ })).toBeNull();
  });

  it('SPK-REG-001: books a rental for a customer from the free times, reserving exactly the offering’s resources', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /offerings': page([offering()]),
        'GET /people': page([
          {
            id: BOOKER_ID,
            givenName: 'Rosa',
            familyName: 'Diaz',
            kind: 'adult',
            status: 'active',
            matchedOn: 'name',
          },
        ]),
        'GET /offerings/{id}/booking-availability': ok({
          offeringId: offering().id,
          timezone: 'America/Los_Angeles',
          durationMinutes: 60,
          resourceCount: 1,
          resources: [
            {
              resourceId: RESOURCE_A,
              name: 'Pitch 1',
              freeIntervals: [
                { start: '2026-11-03T02:00:00.000Z', end: '2026-11-03T03:00:00.000Z' },
              ],
            },
            {
              resourceId: RESOURCE_B,
              name: 'Pitch 2',
              freeIntervals: [
                { start: '2026-11-03T02:00:00.000Z', end: '2026-11-03T03:00:00.000Z' },
              ],
            },
          ],
        }),
        'POST /bookings': { status: 201, body: booking({ status: 'requested' }) },
      }),
    });
    render(app.at('/schedule/rentals/new'));
    const form = await screen.findByRole('form', { name: 'New rental' });
    await user.selectOptions(within(form).getByLabelText(/^Offering/), offering().id);
    expect(
      await within(form).findByText(/By request: nothing is reserved until staff approve/),
    ).toBeInTheDocument();
    await user.type(
      within(form).getByLabelText('Booked for: name or exact email or phone'),
      'Rosa',
    );
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    await user.click(await within(form).findByRole('button', { name: 'Choose Rosa Diaz' }));
    fireEvent.change(within(form).getByLabelText(/^Date \(America\/Los_Angeles\)/), {
      target: { value: '2026-11-02' },
    });
    await user.type(within(form).getByLabelText(/^Length in minutes/), '60');
    const start = await within(form).findByRole('radio', { name: '18:00' });
    await user.click(start);
    await user.click(within(form).getByRole('button', { name: 'Book the rental' }));
    expect(await within(form).findByText('Choose exactly 1 resource.')).toBeInTheDocument();
    await user.click(within(form).getByRole('checkbox', { name: 'Pitch 2' }));
    await user.click(within(form).getByRole('button', { name: 'Book the rental' }));
    expect(await screen.findByText(/Now requested: Waiting for approval/)).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/bookings');
    expect(call?.body).toEqual({
      offeringId: offering().id,
      bookerPersonId: BOOKER_ID,
      start: '2026-11-03T02:00:00.000Z',
      end: '2026-11-03T03:00:00.000Z',
      resourceIds: [RESOURCE_B],
    });
    const availability = app.fake.requests.find(
      (r) => r.route === '/offerings/{id}/booking-availability',
    );
    expect(availability?.query).toMatchObject({
      from: '2026-11-02T08:00:00.000Z',
      to: '2026-11-03T08:00:00.000Z',
      durationMinutes: '60',
    });
    expect(screen.getByRole('link', { name: 'Open the rental' })).toHaveAttribute('href', DETAIL);
  });

  it('a weekly rental needs its repetition chosen (nothing preset); a later week already taken lists the conflict', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /offerings': page([offering()]),
        'GET /people': page([
          {
            id: BOOKER_ID,
            givenName: 'Rosa',
            familyName: 'Diaz',
            kind: 'adult',
            status: 'active',
            matchedOn: 'name',
          },
        ]),
        'GET /offerings/{id}/booking-availability': ok({
          offeringId: offering().id,
          timezone: 'America/Los_Angeles',
          durationMinutes: 60,
          resourceCount: 1,
          resources: [
            {
              resourceId: RESOURCE_A,
              name: 'Pitch 1',
              freeIntervals: [
                { start: '2026-11-03T02:00:00.000Z', end: '2026-11-03T03:00:00.000Z' },
              ],
            },
          ],
        }),
        'POST /bookings': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'The requested time is not free.',
          nextAction: 'resolve_conflict',
          details: {
            conflicts: [{ occurrenceStart: '2026-11-17T02:00:00.000Z', resourceId: RESOURCE_A }],
          },
        }),
      }),
    });
    render(app.at('/schedule/rentals/new'));
    const form = await screen.findByRole('form', { name: 'New rental' });
    await user.selectOptions(within(form).getByLabelText(/^Offering/), offering().id);
    await user.type(
      within(form).getByLabelText('Booked for: name or exact email or phone'),
      'Rosa',
    );
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    await user.click(await within(form).findByRole('button', { name: 'Choose Rosa Diaz' }));
    fireEvent.change(within(form).getByLabelText(/^Date \(America\/Los_Angeles\)/), {
      target: { value: '2026-11-02' },
    });
    await user.type(within(form).getByLabelText(/^Length in minutes/), '60');
    await user.click(await within(form).findByRole('radio', { name: '18:00' }));
    // The only free resource is preselected because the offering needs exactly one.
    expect(within(form).getByRole('checkbox', { name: 'Pitch 1' })).toBeChecked();
    await user.click(within(form).getByLabelText('Repeat weekly on Mondays'));
    expect(within(form).getByLabelText(/^How often/)).toHaveValue('');
    await user.click(within(form).getByRole('button', { name: 'Book the rental' }));
    expect(within(form).getByText('Choose how often it repeats.')).toBeInTheDocument();
    expect(within(form).getByText('Enter 2 to 52 occurrences.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.method === 'POST' && r.route === '/bookings')).toBe(
      false,
    );
    await user.selectOptions(within(form).getByLabelText(/^How often/), '1');
    await user.type(within(form).getByLabelText(/^Number of occurrences/), '6');
    await user.click(within(form).getByRole('button', { name: 'Book the rental' }));
    const conflicts = await within(form).findByRole('list', { name: 'Conflicting times' });
    expect(
      within(conflicts).getByText(/Mon, Nov 16, 18:00 PST: Pitch 1 is not free/),
    ).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.method === 'POST' && r.route === '/bookings')?.body,
    ).toMatchObject({
      recurrence: { interval: 1, count: 6 },
      resourceIds: [RESOURCE_A],
    });
    expect(
      within(form).getByRole('button', { name: 'Check free times again' }),
    ).toBeInTheDocument();
  });

  it('new rentals are not offered while rentals are turned off', async () => {
    const app = createTestApp({ routes: routes({ 'GET /me/permissions': permissions(false) }) });
    render(app.at('/schedule/rentals/new'));
    expect(
      await screen.findByText(/New rentals are not taken while rentals are turned off/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New rental' })).toBeNull();
  });
});
