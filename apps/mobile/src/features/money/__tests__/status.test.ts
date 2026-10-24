/**
 * The status vocabulary of SCR-C-32 to SCR-C-35 (journeys.md section 3; SPK-UX-004, SPK-UX-009,
 * SPK-UX-010, SPK-PAY-007, SPK-PAY-009, SPK-YOUTH-004): phrases and tones, never colour alone, and
 * the money formatting of what the API sent.
 */
import { STATUS_GLYPHS } from '../../../ui/StatusBadge';
import { formatDateOnly, formatDateRange, formatMoney } from '../format';
import {
  consequenceSummary,
  enrollmentStatus,
  installmentStatus,
  paymentIsUnresolved,
  paymentStatus,
  sameConsequence,
  type Enrollment,
  type FinancialConsequence,
  type Installment,
} from '../status';
import { consequence, enrollment, installment } from '../testing/fixtures';

const e = (o: Record<string, unknown> = {}) => enrollment(o) as unknown as Enrollment;
const c = (o: Record<string, unknown> = {}) => consequence(o) as unknown as FinancialConsequence;

describe('money and participation vocabulary', () => {
  it('SPK-UX-004: "Payment processing", "Awaiting placement" and "Confirmed" differ in words, tone and glyph', () => {
    const processing = paymentStatus('processing');
    const awaiting = enrollmentStatus(e(), {
      offeringName: 'U10',
      placement: { status: 'unassigned' } as never,
    });
    const confirmed = enrollmentStatus(e());
    expect([processing.label, awaiting.label, confirmed.label]).toEqual([
      'Payment processing',
      'Confirmed in U10. Awaiting placement.',
      'Confirmed',
    ]);
    const glyphs = new Set([processing, awaiting, confirmed].map((s) => STATUS_GLYPHS[s.tone]));
    expect(glyphs.size).toBe(3);
  });

  it('SPK-PAY-007: an unknown payment is never "Payment failed" and blocks a new payment', () => {
    expect(paymentStatus('unknown').label).toBe(
      'Payment outcome being confirmed. Do not pay again.',
    );
    expect(paymentStatus('unknown').tone).not.toBe('danger');
    for (const status of ['created', 'action_required', 'processing', 'unknown'] as const) {
      expect(paymentIsUnresolved(status)).toBe(true);
    }
    for (const status of ['succeeded', 'failed', 'canceled'] as const) {
      expect(paymentIsUnresolved(status)).toBe(false);
    }
  });

  it('SPK-REG-003: terminal enrollment states read in the journeys.md words', () => {
    expect(enrollmentStatus(e({ status: 'pending' })).label).toBe('Registration pending');
    expect(enrollmentStatus(e({ status: 'canceled' })).label).toBe('Canceled');
    expect(enrollmentStatus(e({ status: 'completed' })).label).toBe('Completed');
    expect(
      enrollmentStatus(e({ status: 'transferred' }), { transferTargetName: 'Sunday League' }).label,
    ).toBe('Transferred to Sunday League');
    expect(enrollmentStatus(e({ status: 'pending' }), { recoveryRequired: true }).label).toBe(
      'Payment received. We are completing your registration.',
    );
  });

  it('SPK-PAY-006: a failed installment reads "Payment attention needed", never "Canceled"', () => {
    const failed = installmentStatus(
      installment(2, { status: 'failed' }) as unknown as Installment,
    );
    expect(failed.label).toBe('Payment attention needed');
    expect(failed.tone).toBe('warning');
  });

  it('SPK-REG-010: money consequences use the API amount and keep the API explanation', () => {
    expect(consequenceSummary(c()).headline).toBe('Refund of $60.00');
    expect(consequenceSummary(c({ kind: 'credit' })).headline).toBe(
      'Credit of $60.00 to your account',
    );
    expect(consequenceSummary(c({ kind: 'charge', amountMinor: 1500 })).headline).toBe(
      'Additional charge of $15.00',
    );
    expect(consequenceSummary(c({ kind: 'none', amountMinor: 0 })).headline).toBe(
      'No money changes',
    );
    expect(consequenceSummary(c({ kind: 'refund', amountMinor: null })).headline).toBe(
      'Refund, amount to be confirmed',
    );
    expect(consequenceSummary(c()).explanation).toBe(
      'The cancellation policy grants a refund of 50% of the price.',
    );
  });

  it('compares consequences by kind, amount and currency (stale preview detection)', () => {
    expect(sameConsequence(c(), c({ explanation: 'reworded' }))).toBe(true);
    expect(sameConsequence(c(), c({ amountMinor: 1 }))).toBe(false);
    expect(sameConsequence(c(), c({ kind: 'credit' }))).toBe(false);
    expect(sameConsequence(c(), c({ currency: 'CAD' }))).toBe(false);
  });

  it('SPK-PAY-001: formats integer minor units with the currency the API sent', () => {
    expect(formatMoney(12550, 'USD')).toBe('$125.50');
    expect(formatMoney(-500, 'USD')).toBe('-$5.00');
    expect(formatMoney(1200, 'JPY')).toBe('¥1,200');
    expect(formatMoney(100, 'not-a-code')).toBe('100 minor units not-a-code');
    expect(formatDateOnly('2026-11-02')).toBe('Nov 2, 2026');
    expect(formatDateRange('2026-11-02', '2026-11-02')).toBe('Nov 2, 2026');
  });
});
