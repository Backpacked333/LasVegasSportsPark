/**
 * SCR-S-25 assisted registration (SPK-REG-009, SPK-REG-004, SPK-REG-006, SPK-PAY-001,
 * SPK-PAY-002, SPK-PAY-007, SPK-PAY-012, DEC-009, DEC-019): the customer's own basket, hold,
 * quote and checkout commands, the staff actor kept apart, no guardian signature by staff, cash
 * with evidence, card payment pending, QUOTE_EXPIRED and PAYMENT_OUTCOME_UNKNOWN handled.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';
import {
  ADULT_ID,
  BASKET_ID,
  ENROLLMENT_ID,
  OFFERING_ID,
  PAYMENT_ID,
  PERSON_ID,
  PROGRAM_ID,
  QUOTE_ID,
  apiError,
  basket,
  checkout,
  hold,
  nameRoutes,
  offering,
  ok,
  program,
  quote,
} from '../../../features/registration-finance/__tests__/fixtures';

const HELD = basket({ status: 'held', holds: [hold()], holdExpiresAt: '2026-10-24T12:10:00.000Z' });

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...nameRoutes(),
    'GET /baskets/{id}': ok(basket()),
    'GET /programs': ok({ items: [program()], nextCursor: null }),
    'GET /programs/{id}/offerings': ok({ items: [offering()], nextCursor: null }),
    ...extra,
  };
}

describe('SCR-S-25 AssistedRegistrationScreen', () => {
  it('SPK-REG-009: starts an all-or-nothing basket for the named household adult', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes({ 'POST /baskets': ok(basket(), 201) }) });
    render(app.at('/registrations/assisted'));
    await user.type(await screen.findByLabelText(/^Household adult/), ADULT_ID);
    expect(await screen.findByText('Sam Rivera')).toBeInTheDocument();
    expect(screen.getByText(/pending DEC-026/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start basket' }));
    expect(await screen.findByRole('list', { name: 'Basket lines' })).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.method === 'POST' && r.route === '/baskets');
    expect(post?.body).toEqual({
      ownerPersonId: ADULT_ID,
      fulfillmentMode: 'all_or_nothing',
      acceptPartialFulfillment: false,
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('shows each line with its own participant, eligibility, price and forms, and never signs for a guardian', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    const lines = await screen.findByRole('list', { name: 'Basket lines' });
    const line = within(lines).getAllByRole('listitem')[0]!;
    expect(await within(line).findByText('Alex Rivera')).toBeInTheDocument();
    expect(within(line).getByText(/price \$125\.00/)).toBeInTheDocument();
    expect(within(line).getByText('Eligible')).toBeInTheDocument();
    expect(
      within(line).getByText(/Staff never sign a guardian acknowledgment/),
    ).toBeInTheDocument();
    const facts = screen.getByLabelText('Basket');
    expect(within(facts).getByText('Front desk 1 (staff)')).toBeInTheDocument();
    // Household adult and payer (the adult, as no other payer is named).
    expect(await within(facts).findAllByText('Sam Rivera')).toHaveLength(2);
  });

  it('adds a line through the same command customers use, then holds the places', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /baskets/{id}/lines': ok(basket(), 201),
        'POST /baskets/{id}/hold': ok(HELD),
      }),
    });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    const form = await screen.findByRole('form', { name: 'Add a participant and offering' });
    const f = within(form);
    await user.type(f.getByLabelText(/^Participant/), PERSON_ID);
    await user.selectOptions(f.getByLabelText(/^Registration intent/), 'youth');
    await waitFor(() =>
      expect(f.getByRole('option', { name: 'Spring academy' })).toBeInTheDocument(),
    );
    await user.selectOptions(f.getByLabelText('Offering: program'), PROGRAM_ID);
    await waitFor(() =>
      expect(f.getByRole('option', { name: /Spring academy U10/ })).toBeInTheDocument(),
    );
    await user.selectOptions(f.getByLabelText('Offering: offering'), OFFERING_ID);
    await user.click(f.getByRole('button', { name: 'Add to basket' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/baskets/{id}/lines')?.body).toEqual({
        participantPersonId: PERSON_ID,
        offeringId: OFFERING_ID,
        intent: 'youth',
        quantity: 1,
        expectedRevision: 2,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Hold the places' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/hold')).toBe(true),
    );
  });

  it('SPK-PAY-002: prices the held basket, records cash with evidence and links the enrollment', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /baskets/{id}': ok(HELD),
        'POST /registration-quotes': ok(quote(), 201),
        'POST /registration-checkouts': ok(checkout(), 201),
      }),
    });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    expect(await screen.findByRole('list', { name: 'Capacity holds' })).toBeInTheDocument();
    expect(screen.getByText(/server-owned; any countdown is informational/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Price the basket' }));
    const quoteGroup = await screen.findByRole('group', { name: 'Quote' });
    expect(within(quoteGroup).getByText(/valid until/)).toBeInTheDocument();
    const totals = within(quoteGroup).getByLabelText('Quote totals');
    const dueNow = within(totals).getByText('Due now').closest('div') as HTMLElement;
    expect(within(dueNow).getByText('$125.00')).toBeInTheDocument();
    expect(within(quoteGroup).getByText(/Engineering defaults applied/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/registration-quotes')?.body).toEqual({
      basketId: BASKET_ID,
      discountCodes: [],
      creditIds: [],
      paymentPlan: { kind: 'full' },
    });

    const pay = screen.getByRole('form', { name: 'Take payment' });
    await user.selectOptions(within(pay).getByLabelText(/^Payment method/), 'provider');
    expect(within(pay).getByText(/depends on DEC-019/)).toBeInTheDocument();
    expect(
      within(pay).getByRole('button', { name: 'Record payment and check out' }),
    ).toBeDisabled();
    await user.selectOptions(within(pay).getByLabelText(/^Payment method/), 'cash');
    expect(within(pay).getByText(/depends on DEC-009/)).toBeInTheDocument();
    await user.selectOptions(await within(pay).findByLabelText(/^Facility/), FACILITY_A);
    await user.type(within(pay).getByLabelText(/^Evidence reference/), 'SLIP-0042');
    await user.click(within(pay).getByRole('button', { name: 'Record payment and check out' }));
    expect(await screen.findByRole('link', { name: /Enrollment 0192f1a0/ })).toHaveAttribute(
      'href',
      `/registrations/enrollments/${ENROLLMENT_ID}`,
    );
    expect(app.fake.requests.find((r) => r.route === '/registration-checkouts')?.body).toEqual({
      quoteId: QUOTE_ID,
      authorizeFutureInstallments: false,
      payment: {
        method: 'cash',
        tenderKind: 'cash',
        facilityId: FACILITY_A,
        evidence: { reference: 'SLIP-0042' },
      },
    });
  });

  it('QUOTE_EXPIRED offers a new price; PAYMENT_OUTCOME_UNKNOWN says not to take payment again', async () => {
    const user = userEvent.setup();
    let checkouts = 0;
    const app = createTestApp({
      routes: routes({
        'GET /baskets/{id}': ok(HELD),
        'POST /registration-quotes': ok(quote(), 201),
        'POST /registration-checkouts': () => {
          checkouts += 1;
          return checkouts === 1
            ? apiError(409, 'QUOTE_EXPIRED', {
                message: 'The quote has expired.',
                nextAction: 'request_new_quote',
              })()
            : apiError(409, 'PAYMENT_OUTCOME_UNKNOWN', {
                message: 'The payment outcome is not yet known.',
                nextAction: 'await_reconciliation',
                details: { paymentAttemptId: PAYMENT_ID, status: 'unknown' },
              })();
        },
      }),
    });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    await user.click(await screen.findByRole('button', { name: 'Price the basket' }));
    const pay = await screen.findByRole('form', { name: 'Take payment' });
    await user.selectOptions(within(pay).getByLabelText(/^Payment method/), 'cash');
    await user.selectOptions(await within(pay).findByLabelText(/^Facility/), FACILITY_A);
    await user.type(within(pay).getByLabelText(/^Evidence reference/), 'SLIP-0042');
    await user.click(within(pay).getByRole('button', { name: 'Record payment and check out' }));
    expect(await screen.findByText('Quote expired')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Get a new price' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/registration-quotes')).toHaveLength(2),
    );
    const first = app.fake.requests.filter((r) => r.route === '/registration-quotes');
    expect(first[0]?.headers['idempotency-key']).not.toEqual(first[1]?.headers['idempotency-key']);

    const again = await screen.findByRole('form', { name: 'Take payment' });
    await user.click(within(again).getByRole('button', { name: 'Record payment and check out' }));
    expect(
      await screen.findByText('Recovery required: payment outcome unknown'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Do not take payment again/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open the payment attempt to reconcile it' }),
    ).toHaveAttribute('href', `/finance/payments/${PAYMENT_ID}`);
  });

  it('shows a basket the viewer may not see as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /baskets/{id}': () =>
          fakeResponse(404, {
            code: 'NOT_FOUND',
            message: 'The requested basket was not found.',
            correlationId: 'c',
            nextAction: 'verify_reference',
          }),
      }),
    });
    render(app.at(`/registrations/assisted/${BASKET_ID}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hold the places' })).toBeNull();
  });
});
