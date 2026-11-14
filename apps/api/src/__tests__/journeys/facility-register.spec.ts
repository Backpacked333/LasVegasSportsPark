import { describe, expect, it } from 'vitest';
import { adult, enableCapability, get, journeyApp, ok, post, staff, type Actor } from './support';

/**
 * Phase 0 verification of the front-desk register against the way the facility's current system is
 * used (docs/package-a/legacy-parity-verification.md). It records what the assembled application
 * does today, including what it refuses: a refusal asserted here is a recorded gap, not a
 * requirement. Prices and names are test data.
 */

type Json = Record<string, unknown>;

describe('Facility register scenarios (assembled application)', () => {
  it('SPK-PAY-012: a desk sale is paid in cash and the drawer balances; a negative price is refused, and so is an open-amount line while its capability is off', async () => {
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
      // A one-off amount with a description and nothing else is never a line: an open-amount line
      // (proposed amendment PA-08, SPK-PAY-016) also names its reason category.
      expect(open.status).toBe(400);
      expect(open.body.code).toBe('VALIDATION_FAILED');
      // Recorded gap, kept while the organization has not turned open-amount lines on (DEC-102
      // pending): the complete open-amount line is refused by the capability, and a sale line is
      // a product and a quantity only.
      const switchedOff = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
        description: 'Field damage deposit',
        amountMinor: 4_250,
        reasonCategory: 'field_damage_fee',
      });
      expect(switchedOff.status).toBe(403);
      expect(switchedOff.body.code).toBe('ACCESS_DENIED');
      expect(switchedOff.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'open_amount_lines',
      });
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

  it('SPK-PAY-016 (proposed amendment PA-08): with open-amount lines on, the desk rings up a one-off amount under a reason category; above the ceiling a second person approves before the sale is paid; the receipt and the session show the line', async () => {
    const t = await journeyApp({ clockStart: '2026-11-02T17:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const manager = await staff(t, ['general_manager']);
      const finance = await staff(t, ['finance_operator']);
      const pm = await staff(t, ['program_manager']);
      const desk = await staff(t, ['front_desk']);
      const customer = await adult(t);
      await enableCapability(t, admin, 'point_of_sale', 'DEC-079');
      await enableCapability(t, admin, 'open_amount_lines', 'DEC-102');

      // The categories and ceilings are policy content, approved by finance (values are test
      // data; the facility's own are pending, DEC-102).
      const policy = await ok<{ id: string }>(
        post(t, '/v1/policy-versions', pm.header, {
          kind: 'overpayment',
          key: 'register-open-amount',
          title: 'Register open amounts',
          content: {
            currency: 'USD',
            categories: [
              {
                code: 'field_damage_fee',
                label: 'Field damage fee',
                revenueCategory: 'facility_fees',
              },
              { code: 'lost_key', label: 'Lost key', revenueCategory: 'facility_fees' },
            ],
            ceilings: { defaultMinor: 2_500, byRole: { front_desk: 5_000 } },
          },
          effectiveFrom: '2026-10-01T00:00:00Z',
        }),
        201,
      );
      await ok(post(t, `/v1/policy-versions/${policy.id}/approve`, finance.header, {}));

      const register = await ok<{ id: string }>(
        post(t, '/v1/pos-registers', manager.header, {
          facilityId: t.facilityId,
          code: 'FD2',
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
      const rules = await ok<Json>(
        get(t, `/v1/pos-open-amount-rules?facilityId=${t.facilityId}`, desk.header),
      );
      expect(rules).toMatchObject({
        basis: 'approved_policy',
        policyVersionId: policy.id,
        ceilingMinor: 5_000,
      });
      const sale = await ok<{ id: string }>(
        post(t, '/v1/pos-sales', desk.header, {
          registerSessionId: session.id,
          customerPersonId: customer.personId,
        }),
        201,
      );
      type Sale = Json & {
        revision: number;
        lines: Array<Json & { id: string; openAmount: Json | null }>;
      };
      // Below the ceiling: nothing more is asked.
      const key = await ok<Sale>(
        post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
          description: 'Locker key 14 not returned',
          amountMinor: 1_500,
          reasonCategory: 'lost_key',
        }),
        201,
      );
      expect(key.lines[0]).toMatchObject({
        kind: 'open_amount',
        name: 'Lost key',
        openAmount: { enteredByPersonId: desk.personId, approvalRequired: false },
      });
      // Above it: the sale takes no tender until a second person approves.
      const damage = await ok<Sale>(
        post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
          description: 'Field damage deposit',
          amountMinor: 20_000,
          reasonCategory: 'field_damage_fee',
        }),
        201,
      );
      expect(damage).toMatchObject({ status: 'open', totalMinor: 21_500 });
      const damageLine = damage.lines.find((l) => l.openAmount?.approvalRequired === true)!;
      const early = await post(t, `/v1/pos-sales/${sale.id}/tenders`, desk.header, {
        kind: 'cash',
        amountMinor: 21_500,
      });
      expect(early.status).toBe(409);
      expect(early.body.details).toMatchObject({ code: 'OPEN_AMOUNT_APPROVAL_REQUIRED' });
      const approval = (who: Actor) =>
        post(t, `/v1/pos-sales/${sale.id}/lines/${damageLine.id}/approval`, who.header, {
          reason: 'Damage confirmed with the renter',
          expectedRevision: damage.revision,
        });
      // The desk does not approve its own line (it holds no approving role either).
      expect((await approval(desk)).status).toBe(403);
      const approved = await ok<Sale>(approval(manager));
      expect(approved.lines.find((l) => l.id === damageLine.id)!.openAmount).toMatchObject({
        approval: { approvedByPersonId: manager.personId },
      });
      const paid = await ok<Json>(
        post(t, `/v1/pos-sales/${sale.id}/tenders`, desk.header, {
          kind: 'cash',
          amountMinor: 21_500,
        }),
        201,
      );
      expect(paid.status).toBe('paid');
      const receipt = await ok<Json>(get(t, `/v1/pos-sales/${sale.id}/receipt`, customer.header));
      expect(receipt).toMatchObject({
        status: 'paid',
        totalMinor: 21_500,
        lines: [
          { name: 'Lost key', description: 'Locker key 14 not returned', lineTotalMinor: 1_500 },
          {
            name: 'Field damage fee',
            description: 'Field damage deposit',
            lineTotalMinor: 20_000,
          },
        ],
      });
      // The session lists its open-amount lines apart, for review.
      const review = await ok<{ items: Json[] }>(
        get(t, `/v1/pos-register-sessions/${session.id}/open-amount-lines`, finance.header),
      );
      expect(
        review.items.map((i) => [i.description, i.reasonCategory, i.approvalRequired]),
      ).toEqual([
        ['Field damage deposit', 'field_damage_fee', true],
        ['Locker key 14 not returned', 'lost_key', false],
      ]);
      const before = await ok<Json & { revision: number }>(
        get(t, `/v1/pos-register-sessions/${session.id}`, desk.header),
      );
      expect(before.expectedCashMinor).toBe(10_000 + 21_500);
    } finally {
      await t.close();
    }
  });
});
