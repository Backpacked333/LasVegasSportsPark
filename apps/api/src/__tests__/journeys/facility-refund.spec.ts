import { describe, expect, it } from 'vitest';
import { FakePaymentTokens } from '../../modules/finance';
import {
  basketFor,
  ledgerTotals,
  offering,
  quoteFor,
} from '../../modules/finance/__tests__/support';
import { adult, child, drain, get, journeyApp, ok, post, staff } from './support';

/**
 * Phase 0 verification of a registration refund against the way the facility's current system is
 * used (docs/package-a/legacy-parity-verification.md): money goes back as a refund of the payment,
 * never as a negative-priced sale. It records what the assembled application does today. Amounts
 * are test data.
 */

type Json = Record<string, unknown>;

describe('Facility refund scenarios (assembled application)', () => {
  it('SPK-PAY-008: finance refunds part of a registration payment; the desk cannot; more than was paid is refused; the ledger balances', async () => {
    const t = await journeyApp({ clockStart: '2026-11-02T15:00:00Z' });
    try {
      const desk = await staff(t, ['front_desk']);
      const manager = await staff(t, ['general_manager']);
      const fo = await staff(t, ['finance_operator']);
      const parent = await adult(t);
      const kid = await child(t, [parent]);
      const klass = await offering(t, { basePriceMinor: 20_000 });
      const { basketId } = await basketFor(t, parent, [klass], {
        hold: false,
        participants: [kid],
      });
      const quote = await quoteFor(t, parent, basketId);
      const checkout = await ok<{ payment: { id: string } }>(
        post(t, '/v1/registration-checkouts', parent.header, {
          quoteId: quote.id,
          payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
        }),
        201,
      );
      await drain(t);
      const refund = (who: { Authorization: string }, amountMinor: number) =>
        post(t, `/v1/payments/${checkout.payment.id}/refunds`, who, {
          amountMinor,
          reason: 'Moved away mid-term',
        });
      // The desk cannot return money on a registration; a manager and finance can.
      const byDesk = await refund(desk.header, 5_000);
      expect(byDesk.status).toBe(403);
      expect(byDesk.body.details).toMatchObject({ action: 'finance.refund' });
      await ok(refund(manager.header, 1_000), 201);
      const refunded = await ok<Json>(refund(fo.header, 5_000), 201);
      expect(refunded).toMatchObject({
        status: 'succeeded',
        amountMinor: 5_000,
        reason: 'Moved away mid-term',
        refundable: { capturedMinor: 20_000, refundedMinor: 6_000, availableMinor: 14_000 },
      });
      await drain(t);

      // Money cannot go back twice: one unit more than what is left is refused.
      const over = await refund(fo.header, 14_001);
      expect(over.status).toBe(409);
      expect(over.body.details).toMatchObject({
        code: 'REFUND_EXCEEDS_REFUNDABLE',
        availableMinor: 14_000,
      });

      // A refund moves money only: the child's place in the class is unchanged.
      const enrollments = await ok<{ items: Json[] }>(
        get(t, `/v1/enrollments?participantPersonId=${kid}`, parent.header),
      );
      expect(enrollments.items.map((e) => e['status'])).toEqual(['confirmed']);
      // SPK-PAY-010: every posting has its other side.
      const ledger = await ledgerTotals(t);
      expect(ledger.debits).toBe(ledger.credits);
      expect(ledger.debits).toBeGreaterThan(0);
    } finally {
      await t.close();
    }
  });
});
