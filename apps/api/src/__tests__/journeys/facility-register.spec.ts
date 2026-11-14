import { describe, expect, it } from 'vitest';
import { adult, enableCapability, get, journeyApp, ok, post, staff } from './support';

/**
 * Phase 0 verification of the front-desk register against the way the facility's current system is
 * used (docs/package-a/legacy-parity-verification.md). It records what the assembled application
 * does today, including what it refuses: a refusal asserted here is a recorded gap, not a
 * requirement. Prices and names are test data.
 */

type Json = Record<string, unknown>;

describe('Facility register scenarios (assembled application)', () => {
  it('SPK-PAY-012: a desk sale is paid in cash and the drawer balances; a negative price and an open-amount line are refused', async () => {
    const t = await journeyApp({ clockStart: '2026-11-02T17:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const manager = await staff(t, ['general_manager']);
      const desk = await staff(t, ['front_desk']);
      const customer = await adult(t);
      await enableCapability(t, admin, 'point_of_sale', 'DEC-079');

      const product = (body: Json) =>
        post(t, '/v1/pos-products', manager.header, {
          sku: 'SOCKS',
          name: 'Game socks',
          kind: 'merchandise',
          priceMinor: 800,
          currency: 'USD',
          ...body,
        });
      const socks = await ok<{ id: string }>(product({}), 201);
      const negative = await product({ sku: 'DISC', name: 'Discount', priceMinor: -500 });
      // The current system's negative-priced "discount" product cannot be recreated.
      expect(negative.status).toBe(400);
      expect(negative.body.code).toBe('VALIDATION_FAILED');
      // Desk staff sell products; they do not define them.
      const deskProduct = await post(t, '/v1/pos-products', desk.header, {
        sku: 'X1',
        name: 'x',
        kind: 'merchandise',
        priceMinor: 100,
        currency: 'USD',
      });
      expect(deskProduct.status).toBe(403);

      const register = await ok<{ id: string }>(
        post(t, '/v1/pos-registers', manager.header, {
          facilityId: t.facilityId,
          code: 'FD1',
          name: 'Front desk',
        }),
        201,
      );
      const session = await ok<{ id: string }>(
        post(t, `/v1/pos-registers/${register.id}/sessions`, desk.header, {
          currency: 'USD',
          openingFloatMinor: 10_000,
        }),
        201,
      );
      const sale = await ok<{ id: string }>(
        post(t, '/v1/pos-sales', desk.header, {
          registerSessionId: session.id,
          customerPersonId: customer.personId,
        }),
        201,
      );
      const open = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
        description: 'Field damage deposit',
        amountMinor: 4_250,
      });
      // Recorded gap (proposed amendment PA-08): a sale line is a product and a quantity only, so
      // a one-off amount with a description cannot be rung up.
      expect(open.status).toBe(400);
      expect(open.body.code).toBe('VALIDATION_FAILED');
      const lined = await ok<Json>(
        post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
          productId: socks.id,
          quantity: 3,
        }),
        201,
      );
      expect(lined).toMatchObject({ status: 'open', totalMinor: 2_400, remainingMinor: 2_400 });
      const paid = await ok<Json & { lines: Array<{ id: string }> }>(
        post(t, `/v1/pos-sales/${sale.id}/tenders`, desk.header, {
          kind: 'cash',
          amountMinor: 2_400,
        }),
        201,
      );
      expect(paid.status).toBe('paid');
      const receipt = await get(t, `/v1/pos-sales/${sale.id}/receipt`, customer.header);
      expect(receipt.status).toBe(200);
      expect(receipt.body).toMatchObject({
        status: 'paid',
        totalMinor: 2_400,
        lines: [{ name: 'Game socks', quantity: 3, unitPriceMinor: 800, lineTotalMinor: 2_400 }],
        tenders: [{ kind: 'cash', amountMinor: 2_400 }],
      });
      const deskReturn = await post(t, `/v1/pos-sales/${sale.id}/returns`, desk.header, {
        lines: [{ saleLineId: paid.lines[0]!.id, quantity: 1 }],
        tenderKind: 'cash',
        reason: 'Wrong size',
      });
      // Today a return needs the finance role; who may refund at the desk is an operator question.
      expect(deskReturn.status).toBe(403);
      expect(deskReturn.body.details).toMatchObject({ action: 'finance.approve_pos_return' });
      const before = await ok<Json & { revision: number }>(
        get(t, `/v1/pos-register-sessions/${session.id}`, desk.header),
      );
      expect(before.expectedCashMinor).toBe(10_000 + 2_400);
      const closed = await ok<Json>(
        post(t, `/v1/pos-register-sessions/${session.id}/close`, desk.header, {
          countedCashMinor: 12_400,
          expectedRevision: before.revision,
        }),
        201,
      );
      expect(closed).toMatchObject({ status: 'closed', varianceMinor: 0 });
    } finally {
      await t.close();
    }
  });
});
