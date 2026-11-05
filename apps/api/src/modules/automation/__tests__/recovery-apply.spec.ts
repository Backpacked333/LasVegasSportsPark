import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecoveryMode } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import { createCapturedPaymentFixture } from '../../finance';
import { createPersonFixture } from '../../identity';
import { MigrationModule } from '../../migration';
import { AutomationModule } from '../automation.module';
import type { FakeAssistantProvider } from '../providers/fake-assistant.provider';
import { enableAutomation, fakeAssistant } from '../testing/automation-fixtures';
import { ASSISTANT_CAPABILITIES, CLOCK_START, key, staffMember, type Actor } from './automation';

/**
 * R3-OPERATIONS-02 (§5.8, SPK-AT-028, SPK-AUTO-003: an applied proposal runs the owning module's
 * normal command with all of its guards): finance refuses a refund during recovery after a restore
 * in the command itself, so an approved automation refund proposal applied while the organization
 * recovers is refused like `POST /payments/{id}/refunds`, and no refund is reserved or recorded.
 */
describe('automation refund proposals during recovery (R3-OPERATIONS-02, SPK-AT-028)', () => {
  let t: TestApp;
  let fake: FakeAssistantProvider;
  let financeOperator: Actor;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [MigrationModule, AutomationModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
      configure: enableAutomation(),
      capabilities: ASSISTANT_CAPABILITIES,
    });
    fake = fakeAssistant(t.app);
    financeOperator = await staffMember(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, body: object) =>
    t.http.post(path).set(financeOperator.header).set('Idempotency-Key', key()).send(body);

  it('§5.8 / SPK-AT-028: an approved refund proposal applied during recovery is refused; nothing is reserved or recorded', async () => {
    const payer = await createPersonFixture(t, { kind: 'adult' });
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: payer,
      amountMinor: 5000,
    });
    const prompt = `refund ${newId()}`;
    fake.script(prompt, [
      {
        type: 'tool_calls',
        calls: [
          {
            tool: 'finance.refund',
            arguments: {
              paymentAttemptId: payment.paymentAttemptId,
              amountMinor: 2000,
              reason: 'Charged twice',
            },
          },
        ],
      },
      { type: 'answer', text: 'Refund prepared.' },
    ]);
    const asked = await post('/v1/assistant/requests', { prompt });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const rec = asked.body.recommendations[0] as { id: string; revision: number };
    const approved = await post(`/v1/recommendations/${rec.id}/approve`, {
      expectedRevision: rec.revision,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // The restore happens between approval and apply.
    expect(await t.app.get(RecoveryMode).enterAll('restore-automation')).toBe(1);
    const applied = await post(`/v1/recommendations/${rec.id}/apply`, {
      expectedRevision: approved.body.revision,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(503);
    expect(applied.body).toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
      details: { reason: 'recovery_mode' },
    });
    const refunds = await t.db
      .selectFrom('refund_attempts')
      .select(['status'])
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .execute();
    expect(refunds).toEqual([]);
    const refundable = await t.db
      .selectFrom('payment_refundables')
      .select(['reserved_minor', 'refunded_minor'])
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .executeTakeFirstOrThrow();
    expect(refundable).toEqual({ reserved_minor: 0, refunded_minor: 0 });
    // the apply failed with a known outcome (nothing reserved), so it is not held as unknown
    const invocation = await t.db
      .selectFrom('tool_invocations')
      .select(['outcome', 'error_code'])
      .where('recommendation_id', '=', rec.id)
      .executeTakeFirstOrThrow();
    expect(invocation).toEqual({ outcome: 'failed', error_code: 'INTEGRATION_UNAVAILABLE' });
  });
});
