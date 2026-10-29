/**
 * Wording of the SCR-C-34 and SCR-C-35 lists (SPK-PAY-005, SPK-PAY-007, SPK-PAY-008, SPK-UX-004,
 * SPK-UX-010): an unknown or processing payment is never success or failure, a refund being
 * confirmed is never "Refunded", overpayments stay visible, an order in recovery says the payment
 * was received, and a session package reads its sessions left from the API.
 */
import { TEST_NOW } from '../../../testing/test-app';
import { inDays, obligation, receipt } from '../testing/fixtures';
import { liveAttempt, myOrder, packageEntitlement } from '../testing/list-fixtures';
import {
  liveAttemptStatus,
  liveAttemptText,
  obligationAmounts,
  orderAmounts,
  orderStatus,
  orderTitle,
  packageHistory,
  packageStatus,
  paymentTitle,
  receiptAmounts,
  refundStatus,
  type LiveAttempt,
  type Order,
  type PackageEntitlement,
} from '../payment-lists';
import type { Obligation, Receipt } from '../status';

const live = (o: Record<string, unknown> = {}) => liveAttempt(o) as unknown as LiveAttempt;
const anOrder = (o: Record<string, unknown> = {}) => myOrder(o) as unknown as Order;
const aPackage = (o: Record<string, unknown> = {}) =>
  packageEntitlement(o) as unknown as PackageEntitlement;

describe('SCR-C-34 payment list wording', () => {
  it('SPK-PAY-007: a live unknown attempt says not to pay again, never success or failure', () => {
    expect(liveAttemptStatus(live())).toEqual({
      tone: 'warning',
      label: 'Payment outcome being confirmed. Do not pay again.',
    });
    expect(liveAttemptText(live())).toMatch(/Do not pay again: the facility confirms it\.$/);
    expect(liveAttemptStatus(live({ status: 'processing' })).label).toBe('Payment processing');
    expect(liveAttemptStatus(live({ status: 'created' })).label).toBe('Payment processing');
    expect(liveAttemptStatus(live({ status: 'action_required' })).label).toBe(
      'Payment needs your action',
    );
    for (const status of ['unknown', 'processing', 'created', 'action_required']) {
      expect(liveAttemptStatus(live({ status })).tone).not.toBe('success');
      expect(liveAttemptStatus(live({ status })).tone).not.toBe('danger');
    }
  });

  it('names what a payment paid for with its amount', () => {
    expect(paymentTitle({ purpose: 'contribution', amountMinor: 7500, currency: 'USD' })).toBe(
      'Team contribution: $75.00',
    );
    expect(paymentTitle({ purpose: 'checkout', amountMinor: 12000, currency: 'USD' })).toBe(
      'Registration payment: $120.00',
    );
  });

  it('SPK-PAY-005: a receipt and a balance keep an overpayment visible', () => {
    expect(receiptAmounts(receipt({ allocatedMinor: 4000, excessMinor: 500 }) as Receipt)).toBe(
      'Applied $40.00. Paid beyond the balance: $5.00',
    );
    expect(receiptAmounts(receipt() as Receipt)).toBe('Applied $40.00');
    expect(
      obligationAmounts(
        obligation({
          status: 'settled',
          totals: {
            amountMinor: 4000,
            receivedMinor: 4500,
            allocatedMinor: 4000,
            remainingMinor: 0,
            excessMinor: 500,
            currency: 'USD',
          },
        }) as unknown as Obligation,
      ),
    ).toBe('$40.00. Paid beyond the balance: $5.00');
  });

  it('§4.11: an order in recovery says the payment was received before anything else', () => {
    expect(orderStatus(anOrder({ fulfillmentStatus: 'recovery_required' })).label).toBe(
      'Payment received. We are completing your registration.',
    );
    expect(
      orderStatus(anOrder({ paymentStatus: 'awaiting_payment', fulfillmentStatus: 'pending' }))
        .label,
    ).toBe('Payment needs your action');
    expect(orderStatus(anOrder()).label).toBe('Registration complete');
    expect(orderStatus(anOrder({ fulfillmentStatus: 'compensated' })).label).toBe(
      'Payment returned. Registration was not completed.',
    );
  });

  it('summarizes an order by its first line and its amounts, credits named only when applied', () => {
    expect(orderTitle(anOrder())).toBe('Autumn U10 League');
    expect(orderAmounts(anOrder())).toBe('Total $120.00. Due at checkout $40.00');
    expect(orderAmounts(anOrder({ creditsAppliedMinor: 1000 }))).toBe(
      'Total $120.00. Credits applied $10.00. Due at checkout $40.00',
    );
    const lines = anOrder().lines;
    expect(
      orderTitle(
        anOrder({
          lines: [...lines, { ...lines[0], id: 'x', sequence: 2, description: 'Second' }],
        }),
      ),
    ).toBe('Autumn U10 League and 1 more');
  });

  it('SPK-PAY-008: a refund being confirmed is never "Refunded"', () => {
    expect(refundStatus('unknown')).toEqual({
      tone: 'warning',
      label: 'Refund outcome being confirmed',
    });
    expect(refundStatus('processing').label).toBe('Refund processing');
    expect(refundStatus('succeeded').label).toBe('Refunded');
    expect(refundStatus('failed').label).toBe('Refund failed');
  });
});

describe('SCR-C-35 session package wording (ENR-11)', () => {
  it('reads the sessions left from the API, and the end states', () => {
    expect(packageStatus(aPackage(), TEST_NOW)).toEqual({
      tone: 'success',
      label: '7 sessions left',
    });
    expect(packageStatus(aPackage({ remainingCredits: 1 }), TEST_NOW).label).toBe('1 session left');
    expect(
      packageStatus(aPackage({ status: 'exhausted', remainingCredits: 0 }), TEST_NOW).label,
    ).toBe('All sessions used');
    expect(packageStatus(aPackage({ status: 'revoked' }), TEST_NOW).label).toBe('Revoked');
    expect(packageStatus(aPackage({ status: 'expired' }), TEST_NOW).label).toBe('Expired');
  });

  it('an active package past its expiry reads "Expired"; one without an expiry never does', () => {
    expect(packageStatus(aPackage({ expiresAt: inDays(-1) }), TEST_NOW).label).toBe('Expired');
    expect(packageStatus(aPackage({ expiresAt: null }), TEST_NOW).label).toBe('7 sessions left');
  });

  it('lists the redemption history newest first, reversals included', () => {
    expect(packageHistory(aPackage()).map((r) => r.kind)).toEqual(['reversal', 'redeem']);
  });
});
