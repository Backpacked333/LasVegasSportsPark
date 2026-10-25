import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, newId } from '@sportspark/contracts';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { AutomationModule, enableAutomation, fakeAssistant } from '../../automation';
import type { FakeAssistantProvider } from '../../automation';
import { createCapturedPaymentFixture, RefundsService } from '../../finance';
import { createPersonFixture } from '../../identity';
import { MigrationModule } from '../migration.module';
import { createAuthorityAssignmentFixture } from '../testing/migration-fixtures';
import { key, post, staff, type Actor } from './support';

const HOUR = 3_600_000;

/**
 * §5.6 "a synchronized copy does not become an independent writer", §4.7 invariant 11: finance
 * guards its refund command itself (RECORD_AUTHORITY_PORT, implemented by this module), so an
 * in-process caller — support's refund helper, automation's refund proposal — is refused exactly
 * like `POST /payments/{id}/refunds` while the legacy system writes refunds (authority matrix
 * row 15).
 */
describe('record authority in-process (§5.6, §4.7 invariant 11, authority matrix row 15)', () => {
  let t: TestApp;
  let fake: FakeAssistantProvider;
  let financeOperator: Actor;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [MigrationModule, AutomationModule],
      principalResolver: 'module',
      clockStart: '2027-01-16T20:00:00.000Z',
      configure: enableAutomation(),
    });
    fake = fakeAssistant(t.app);
    financeOperator = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  const refundRows = (paymentAttemptId: string) =>
    t.db
      .selectFrom('refund_attempts')
      .select(['status', 'amount_minor'])
      .where('payment_attempt_id', '=', paymentAttemptId)
      .execute();

  const refundable = (paymentAttemptId: string) =>
    t.db
      .selectFrom('payment_refundables')
      .select(['reserved_minor', 'refunded_minor'])
      .where('payment_attempt_id', '=', paymentAttemptId)
      .executeTakeFirstOrThrow();

  it('§4.7 invariant 11: RefundsService.request called in-process is refused while the legacy system writes refunds, and runs once SportsPark is authoritative', async () => {
    const payer = await createPersonFixture(t, { kind: 'adult' });
    const payment = await createCapturedPaymentFixture(t, {
      payerPersonId: payer,
      amountMinor: 3000,
    });
    // Legacy writes refunds until the cutover instant one hour from now.
    const assignmentId = await createAuthorityAssignmentFixture(t, {
      recordCategory: 'refund',
      authoritativeSystem: 'legacy',
      effectiveTo: new Date(t.clock.now().getTime() + HOUR),
    });
    const refunds = t.app.get(RefundsService, { strict: false });
    const principal = staffPrincipal(t.organizationId, ['finance_operator']);
    let caught: unknown = null;
    try {
      await refunds.request(
        principal,
        payment.paymentAttemptId,
        { amountMinor: 1000, reason: 'Duplicate charge' },
        null,
      );
    } catch (error) {
      caught = error;
    }
    expect(DomainError.is(caught)).toBe(true);
    expect(caught).toMatchObject({
      code: 'ACCESS_DENIED',
      nextAction: 'write_in_authoritative_system',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'refund', assignmentId },
    });
    expect(await refundRows(payment.paymentAttemptId)).toEqual([]);
    expect(await refundable(payment.paymentAttemptId)).toEqual({
      reserved_minor: 0,
      refunded_minor: 0,
    });
    const audited = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .where('action', '=', 'finance.refund')
      .execute();
    expect(audited).toEqual([]);

    // After the cutover instant SportsPark is authoritative: the same in-process call refunds once.
    t.clock.advance(2 * HOUR);
    const refund = await refunds.request(
      principal,
      payment.paymentAttemptId,
      { amountMinor: 1000, reason: 'Duplicate charge' },
      null,
    );
    expect(refund.status).toBe('succeeded');
    expect(await refundRows(payment.paymentAttemptId)).toEqual([
      { status: 'succeeded', amount_minor: 1000 },
    ]);
  });

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
    const asked = await post(t, '/v1/assistant/requests', financeOperator, { prompt });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const rec = asked.body.recommendations[0] as { id: string; revision: number };
    const approved = await post(t, `/v1/recommendations/${rec.id}/approve`, financeOperator, {
      expectedRevision: rec.revision,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // A legacy refund assignment is in effect (at any scope) when the reviewer applies it.
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'refund',
      authoritativeSystem: 'legacy',
      facilityId: t.facilityId,
    });
    const applied = await t.http
      .post(`/v1/recommendations/${rec.id}/apply`)
      .set(financeOperator.header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: approved.body.revision });
    expect(applied.status, JSON.stringify(applied.body)).toBe(403);
    expect(applied.body).toMatchObject({
      code: 'ACCESS_DENIED',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'refund' },
    });
    expect(await refundRows(payment.paymentAttemptId)).toEqual([]);
    expect(await refundable(payment.paymentAttemptId)).toEqual({
      reserved_minor: 0,
      refunded_minor: 0,
    });
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
