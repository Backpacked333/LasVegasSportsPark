import { systemPrincipal, type FinancialConsequence } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import { EnrollmentModule } from '../enrollment.module';
import {
  ENROLLMENT_PORT,
  FINANCE_POLICY_IMPL,
  type EnrollmentPort,
  type FinancePolicyPort,
} from '../enrollment.ports';
import {
  CLOCK_START,
  acknowledge,
  adult,
  basketWith,
  child,
  key,
  offering,
  post,
  type Actor,
} from './support';

/** A finance policy that charges or credits the price difference (stands in for DEC-009). */
const differencePolicy: FinancePolicyPort = {
  transferConsequence: async (_organizationId, input) => {
    const diff = (input.toPrice?.amountMinor ?? 0) - (input.fromPrice?.amountMinor ?? 0);
    const consequence: FinancialConsequence = {
      kind: diff > 0 ? 'charge' : diff < 0 ? 'credit' : 'none',
      amountMinor: diff === 0 ? null : Math.abs(diff),
      currency: diff === 0 ? null : 'USD',
      explanation: 'The price difference between the offerings.',
      policyVersionId: null,
    };
    return consequence;
  },
  cancellationConsequence: async () => ({
    kind: 'none',
    amountMinor: null,
    currency: null,
    explanation: 'No consequence.',
    policyVersionId: null,
  }),
};

/**
 * SPK-REG-010 ("refund, credit or additional charge"), §4.7 invariant 12 (no lost required
 * follow-up after a committed operation), §4.11 steps 7-9: the consequence accepted with a
 * transfer is a recorded fact with its amount, and the money side has an owner (DEC-009 pending).
 */
describe('transfer financial consequence is recorded and owned (SPK-REG-010, §4.7-12)', () => {
  let t: TestApp;
  let parent: Actor;
  let coGuardian: Actor;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [EnrollmentModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
      providers: [{ provide: FINANCE_POLICY_IMPL, useValue: differencePolicy }],
    });
    parent = await adult(t);
    coGuardian = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  async function confirmedIn(fromPrice: number) {
    const from = await offering(t, { basePriceMinor: fromPrice });
    const kid = await child(t, [parent, coGuardian]);
    await acknowledge(t, from, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: from.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    const enrollmentId = held.body.lines[0].enrollmentId as string;
    await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app
        .get<EnrollmentPort>(ENROLLMENT_PORT)
        .confirmEnrollment(trx, t.organizationId, enrollmentId, {
          orderRef: `order-${enrollmentId}`,
          actor: systemPrincipal(t.organizationId, 'finance.checkout'),
          correlationId: null,
        }),
    );
    return { kid, enrollmentId };
  }

  async function target(price: number, kid: string) {
    const to = await offering(t, {
      basePriceMinor: price,
      startsOn: '2027-02-01',
      endsOn: '2027-04-30',
    });
    await acknowledge(t, to, kid, parent.personId);
    return to.offeringId;
  }

  const exceptionsFor = (enrollmentId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('affected_id', '=', enrollmentId)
      .where('category', '=', 'enrollment.transfer_consequence_pending')
      .execute();

  it('SPK-REG-010 / §4.7 invariant 12: an accepted transfer charge is recorded with its amount and opens a finance follow-up', async () => {
    const { kid, enrollmentId } = await confirmedIn(10_000);
    const targetOfferingId = await target(15_000, kid);
    const idempotencyKey = key();
    const transfer = () =>
      t.http
        .post(`/v1/enrollments/${enrollmentId}/transfer`)
        .set(parent.header)
        .set('Idempotency-Key', idempotencyKey)
        .send({ targetOfferingId, expectedRevision: 2, commit: true, acceptConsequence: true });
    const committed = await transfer();
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    const charge = {
      kind: 'charge',
      amountMinor: 5_000,
      currency: 'USD',
    };
    expect(committed.body.financialConsequence).toMatchObject(charge);
    expect(committed.body.previousEnrollment).toMatchObject({
      status: 'transferred',
      transferConsequence: charge,
    });
    // The fact on the transferred-from enrollment, the event, the audit and the operation.
    const row = await t.db
      .selectFrom('enrollments')
      .select(['transfer_consequence', 'last_operation_id'])
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(row.transfer_consequence).toMatchObject(charge);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'enrollment.enrollment_transferred')
      .where('aggregate_id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ financialConsequence: charge });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('action', '=', 'enrollment.transfer_enrollment')
      .where('target_id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ consequence: charge, consequenceAccepted: true });
    const operation = await t.db
      .selectFrom('operations')
      .select(['status', 'result'])
      .where('id', '=', row.last_operation_id as string)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({
      status: 'succeeded',
      result: { financialConsequence: charge },
    });
    // The money side has an owner until DEC-009 decides how finance settles it.
    expect(await exceptionsFor(enrollmentId)).toEqual([
      expect.objectContaining({
        status: 'open',
        owner_queue: 'finance_operator',
        affected_type: 'enrollment',
        details: expect.objectContaining({
          consequence: expect.objectContaining(charge),
          toEnrollmentId: committed.body.newEnrollment.id,
        }),
      }),
    ]);
    // A replay changes nothing and raises nothing twice.
    const replay = await transfer();
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await exceptionsFor(enrollmentId)).toHaveLength(1);
    // Payer privacy (SPK-AT-004): another guardian sees the participation, not the money fact.
    const seen = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(coGuardian.header);
    expect(seen.status).toBe(200);
    expect(seen.body.transferConsequence).toBeNull();
    const own = await t.http.get(`/v1/enrollments/${enrollmentId}`).set(parent.header);
    expect(own.body.transferConsequence).toMatchObject(charge);
  });

  it('SPK-REG-010: an accepted transfer credit is recorded the same way; a transfer with no consequence raises nothing', async () => {
    const credited = await confirmedIn(15_000);
    const cheaper = await target(10_000, credited.kid);
    const down = await post(t, `/v1/enrollments/${credited.enrollmentId}/transfer`, parent.header, {
      targetOfferingId: cheaper,
      expectedRevision: 2,
      commit: true,
      acceptConsequence: true,
    });
    expect(down.status).toBe(200);
    expect(down.body.previousEnrollment.transferConsequence).toMatchObject({
      kind: 'credit',
      amountMinor: 5_000,
    });
    expect(await exceptionsFor(credited.enrollmentId)).toHaveLength(1);

    const even = await confirmedIn(12_000);
    const same = await target(12_000, even.kid);
    const flat = await post(t, `/v1/enrollments/${even.enrollmentId}/transfer`, parent.header, {
      targetOfferingId: same,
      expectedRevision: 2,
      commit: true,
    });
    expect(flat.status).toBe(200);
    expect(flat.body.previousEnrollment.transferConsequence).toMatchObject({ kind: 'none' });
    expect(await exceptionsFor(even.enrollmentId)).toEqual([]);
  });
});
