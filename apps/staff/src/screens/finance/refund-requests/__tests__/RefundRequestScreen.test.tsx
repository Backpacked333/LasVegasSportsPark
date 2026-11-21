/**
 * Staff S 4b: approving a family's refund request (SPK-REG-010, SPK-PAY-008, SPK-PAY-009,
 * SPK-SUPPORT-002, §4.9 money never optimistic).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions, staffMe } from '../../../../testing/test-app';

const CASE = '0192f1a0-0000-7000-8000-00000000ca5e';
const ENROLLMENT = '0192f1a0-0000-7000-8000-00000000e001';
const PAYMENT = '0192f1a0-0000-7000-8000-00000000fa11';
const OFFERING = '0192f1a0-0000-7000-8000-0000000000f1';
const DANA = '0192f1a0-0000-7000-8000-00000000da11';
const MAYA = '0192f1a0-0000-7000-8000-00000000aa01';
const NEXT = '0192f1a0-0000-7000-8000-00000000aa02';
const ENTRY = '0192f1a0-0000-7000-8000-00000000ee01';

const request = {
  id: CASE,
  facilityId: null,
  category: 'payment',
  priority: 'normal',
  status: 'open',
  title: 'Cancel a week: Winter Break Camp · week 2',
  description: "We're travelling Dec 29 after all — can we drop week 2?",
  subject: { personId: MAYA, householdId: null, canonicalPersonId: MAYA },
  owner: null,
  relatedRecords: [
    { type: 'enrollment', id: ENROLLMENT },
    { type: 'payment_attempt', id: PAYMENT },
  ],
  origin: null,
  dueAt: null,
  overdue: false,
  resolution: null,
  resolvedAt: null,
  closedAt: null,
  openedBy: { kind: 'customer', accountId: null, personId: DANA, actorLabel: 'Dana' },
  openedVia: 'customer',
  allowedEvents: ['resolve'],
  revision: 3,
  createdAt: '2026-10-24T16:12:00.000Z',
  updatedAt: '2026-10-24T16:12:00.000Z',
  events: [],
  actions: [],
};

function preview(refundMinor: number) {
  return {
    enrollmentId: ENROLLMENT,
    status: 'confirmed',
    existing: {
      offeringId: OFFERING,
      offeringName: 'Winter Break Camp · week 2',
      startsOn: '2026-12-29',
      endsOn: '2027-01-02',
      entitlementDefinitionId: null,
      price: {
        priceRuleId: '0192f1a0-0000-7000-8000-00000000ab01',
        basePriceMinor: 11_600,
        currency: 'USD',
        chargeLines: [],
      },
    },
    affectedDates: { startsOn: '2026-12-29', endsOn: '2027-01-02' },
    capacity: { released: [] },
    cancellationPolicyVersionId: null,
    financialConsequence: {
      kind: 'refund',
      amountMinor: refundMinor,
      currency: 'USD',
      explanation: 'full refund until Dec 8',
      policyVersionId: null,
    },
    requiredApproval: false,
    permitted: true,
  };
}

function routes(options: { refundMinor?: number; roles?: string[]; refund?: boolean } = {}) {
  const names = [DANA, MAYA, NEXT].map((id, i) => ({
    personId: id,
    canonicalPersonId: id,
    givenName: ['Dana', 'Maya', 'Ava'][i],
    familyName: ['Ortiz', 'Ortiz', 'Kim'][i],
    displayName: ['Dana Ortiz', 'Maya Ortiz', 'Ava Kim'][i],
    kind: i === 0 ? 'adult' : 'child',
  }));
  const me = staffMe();
  (me.body.principal as { staffRoles: string[] }).staffRoles = options.roles ?? [
    'finance_operator',
  ];
  return {
    'GET /me': me,
    'GET /me/permissions': mePermissions({
      actions: options.refund === false ? [] : ['finance.refund', 'finance.issue_credit'],
    }),
    'GET /cases/{id}': { status: 200, body: request },
    'GET /enrollments/{id}/cancellation-preview': {
      status: 200,
      body: preview(options.refundMinor ?? 10_440),
    },
    'GET /enrollments/{id}': {
      status: 200,
      body: { id: ENROLLMENT, revision: 4, payerPersonId: DANA, status: 'confirmed' },
    },
    'GET /payments/{id}': { status: 200, body: { id: PAYMENT, status: 'succeeded' } },
    'GET /waitlist-entries': {
      status: 200,
      body: [{ id: ENTRY, participantPersonId: NEXT, status: 'waiting', position: 1 }],
    },
    'GET /person-names': { status: 200, body: { items: names } },
    'POST /enrollments/{id}/cancel': { status: 200, body: { id: ENROLLMENT } },
    'POST /cases/{id}/request-refund': { status: 201, body: { id: 'r' } },
    'POST /credits': { status: 201, body: { id: 'c' } },
    'POST /waitlist-entries/{id}/offer': { status: 201, body: { id: ENTRY } },
    'POST /cases/{id}/transition': { status: 200, body: request },
  } as NonNullable<Parameters<typeof createTestApp>[0]>['routes'];
}

describe('S 4b refund request', () => {
  it('S 4b SPK-REG-010: the amount is worked out (item, what the policy keeps, the policy) and Refund cancels, refunds through the case, offers the place and tells the family', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(`/finance/refund-requests/${CASE}`));

    expect(
      await screen.findByRole('heading', { name: 'Refund request · Dana Ortiz' }),
    ).toBeVisible();
    expect(await screen.findByText('$116.00')).toBeInTheDocument();
    expect(screen.getByText('−$11.60')).toBeInTheDocument();
    expect(screen.getByText(/full refund until Dec 8/)).toBeInTheDocument();
    expect(await screen.findByText(/Ava Kim is next/)).toBeInTheDocument();
    // The credit bonus has no policy: proposed, never added.
    expect(screen.getByText(/bonus proposed/)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Refund $104.40' }));
    expect(await screen.findByText(/Refund of \$104.40 sent to the card/)).toBeInTheDocument();
    const order = app.fake.requests.filter((r) => r.method === 'POST').map((r) => r.route);
    expect(order).toEqual([
      '/enrollments/{id}/cancel',
      '/cases/{id}/request-refund',
      '/waitlist-entries/{id}/offer',
      '/cases/{id}/transition',
    ]);
    const refund = app.fake.requests.find((r) => r.route === '/cases/{id}/request-refund');
    expect(refund?.body).toEqual(
      expect.objectContaining({ paymentAttemptId: PAYMENT, amountMinor: 10_440 }),
    );
    expect(refund?.headers['idempotency-key']).toBeTruthy();
    const cancel = app.fake.requests.find((r) => r.route === '/enrollments/{id}/cancel');
    expect(cancel?.body).toEqual(
      expect.objectContaining({
        expectedRevision: 4,
        acceptedConsequence: { kind: 'refund', amountMinor: 10_440, currency: 'USD' },
      }),
    );
  });

  it('S 4b: "Change amount" requires a note before anything can be sent', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(`/finance/refund-requests/${CASE}`));
    await user.click(await screen.findByRole('button', { name: 'Change amount' }));
    const amount = screen.getByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, '90');
    expect(screen.getByRole('button', { name: 'Refund $90.00' })).toBeDisabled();
    await user.type(screen.getByLabelText('Note (required)'), 'Kept one day of camp');
    expect(screen.getByRole('button', { name: 'Refund $90.00' })).toBeEnabled();
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('S 4b: over $200 needs a manager (proposed threshold), and a role without finance.refund is told to ask one', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes({ refundMinor: 25_000 }) });
    render(app.at(`/finance/refund-requests/${CASE}`));
    expect(await screen.findByText('Over $200 needs a manager (proposed rule).')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refund $250.00' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Family credit/ }));
    expect(screen.getByRole('button', { name: 'Credit $250.00' })).toBeDisabled();

    const desk = createTestApp({ routes: routes({ refund: false }) });
    render(desk.at(`/finance/refund-requests/${CASE}`));
    expect(
      await screen.findByText('Refunds are a finance command: ask a manager.'),
    ).toBeInTheDocument();
  });

  it('S 4b: a general manager approves over $200; declining needs a note the family sees', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ refundMinor: 25_000, roles: ['general_manager'] }),
    });
    render(app.at(`/finance/refund-requests/${CASE}`));
    expect(await screen.findByRole('button', { name: 'Refund $250.00' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(screen.getByRole('button', { name: 'Decline request' })).toBeDisabled();
    await user.type(
      screen.getByLabelText('Why it is declined (the family sees this)'),
      'The week has started.',
    );
    await user.click(screen.getByRole('button', { name: 'Decline request' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/cases/{id}/transition')?.body).toEqual(
        expect.objectContaining({
          event: 'resolve',
          resolution: { kind: 'no_action_needed', summary: 'The week has started.' },
        }),
      ),
    );
  });
});
