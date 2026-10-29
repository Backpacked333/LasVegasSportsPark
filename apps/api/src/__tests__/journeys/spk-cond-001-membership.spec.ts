import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  createProgramFixture,
  type OfferingFixture,
} from '../../modules/catalog';
import { MEMBERSHIP_LIFECYCLE_JOB } from '../../modules/enrollment/services/enrollment-jobs';
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
  type Actor,
} from './support';

const HOUR = 3_600_000;

/**
 * SPK-COND-001 (§3.16, §6.5 Package G; DEC-016 and DEC-072 pending; benefits and notice lead
 * POL-038): a membership with two included sessions per week, across catalog, enrollment, entry,
 * finance and communications, through HTTP. The weekly count, the week start (Monday), the term
 * and the 14-day notice lead are the definition's stated test values; nothing is implied.
 */
describe('SPK-COND-001: membership (assembled application)', () => {
  let t: TestApp;
  let pm: Actor;
  let leagueManager: Actor;
  let desk: Actor;
  let adultProgram: string;
  let target: OfferingFixture;
  let membership: OfferingFixture;
  /** Sessions of the covered offering: three in the week of Monday 16 November, one the week after. */
  let week1: string[];
  let week2: string;
  let member: Actor;
  let membershipEnrollmentId: string;

  beforeAll(async () => {
    t = await journeyApp({ clockStart: '2026-11-09T16:00:00Z' });
    const admin = await staff(t, ['system_administrator']);
    pm = await staff(t, ['program_manager']);
    leagueManager = await staff(t, ['league_manager']);
    desk = await staff(t, ['front_desk']);
    await enableCapability(t, admin, 'memberships', 'DEC-072');
    adultProgram = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    target = await createOfferingFixture(t, {
      responsibleManagerPersonId: pm.personId,
      programId: adultProgram,
      kind: 'session',
      basePriceMinor: 2_500,
      capacityUnits: [{ unit: 'seats', limit: 10 }],
    });
    const session = (start: string) =>
      createOfferingSessionFixture(t, {
        offeringId: target.offeringId,
        scheduledStart: new Date(start),
        scheduledEnd: new Date(Date.parse(start) + HOUR),
      });
    week1 = [
      await session('2026-11-17T18:00:00Z'),
      await session('2026-11-19T18:00:00Z'),
      await session('2026-11-21T18:00:00Z'),
    ];
    week2 = await session('2026-11-24T18:00:00Z');
  });
  afterAll(async () => {
    await t?.close();
  });

  async function acknowledgeFor(person: Actor, ...setups: OfferingFixture[]) {
    for (const setup of setups) {
      await createAcknowledgmentFixture(t, {
        subjectPersonId: person.personId,
        policyVersionId: setup.formPolicyVersionId,
        signedByPersonId: person.personId,
      });
    }
  }

  async function membershipOffering(dates: { startsOn: string; endsOn: string }) {
    const definition = await ok<{ id: string }>(
      post(t, '/v1/entitlement-definitions', pm.header, {
        name: `Membership ${Date.now()}-${Math.random()}`,
        kind: 'membership_benefit',
        scope: {
          attendance: {
            mode: 'included_sessions',
            appliesTo: { offeringIds: [target.offeringId] },
            limit: { count: 2, period: 'week', weekStartsOn: 1 },
          },
          term: { kind: 'offering_dates' },
          renewal: { noticeLeadDays: 14 },
        },
        equivalenceScope: 'none',
      }),
      201,
    );
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: pm.personId,
      programId: adultProgram,
      kind: 'membership',
      publicationState: 'draft',
      entitlementDefinitionId: definition.id,
      basePriceMinor: 9_000,
      capacityUnits: [{ unit: 'seats', limit: 500 }],
      startsOn: dates.startsOn,
      endsOn: dates.endsOn,
    });
    await ok(post(t, `/v1/offerings/${offering.offeringId}/publish`, pm.header, {}));
    await ok(post(t, `/v1/offerings/${offering.offeringId}/registration/open`, pm.header, {}));
    return offering;
  }

  async function checkoutBasket(actor: Actor, basketId: string) {
    const quote = await ok<{ id: string; totalMinor: number }>(
      post(t, '/v1/registration-quotes', actor.header, { basketId }),
      201,
    );
    const checkout = await ok<{ status: string }>(
      post(t, '/v1/registration-checkouts', actor.header, {
        quoteId: quote.id,
        payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      }),
      201,
    );
    expect(checkout.status).toBe('completed');
    await drain(t);
    return quote;
  }

  const book = (actor: Actor, sessionId: string, enrollmentId: string) =>
    post(t, '/v1/session-bookings', actor.header, {
      offeringId: target.offeringId,
      sessionId,
      participantPersonId: actor.personId,
      membershipEnrollmentId: enrollmentId,
    });

  it('a member buys through checkout; two included sessions a week from Monday; the third booking that week is refused; an unbooked session is not admitted', async () => {
    membership = await membershipOffering({ startsOn: '2026-11-01', endsOn: '2026-11-30' });
    member = await adult(t);
    await acknowledgeFor(member, membership, target);
    const basket = await ok<{ id: string }>(
      post(t, '/v1/baskets', member.header, { ownerPersonId: member.personId }),
      201,
    );
    const line = await ok<{ revision: number; lines: Array<{ enrollmentId: string | null }> }>(
      post(t, `/v1/baskets/${basket.id}/lines`, member.header, {
        participantPersonId: member.personId,
        offeringId: membership.offeringId,
        intent: 'membership',
      }),
      201,
    );
    await ok(
      post(t, `/v1/baskets/${basket.id}/hold`, member.header, { expectedRevision: line.revision }),
    );
    const quote = await checkoutBasket(member, basket.id);
    expect(quote.totalMinor).toBe(9_000);
    const memberships = await ok<{ items: Array<{ enrollmentId: string; status: string }> }>(
      get(t, '/v1/me/memberships', member.header),
    );
    expect(memberships.items).toEqual([expect.objectContaining({ status: 'confirmed' })]);
    membershipEnrollmentId = memberships.items[0]!.enrollmentId;

    const first = await ok<{ status: string; entitlementBasis: string; price: unknown }>(
      book(member, week1[0]!, membershipEnrollmentId),
      201,
    );
    expect(first).toMatchObject({
      status: 'confirmed',
      entitlementBasis: 'membership',
      price: null,
    });
    await ok(book(member, week1[1]!, membershipEnrollmentId), 201);
    const third = await book(member, week1[2]!, membershipEnrollmentId);
    expect(third.status).toBe(409);
    expect(third.body.details).toMatchObject({
      code: 'MEMBERSHIP_SESSIONS_USED',
      periodKey: 'week:2026-11-16',
    });
    const usage = await ok<{ items: Array<{ usage: unknown[] }> }>(
      get(t, '/v1/me/memberships', member.header),
    );
    expect(usage.items[0]!.usage).toEqual(
      expect.arrayContaining([{ periodKey: 'week:2026-11-16', usedCount: 2, limitCount: 2 }]),
    );

    // a membership never admits by itself: the unbooked third session holds at the desk
    const back = t.clock.now().getTime();
    t.clock.set(new Date(Date.parse('2026-11-21T18:00:00Z') - 10 * 60_000));
    try {
      const held = await ok<{ status: string; basis: unknown; issues: Array<{ code: string }> }>(
        post(t, '/v1/session-checkins', desk.header, {
          personId: member.personId,
          activity: { type: 'session', offeringId: target.offeringId, sessionId: week1[2] },
        }),
        201,
      );
      expect(held.status).not.toBe('admitted');
      expect(held.basis).toBeNull();
      expect(held.issues.map((i) => i.code)).toContain('no_participation');
    } finally {
      t.clock.set(new Date(back));
    }
  });

  it('a suspension blocks bookings inside it; member-only eligibility refuses a non-member', async () => {
    await ok(
      post(t, `/v1/enrollments/${membershipEnrollmentId}/membership-suspensions`, desk.header, {
        from: '2026-11-23T08:00:00Z',
        until: '2026-11-30T08:00:00Z',
        reason: 'Travelling',
      }),
      201,
    );
    const suspended = await book(member, week2, membershipEnrollmentId);
    expect(suspended.status).toBe(409);
    expect(suspended.body.details.code).toBe('MEMBERSHIP_SUSPENDED');

    // an eligibility rule requiring this membership (POL-038 test value)
    const policy = await ok<{ id: string }>(
      post(t, '/v1/policy-versions', pm.header, {
        kind: 'eligibility',
        key: `members-only-${Date.now()}`,
        title: 'Members only',
        content: { membershipRequired: { offeringIds: [membership.offeringId] } },
        effectiveFrom: '2026-10-01T00:00:00Z',
      }),
      201,
    );
    await ok(post(t, `/v1/policy-versions/${policy.id}/approve`, leagueManager.header, {}));
    const membersOnly = await createOfferingFixture(t, {
      responsibleManagerPersonId: pm.personId,
      programId: adultProgram,
      kind: 'term',
      basePriceMinor: 0,
      eligibilityPolicyVersionId: policy.id,
      startsOn: '2026-11-16',
      endsOn: '2026-11-20',
    });
    const reasonsOf = async (actor: Actor) => {
      const options = await ok<{
        participants: Array<{
          intents: Array<{ eligibility: { reasons: Array<{ code: string }> } }>;
        }>;
      }>(
        get(
          t,
          `/v1/offerings/${membersOnly.offeringId}/registration-options?participantPersonIds=${actor.personId}`,
          actor.header,
        ),
      );
      return options.participants[0]!.intents[0]!.eligibility.reasons.map((r) => r.code);
    };
    const outsider = await adult(t);
    expect(await reasonsOf(outsider)).toContain('MEMBERSHIP_REQUIRED');
    expect(await reasonsOf(member)).not.toContain('MEMBERSHIP_REQUIRED');
    // and the outsider cannot register for it
    await acknowledgeFor(outsider, membersOnly);
    const basket = await ok<{ id: string }>(
      post(t, '/v1/baskets', outsider.header, { ownerPersonId: outsider.personId }),
      201,
    );
    const added = await ok<{ revision: number; lines: unknown[] }>(
      post(t, `/v1/baskets/${basket.id}/lines`, outsider.header, {
        participantPersonId: outsider.personId,
        offeringId: membersOnly.offeringId,
        intent: 'youth',
      }),
      201,
    );
    // the line records why it is not eligible, and the basket cannot be held for payment
    expect(JSON.stringify(added.lines)).toContain('MEMBERSHIP_REQUIRED');
    const refused = await post(t, `/v1/baskets/${basket.id}/hold`, outsider.header, {
      expectedRevision: added.revision,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(JSON.stringify(refused.body)).toContain('MEMBERSHIP_REQUIRED');
  });

  it('POL-038: one renewal notice at the configured lead time; the renewal charges nothing until its checkout', async () => {
    // the term ends 30 November (local); the notice lead is 14 days
    t.clock.set(new Date('2026-11-14T08:00:00Z'));
    await t.runPeriodicJobs([MEMBERSHIP_LIFECYCLE_JOB]);
    await drain(t);
    const early = await t.db
      .selectFrom('notifications')
      .select('id')
      .where('kind', '=', 'renewal_opportunity')
      .where('subject_id', '=', membershipEnrollmentId)
      .execute();
    expect(early).toHaveLength(0);
    t.clock.set(new Date('2026-11-17T08:00:00Z'));
    await t.runPeriodicJobs([MEMBERSHIP_LIFECYCLE_JOB]);
    await t.runPeriodicJobs([MEMBERSHIP_LIFECYCLE_JOB]);
    await drain(t);
    const notices = await t.db
      .selectFrom('notifications')
      .select('id')
      .where('kind', '=', 'renewal_opportunity')
      .where('subject_id', '=', membershipEnrollmentId)
      .execute();
    expect(notices).toHaveLength(1);
    const inbox = await ok<{ items: Array<{ kind: string }> }>(
      get(t, '/v1/me/inbox', member.header),
    );
    expect(inbox.items.filter((i) => i.kind === 'renewal_opportunity')).toHaveLength(1);

    const next = await membershipOffering({ startsOn: '2026-12-01', endsOn: '2027-02-28' });
    await acknowledgeFor(member, next);
    const paymentsBefore = (
      await t.db
        .selectFrom('payment_attempts')
        .select('id')
        .where('payer_person_id', '=', member.personId)
        .execute()
    ).length;
    const renewed = await ok<{ id: string; lines: Array<{ offeringId: string; intent: string }> }>(
      post(t, `/v1/enrollments/${membershipEnrollmentId}/renew`, member.header, {
        targetOfferingId: next.offeringId,
      }),
      201,
    );
    expect(renewed.lines).toEqual([
      expect.objectContaining({ offeringId: next.offeringId, intent: 'membership' }),
    ]);
    expect(
      (
        await t.db
          .selectFrom('payment_attempts')
          .select('id')
          .where('payer_person_id', '=', member.personId)
          .execute()
      ).length,
    ).toBe(paymentsBefore);
    const held = await ok<{ revision: number }>(get(t, `/v1/baskets/${renewed.id}`, member.header));
    await ok(
      post(t, `/v1/baskets/${renewed.id}/hold`, member.header, { expectedRevision: held.revision }),
    );
    const quote = await checkoutBasket(member, renewed.id);
    expect(quote.totalMinor).toBe(9_000);
    expect(
      (
        await t.db
          .selectFrom('payment_attempts')
          .select('id')
          .where('payer_person_id', '=', member.personId)
          .execute()
      ).length,
    ).toBe(paymentsBefore + 1);
  });
});
