import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPolicyVersionFixture } from '../../catalog';
import {
  BASKET_PORT,
  ENROLLMENT_PORT,
  type BasketPort,
  type EnrollmentPort,
} from '../enrollment.ports';
import {
  acknowledge,
  adult,
  basketWith,
  child,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const MINUTE = 60_000;
const FEE = [
  {
    code: 'registration',
    label: 'Registration fee',
    kind: 'fee' as const,
    amountMinor: 2_500,
    inclusive: false,
  },
];

/**
 * Registration integrity (SPK-PAY-001/002, SPK-REG-002/004/007, SPK-AT-004, §4.11): what a basket
 * owes, which application a line reuses, what an override covers, who ends a basket while a
 * checkout runs, and when a partial basket is payable.
 */
describe('registration integrity: price basis, applications, overrides, checkout and partial baskets', () => {
  let t: TestApp;
  let parent: Actor;
  let programManager: Actor;
  let financeOperator: Actor;
  let uow: UnitOfWork;
  let enrollmentPort: EnrollmentPort;
  let basketPort: BasketPort;
  const finance = () => systemPrincipal(t.organizationId, 'finance.checkout');

  beforeAll(async () => {
    t = await enrollmentTestApp();
    parent = await adult(t);
    programManager = await staff(t, ['program_manager']);
    financeOperator = await staff(t, ['finance_operator']);
    uow = t.app.get(UnitOfWork);
    enrollmentPort = t.app.get(ENROLLMENT_PORT);
    basketPort = t.app.get(BASKET_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  async function kidFor(setup: OfferingSetup, guardians: Actor[] = [parent], dateOfBirth?: string) {
    const kid = await child(t, guardians, { dateOfBirth });
    await acknowledge(t, setup, kid, guardians[0]!.personId);
    return kid;
  }
  const enrollmentsOf = (kid: string) =>
    t.db
      .selectFrom('enrollments')
      .select(['id', 'status', 'order_ref', 'price_snapshot'])
      .where('participant_person_id', '=', kid)
      .orderBy('created_at')
      .execute();

  // -------------------------------------------------------------------------------------------
  // enrollment-03: SPK-PAY-001/002 — the owes-nothing path counts fees and the current rule
  // -------------------------------------------------------------------------------------------

  it('SPK-PAY-002: a line whose only charge is an approved fee owes the fee; /complete refuses with PAYMENT_REQUIRED', async () => {
    const setup = await offering(t, { basePriceMinor: 0, chargeLines: FEE });
    const kid = await kidFor(setup);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    expect(held.body.lines[0].price).toMatchObject({ basePriceMinor: 0, chargeLines: [FEE[0]] });
    const completed = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    expect(completed.status).toBe(409);
    expect(completed.body.details).toMatchObject({
      code: 'PAYMENT_REQUIRED',
      lineIds: [held.body.lines[0].id],
    });
    expect(await enrollmentsOf(kid)).toEqual([
      expect.objectContaining({ status: 'pending', order_ref: null }),
    ]);
  });

  it('SPK-PAY-001: a basket is priced from the rule effective at hold and completion, not when the line was added', async () => {
    const setup = await offering(t, { basePriceMinor: 0 });
    const kid = await kidFor(setup);
    // Finance schedules the season price; the open basket was filled while the old rule applied.
    const rule = await post(
      t,
      `/v1/offerings/${setup.offeringId}/price-rules`,
      financeOperator.header,
      {
        effectiveFrom: new Date(t.clock.now().getTime() + 60 * MINUTE).toISOString(),
        basePriceMinor: 15_000,
        currency: 'USD',
        chargeLines: [],
      },
    );
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    expect(
      (basket.body['lines'] as Array<{ price: { basePriceMinor: number } }>)[0]?.price,
    ).toMatchObject({
      basePriceMinor: 0,
    });
    t.clock.advance(2 * 60 * MINUTE);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    expect(held.body.lines[0].price).toMatchObject({ basePriceMinor: 15_000 });
    expect(held.body.subtotalMinor).toBe(15_000);
    const completed = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    expect(completed.status).toBe(409);
    expect(completed.body.details.code).toBe('PAYMENT_REQUIRED');
    const [enrollment] = await enrollmentsOf(kid);
    expect(enrollment).toMatchObject({ status: 'pending', order_ref: null });
    expect(enrollment?.price_snapshot).toMatchObject({ basePriceMinor: 15_000 });
  });

  // -------------------------------------------------------------------------------------------
  // enrollment-05: SPK-AT-004 — a stale accepted application of another household never blocks
  // -------------------------------------------------------------------------------------------

  it('SPK-AT-004: a released, removed or abandoned basket line of one guardian does not block the other guardian', async () => {
    const setup = await offering(t, { basePriceMinor: 0 });
    for (const ending of ['released', 'removed', 'abandoned'] as const) {
      const first = await adult(t);
      const second = await adult(t);
      const kid = await kidFor(setup, [first, second]);
      const basket = await basketWith(t, first, [
        { participantPersonId: kid, offeringId: setup.offeringId },
      ]);
      if (ending === 'released') {
        expect(
          (await post(t, `/v1/baskets/${basket.id}/release`, first.header, { reason: 'later' }))
            .status,
        ).toBe(200);
      } else if (ending === 'removed') {
        const lineId = (basket.body['lines'] as Array<{ id: string }>)[0]!.id;
        expect(
          (await post(t, `/v1/baskets/${basket.id}/lines/${lineId}/remove`, first.header, {}))
            .status,
        ).toBe(200);
      } else {
        t.clock.advance(5 * 24 * 60 * MINUTE);
      }
      // The other guardian can apply, and register through their own basket.
      const applied = await post(t, '/v1/applications', second.header, {
        offeringId: setup.offeringId,
        participantPersonId: kid,
        intent: 'youth',
      });
      expect(applied.status, `${ending}: ${JSON.stringify(applied.body)}`).toBe(201);
      const own = await basketWith(t, second, [
        { participantPersonId: kid, offeringId: setup.offeringId },
      ]);
      expect(
        (own.body['lines'] as Array<{ applicationId: string }>)[0]?.applicationId,
        ending,
      ).toBe(applied.body.id);
      expect((await post(t, `/v1/baskets/${own.id}/hold`, second.header, {})).status).toBe(200);
      expect(
        (await enrollmentsOf(kid)).filter((e) => ['pending', 'confirmed'].includes(e.status)),
      ).toHaveLength(1);
    }
  });

  it('SPK-AT-004: after both guardians add the child and the winner cancels, the winner can register again', async () => {
    const setup = await offering(t, { basePriceMinor: 0 });
    const first = await adult(t);
    const second = await adult(t);
    const kid = await kidFor(setup, [first, second]);
    const a = await basketWith(t, first, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    const b = await basketWith(t, second, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${a.id}/hold`, first.header, {})).status).toBe(200);
    // One equivalent entitlement: the second hold loses at the database (§4.7 invariant 2).
    const lost = await post(t, `/v1/baskets/${b.id}/hold`, second.header, {});
    expect(lost.status).toBe(409);
    expect(lost.body.code).toBe('DUPLICATE_ENTITLEMENT');
    expect(JSON.stringify(lost.body)).not.toContain(first.personId);
    const done = await post(t, `/v1/baskets/${a.id}/complete`, first.header, {});
    expect(done.status).toBe(200);
    const enrollmentId = done.body.lines[0].enrollmentId as string;
    const canceled = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, first.header, {
      expectedRevision: 2,
      reason: 'Schedule changed',
    });
    expect(canceled.status).toBe(200);
    // The other guardian's stale accepted application no longer blocks re-registration.
    const again = await basketWith(t, first, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${again.id}/hold`, first.header, {})).status).toBe(200);
  });

  // -------------------------------------------------------------------------------------------
  // enrollment-07: SPK-REG-002 — an override covers what it recorded, for its own intent
  // -------------------------------------------------------------------------------------------

  async function overriddenTeen(setup: OfferingSetup) {
    const teen = await kidFor(setup, [parent], '2010-02-01');
    const applied = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: teen,
      intent: 'youth',
    });
    expect(applied.body.status).toBe('submitted');
    const overridden = await post(
      t,
      `/v1/applications/${applied.body.id as string}/override-eligibility`,
      programManager.header,
      { expectedRevision: 1, reason: 'Plays up with coach approval' },
    );
    expect(overridden.status).toBe(200);
    expect(
      overridden.body.override.originalReasons
        .filter((r: { severity: string }) => r.severity === 'blocking')
        .map((r: { code: string }) => r.code),
    ).toEqual(['above_maximum_age']);
    return { teen, applicationId: applied.body.id as string };
  }

  it('SPK-REG-002: an overridden application from POST /applications is reused by the household basket line and lets the hold through', async () => {
    const setup = await offering(t, { basePriceMinor: 0 });
    const { teen, applicationId } = await overriddenTeen(setup);
    const basket = await basketWith(t, parent, [
      { participantPersonId: teen, offeringId: setup.offeringId },
    ]);
    expect((basket.body['lines'] as Array<{ applicationId: string }>)[0]?.applicationId).toBe(
      applicationId,
    );
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    const eligibility = held.body.lines[0].eligibility;
    expect(eligibility).toMatchObject({ eligible: true, overridden: true });
    // No stored result says eligible while still carrying a blocking reason.
    expect(
      eligibility.reasons.filter((r: { severity: string }) => r.severity === 'blocking'),
    ).toEqual([]);
  });

  it('SPK-REG-002: an override covers only the reasons it recorded; a later blocking reason still blocks the hold', async () => {
    const setup = await offering(t, {
      basePriceMinor: 0,
      registrationClosesAt: new Date(t.clock.now().getTime() + 60 * MINUTE),
    });
    const { teen } = await overriddenTeen(setup);
    const basket = await basketWith(t, parent, [
      { participantPersonId: teen, offeringId: setup.offeringId },
    ]);
    t.clock.advance(2 * 60 * MINUTE);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(422);
    expect(held.body.code).toBe('ELIGIBILITY_FAILED');
    expect(held.body.details.reasons.map((r: { code: string }) => r.code)).toEqual([
      'registration_closed',
    ]);
    expect(held.body.details.overriddenReasonCodes).toEqual(['above_maximum_age']);
    expect(await enrollmentsOf(teen)).toEqual([]);
  });

  it('SPK-REG-002 / §4.7-3: an override never covers a line of another intent, so it cannot take a place without a hold', async () => {
    const setup = await offering(t, {
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const seated = await kidFor(setup);
    const first = await basketWith(t, parent, [
      { participantPersonId: seated, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${first.id}/hold`, parent.header, {})).status).toBe(200);
    expect((await post(t, `/v1/baskets/${first.id}/complete`, parent.header, {})).status).toBe(200);
    const { teen, applicationId } = await overriddenTeen(setup);
    // A create_team_entry line on a term offering holds no seat; the youth override must not
    // cover it. (A rental request is never a bare basket line: ENR-10, SPK-COND-003.)
    const basket = await basketWith(t, parent, [
      { participantPersonId: teen, offeringId: setup.offeringId, intent: 'create_team_entry' },
    ]);
    expect((basket.body['lines'] as Array<{ applicationId: string }>)[0]?.applicationId).not.toBe(
      applicationId,
    );
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(422);
    expect(held.body.code).toBe('ELIGIBILITY_FAILED');
    expect(held.body.details.reasons.map((r: { code: string }) => r.code)).toEqual(
      expect.arrayContaining(['intent_offering_mismatch', 'above_maximum_age']),
    );
    const pools = await t.db
      .selectFrom('capacity_pools')
      .select(['capacity', 'committed', 'held'])
      .where('offering_id', '=', setup.offeringId)
      .execute();
    expect(pools).toEqual([{ capacity: 1, committed: 1, held: 0 }]);
    expect(await enrollmentsOf(teen)).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // enrollment-10: §4.11 / SPK-PAY-007 — a checking_out basket is finance's
  // -------------------------------------------------------------------------------------------

  it('§4.11 / SPK-PAY-007: a checking_out basket is finance’s; customer release and enrollment cancel are refused', async () => {
    const setup = await offering(t);
    const kid = await kidFor(setup);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    const enrollmentId = held.body.lines[0].enrollmentId as string;
    await uow.run(({ trx }) =>
      basketPort.startCheckout(trx, t.organizationId, basket.id, 'order-run', finance()),
    );
    const current = await t.http.get(`/v1/baskets/${basket.id}`).set(parent.header);
    expect(current.body.status).toBe('checking_out');
    const released = await post(t, `/v1/baskets/${basket.id}/release`, parent.header, {
      expectedRevision: current.body.revision,
      reason: 'changed my mind',
    });
    expect(released.status).toBe(409);
    expect(released.body.details).toMatchObject({
      code: 'CHECKOUT_IN_PROGRESS',
      orderRef: 'order-run',
    });
    const canceled = await post(t, `/v1/enrollments/${enrollmentId}/cancel`, parent.header, {
      expectedRevision: 1,
      reason: 'changed my mind',
    });
    expect(canceled.status).toBe(409);
    expect(canceled.body.details.code).toBe('CHECKOUT_IN_PROGRESS');
    expect(await enrollmentsOf(kid)).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect(
      (
        await t.db.selectFrom('holds').select('status').where('basket_id', '=', basket.id).execute()
      ).map((h) => h.status),
    ).toEqual(['active']);
    // The captured payment confirms the place it is for.
    await uow.run(async ({ trx }) => {
      await enrollmentPort.confirmEnrollment(trx, t.organizationId, enrollmentId, {
        actor: finance(),
        orderRef: 'order-run',
      });
      await basketPort.finishCheckout(trx, t.organizationId, basket.id, 'fulfilled', finance());
    });
    expect((await enrollmentsOf(kid))[0]?.status).toBe('confirmed');
    // Finance (not the customer) ends an abandoned checkout.
    const other = await kidFor(setup);
    const second = await basketWith(t, parent, [
      { participantPersonId: other, offeringId: setup.offeringId },
    ]);
    expect((await post(t, `/v1/baskets/${second.id}/hold`, parent.header, {})).status).toBe(200);
    await uow.run(({ trx }) =>
      basketPort.startCheckout(trx, t.organizationId, second.id, 'order-gone', finance()),
    );
    const abandoned = await uow.run(({ trx }) =>
      basketPort.finishCheckout(trx, t.organizationId, second.id, 'abandoned', finance()),
    );
    expect(abandoned.status).toBe('abandoned');
    expect((await enrollmentsOf(other))[0]?.status).toBe('canceled');
    expect(
      (
        await t.db.selectFrom('holds').select('status').where('basket_id', '=', second.id).execute()
      ).map((h) => h.status),
    ).toEqual(['released']);
  });

  // -------------------------------------------------------------------------------------------
  // enrollment-11: SPK-REG-004/007 — partial and all-or-nothing payability
  // -------------------------------------------------------------------------------------------

  // The current version of the `registration` approval policy names the offerings needing review.
  let approvalVersion = 0;
  async function approvalOffering(input: { seats?: number } = {}) {
    const setup = await offering(t, {
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: input.seats ?? 20 }],
    });
    approvalVersion += 1;
    await createPolicyVersionFixture(t, {
      kind: 'approval',
      key: 'registration',
      version: approvalVersion,
      content: { offeringIds: [setup.offeringId] },
    });
    return setup;
  }

  it('SPK-REG-004/007: in a partial basket a failed line that needed approval does not block payment of the held lines', async () => {
    const open = await offering(t, { basePriceMinor: 0 });
    const reviewedButFull = await approvalOffering({ seats: 0 });
    const a = await kidFor(open);
    const b = await kidFor(reviewedButFull);
    const basket = await basketWith(
      t,
      parent,
      [
        { participantPersonId: a, offeringId: open.offeringId },
        { participantPersonId: b, offeringId: reviewedButFull.offeringId },
      ],
      { fulfillmentMode: 'partial' },
    );
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    expect(
      held.body.lines.map((l: { outcome: string; requiresApproval: boolean }) => [
        l.outcome,
        l.requiresApproval,
      ]),
    ).toEqual([
      ['held', false],
      ['failed', true],
    ]);
    expect(held.body.approvalPending).toBe(false);
    const completed = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.status).toBe('partially_fulfilled');
  });

  it('SPK-REG-004/007: a partial basket whose held approval line is declined after the hold is payable for the rest', async () => {
    const open = await offering(t, { basePriceMinor: 0 });
    const reviewed = await approvalOffering();
    const a = await kidFor(open);
    const b = await kidFor(reviewed);
    const basket = await basketWith(
      t,
      parent,
      [
        { participantPersonId: a, offeringId: open.offeringId },
        { participantPersonId: b, offeringId: reviewed.offeringId },
      ],
      { fulfillmentMode: 'partial' },
    );
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.body.approvalPending).toBe(true);
    const applicationId = held.body.lines[1].applicationId as string;
    const declined = await post(
      t,
      `/v1/applications/${applicationId}/decline`,
      programManager.header,
      {
        expectedRevision: 1,
        reason: 'Group is for returning players',
      },
    );
    expect(declined.status).toBe(200);
    const completed = await post(t, `/v1/baskets/${basket.id}/complete`, parent.header, {});
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.status).toBe('partially_fulfilled');
    expect(completed.body.lines.map((l: { outcome: string }) => l.outcome)).toEqual([
      'confirmed',
      'failed',
    ]);
  });

  it('SPK-REG-004 / DEC-026: an all-or-nothing basket whose line fails or is released after the hold cannot be completed or paid', async () => {
    // (a) the approval line is declined after the hold
    const open = await offering(t, { basePriceMinor: 0 });
    const reviewed = await approvalOffering();
    const a = await kidFor(open);
    const b = await kidFor(reviewed);
    const strict = await basketWith(t, parent, [
      { participantPersonId: a, offeringId: open.offeringId },
      { participantPersonId: b, offeringId: reviewed.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${strict.id}/hold`, parent.header, {});
    expect(held.status).toBe(200);
    await post(
      t,
      `/v1/applications/${held.body.lines[1].applicationId as string}/decline`,
      programManager.header,
      {
        expectedRevision: 1,
        reason: 'Not this season',
      },
    );
    const blocked = await post(t, `/v1/baskets/${strict.id}/complete`, parent.header, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({
      code: 'BASKET_INCOMPLETE',
      lineIds: [held.body.lines[1].id],
    });
    await expect(
      uow.run(({ trx }) => basketPort.assertPaymentPermitted(trx, t.organizationId, strict.id)),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT', details: { code: 'BASKET_INCOMPLETE' } });
    // (b) one pending enrollment of a held all-or-nothing basket is canceled
    const c = await kidFor(open);
    const d = await kidFor(open);
    const second = await basketWith(t, parent, [
      { participantPersonId: c, offeringId: open.offeringId },
      { participantPersonId: d, offeringId: open.offeringId },
    ]);
    const heldSecond = await post(t, `/v1/baskets/${second.id}/hold`, parent.header, {});
    expect(heldSecond.status).toBe(200);
    const canceled = await post(
      t,
      `/v1/enrollments/${heldSecond.body.lines[0].enrollmentId as string}/cancel`,
      parent.header,
      { expectedRevision: 1, reason: 'one child only' },
    );
    expect(canceled.status).toBe(200);
    const incomplete = await post(t, `/v1/baskets/${second.id}/complete`, parent.header, {});
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.details.code).toBe('BASKET_INCOMPLETE');
    expect((await enrollmentsOf(d))[0]?.status).toBe('pending');
  });
});
