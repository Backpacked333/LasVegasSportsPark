import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingFixture, createProgramFixture } from '../../catalog';
import {
  addRosterMemberFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { createEnrollmentFixture } from '../../enrollment';
import { createPersonFixture } from '../../identity';
import {
  createFulfilledOrder,
  createRefundedOrderPayment,
  get,
  reportingTestApp,
  staff,
  valueOf,
  type Actor,
} from './support';

const PERIODS = {
  anchorFrom: '2027-01-01',
  anchorTo: '2027-01-31',
  comparisonFrom: '2027-04-01',
  comparisonTo: '2027-04-30',
};

describe('retention by cohort (SPK-REPORT-005)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let firstSeason: string;
  let secondSeason: string;
  let youthProgram: string;
  let closedProgram: string;

  const report = (query: Record<string, string>) =>
    get(t, '/v1/reports/retention', leagueManager, query);

  beforeAll(async () => {
    t = await reportingTestApp();
    leagueManager = await staff(t, ['league_manager']);
    const managerId = (await staff(t, ['program_manager'])).personId;

    // One household: a parent who pays, two children who each play once.
    const parent = await createPersonFixture(t, { kind: 'adult' });
    const childA = await createPersonFixture(t, { kind: 'child' });
    const childB = await createPersonFixture(t, { kind: 'child' });
    const householdId = newId();
    await t.db
      .insertInto('households')
      .values({
        id: householdId,
        organization_id: t.organizationId,
        name: 'Rivera household',
        created_by: json({ kind: 'system' }),
      })
      .execute();
    await t.db
      .insertInto('household_memberships')
      .values(
        [parent, childA, childB].map((personId) => ({
          id: newId(),
          organization_id: t.organizationId,
          household_id: householdId,
          person_id: personId,
          label: null,
          added_by: json({ kind: 'system' }),
        })),
      )
      .execute();

    youthProgram = await createProgramFixture(t, { name: 'Junior academy' });
    const winter = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      programId: youthProgram,
      kind: 'term',
      startsOn: '2027-01-10',
      endsOn: '2027-03-10',
      basePriceMinor: 12_000,
    });
    const spring = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      programId: youthProgram,
      kind: 'term',
      startsOn: '2027-04-10',
      endsOn: '2027-06-10',
      basePriceMinor: 12_000,
    });
    await createEnrollmentFixture(t, {
      offeringId: winter.offeringId,
      participantPersonId: childA,
      payerPersonId: parent,
    });
    await createEnrollmentFixture(t, {
      offeringId: spring.offeringId,
      participantPersonId: childB,
      payerPersonId: parent,
    });
    await createFulfilledOrder(t, {
      payerPersonId: parent,
      fulfilledAt: t.clock.now(),
      lines: [
        {
          offeringId: winter.offeringId,
          participantPersonId: childA,
          priceRuleId: winter.priceRuleId!,
          amountMinor: 12_000,
        },
      ],
    });
    await createFulfilledOrder(t, {
      payerPersonId: parent,
      fulfilledAt: t.clock.now(),
      lines: [
        {
          offeringId: spring.offeringId,
          participantPersonId: childB,
          priceRuleId: spring.priceRuleId!,
          amountMinor: 12_000,
        },
      ],
    });

    // A program that offers nothing in the comparison period (K4).
    closedProgram = await createProgramFixture(t, { name: 'Winter futsal clinic' });
    const clinic = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      programId: closedProgram,
      kind: 'camp',
      startsOn: '2027-01-20',
      endsOn: '2027-01-24',
    });
    await createEnrollmentFixture(t, {
      offeringId: clinic.offeringId,
      participantPersonId: await createPersonFixture(t, { kind: 'child' }),
    });

    // Rentals: the parent rents a pitch in January only.
    const rentalJanuary = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      kind: 'rental',
      startsOn: '2027-01-15',
      endsOn: '2027-01-15',
    });
    await createEnrollmentFixture(t, {
      offeringId: rentalJanuary.offeringId,
      participantPersonId: parent,
      payerPersonId: parent,
      intent: 'rental_request',
    });

    // Adult league: two seasons. Team 1 renews, team 2 does not, team 3 is new.
    const fall = await createSeasonFixture(t, {
      name: 'Fall 2026',
      startsOn: '2026-09-01',
      endsOn: '2026-12-15',
      status: 'completed',
    });
    firstSeason = fall.seasonId;
    secondSeason = (
      await createSeasonFixture(t, {
        competitionId: fall.competitionId,
        ruleSetId: fall.ruleSetId,
        name: 'Spring 2027',
        startsOn: '2027-03-01',
        endsOn: '2027-06-15',
      })
    ).seasonId;
    const captain = await createPersonFixture(t, { kind: 'adult' });
    const team1Fall = await createTeamEntryFixture(t, {
      seasonId: firstSeason,
      captainPersonId: captain,
    });
    const team2Fall = await createTeamEntryFixture(t, {
      seasonId: firstSeason,
      captainPersonId: captain,
    });
    const team1Spring = await createTeamEntryFixture(t, {
      seasonId: secondSeason,
      captainPersonId: captain,
      teamId: team1Fall.teamId,
      renewedFromEntryId: team1Fall.teamEntryId,
    });
    const team3Spring = await createTeamEntryFixture(t, {
      seasonId: secondSeason,
      captainPersonId: captain,
    });
    // An applied (never approved) entry does not qualify (K3).
    await createTeamEntryFixture(t, {
      seasonId: secondSeason,
      captainPersonId: captain,
      teamId: team2Fall.teamId,
      status: 'applied',
    });

    // Players: X and Y play in the fall; X returns, and Y returns under a duplicate record later
    // merged into Y (G7). A guest appearance never qualifies (K3).
    const since = new Date(t.clock.now().getTime() - 86_400_000);
    const x = await createPersonFixture(t, { kind: 'adult' });
    const y = await createPersonFixture(t, { kind: 'adult' });
    const yDuplicate = await createPersonFixture(t, { kind: 'adult' });
    const guest = await createPersonFixture(t, { kind: 'adult' });
    await addRosterMemberFixture(t, {
      teamEntryId: team1Fall.teamEntryId,
      personId: x,
      effectiveFrom: since,
    });
    await addRosterMemberFixture(t, {
      teamEntryId: team2Fall.teamEntryId,
      personId: y,
      effectiveFrom: since,
    });
    await addRosterMemberFixture(t, {
      teamEntryId: team1Fall.teamEntryId,
      personId: guest,
      status: 'guest',
      effectiveFrom: since,
    });
    await addRosterMemberFixture(t, {
      teamEntryId: team1Spring.teamEntryId,
      personId: x,
      effectiveFrom: since,
    });
    await addRosterMemberFixture(t, {
      teamEntryId: team3Spring.teamEntryId,
      personId: yDuplicate,
      effectiveFrom: since,
    });
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: y })
      .where('id', '=', yDuplicate)
      .execute();
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-005 (K1): a household that buys again and a returning youth participant are different metrics', async () => {
    const households = await report({ cohort: 'households', ...PERIODS });
    expect(households.status, JSON.stringify(households.body)).toBe(200);
    expect(valueOf(households.body, 'MET-082', 'Household repeat purchase rate')).toBe(1);
    expect(households.body.rows).toEqual([
      expect.objectContaining({ cohort: 'households', cohortSize: 1, returned: 1, returnRate: 1 }),
    ]);

    const youth = await report({
      cohort: 'youth_participants',
      programId: youthProgram,
      ...PERIODS,
    });
    expect(youth.status).toBe(200);
    // Child A played in the winter and did not return; child B is new in the spring, not a return.
    expect(youth.body.rows[0]).toMatchObject({
      cohortSize: 1,
      returned: 0,
      returnRate: 0,
      newInComparison: 1,
    });
    // Each response reports one cohort only: no cross-cohort total exists (K1).
    expect(youth.body.metrics.map((m: { metricKey: string }) => m.metricKey)).toEqual(
      expect.arrayContaining(['MET-079', 'MET-080', 'MET-081', 'MET-082', 'MET-083']),
    );
    expect(
      youth.body.values.every(
        (v: { dimensions: { cohort: string } }) => v.dimensions.cohort === 'youth_participants',
      ),
    ).toBe(true);
  });

  it('SPK-REPORT-005 (K5): adult teams renew as continuing teams, not as season entries', async () => {
    const res = await report({
      cohort: 'adult_teams',
      anchorSeasonId: firstSeason,
      comparisonSeasonId: secondSeason,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows[0]).toMatchObject({
      cohortSize: 2,
      returned: 1,
      returnRate: 0.5,
      newInComparison: 1,
    });
  });

  it('SPK-REPORT-005 (K3, G7): individual players return regardless of who paid; merged duplicates count once; guests never qualify', async () => {
    const res = await report({
      cohort: 'individual_players',
      anchorSeasonId: firstSeason,
      comparisonSeasonId: secondSeason,
    });
    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({ cohortSize: 2, returned: 2, returnRate: 1 });
  });

  it('SPK-REPORT-005: rental customers who did not book again', async () => {
    const res = await report({ cohort: 'rental_customers', ...PERIODS });
    expect(res.status).toBe(200);
    expect(res.body.rows[0]).toMatchObject({ cohortSize: 1, returned: 0, returnRate: 0 });
  });

  it('SPK-REPORT-005 (K4): members who could not return are shown separately and leave the denominator only when asked', async () => {
    const kept = await report({
      cohort: 'youth_participants',
      programId: closedProgram,
      ...PERIODS,
    });
    expect(kept.body.rows[0]).toMatchObject({
      cohortSize: 1,
      returned: 0,
      notOffered: 1,
      denominator: 1,
      returnRate: 0,
    });
    const excluded = await report({
      cohort: 'youth_participants',
      programId: closedProgram,
      excludeNotOffered: 'true',
      ...PERIODS,
    });
    expect(excluded.body.rows[0]).toMatchObject({
      notOffered: 1,
      denominator: 0,
      returnRate: null,
    });
    const rate = excluded.body.values.find(
      (v: { metric: string; label: string }) => v.label === 'Youth participant return rate',
    );
    expect(rate.value).toBeNull();
    expect(rate.unavailableReason).toBeTruthy();
  });

  it('SPK-REPORT-005 (MET-082): an order refunded in full by the as-of instant is not a purchase; a partly refunded one is', async () => {
    const managerId = (await staff(t, ['program_manager'])).personId;
    const term = (startsOn: string, endsOn: string) =>
      createOfferingFixture(t, {
        responsibleManagerPersonId: managerId,
        kind: 'term',
        startsOn,
        endsOn,
        basePriceMinor: 8_000,
      });
    const winter = await term('2027-01-12', '2027-03-12');
    const spring = await term('2027-04-12', '2027-06-12');
    /** A household of one paying adult with a fulfilled order per offering, refunded as given. */
    const household = async (
      name: string,
      orders: Array<{ offering: typeof winter; refundedMinor: number }>,
    ) => {
      const payer = await createPersonFixture(t, { kind: 'adult' });
      const householdId = newId();
      await t.db
        .insertInto('households')
        .values({
          id: householdId,
          organization_id: t.organizationId,
          name,
          created_by: json({ kind: 'system' }),
        })
        .execute();
      await t.db
        .insertInto('household_memberships')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          household_id: householdId,
          person_id: payer,
          label: null,
          added_by: json({ kind: 'system' }),
        })
        .execute();
      for (const { offering, refundedMinor } of orders) {
        const order = await createFulfilledOrder(t, {
          payerPersonId: payer,
          fulfilledAt: t.clock.now(),
          lines: [
            {
              offeringId: offering.offeringId,
              participantPersonId: payer,
              priceRuleId: offering.priceRuleId!,
              amountMinor: 8_000,
            },
          ],
        });
        await createRefundedOrderPayment(t, {
          order,
          payerPersonId: payer,
          paidMinor: 8_000,
          paidAt: t.clock.now(),
          refunds:
            refundedMinor > 0 ? [{ amountMinor: refundedMinor, resolvedAt: t.clock.now() }] : [],
        });
      }
    };
    // Bought in the winter; the spring order was refunded in full: not a repeat purchase.
    await household('Chen household', [
      { offering: winter, refundedMinor: 0 },
      { offering: spring, refundedMinor: 8_000 },
    ]);
    // A partly refunded winter order is still a purchase; it bought again in the spring.
    await household('Diaz household', [
      { offering: winter, refundedMinor: 4_000 },
      { offering: spring, refundedMinor: 0 },
    ]);
    // Its only winter order was refunded in full: not in the cohort at all.
    await household('Evans household', [
      { offering: winter, refundedMinor: 8_000 },
      { offering: spring, refundedMinor: 0 },
    ]);

    const res = await report({ cohort: 'households', ...PERIODS });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Rivera (from the setup), Chen and Diaz bought in the winter; Rivera and Diaz again in the spring.
    expect(res.body.rows).toEqual([
      expect.objectContaining({ cohort: 'households', cohortSize: 3, returned: 2 }),
    ]);
    expect(valueOf(res.body, 'MET-082', 'Household repeat purchase rate')).toBeCloseTo(2 / 3, 4);
  });

  it('K2: the comparable periods are explicit and validated; access is for retention viewers', async () => {
    expect((await report({ cohort: 'adult_teams' })).status).toBe(400);
    expect(
      (
        await report({
          cohort: 'households',
          anchorFrom: '2027-04-01',
          anchorTo: '2027-04-30',
          comparisonFrom: '2027-01-01',
          comparisonTo: '2027-01-31',
        })
      ).status,
    ).toBe(400);
    const scheduler = await staff(t, ['scheduler']);
    expect(
      (await get(t, '/v1/reports/retention', scheduler, { cohort: 'households', ...PERIODS }))
        .status,
    ).toBe(403);
  });
});
