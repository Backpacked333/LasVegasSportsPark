/**
 * SCR-S-52 Parties (Package G; SPK-COND-003, SPK-REG-010, ENR-03, ENR-13, DEC-016, DEC-077): the
 * staffing state (a paid party is awaiting_staff until its host accepts, never "confirmed"), the
 * cancellation of a paid party with the previewed consequence bound to the command
 * (acceptedConsequence, CONSEQUENCE_CHANGED and Preview again), a held party whose checkout is in
 * progress (no cancellation offered, the outcome never assumed), the party package's definition
 * read-only (length, guest limit, equipment, host), and booking a party with its guests.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../../testing/test-app';
import {
  BASKET_ID,
  BOOKER_ID,
  ENROLLMENT_ID,
  PARTY_BOOKING_ID,
  PARTY_DEFINITION_ID,
  PARTY_OFFERING_ID,
  RESOURCE_A,
  apiError,
  booking,
  bookingTerms,
  catalogRoutes,
  offering,
  ok,
  page,
  partyBooking,
} from '../../participation/__tests__/fixtures';

const ACTIONS = [
  'enrollment.read_booking',
  'enrollment.request_booking',
  'enrollment.decide_booking',
];

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...catalogRoutes(),
    'GET /me/permissions': mePermissions({ enabled: ['parties'], actions: ACTIONS }),
    'GET /bookings': page([booking(), partyBooking()]),
    'GET /bookings/{id}': ok(partyBooking()),
    'GET /policy-versions/{id}': ok(
      bookingTerms(
        { key: 'pol-040-parties', title: 'Party terms' },
        {
          confirmationMode: 'instant',
          installmentPolicyKey: null,
          hostResponsibilities: 'The host runs games and serves cake.',
        },
      ),
    ),
    ...extra,
  };
}

const DETAIL = `/schedule/parties/${PARTY_BOOKING_ID}`;

function preview(kind: 'refund' | 'none' = 'refund', amountMinor: number | null = 15000) {
  return {
    enrollmentId: ENROLLMENT_ID,
    status: 'confirmed',
    existing: {
      offeringId: PARTY_OFFERING_ID,
      offeringName: 'Birthday party package',
      startsOn: '2026-09-01',
      endsOn: '2027-08-31',
      entitlementDefinitionId: PARTY_DEFINITION_ID,
      price: null,
    },
    affectedDates: { startsOn: '2026-11-01', endsOn: '2026-11-01' },
    capacity: { released: [] },
    cancellationPolicyVersionId: null,
    financialConsequence: {
      kind,
      amountMinor: kind === 'none' ? null : amountMinor,
      currency: kind === 'none' ? null : 'USD',
      explanation:
        kind === 'none'
          ? 'Nothing is refunded or charged.'
          : 'Refund of the deposit less the booking fee.',
      policyVersionId: null,
    },
    requiredApproval: false,
    permitted: true,
  };
}

describe('SCR-S-52 Parties', () => {
  it('DEC-016: opens from the Schedule navigation turned off by default, naming DEC-016 and DEC-077', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: { ...routes(), 'GET /me/permissions': mePermissions() } });
    render(app.at('/schedule/calendar'));
    const nav = await screen.findByRole('navigation', { name: 'Schedule sections' });
    await user.click(within(nav).getByRole('link', { name: 'Parties' }));
    const pageEl = await screen.findByTestId('package-g-parties');
    expect(pageEl).toHaveAccessibleName('Parties');
    const off = await within(pageEl).findByTestId('state-turned-off');
    expect(off).toHaveTextContent('Parties turned off');
    expect(off).toHaveTextContent('(DEC-016, DEC-077)');
    const list = await within(pageEl).findByRole('list', { name: 'Party bookings' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('awaiting_staff')).toBeInTheDocument();
    expect(within(list).getByText(/12 guests/)).toBeInTheDocument();
  });

  it('SPK-COND-003: a paid party waits for its host and is never shown as confirmed', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /enrollments/{id}/cancellation-preview': ok(preview()) }),
    });
    render(app.at(DETAIL));
    const staffing = await screen.findByRole('group', { name: 'Staffing' });
    expect(within(staffing).getByText('Waiting for staff')).toBeInTheDocument();
    expect(within(staffing).getByText(/including the host/)).toBeInTheDocument();
    expect(
      within(staffing).getByRole('link', { name: 'Staff assignments and coverage' }),
    ).toHaveAttribute('href', '/staff');
    expect(screen.getByText('Waiting for staff acceptance')).toBeInTheDocument();
    expect(screen.queryByText('confirmed', { selector: '.badge-label' })).toBeNull();
    const facts = screen.getByLabelText('Party booking');
    expect(await within(facts).findByText('Bouncy castle')).toBeInTheDocument();
    expect(within(facts).getByText('The host runs games and serves cake.')).toBeInTheDocument();
    expect(within(facts).getByText('12')).toBeInTheDocument();
    // The package's definition, read-only: length, guest limit and the host it needs.
    expect(await screen.findByText('120 minutes')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(
      screen.getByText('Supervisor: 1 party host (qualifications: first aid)'),
    ).toBeInTheDocument();
  });

  it('ENR-03: cancels a paid party only after the customer accepts the previewed consequence, which is sent with it', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}/cancellation-preview': ok(preview()),
        'POST /bookings/{id}/cancel': ok(
          partyBooking({ status: 'canceled', outstanding: [], revision: 4 }),
        ),
      }),
    });
    render(app.at(DETAIL));
    const consequence = await screen.findByRole('group', { name: 'Financial consequence' });
    expect(within(consequence).getByText('Refund')).toBeInTheDocument();
    expect(within(consequence).getByText(/\$150\.00/)).toBeInTheDocument();
    expect(within(consequence).getByText(/pending DEC-009 and DEC-030/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Cancel the party' });
    const submit = within(form).getByRole('button', { name: 'Cancel the party' });
    expect(submit).toBeDisabled();
    await user.type(within(form).getByLabelText(/^Reason for canceling/), 'Family emergency');
    await user.click(
      within(form).getByLabelText('The customer accepted the financial consequence shown'),
    );
    await user.click(submit);
    expect(await screen.findByText('Canceled: now canceled')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/bookings/{id}/cancel')?.body).toEqual({
      reason: 'Family emergency',
      expectedRevision: 3,
      acceptedConsequence: { kind: 'refund', amountMinor: 15000, currency: 'USD' },
    });
  });

  it('CONSEQUENCE_CHANGED: shows the code, keeps the reason and previews again before a new acceptance', async () => {
    const user = userEvent.setup();
    let previews = 0;
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}/cancellation-preview': () => {
          previews += 1;
          return fakeResponse(200, preview('refund', previews === 1 ? 15000 : 10000));
        },
        'POST /bookings/{id}/cancel': apiError(409, 'RESOURCE_CONFLICT', {
          message:
            'The financial consequence changed since it was previewed; review and accept it again.',
          nextAction: 'reload_current_state',
          details: {
            code: 'CONSEQUENCE_CHANGED',
            consequence: { kind: 'refund', amountMinor: 10000, currency: 'USD' },
          },
        }),
      }),
    });
    render(app.at(DETAIL));
    const form = await screen.findByRole('form', { name: 'Cancel the party' });
    await user.type(within(form).getByLabelText(/^Reason for canceling/), 'Family emergency');
    await user.click(
      within(form).getByLabelText('The customer accepted the financial consequence shown'),
    );
    await user.click(within(form).getByRole('button', { name: 'Cancel the party' }));
    expect(
      await within(form).findByText('Error code: RESOURCE_CONFLICT. Reference: corr-pg-1'),
    ).toBeInTheDocument();
    expect(
      within(form).getByText(/Preview it again and confirm the customer accepts it/),
    ).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Preview again' }));
    const consequence = await screen.findByRole('group', { name: 'Financial consequence' });
    await waitFor(() => expect(within(consequence).getByText(/\$100\.00/)).toBeInTheDocument());
    const again = screen.getByRole('form', { name: 'Cancel the party' });
    expect(within(again).getByLabelText(/^Reason for canceling/)).toHaveValue('Family emergency');
    expect(
      within(again).getByLabelText('The customer accepted the financial consequence shown'),
    ).not.toBeChecked();
    expect(within(again).getByRole('button', { name: 'Cancel the party' })).toBeDisabled();
  });

  it('a held party whose checkout is in progress offers no cancellation and never assumes the payment outcome', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /bookings/{id}': ok(
          partyBooking({
            status: 'held',
            outstanding: ['payment', 'staffing'],
            enrollmentId: null,
          }),
        ),
        'GET /baskets/{id}': ok({ id: BASKET_ID, status: 'checking_out' }),
      }),
    });
    render(app.at(DETAIL));
    const inProgress = await screen.findByRole('group', { name: 'Checkout in progress' });
    expect(within(inProgress).getByText(/A payment may be on its way/)).toBeInTheDocument();
    expect(
      within(inProgress).getByRole('link', { name: 'Open the checkout in assisted registration' }),
    ).toHaveAttribute('href', `/registrations/assisted/${BASKET_ID}`);
    expect(screen.queryByRole('form', { name: 'Cancel the party' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Payment' })).toHaveTextContent(
      'until the checkout confirms it, it is not paid',
    );
    expect(screen.getByRole('group', { name: 'Staffing' })).toHaveTextContent(
      'Staff not yet accepted',
    );
  });

  it('a held party with an open basket can be canceled, releasing the hold', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /bookings/{id}': ok(
          partyBooking({ status: 'held', outstanding: ['payment'], enrollmentId: null }),
        ),
        'GET /baskets/{id}': ok({ id: BASKET_ID, status: 'held' }),
        'POST /bookings/{id}/cancel': ok(partyBooking({ status: 'canceled', outstanding: [] })),
      }),
    });
    render(app.at(DETAIL));
    expect(
      await screen.findByText(/Nothing has been paid. Canceling releases the reservation/),
    ).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Cancel the party' });
    await user.type(within(form).getByLabelText(/^Reason for canceling/), 'Changed plans');
    await user.click(within(form).getByRole('button', { name: 'Cancel the party' }));
    expect(await screen.findByText('Canceled: now canceled')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/bookings/{id}/cancel')?.body).toEqual({
      reason: 'Changed plans',
      expectedRevision: 3,
    });
  });

  it('books a party for a customer with its guests; the length is the package’s', async () => {
    const user = userEvent.setup();
    const partyOffering = offering({
      id: PARTY_OFFERING_ID,
      kind: 'party',
      name: 'Birthday party package',
      entitlementDefinitionId: PARTY_DEFINITION_ID,
    });
    const app = createTestApp({
      routes: routes({
        'GET /offerings': page([partyOffering]),
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
          offeringId: PARTY_OFFERING_ID,
          timezone: 'America/Los_Angeles',
          durationMinutes: 120,
          resourceCount: 1,
          resources: [
            {
              resourceId: RESOURCE_A,
              name: 'Party room',
              freeIntervals: [
                { start: '2026-11-07T18:00:00.000Z', end: '2026-11-07T20:00:00.000Z' },
              ],
            },
          ],
        }),
        'POST /bookings': {
          status: 201,
          body: partyBooking({
            status: 'held',
            outstanding: ['payment', 'staffing'],
            enrollmentId: null,
          }),
        },
      }),
    });
    render(app.at('/schedule/parties/new'));
    const form = await screen.findByRole('form', { name: 'New party' });
    expect(within(form).queryByLabelText(/^Length in minutes/)).toBeNull();
    await user.selectOptions(within(form).getByLabelText(/^Offering/), PARTY_OFFERING_ID);
    expect(
      await within(form).findByText(
        /Confirmed at once: the booking is reserved and held for payment/,
      ),
    ).toBeInTheDocument();
    expect(within(form).getByText('No deposit: charged in full at checkout.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Booked for: name or exact email or phone'), 'Ro');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    await user.click(await within(form).findByRole('button', { name: 'Choose Rosa Diaz' }));
    fireEvent.change(within(form).getByLabelText(/^Date \(America\/Los_Angeles\)/), {
      target: { value: '2026-11-07' },
    });
    await user.click(await within(form).findByRole('radio', { name: '10:00' }));
    expect(within(form).getByRole('checkbox', { name: 'Party room' })).toBeChecked();
    await user.click(within(form).getByRole('button', { name: 'Book the party' }));
    expect(await within(form).findByText('Enter the number of guests.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Guests/), '12');
    await user.click(within(form).getByRole('button', { name: 'Book the party' }));
    expect(await screen.findByText(/Now held: Reserved and held for payment/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Continue to checkout in assisted registration' }),
    ).toHaveAttribute('href', `/registrations/assisted/${BASKET_ID}`);
    const call = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/bookings');
    expect(call?.body).toEqual({
      offeringId: PARTY_OFFERING_ID,
      bookerPersonId: BOOKER_ID,
      start: '2026-11-07T18:00:00.000Z',
      resourceIds: [RESOURCE_A],
      guestCount: 12,
    });
    const availability = app.fake.requests.find(
      (r) => r.route === '/offerings/{id}/booking-availability',
    );
    expect(availability?.query.durationMinutes).toBeUndefined();
  });

  it('a guest count over the package limit shows the API’s answer at the field', async () => {
    const user = userEvent.setup();
    const partyOffering = offering({
      id: PARTY_OFFERING_ID,
      kind: 'party',
      name: 'Birthday party package',
      entitlementDefinitionId: PARTY_DEFINITION_ID,
    });
    const app = createTestApp({
      routes: routes({
        'GET /offerings': page([partyOffering]),
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
          offeringId: PARTY_OFFERING_ID,
          timezone: 'America/Los_Angeles',
          durationMinutes: 120,
          resourceCount: 1,
          resources: [
            {
              resourceId: RESOURCE_A,
              name: 'Party room',
              freeIntervals: [
                { start: '2026-11-07T18:00:00.000Z', end: '2026-11-07T20:00:00.000Z' },
              ],
            },
          ],
        }),
        'POST /bookings': apiError(400, 'VALIDATION_FAILED', {
          message: 'This package takes at most 20 guests.',
          nextAction: 'correct_input',
          details: { path: 'guestCount', code: 'GUEST_LIMIT_EXCEEDED' },
        }),
      }),
    });
    render(app.at('/schedule/parties/new'));
    const form = await screen.findByRole('form', { name: 'New party' });
    await user.selectOptions(within(form).getByLabelText(/^Offering/), PARTY_OFFERING_ID);
    await user.type(within(form).getByLabelText('Booked for: name or exact email or phone'), 'Ro');
    await user.click(within(form).getByRole('button', { name: 'Search' }));
    await user.click(await within(form).findByRole('button', { name: 'Choose Rosa Diaz' }));
    fireEvent.change(within(form).getByLabelText(/^Date \(America\/Los_Angeles\)/), {
      target: { value: '2026-11-07' },
    });
    await user.click(await within(form).findByRole('radio', { name: '10:00' }));
    await user.type(within(form).getByLabelText(/^Guests/), '30');
    await user.click(within(form).getByRole('button', { name: 'Book the party' }));
    expect(
      await within(form).findByText('Error code: VALIDATION_FAILED. Reference: corr-pg-1'),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Guests/)).toHaveAttribute('aria-invalid', 'true');
    expect(
      within(form).getAllByText('This package takes at most 20 guests.').length,
    ).toBeGreaterThan(0);
  });
});
