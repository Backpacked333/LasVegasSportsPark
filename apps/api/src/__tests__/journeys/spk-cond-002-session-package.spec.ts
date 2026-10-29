import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  createProgramFixture,
  type OfferingFixture,
} from '../../modules/catalog';
import { EXPIRE_PACKAGES_JOB } from '../../modules/enrollment/services/enrollment-jobs';
import { FakePaymentTokens } from '../../modules/finance';
import {
  adult,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  staff,
  together,
  type Actor,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Entitlement {
  id: string;
  credits: number;
  remainingCredits: number;
  status: string;
  enrollmentId?: string;
}

/**
 * SPK-COND-002 / SPK-AT-020 (§3.16, §6.5 Package G; DEC-016 and DEC-074 pending; credit return
 * POL-007, POL-039): a session package bought through checkout across catalog, enrollment, finance
 * and entry, through HTTP. Credits, prices, expiry and the return window are test data.
 * The race for the last credit overlaps under TEST_DATABASE_URL.
 */
describe('SPK-COND-002 / SPK-AT-020: session package (assembled application)', () => {
  let t: TestApp;
  let pm: Actor;
  let finance: Actor;
  let desk: Actor;
  let target: OfferingFixture;
  let sessions: string[];
  let adultProgram: string;

  beforeAll(async () => {
    t = await journeyApp({ clockStart: '2026-11-02T16:00:00Z' });
    const admin = await staff(t, ['system_administrator']);
    pm = await staff(t, ['program_manager']);
    finance = await staff(t, ['finance_operator']);
    desk = await staff(t, ['front_desk']);
    await enableCapability(t, admin, 'session_packages', 'DEC-074');
    adultProgram = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    target = await createOfferingFixture(t, {
      responsibleManagerPersonId: pm.personId,
      programId: adultProgram,
      kind: 'session',
      basePriceMinor: 2_000,
      capacityUnits: [{ unit: 'seats', limit: 10 }],
    });
    sessions = [];
    for (let i = 0; i < 6; i += 1) {
      sessions.push(
        await createOfferingSessionFixture(t, {
          offeringId: target.offeringId,
          scheduledStart: new Date(Date.parse('2026-11-20T02:00:00Z') + i * DAY),
          scheduledEnd: new Date(Date.parse('2026-11-20T03:00:00Z') + i * DAY),
        }),
      );
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  async function approvedPolicy(kind: string, content: Record<string, unknown>) {
    const version = await ok<{ id: string }>(
      post(t, '/v1/policy-versions', pm.header, {
        kind,
        key: `${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        title: `${kind} policy`,
        content,
        effectiveFrom: '2026-10-01T00:00:00Z',
      }),
      201,
    );
    await ok(post(t, `/v1/policy-versions/${version.id}/approve`, finance.header, {}));
    return version.id;
  }

  /** A package offering created, published and opened by the program manager. */
  async function packageOffering(input: {
    credits: number;
    expiry: Record<string, unknown>;
    cancellationPolicyVersionId?: string;
  }) {
    const definition = await ok<{ id: string }>(
      post(t, '/v1/entitlement-definitions', pm.header, {
        name: `Package ${Date.now()}-${Math.random()}`,
        kind: 'package_credits',
        scope: {
          credits: input.credits,
          appliesTo: { offeringIds: [target.offeringId] },
          expiry: input.expiry,
        },
        equivalenceScope: 'none',
      }),
      201,
    );
    const pack = await createOfferingFixture(t, {
      responsibleManagerPersonId: pm.personId,
      programId: adultProgram,
      kind: 'package',
      publicationState: 'draft',
      entitlementDefinitionId: definition.id,
      basePriceMinor: 3_000,
      capacityUnits: [{ unit: 'seats', limit: 50 }],
      cancellationPolicyVersionId: input.cancellationPolicyVersionId,
    });
    await ok(post(t, `/v1/offerings/${pack.offeringId}/publish`, pm.header, {}));
    await ok(post(t, `/v1/offerings/${pack.offeringId}/registration/open`, pm.header, {}));
    return pack;
  }

  /** Buys the package through basket, quote and checkout; returns its issued entitlement. */
  async function buy(buyer: Actor, pack: OfferingFixture): Promise<Entitlement> {
    for (const setup of [pack, target]) {
      await createAcknowledgmentFixture(t, {
        subjectPersonId: buyer.personId,
        policyVersionId: setup.formPolicyVersionId,
        signedByPersonId: buyer.personId,
      });
    }
    const basket = await ok<{ id: string; revision: number }>(
      post(t, '/v1/baskets', buyer.header, { ownerPersonId: buyer.personId }),
      201,
    );
    const line = await ok<{ revision: number }>(
      post(t, `/v1/baskets/${basket.id}/lines`, buyer.header, {
        participantPersonId: buyer.personId,
        offeringId: pack.offeringId,
        intent: 'package_purchase',
      }),
      201,
    );
    await ok(
      post(t, `/v1/baskets/${basket.id}/hold`, buyer.header, { expectedRevision: line.revision }),
    );
    const quote = await ok<{ id: string; totalMinor: number }>(
      post(t, '/v1/registration-quotes', buyer.header, { basketId: basket.id }),
      201,
    );
    expect(quote.totalMinor).toBe(3_000);
    const checkout = await ok<{ status: string }>(
      post(t, '/v1/registration-checkouts', buyer.header, {
        quoteId: quote.id,
        payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      }),
      201,
    );
    expect(checkout.status).toBe('completed');
    await drain(t);
    const mine = await ok<{ items: Entitlement[] }>(
      get(t, '/v1/me/package-entitlements', buyer.header),
    );
    const issued = mine.items.filter((e) => e.status === 'active');
    expect(issued).toHaveLength(1);
    return issued[0]!;
  }

  const book = (actor: Actor, sessionId: string, packageEntitlementId: string) =>
    post(t, '/v1/session-bookings', actor.header, {
      offeringId: target.offeringId,
      sessionId,
      participantPersonId: actor.personId,
      packageEntitlementId,
    });

  it('SPK-COND-002: buying 2 credits through checkout issues them; two concurrent bookings of the last credit yield one; a cancellation inside the approved window returns the credit', async () => {
    const returnPolicy = await approvedPolicy('cancellation', {
      text: 'Package credits return until a day before the session.',
      packageCreditReturn: { untilMinutesBeforeStart: 24 * 60 },
    });
    const pack = await packageOffering({
      credits: 2,
      expiry: { kind: 'days_after_issue', days: 60 },
      cancellationPolicyVersionId: returnPolicy,
    });
    const buyer = await adult(t);
    const entitlement = await buy(buyer, pack);
    expect(entitlement).toMatchObject({ credits: 2, remainingCredits: 2 });

    const first = await ok<{ id: string; revision: number; status: string }>(
      book(buyer, sessions[0]!, entitlement.id),
      201,
    );
    expect(first.status).toBe('confirmed');
    // the last credit, twice at once: exactly one booking
    const race = await together(
      () => book(buyer, sessions[1]!, entitlement.id),
      () => book(buyer, sessions[2]!, entitlement.id),
    );
    expect(race.map((r) => r.status).sort(), JSON.stringify(race.map((r) => r.body))).toEqual([
      201, 409,
    ]);
    expect(race.find((r) => r.status === 409)!.body.details.code).toBe('PACKAGE_CREDITS_EXHAUSTED');
    const exhausted = await t.db
      .selectFrom('package_entitlements')
      .select(['redeemed_count', 'status'])
      .where('id', '=', entitlement.id)
      .executeTakeFirstOrThrow();
    expect(exhausted).toEqual({ redeemed_count: 2, status: 'exhausted' });
    // well before the session: the approved window returns the credit
    const canceled = await ok<{ creditDisposition: string }>(
      post(t, `/v1/session-bookings/${first.id}/cancel`, buyer.header, {
        reason: 'Cannot come',
        expectedRevision: first.revision,
      }),
    );
    expect(canceled.creditDisposition).toBe('returned');
    const after = await ok<{ items: Entitlement[] }>(
      get(t, '/v1/me/package-entitlements', buyer.header),
    );
    expect(after.items.find((e) => e.id === entitlement.id)).toMatchObject({
      remainingCredits: 1,
      status: 'active',
    });

    // the booked session admits its participant at the desk
    const booked = race.find((r) => r.status === 201)!.body as { sessionId: string };
    const sessionStart =
      Date.parse('2026-11-20T02:00:00Z') + sessions.indexOf(booked.sessionId) * DAY;
    const back = t.clock.now().getTime();
    t.clock.set(new Date(sessionStart - 15 * 60_000));
    try {
      const admitted = await ok<{ status: string; basis: { kind: string } | null }>(
        post(t, '/v1/session-checkins', desk.header, {
          personId: buyer.personId,
          activity: { type: 'session', offeringId: target.offeringId, sessionId: booked.sessionId },
        }),
        201,
      );
      expect(admitted).toMatchObject({ status: 'admitted', basis: { kind: 'session_booking' } });
      // a session the package never booked does not admit
      const unbooked = await ok<{ status: string; issues: Array<{ code: string }> }>(
        post(t, '/v1/session-checkins', desk.header, {
          personId: buyer.personId,
          activity: { type: 'session', offeringId: target.offeringId, sessionId: sessions[5] },
        }),
        201,
      );
      expect(unbooked.status).toBe('held');
      expect(unbooked.issues.map((i) => i.code)).toContain('no_participation');
    } finally {
      t.clock.set(new Date(back));
    }
  });

  it('POL-039: without a policy stating a return the credit is retained pending policy; expiry stops redemption; canceling the purchase revokes it', async () => {
    const pack = await packageOffering({
      credits: 2,
      expiry: { kind: 'days_after_issue', days: 3 },
    });
    const buyer = await adult(t);
    const entitlement = await buy(buyer, pack);
    const booked = await ok<{ id: string; revision: number }>(
      book(buyer, sessions[3]!, entitlement.id),
      201,
    );
    const canceled = await ok<{ creditDisposition: string }>(
      post(t, `/v1/session-bookings/${booked.id}/cancel`, buyer.header, {
        reason: 'Changed plans',
        expectedRevision: booked.revision,
      }),
    );
    expect(canceled.creditDisposition).toBe('retained_pending_policy');

    // expiry (days_after_issue 3) stops redemption
    const back = t.clock.now().getTime();
    t.clock.advance(3 * DAY + 1_000);
    try {
      await t.runPeriodicJobs([EXPIRE_PACKAGES_JOB]);
      const expired = await t.db
        .selectFrom('package_entitlements')
        .select('status')
        .where('id', '=', entitlement.id)
        .executeTakeFirstOrThrow();
      expect(expired.status).toBe('expired');
      const refused = await book(buyer, sessions[4]!, entitlement.id);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.details.code).toBe('PACKAGE_NOT_REDEEMABLE');
    } finally {
      t.clock.set(new Date(back));
    }

    // a second purchase is canceled: the package is revoked and no longer redeemable
    const other = await adult(t);
    const second = await buy(other, pack);
    const future = await ok<{ id: string }>(book(other, sessions[4]!, second.id), 201);
    const row = await t.db
      .selectFrom('package_entitlements')
      .select('enrollment_id')
      .where('id', '=', second.id)
      .executeTakeFirstOrThrow();
    const preview = await ok<{
      financialConsequence: { kind: string; amountMinor: number | null; currency: string | null };
    }>(get(t, `/v1/enrollments/${row.enrollment_id}/cancellation-preview`, other.header));
    const enrollment = await ok<{ revision: number }>(
      get(t, `/v1/enrollments/${row.enrollment_id}`, other.header),
    );
    await ok(
      post(t, `/v1/enrollments/${row.enrollment_id}/cancel`, other.header, {
        reason: 'No longer needed',
        expectedRevision: enrollment.revision,
        acceptedConsequence: preview.financialConsequence,
      }),
    );
    await drain(t);
    const revoked = await t.db
      .selectFrom('package_entitlements')
      .select(['status', 'revoked_reason'])
      .where('id', '=', second.id)
      .executeTakeFirstOrThrow();
    expect(revoked).toEqual({ status: 'revoked', revoked_reason: 'purchase_canceled' });
    // the booking already made stays, and staff are asked to decide it
    const stays = await t.db
      .selectFrom('session_bookings')
      .select('status')
      .where('id', '=', future.id)
      .executeTakeFirstOrThrow();
    expect(stays.status).toBe('confirmed');
    const raised = await t.db
      .selectFrom('operational_exceptions')
      .select('owner_queue')
      .where('category', '=', 'enrollment.revoked_package_has_bookings')
      .where('affected_id', '=', second.id)
      .execute();
    expect(raised).toEqual([{ owner_queue: 'program_manager' }]);
    const refused = await book(other, sessions[5]!, second.id);
    expect(refused.status).toBe(409);
    expect(refused.body.details.code).toBe('PACKAGE_NOT_REDEEMABLE');
  });
});
