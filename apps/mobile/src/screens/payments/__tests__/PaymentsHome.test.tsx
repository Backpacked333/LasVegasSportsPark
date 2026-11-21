/**
 * Handoff M 4a Payments & receipts and M 4b Receipt with a refund request (SPK-PAY-005,
 * SPK-PAY-008, SPK-REG-010, SPK-SUPPORT-002).
 */
import { fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  cancellationPreview,
  consequence,
  IDS,
  obligation,
  order,
  paymentAttempt,
} from '../../../features/money/testing/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { PaymentsHomeScreen } from '../PaymentsHomeScreen';
import { ReceiptScreen } from '../ReceiptScreen';
import { historyRows, refundWords, rowAmount } from '../receipts-model';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));
beforeEach(() => mockPush.mockClear());

const ok = (body: unknown) => ({ status: 200, body });
const ME = {
  principal: {
    kind: 'customer',
    organizationId: IDS.facility,
    accountId: IDS.operation,
    personId: IDS.self,
    staffRoles: [],
    facilityIds: [],
  },
  person: {
    id: IDS.self,
    kind: 'adult',
    givenName: 'Dana',
    familyName: 'Ortiz',
    dateOfBirth: null,
    status: 'active',
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  staffMemberships: [],
  authorities: [{ subjectPersonId: IDS.child, permissions: ['view', 'pay', 'register'] }],
};

const camp = order({
  totalMinor: 20880,
  lines: [
    {
      ...order().lines[0],
      id: IDS.enrollmentB,
      enrollmentId: IDS.enrollment,
      description: 'Winter Break Camp · week 1',
      baseAmountMinor: 11600,
      discountMinor: 1160,
      totalMinor: 10440,
    },
    {
      ...order().lines[0],
      id: IDS.enrollmentC,
      enrollmentId: IDS.enrollmentB,
      description: 'Winter Break Camp · week 2',
      baseAmountMinor: 11600,
      discountMinor: 1160,
      totalMinor: 10440,
    },
  ],
});
const paid = paymentAttempt({ amountMinor: 20880, obligationId: null, purpose: 'checkout' });

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /me': ok(ME),
    'GET /person-names': ok({
      items: [
        {
          personId: IDS.child,
          canonicalPersonId: IDS.child,
          givenName: 'Maya',
          familyName: 'Ortiz',
          displayName: 'Maya Ortiz',
          kind: 'child',
        },
      ],
    }),
    'GET /obligations': (req: { query: Record<string, string> }) =>
      fakeResponse(200, {
        items:
          req.query.debtorPersonId === IDS.child
            ? [
                obligation({
                  description: 'Spring Rec League · 2 of 3',
                  debtor: { kind: 'person', personId: IDS.child, teamEntryId: null },
                  status: 'open',
                }),
              ]
            : [],
        nextCursor: null,
      }),
    'GET /people/{id}/waivers': ok({ personId: IDS.child, evaluated: true, waivers: [] }),
    'GET /me/team-invitations': ok({ items: [], nextCursor: null }),
    'GET /me/payments': ok({ items: [paid], nextCursor: null }),
    'GET /payments/{id}': ok({
      ...paid,
      refundableMinor: 20880,
      refunds: [
        {
          id: IDS.credit,
          status: 'succeeded',
          amountMinor: 1200,
          currency: 'USD',
          requestedAt: '2026-10-25T10:00:00.000Z',
        },
      ],
    }),
    'GET /orders/{id}': ok(camp),
    'GET /people/{id}/money-summary': ok({
      personId: IDS.self,
      accountBalance: [],
      openObligations: 1,
      pastDueObligations: 0,
      creditsAvailable: [{ amountMinor: 2500, currency: 'USD' }],
      creditsPendingApproval: [],
      paidThisYear: [{ amountMinor: 128400, currency: 'USD' }],
      refundedThisYear: [],
      paidSince: '2026-01-01T00:00:00.000Z',
      yearTimeZone: 'America/Los_Angeles',
      asOf: '2026-10-24T12:00:00.000Z',
    }),
    'GET /me/cases': ok({ items: [], nextCursor: null }),
    'GET /enrollments/{id}/cancellation-preview': (req: { params: Record<string, string> }) =>
      fakeResponse(
        200,
        cancellationPreview({
          enrollmentId: req.params.id,
          financialConsequence: consequence({
            amountMinor: 11600,
            explanation: 'Full refund until Dec 8.',
          }),
        }),
      ),
    ...extra,
  };
}

describe('handoff M 4a Payments & receipts', () => {
  it('the next payment on top with Pay now; Manage plan and the tax summary are proposed', async () => {
    const app = createTestApp({ routes: routes() as never });
    render(<PaymentsHomeScreen />, { wrapper: app.wrapper });
    const next = await screen.findByTestId('payments-next');
    expect(within(next).getByText(/Spring Rec League · 2 of 3/)).toBeOnTheScreen();
    expect(within(next).getByRole('button', { name: 'Manage plan' })).toBeDisabled();
    expect(within(next).getByText('Proposed')).toBeOnTheScreen();
    fireEvent.press(within(next).getByRole('button', { name: 'Pay now' }));
    expect(await screen.findByTestId('pay-sheet')).toBeOnTheScreen();
    expect(await screen.findByText('$1,284')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Tax summary, proposed' }));
    expect(await screen.findByTestId('payments-tax-proposed')).toBeOnTheScreen();
  });

  it('history names what each payment was for and who; refunds are green with a +; a row opens its receipt', async () => {
    const app = createTestApp({ routes: routes() as never });
    render(<PaymentsHomeScreen />, { wrapper: app.wrapper });
    const history = await screen.findByTestId('payments-history');
    expect(
      await within(history).findByText('Winter Break Camp · week 1 + 1 more'),
    ).toBeOnTheScreen();
    expect(await within(history).findByText('+$12.00')).toBeOnTheScreen();
    fireEvent.press(
      within(history).getByRole('button', { name: /^Winter Break Camp · week 1 \+ 1 more, Maya/ }),
    );
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/payments/receipt/[paymentId]',
      params: { paymentId: paid.id },
    });
    fireEvent.press(
      screen.getByRole('button', { name: 'Filter: every payment, receipt and order' }),
    );
    expect(mockPush).toHaveBeenLastCalledWith('/payments/all');
  });

  it('pure parts: only payments that went through, refunds after their payment, amounts', () => {
    const rows = historyRows(
      [paid as never, paymentAttempt({ id: IDS.makeup, status: 'processing' }) as never],
      {},
      { [IDS.order]: camp as never },
      {},
    );
    expect(rows.map((r) => r.title)).toEqual(['Winter Break Camp · week 1 + 1 more']);
    expect(rowAmount({ kind: 'refund', amountMinor: 1200, currency: 'USD' })).toBe('+$12.00');
    expect(refundWords(consequence() as never, () => '$60.00')).toBe('$60.00 back to your card');
    expect(refundWords(consequence({ kind: 'review_required' }) as never, () => '')).toBe(
      'The desk decides what comes back',
    );
  });
});

describe('handoff M 4b Receipt with a refund request', () => {
  it('is itemised with the discount and the reference; Download PDF is proposed', async () => {
    const app = createTestApp({ routes: routes() as never });
    render(<ReceiptScreen paymentId={paid.id} />, { wrapper: app.wrapper });
    const lines = await screen.findByTestId('receipt-lines');
    expect(within(lines).getByText('Winter Break Camp · week 1')).toBeOnTheScreen();
    expect(within(lines).getByText('−$23.20')).toBeOnTheScreen();
    expect(within(lines).getByText('ref fake_ref_1')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
    expect(await screen.findByText('Full refund until Dec 8.')).toBeOnTheScreen();
  });

  it('"Cancel a week" lists the weeks with what comes back and sends a request the desk approves', async () => {
    const app = createTestApp({
      routes: routes({
        'POST /me/support-requests': {
          status: 201,
          body: {
            id: IDS.policy,
            category: 'payment',
            title: 'Cancel a week: Winter Break Camp · week 2',
            status: 'open',
            subjectPersonId: IDS.child,
            createdAt: '2026-10-24T12:00:00.000Z',
            updatedAt: '2026-10-24T12:00:00.000Z',
            resolvedAt: null,
          },
        },
      }) as never,
    });
    render(<ReceiptScreen paymentId={paid.id} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Cancel a week' }));
    const week = await screen.findByRole('radio', {
      name: 'Winter Break Camp · week 2, $116.00 back to your card',
    });
    fireEvent.press(week);
    fireEvent.press(screen.getByRole('button', { name: 'Send the request' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/support-requests')).toBe(true),
    );
    const sent = app.fake.requests.find((r) => r.route === '/me/support-requests');
    expect(sent?.headers['idempotency-key']).toBeTruthy();
    expect(sent?.body).toMatchObject({
      category: 'payment',
      title: 'Cancel a week: Winter Break Camp · week 2',
      subjectPersonId: IDS.child,
      relatedRecords: [
        { type: 'enrollment', id: IDS.enrollmentB },
        { type: 'payment_attempt', id: paid.id },
      ],
    });
    expect(await screen.findByText('Request sent · the desk will confirm')).toBeOnTheScreen();
  });

  it('a week already asked about shows "Request sent" and cannot be asked again', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/cases': ok({
          items: [
            {
              id: IDS.policy,
              category: 'payment',
              title: 'Cancel a week: Winter Break Camp · week 2',
              status: 'open',
              subjectPersonId: IDS.child,
              createdAt: '2026-10-24T12:00:00.000Z',
              updatedAt: '2026-10-24T12:00:00.000Z',
              resolvedAt: null,
            },
          ],
          nextCursor: null,
        }),
      }) as never,
    });
    render(<ReceiptScreen paymentId={paid.id} />, { wrapper: app.wrapper });
    expect(await screen.findByText('Request sent · the desk will confirm')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel a week' }));
    expect(
      await screen.findByRole('radio', { name: 'Winter Break Camp · week 2, request sent' }),
    ).toBeDisabled();
  });
});
