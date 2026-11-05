import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createCapturedPaymentFixture } from '../../finance';
import { createPersonFixture } from '../../identity';
import { MigrationModule, createAuthorityAssignmentFixture } from '../../migration';
import { AutomationModule } from '../automation.module';
import type { FakeAssistantProvider } from '../providers/fake-assistant.provider';
import { enableAutomation, fakeAssistant } from '../testing/automation-fixtures';
import { ASSISTANT_CAPABILITIES, CLOCK_START, key, staffMember, type Actor } from './automation';

/**
 * §5.6 "a synchronized copy does not become an independent writer", §4.7 invariant 11,
 * SPK-AUTO-003 (an applied proposal runs the owning module's normal command with all of its
 * guards): finance guards its refund command itself (RECORD_AUTHORITY_PORT, implemented by the
 * migration module), so automation's refund proposal is refused at apply exactly like
 * `POST /payments/{id}/refunds` while the legacy system writes refunds (authority matrix row 15).
 */
describe('automation refund proposals under legacy refund authority (§5.6, SPK-AUTO-003)', () => {
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

  it('§5.6 / SPK-AUTO-003: an approved automation refund proposal is refused at apply while the legacy system writes refunds; no refund is recorded', async () => {
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
    // A legacy refund assignment is in effect (at any scope) when the reviewer applies it.
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'refund',
      authoritativeSystem: 'legacy',
      facilityId: t.facilityId,
    });
    const applied = await post(`/v1/recommendations/${rec.id}/apply`, {
      expectedRevision: approved.body.revision,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(403);
    expect(applied.body).toMatchObject({
      code: 'ACCESS_DENIED',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'refund' },
    });
    const refunds = await t.db
      .selectFrom('refund_attempts')
      .select(['status', 'amount_minor'])
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .execute();
    expect(refunds).toEqual([]);
    const refundable = await t.db
      .selectFrom('payment_refundables')
      .select(['reserved_minor', 'refunded_minor'])
      .where('payment_attempt_id', '=', payment.paymentAttemptId)
      .executeTakeFirstOrThrow();
    expect(refundable).toEqual({ reserved_minor: 0, refunded_minor: 0 });
    const invocation = await t.db
      .selectFrom('tool_invocations')
      .select(['outcome', 'error_code'])
      .where('recommendation_id', '=', rec.id)
      .executeTakeFirstOrThrow();
    expect(invocation.outcome).not.toBe('succeeded');
    expect(invocation.outcome).not.toBe('unknown');
    expect(invocation.error_code).toBe('ACCESS_DENIED');
  });
});
