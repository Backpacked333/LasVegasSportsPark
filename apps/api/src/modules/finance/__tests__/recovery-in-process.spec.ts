import { DomainError } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecoveryMode } from '../../../kernel';
import { customerPrincipal, staffPrincipal, type TestApp } from '../../../testing';
import { CreditsService } from '../services/credits.service';
import { ObligationsService } from '../services/obligations.service';
import { RefundsService } from '../services/refunds.service';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { createCapturedPaymentFixture, createObligationFixture } from '../testing/finance-fixtures';
import { adult, financeTestApp, type Actor } from './support';

/**
 * R3-OPERATIONS-02 / R3-DOCS-TRUTH-3-07 (§5.8 "recovery reconciles external facts before normal
 * operation resumes", SPK-AT-028): the kernel's RecoveryGuard refuses finance's HTTP routes, but
 * support's case refund, an automation apply and a migration import apply call finance in process.
 * The refund request, credit issue, obligation create and obligation payment commands therefore
 * refuse themselves during recovery, with the guard's answer, before anything is reserved,
 * recorded or sent to the provider.
 */
describe('finance money commands refuse in-process callers during recovery (R3-OPERATIONS-02, SPK-AT-028)', () => {
  let t: TestApp;
  let payer: Actor;
  let paymentAttemptId: string;
  let obligationId: string;

  beforeAll(async () => {
    t = await financeTestApp();
    payer = await adult(t);
    paymentAttemptId = (
      await createCapturedPaymentFixture(t, { payerPersonId: payer.personId, amountMinor: 5_000 })
    ).paymentAttemptId;
    obligationId = await createObligationFixture(t, {
      debtorPersonId: payer.personId,
      amountMinor: 2_000,
    });
    expect(await t.app.get(RecoveryMode).enterAll('restore-in-process')).toBe(1);
  });
  afterAll(async () => {
    await t?.close();
  });

  async function refusal(command: Promise<unknown>): Promise<void> {
    const error = await command.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('INTEGRATION_UNAVAILABLE');
    expect((error as DomainError).details).toEqual({ reason: 'recovery_mode' });
  }

  const count = async (table: 'refund_attempts' | 'credits' | 'obligations' | 'payment_attempts') =>
    Number(
      (
        await t.db
          .selectFrom(table)
          .select((eb) => eb.fn.countAll().as('n'))
          .where('organization_id', '=', t.organizationId)
          .executeTakeFirstOrThrow()
      ).n,
    );

  it('§5.8: a refund request reserves nothing and calls no provider', async () => {
    const finance = staffPrincipal(t.organizationId, ['finance_operator']);
    const before = await count('refund_attempts');
    await refusal(
      t.app
        .get(RefundsService)
        .request(finance, paymentAttemptId, { amountMinor: 1_000, reason: 'goodwill' }, null),
    );
    expect(await count('refund_attempts')).toBe(before);
    const refundable = await t.db
      .selectFrom('payment_refundables')
      .select(['reserved_minor', 'refunded_minor'])
      .where('payment_attempt_id', '=', paymentAttemptId)
      .executeTakeFirstOrThrow();
    expect(refundable).toEqual({ reserved_minor: 0, refunded_minor: 0 });
  });

  it('§5.8: a credit issue and an obligation create (the migration import apply path) record nothing', async () => {
    const finance = staffPrincipal(t.organizationId, ['finance_operator']);
    const credits = await count('credits');
    await refusal(
      t.app.get(CreditsService).issue(
        finance,
        {
          ownerPersonId: payer.personId,
          amountMinor: 5_000,
          currency: 'USD',
          permittedUses: ['obligation'],
          sourceKind: 'goodwill',
          reason: 'Opening balance',
        },
        null,
      ),
    );
    expect(await count('credits')).toBe(credits);
    const obligations = await count('obligations');
    await refusal(
      t.app.get(ObligationsService).create(
        finance,
        {
          debtor: { kind: 'person', personId: payer.personId },
          mode: 'individual',
          amountMinor: 3_000,
          currency: 'USD',
          dueAt: '2026-12-01T00:00:00Z',
          description: 'Opening balance',
          source: { kind: 'manual' },
        },
        null,
      ),
    );
    expect(await count('obligations')).toBe(obligations);
  });

  it('§5.8: an obligation payment starts no payment attempt', async () => {
    const attempts = await count('payment_attempts');
    await refusal(
      t.app
        .get(ObligationsService)
        .pay(
          customerPrincipal(t.organizationId, { personId: payer.personId }),
          obligationId,
          { paymentMethodToken: FakePaymentTokens.succeed },
          null,
        ),
    );
    expect(await count('payment_attempts')).toBe(attempts);
  });
});
