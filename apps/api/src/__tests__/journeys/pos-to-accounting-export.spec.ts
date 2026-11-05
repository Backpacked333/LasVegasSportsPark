import { newId } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  FakeAccountingProvider,
  FakePaymentProvider,
  FakePaymentTokens,
  FinanceWorker,
  RECONCILE_ACCOUNTING_JOB,
} from '../../modules/finance';
import { adult, enableCapability, get, journeyApp, ok, post, staff } from './support';

/**
 * §3.16 Point of sale (DEC-079) and Accounting (DEC-081), both behind DEC-016 switches, across
 * catalog (approved tax policy), finance (sales, tenders, returns, journals, export batches),
 * identity (customer receipts) and the kernel (periodic jobs, operational exceptions), on the
 * assembled application. Tax rates, prices and account references are test data, not policy.
 */

const CLOCK_START = '2026-11-02T17:00:00Z';
const MINUTE = 60_000;

type Json = Record<string, unknown>;

interface Sale extends Json {
  id: string;
  status: string;
  lines: Array<{ id: string }>;
  tenders: Array<Json & { paymentAttemptId?: string | null }>;
}

interface Batch extends Json {
  id: string;
  revision: number;
  status: string;
  lines: Array<Json & { ledgerAccount: string; debitMinor: number; creditMinor: number }>;
}

describe('Point of sale to accounting export (assembled application)', () => {
  it('SPK-PAY-002/010/011/012: an approved tax prices a sale; cash and an unknown card outcome settle once; the drawer difference goes to finance; the export needs approved mappings and a later return goes into the next batch', async () => {
    const t = await journeyApp({ clockStart: CLOCK_START });
    try {
      const admin = await staff(t, ['system_administrator']);
      const manager = await staff(t, ['general_manager']);
      const pm = await staff(t, ['program_manager']);
      const desk = await staff(t, ['front_desk']);
      const fo1 = await staff(t, ['finance_operator']);
      const fo2 = await staff(t, ['finance_operator']);
      const customer = await adult(t);
      const periodStart = t.clock.now().toISOString();

      // DEC-016: both capabilities start off; nothing new is sold or exported.
      const product = (body: Json = {}) =>
        post(t, '/v1/pos-products', manager.header, {
          sku: `SKU-${newId().slice(-8).toUpperCase()}`,
          name: 'Team water bottle',
          kind: 'merchandise',
          priceMinor: 1_000,
          currency: 'USD',
          ...body,
        });
      const off = await product();
      expect(off.status).toBe(403);
      expect(off.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'point_of_sale',
      });
      const noMapping = await post(t, '/v1/accounting-mappings', fo1.header, {
        ledgerAccount: 'cash_on_hand',
        externalAccountRef: '1010',
      });
      expect(noMapping.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'accounting',
      });
      await enableCapability(t, admin, 'point_of_sale', 'DEC-079');
      await enableCapability(t, admin, 'accounting', 'DEC-081');

      // SPK-PAY-002: a tax applies only through an approved tax_fee version (finance approves).
      const tax = await ok<{ id: string }>(
        post(t, '/v1/policy-versions', pm.header, {
          kind: 'tax_fee',
          key: 'city-sales-tax',
          title: 'City sales tax',
          content: {
            code: 'CITY',
            label: 'City sales tax',
            kind: 'tax',
            rateBasisPoints: 825,
            rounding: 'half_up',
          },
          effectiveFrom: '2026-10-01T00:00:00Z',
        }),
        201,
      );
      expect((await post(t, `/v1/policy-versions/${tax.id}/approve`, pm.header, {})).status).toBe(
        403,
      );
      await ok(post(t, `/v1/policy-versions/${tax.id}/approve`, fo1.header, {}));
      const bottle = (
        await ok<{ id: string }>(product({ chargePolicyKeys: ['city-sales-tax'] }), 201)
      ).id;
      const levied = (
        await ok<{ id: string }>(
          product({ priceMinor: 500, chargePolicyKeys: ['county-levy'] }),
          201,
        )
      ).id;

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
          openingFloatMinor: 5_000,
        }),
        201,
      );
      const sale = async (customerPersonId?: string) =>
        ok<Sale>(
          post(t, '/v1/pos-sales', desk.header, {
            registerSessionId: session.id,
            ...(customerPersonId ? { customerPersonId } : {}),
          }),
          201,
        );
      const line = (saleId: string, productId: string, quantity: number) =>
        post(t, `/v1/pos-sales/${saleId}/lines`, desk.header, { productId, quantity });

      // A cash sale: 2 x 10.00 + 8.25% tax = 21.65.
      const cash = await sale(customer.personId);
      expect((await ok<Json>(line(cash.id, bottle, 2), 201)).totalMinor).toBe(2_165);
      const unapproved = await line(cash.id, levied, 1);
      expect(unapproved.status).toBe(409);
      expect(unapproved.body.details).toMatchObject({
        code: 'CHARGE_POLICY_NOT_APPROVED',
        policyKey: 'county-levy',
      });
      const paidCash = await ok<Sale>(
        post(t, `/v1/pos-sales/${cash.id}/tenders`, desk.header, {
          kind: 'cash',
          amountMinor: 2_165,
        }),
        201,
      );
      expect(paidCash.status).toBe('paid');
      // SPK-PAY-012: an external tender needs evidence.
      const other = await sale();
      await line(other.id, bottle, 1);
      const bare = await post(t, `/v1/pos-sales/${other.id}/tenders`, desk.header, {
        kind: 'external',
        amountMinor: 1_083,
      });
      expect(bare.status).toBe(400);
      await ok(
        post(t, `/v1/pos-sales/${other.id}/void`, desk.header, { reason: 'Walked away' }),
        201,
      );

      // §4.11: a card tender whose answer is lost keeps the sale open; the provider worker
      // reconciles it and the sale is paid exactly once.
      const card = await sale(customer.personId);
      await line(card.id, bottle, 4); // 40.00 + 3.30
      const unknown = await ok<Sale>(
        post(t, `/v1/pos-sales/${card.id}/tenders`, desk.header, {
          kind: 'card',
          amountMinor: 4_330,
          paymentMethodToken: FakePaymentTokens.timeout,
        }),
        201,
      );
      expect(unknown).toMatchObject({ status: 'open', pendingMinor: 4_330 });
      expect(unknown.tenders[0]).toMatchObject({ paymentStatus: 'unknown' });
      const attemptId = unknown.tenders[0]!.paymentAttemptId as string;
      const again = await post(t, `/v1/pos-sales/${card.id}/tenders`, desk.header, {
        kind: 'card',
        amountMinor: 1,
        paymentMethodToken: FakePaymentTokens.succeed,
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
      t.clock.advance(20 * MINUTE);
      // The provider-facing worker runs in the worker process (§4.1); here one pass, then another.
      await t.app.get(FinanceWorker).runOnce();
      await t.app.get(FinanceWorker).runOnce();
      expect(await ok<Sale>(get(t, `/v1/pos-sales/${card.id}`, desk.header))).toMatchObject({
        status: 'paid',
        settledMinor: 4_330,
        pendingMinor: 0,
      });
      expect(
        t.app.get(FakePaymentProvider).paymentCalls.filter((c) => c.idempotencyKey === attemptId),
      ).toHaveLength(1);

      // §4.10: the customer reads their receipts and the card payment; nobody else does.
      const receipts = await ok<{ items: Array<{ saleId: string }> }>(
        get(t, '/v1/me/pos-receipts', customer.header),
      );
      expect(receipts.items.map((r) => r.saleId).sort()).toEqual([cash.id, card.id].sort());
      expect(await ok<Json>(get(t, `/v1/payments/${attemptId}`, customer.header))).toMatchObject({
        purpose: 'pos_sale',
        posSaleId: card.id,
      });
      const stranger = await adult(t);
      expect((await get(t, `/v1/pos-sales/${card.id}/receipt`, stranger.header)).status).toBe(404);

      // POL-018: the drawer is counted 0.50 short; the difference goes to finance, unposted.
      const before = await ok<Json & { revision: number }>(
        get(t, `/v1/pos-register-sessions/${session.id}`, desk.header),
      );
      expect(before.expectedCashMinor).toBe(5_000 + 2_165);
      const closed = await ok<Json>(
        post(t, `/v1/pos-register-sessions/${session.id}/close`, desk.header, {
          countedCashMinor: 7_115,
          expectedRevision: before.revision,
        }),
        201,
      );
      expect(closed).toMatchObject({ status: 'closed', varianceMinor: -50 });
      const variance = (
        await ok<{ items: Array<Json & { affected: { id: string } | null }> }>(
          get(t, '/v1/exceptions?queue=finance_operator&status=open', fo1.header),
        )
      ).items.filter((e) => e.category === 'finance.pos_register_variance');
      expect(variance).toEqual([
        expect.objectContaining({ affected: expect.objectContaining({ id: session.id }) }),
      ]);

      // SPK-PAY-011: preparation names every unmapped account and prepares nothing.
      t.clock.advance(10 * MINUTE);
      const period = { periodStart, periodEnd: t.clock.now().toISOString() };
      const blocked = await post(t, '/v1/accounting-export-batches', fo1.header, period);
      expect(blocked.status).toBe(409);
      expect(blocked.body.details).toMatchObject({ code: 'ACCOUNTING_MAPPING_REQUIRED' });
      const accounts = [...(blocked.body.details.accounts as string[])].sort();
      expect(accounts).toEqual(
        expect.arrayContaining(['cash_on_hand', 'cash_processor', 'pos_revenue', 'taxes_payable']),
      );
      // Four eyes: the proposer cannot approve; a second finance operator does.
      for (const [index, ledgerAccount] of accounts.entries()) {
        const proposed = await ok<{ id: string; revision: number }>(
          post(t, '/v1/accounting-mappings', fo1.header, {
            ledgerAccount,
            externalAccountRef: `${1000 + index} ${ledgerAccount}`,
          }),
          201,
        );
        if (index === 0) {
          const self = await post(t, `/v1/accounting-mappings/${proposed.id}/approve`, fo1.header, {
            expectedRevision: proposed.revision,
          });
          expect(self.status).toBe(409);
          expect(self.body.details).toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
        }
        await ok(
          post(t, `/v1/accounting-mappings/${proposed.id}/approve`, fo2.header, {
            expectedRevision: proposed.revision,
          }),
          201,
        );
      }
      const batch = await ok<Batch>(
        post(t, '/v1/accounting-export-batches', fo1.header, period),
        201,
      );
      expect(batch.status).toBe('prepared');
      const sum = (b: Batch, side: 'debitMinor' | 'creditMinor') =>
        b.lines.reduce((a, l) => a + l[side], 0);
      expect(sum(batch, 'debitMinor')).toBe(sum(batch, 'creditMinor'));
      expect(sum(batch, 'debitMinor')).toBeGreaterThan(0);

      // §4.11, §4.12: the connection keeps the batch but its answer is lost; the job settles it
      // without a second batch at the connection.
      const fake = t.app.get(FakeAccountingProvider);
      const recordedBefore = fake.recordedBatches();
      fake.scriptSubmissions('timeout_accepted');
      const submitted = await ok<Batch>(
        post(t, `/v1/accounting-export-batches/${batch.id}/submit`, fo1.header, {
          expectedRevision: batch.revision,
        }),
        201,
      );
      expect(submitted.status).toBe('unknown');
      const [reconciled] = await t.runPeriodicJobs([RECONCILE_ACCOUNTING_JOB]);
      expect(reconciled, JSON.stringify(reconciled)).toMatchObject({ ran: true, failed: false });
      const exported = await ok<Batch>(
        get(t, `/v1/accounting-export-batches/${batch.id}`, fo1.header),
      );
      expect(exported.status).toBe('accepted');
      expect(fake.recordedBatches()).toBe(recordedBefore + 1);

      // SPK-PAY-010: a return after the export posts reversing entries, which go into the next
      // batch; the exported batch never changes.
      // The first session is closed: the next one's drawer pays the cash back.
      const nextSession = await ok<{ id: string }>(
        post(t, `/v1/pos-registers/${register.id}/sessions`, desk.header, {
          currency: 'USD',
          openingFloatMinor: 5_000,
        }),
        201,
      );
      const returned = await ok<Sale & { returns: Array<{ id: string; amountMinor: number }> }>(
        post(t, `/v1/pos-sales/${cash.id}/returns`, fo1.header, {
          lines: [{ saleLineId: paidCash.lines[0]!.id, quantity: 1 }],
          tenderKind: 'cash',
          registerSessionId: nextSession.id,
          reason: 'Damaged bottle',
        }),
        201,
      );
      expect(returned.returns[0]).toMatchObject({ amountMinor: 1_083 });
      t.clock.advance(MINUTE);
      const next = await ok<Batch>(
        post(t, '/v1/accounting-export-batches', fo1.header, {
          periodStart,
          periodEnd: t.clock.now().toISOString(),
        }),
        201,
      );
      expect(next.lines.map((l) => [l.ledgerAccount, l.debitMinor, l.creditMinor])).toEqual(
        expect.arrayContaining([
          ['pos_revenue', 1_000, 0],
          ['taxes_payable', 83, 0],
          ['cash_on_hand', 0, 1_083],
        ]),
      );
      expect(next.lines).toHaveLength(3);
      expect(
        await ok<Batch>(get(t, `/v1/accounting-export-batches/${batch.id}`, fo1.header)),
      ).toEqual(exported);
    } finally {
      await t.close();
    }
  });
});
