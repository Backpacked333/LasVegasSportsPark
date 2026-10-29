import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecoveryMode } from '../../kernel';
import { DOMAIN_MODULES } from '../../modules';
import { FakePaymentTokens } from '../../modules/finance';
import {
  adult,
  basketFor,
  drain,
  offering,
  post,
  provider,
  quoteFor,
  staff,
  worker,
  type Actor,
} from '../../modules/finance/__tests__/support';
import { fakeFeeFor } from '../../modules/finance/providers/fake-payment.provider';
import { createTestApp, type TestApp } from '../../testing';

const RESTORE = 'restore-at028';

/**
 * SPK-AT-028 (spec §6.1): "Backup restored after external transactions — external facts
 * reconciled before normal operations resume", over the assembled application. §5.8: restoring
 * an older database cannot undo payments; recovery preserves journals, reconciles external facts
 * and explicitly hands authority back. The restored state is the one the backup held: a checkout
 * whose provider call timed out after the provider captured the money (outcome `unknown` locally),
 * and an installment plan with an installment falling due. The real restore tooling (DEC-021), the
 * provider feed that recreates post-backup facts (DEC-019) and the named recovery owner (DEC-068)
 * are pending.
 */
describe('SPK-AT-028: backup restored after external transactions (assembled application)', () => {
  let t: TestApp;
  let parent: Actor;
  let finance: Actor;
  let manager: Actor;
  let support: Actor;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00Z',
    });
    parent = await adult(t);
    finance = await staff(t, ['finance_operator']);
    manager = await staff(t, ['general_manager']);
    support = await staff(t, ['support_operator']);
  });
  afterAll(async () => {
    await t?.close();
  });

  /** What the provider settled: every distinct charge it captured, net of its fee. */
  const providerNet = () => {
    const seen = new Map<string, number>();
    for (const call of provider(t).paymentCalls) seen.set(call.idempotencyKey, call.amountMinor);
    return [...seen.values()].reduce((acc, amount) => acc + amount - fakeFeeFor(amount), 0);
  };
  const settle = (reference: string) =>
    post(t, '/v1/settlement-reconciliations', finance.header, {
      kind: 'processor_settlement',
      provider: 'fake-payments',
      periodStart: '2026-11-01T00:00:00Z',
      periodEnd: t.clock.now().toISOString(),
      currency: 'USD',
      reportedMinor: providerNet(),
      externalReference: reference,
    });
  const checkout = async (token: string, extra: Record<string, unknown> = {}) => {
    const setup = await offering(t, { basePriceMinor: 30_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId, extra);
    return post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: token },
      ...(extra['paymentPlan'] ? { authorizeFutureInstallments: true } : {}),
    });
  };
  const resume = (actor: Actor) =>
    post(t, '/v1/recovery/resume', actor.header, { reason: 'provider facts reconciled' });
  const recoveryStatus = async () =>
    (await t.http.get('/v1/recovery').set(manager.header)).body as {
      active: boolean;
      exceptionId: string | null;
      blockers: Array<{ code: string }>;
    };

  it('SPK-AT-028 / §5.8: after a restore, financial commands and new charges stay paused until provider facts are reconciled and the general manager resumes normal operation', async () => {
    // state at the backup: an installment plan (first installment paid) and a checkout whose
    // provider call timed out after the provider captured the money
    const plan = await checkout(FakePaymentTokens.succeed, {
      paymentPlan: { kind: 'installments', count: 3 },
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body.status).toBe('completed');
    const unknown = await checkout(FakePaymentTokens.timeout);
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(201);
    expect(unknown.body.payment.status).toBe('unknown');
    await drain(t);

    // the restore: the process boots with RECOVERY_RESTORE_REFERENCE (the boot path)
    expect(await t.app.get(RecoveryMode).enterAll(RESTORE)).toBe(1);
    const entered = await recoveryStatus();
    expect(entered.active).toBe(true);
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'severity', 'owner_queue', 'status'])
      .where('id', '=', entered.exceptionId as string)
      .executeTakeFirstOrThrow();
    expect(exception).toEqual({
      category: 'reliability.recovery_mode',
      severity: 'critical',
      owner_queue: 'general_manager',
      status: 'open',
    });

    // consequential financial commands are refused with a clear error; reads stay available
    const charges = provider(t).paymentCalls.length;
    const setup = await offering(t, { basePriceMinor: 5_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const paused = await post(t, '/v1/registration-quotes', parent.header, { basketId });
    expect(paused.status, JSON.stringify(paused.body)).toBe(503);
    expect(paused.body).toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      nextAction: 'retry_later',
      details: { reason: 'recovery_mode' },
    });
    const refund = await post(
      t,
      `/v1/payments/${plan.body.payment.id as string}/refunds`,
      finance.header,
      { amountMinor: 1_000, reason: 'goodwill' },
    );
    expect(refund.status).toBe(503);
    expect(
      (await t.http.get(`/v1/orders/${plan.body.orderId as string}`).set(parent.header)).status,
    ).toBe(200);

    // resuming before the facts are reconciled is refused, naming what blocks it
    const early = await resume(manager);
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(early.body.details.code).toBe('recovery_reconciliation_incomplete');
    expect(early.body.details.blockers.map((b: { code: string }) => b.code).sort()).toEqual(
      ['payment_outcomes_unresolved', 'processor_settlement_missing'].sort(),
    );
    // the Today card cannot be closed to skip reconciliation
    const skip = await post(
      t,
      `/v1/exceptions/${entered.exceptionId as string}/resolve`,
      support.header,
      { reason: 'looks fine' },
    );
    expect(skip.status, JSON.stringify(skip.body)).toBe(409);
    expect(skip.body.details.code).toBe('recovery_resume_required');

    // a settlement recorded while the unknown capture is unreconciled shows the discrepancy
    const discrepancy = await settle('payout-before');
    expect(discrepancy.status, JSON.stringify(discrepancy.body)).toBe(201);
    expect(discrepancy.body.status).toBe('discrepancy');
    expect(
      (await recoveryStatus()).blockers
        .map((b) => b.code)
        .includes('processor_settlement_discrepancy'),
    ).toBe(true);

    // the installment falls due and the unknown attempt is past the reconciliation threshold: the
    // worker resolves the attempt from provider evidence (by its idempotency key) but starts no
    // new charge on restored state; the checkout finalizes and Finance's settlement now balances
    const planId = (
      await t.http.get(`/v1/orders/${plan.body.orderId as string}`).set(parent.header)
    ).body.installmentPlanId as string;
    t.clock.set('2026-12-02T15:00:01Z');
    const reconcile = await worker(t).runOnce();
    expect(reconcile.paymentsReconciled).toBeGreaterThanOrEqual(1);
    expect(reconcile.installmentsCollected).toBe(0);
    expect(provider(t).paymentCalls.length).toBe(charges);
    await drain(t);
    const finalized = await t.http
      .get(`/v1/registration-checkouts/${unknown.body.id as string}`)
      .set(parent.header);
    expect(finalized.body.status).toBe('completed');
    t.clock.advance(60_000);
    const balanced = await settle('payout-after');
    expect(balanced.status, JSON.stringify(balanced.body)).toBe(201);
    expect(balanced.body.status, JSON.stringify(balanced.body)).toBe('balanced');
    expect((await recoveryStatus()).blockers).toEqual([]);

    // only the recovery owner hands authority back (DEC-068 pending: the general manager)
    for (const who of [support, finance]) {
      const refused = await resume(who);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    }
    const resumed = await resume(manager);
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({ active: false, blockers: [] });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'operations.resume_after_recovery')
      .execute();
    expect(audit).toEqual([
      { action: 'operations.resume_after_recovery', reason: 'provider facts reconciled' },
    ]);

    // normal operation: commands succeed and the due installment is collected once
    const fresh = await basketFor(t, parent, [await offering(t, { basePriceMinor: 5_000 })]);
    const quote = await post(t, '/v1/registration-quotes', parent.header, {
      basketId: fresh.basketId,
    });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    const after = await worker(t).runOnce();
    expect(after.installmentsCollected).toBe(1);
    const installments = await t.http.get(`/v1/installment-plans/${planId}`).set(parent.header);
    expect(installments.body.installments.map((i: { status: string }) => i.status)).toEqual([
      'paid',
      'paid',
      'scheduled',
    ]);

    // a restart with the same restore reference does not re-enter a resumed recovery
    expect(await t.app.get(RecoveryMode).enterAll(RESTORE)).toBe(0);
    expect((await recoveryStatus()).active).toBe(false);
    expect((await resume(manager)).status).toBe(409);
  });

  it('SPK-AT-028: a process started with RECOVERY_RESTORE_REFERENCE enters recovery at boot and pauses financial commands', async () => {
    const booted = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00Z',
      env: { RECOVERY_RESTORE_REFERENCE: 'restore-boot' },
    });
    try {
      const gm = await staff(booted, ['general_manager']);
      const status = await booted.http.get('/v1/recovery').set(gm.header);
      expect(status.body).toMatchObject({ active: true, restoreReference: 'restore-boot' });
      const someone = await adult(booted);
      const setup = await offering(booted, { basePriceMinor: 5_000 });
      const { basketId } = await basketFor(booted, someone, [setup], { hold: false });
      const refused = await post(booted, '/v1/registration-quotes', someone.header, { basketId });
      expect(refused.status).toBe(503);
      expect(refused.body.details).toEqual({ reason: 'recovery_mode' });
    } finally {
      await booted.close();
    }
  });
});
