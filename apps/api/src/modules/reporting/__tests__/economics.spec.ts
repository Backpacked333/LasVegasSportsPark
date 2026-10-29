import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingFixture, createOfferingSessionFixture } from '../../catalog';
import { createPersonFixture } from '../../identity';
import {
  at,
  createScheduledEvent,
  EventsService,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import {
  createFulfilledOrder,
  createRefundedOrderPayment,
  get,
  HOUR,
  post,
  reportingTestApp,
  staff,
  valueOf,
  type Actor,
} from './support';

type Row = Record<string, string | number | boolean | null>;

describe('economics (SPK-REPORT-004)', () => {
  let t: TestApp;
  let finance: Actor;
  let pitch: PitchFixture;

  const report = (actor: Actor, query: Record<string, string>) =>
    get(t, '/v1/reports/economics', actor, {
      facilityId: t.facilityId,
      from: '2027-02-01',
      to: '2027-02-07',
      ...query,
    });
  const spaceRow = (body: { rows: Row[] }, resourceId: string) =>
    body.rows.find((r) => r.section === 'space' && r.resourceId === resourceId);

  beforeAll(async () => {
    t = await reportingTestApp();
    finance = await staff(t, ['finance_operator']);
    const managerId = (await staff(t, ['program_manager'])).personId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      defaultCleanupMinutes: 0,
    });
    const events = t.app.get(EventsService);
    const sessionWithEvent = async (
      offeringId: string,
      resourceId: string,
      date: string,
      start: string,
      end: string,
    ) => {
      const event = await createScheduledEvent(events, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [resourceId],
        start: at(date, start),
        end: at(date, end),
        kind: 'session',
        sourceType: 'offering_session',
      });
      await createOfferingSessionFixture(t, {
        offeringId,
        scheduledStart: new Date(at(date, start)),
        scheduledEnd: new Date(at(date, end)),
        schedulingEventId: event.id,
      });
    };
    // A term with two one-hour sessions on the whole pitch (one inside the period, one after it).
    const term = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      kind: 'term',
      startsOn: '2027-02-01',
      endsOn: '2027-02-28',
      basePriceMinor: 10_000,
    });
    await sessionWithEvent(term.offeringId, pitch.pitchId, '2027-02-03', '10:00', '11:00');
    await sessionWithEvent(term.offeringId, pitch.pitchId, '2027-02-10', '10:00', '11:00');
    // A single 90-minute camp day on the north half.
    const camp = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      kind: 'camp',
      startsOn: '2027-02-04',
      endsOn: '2027-02-04',
      basePriceMinor: 4_500,
    });
    await sessionWithEvent(camp.offeringId, pitch.northHalfId, '2027-02-04', '09:00', '10:30');
    // A membership: never field time.
    const membership = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      kind: 'membership',
      startsOn: '2027-02-01',
      endsOn: '2027-12-31',
      basePriceMinor: 3_000,
    });
    const payer = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    await createFulfilledOrder(t, {
      payerPersonId: payer,
      fulfilledAt: t.clock.now(),
      lines: [
        {
          offeringId: term.offeringId,
          participantPersonId: child,
          priceRuleId: term.priceRuleId!,
          amountMinor: 10_000,
        },
        {
          offeringId: camp.offeringId,
          participantPersonId: child,
          priceRuleId: camp.priceRuleId!,
          amountMinor: 4_500,
        },
        {
          offeringId: membership.offeringId,
          participantPersonId: payer,
          priceRuleId: membership.priceRuleId!,
          amountMinor: 3_000,
        },
      ],
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-004: revenue per field hour is refused without an explicit allocation method', async () => {
    const res = await report(finance, {});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body.details)).toContain('allocationMethod');
  });

  it('SPK-REPORT-004 (E1, E3): pro rata spreads a term fee over its events by activity minutes and discloses coverage', async () => {
    const res = await report(finance, { allocationMethod: 'pro_rata' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Half the term fee falls on the in-period session: 5000 over two unit-hours on the pitch.
    expect(spaceRow(res.body, pitch.pitchId)).toMatchObject({
      currency: 'USD',
      amountMinor: 5_000,
      activityHours: 2,
      perActivityHourMinor: 2_500,
    });
    expect(spaceRow(res.body, pitch.northHalfId)).toMatchObject({
      amountMinor: 4_500,
      activityHours: 1.5,
      perActivityHourMinor: 3_000,
    });
    expect(valueOf(res.body, 'MET-075', 'Unallocated sales', 'USD')).toBe(3_000);
    expect(valueOf(res.body, 'MET-076', 'Allocation coverage', 'USD')).toBeCloseTo(
      9_500 / 12_500,
      4,
    );
    expect(valueOf(res.body, 'MET-074', 'Allocated sales per activity hour', 'USD')).toBe(
      Math.round(9_500 / 3.5),
    );
    expect((res.body.disclosures as string[])[0]).toContain('Allocation method: pro_rata');
    const unallocated = (res.body.rows as Row[]).find((r) => r.section === 'unallocated');
    expect(unallocated).toMatchObject({ reason: 'sale_type_not_field_time', amountMinor: 3_000 });
    // Margin is not shown unless asked for, and then only from agreed cost inputs.
    const margin = res.body.values.find((v: { metric: string }) => v.metric === 'MET-077');
    expect(margin.value).toBeNull();
  });

  it('SPK-REPORT-004 (E1): direct allocation only attributes a line with exactly one event', async () => {
    const res = await report(finance, { allocationMethod: 'direct' });
    expect(res.status).toBe(200);
    expect(spaceRow(res.body, pitch.pitchId)).toBeUndefined();
    expect(spaceRow(res.body, pitch.northHalfId)).toMatchObject({ amountMinor: 4_500 });
    const reasons = (res.body.rows as Row[])
      .filter((r) => r.section === 'unallocated')
      .map((r) => [r.reason, r.amountMinor]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        ['direct_needs_single_event', 10_000],
        ['sale_type_not_field_time', 3_000],
      ]),
    );
    expect(valueOf(res.body, 'MET-076', 'Allocation coverage', 'USD')).toBeCloseTo(
      4_500 / 17_500,
      4,
    );
  });

  it('SPK-REPORT-004 (E4): contribution margin is refused without agreed cost inputs, then computed from them', async () => {
    const refused = await report(finance, { allocationMethod: 'pro_rata', includeMargin: 'true' });
    expect(refused.status).toBe(400);
    expect(refused.body.details.code).toBe('cost_inputs_required');

    const recorded = await post(t, '/v1/reports/cost-inputs', finance, {
      facilityId: t.facilityId,
      basis: 'per_activity_hour',
      amountMinor: 1_000,
      currency: 'USD',
      effectiveFrom: '2027-01-01',
      description: 'Direct field cost (lighting, line marking, turf wear)',
      approvalReference: 'DEC-085 finance approval',
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body.approvedBy.personId).toBe(finance.personId);

    const res = await report(finance, { allocationMethod: 'pro_rata', includeMargin: 'true' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(spaceRow(res.body, pitch.pitchId)).toMatchObject({
      costMinor: 2_000,
      contributionMinor: 3_000,
      contributionPerActivityHourMinor: 1_500,
    });
    expect(spaceRow(res.body, pitch.northHalfId)).toMatchObject({
      costMinor: 1_500,
      contributionMinor: 3_000,
    });
    expect(valueOf(res.body, 'MET-077', 'Contribution margin per activity hour', 'USD')).toBe(
      Math.round(6_000 / 3.5),
    );

    // A space's own agreed input takes precedence over the facility's.
    const own = await post(t, '/v1/reports/cost-inputs', finance, {
      facilityId: t.facilityId,
      resourceId: pitch.pitchId,
      basis: 'per_activity_hour',
      amountMinor: 2_000,
      currency: 'USD',
      effectiveFrom: '2027-01-01',
      description: 'Floodlit full pitch',
      approvalReference: 'DEC-085 finance approval',
    });
    expect(own.status).toBe(201);
    const withOwn = await report(finance, { allocationMethod: 'pro_rata', includeMargin: 'true' });
    expect(spaceRow(withOwn.body, pitch.pitchId)).toMatchObject({
      costMinor: 4_000,
      contributionMinor: 1_000,
    });
  });

  it('cost inputs: overlapping agreed inputs are refused; withdrawal checks the revision and follows the machine', async () => {
    const overlap = await post(t, '/v1/reports/cost-inputs', finance, {
      facilityId: t.facilityId,
      basis: 'per_activity_hour',
      amountMinor: 900,
      currency: 'USD',
      effectiveFrom: '2027-02-01',
      effectiveTo: '2027-03-01',
      description: 'Overlapping input',
      approvalReference: 'none',
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('RESOURCE_CONFLICT');

    const list = await get(t, '/v1/reports/cost-inputs', finance, { facilityId: t.facilityId });
    expect(list.status).toBe(200);
    const facilityWide = list.body.items.find(
      (c: { resourceId: string | null }) => c.resourceId === null,
    );
    const stale = await post(t, `/v1/reports/cost-inputs/${facilityWide.id}/withdraw`, finance, {
      reason: 'Superseded by the new agreement',
      expectedRevision: facilityWide.revision + 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const withdrawn = await post(
      t,
      `/v1/reports/cost-inputs/${facilityWide.id}/withdraw`,
      finance,
      {
        reason: 'Superseded by the new agreement',
        expectedRevision: facilityWide.revision,
      },
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe('withdrawn');
    const again = await post(t, `/v1/reports/cost-inputs/${facilityWide.id}/withdraw`, finance, {
      reason: 'Again',
      expectedRevision: withdrawn.body.revision,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    // With the facility-wide input withdrawn, the north half has no agreed input: margin refused again.
    const refused = await report(finance, { allocationMethod: 'pro_rata', includeMargin: 'true' });
    expect(refused.status).toBe(400);
    expect(refused.body.details.missing).toEqual(
      expect.arrayContaining([expect.objectContaining({ resourceId: pitch.northHalfId })]),
    );
  });

  it('SPK-REPORT-007 (G3): a margin run reproduces after its cost input is corrected (withdrawn and recorded again)', async () => {
    const costInput = {
      facilityId: t.facilityId,
      basis: 'per_activity_hour',
      currency: 'USD',
      effectiveFrom: '2027-01-01',
      description: 'Direct field cost (lighting, line marking, turf wear)',
      approvalReference: 'DEC-085 finance approval',
    };
    const recorded = await post(t, '/v1/reports/cost-inputs', finance, {
      ...costInput,
      amountMinor: 1_000,
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const run = await post(t, '/v1/reports/runs', finance, {
      report: 'economics',
      parameters: {
        facilityId: t.facilityId,
        from: '2027-02-01',
        to: '2027-02-07',
        allocationMethod: 'pro_rata',
        includeMargin: true,
      },
      reason: 'Monthly margin review',
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(spaceRow(run.body.result, pitch.northHalfId)).toMatchObject({ costMinor: 1_500 });

    // An hour later finance corrects the input: withdrawn, then recorded with the right amount.
    t.clock.advance(HOUR);
    const withdrawn = await post(
      t,
      `/v1/reports/cost-inputs/${recorded.body.id}/withdraw`,
      finance,
      { reason: 'Corrected amount', expectedRevision: recorded.body.revision },
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    const corrected = await post(t, '/v1/reports/cost-inputs', finance, {
      ...costInput,
      amountMinor: 1_200,
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);

    // Re-evaluated at the run's as-of instant, the inputs in force then give the same figures.
    const reproduced = await post(t, `/v1/reports/runs/${run.body.id}/reproduce`, finance, {});
    expect(reproduced.status, JSON.stringify(reproduced.body)).toBe(201);
    expect(reproduced.body.matched).toBe(true);
    // Evaluated now, the corrected input applies.
    const live = await report(finance, { allocationMethod: 'pro_rata', includeMargin: 'true' });
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(spaceRow(live.body, pitch.northHalfId)).toMatchObject({ costMinor: 1_800 });
  });

  it('SPK-REPORT-004 (E2, G2): a refund of an order with lines at several facilities counts only the share of this facility’s lines', async () => {
    const otherFacilityId = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: otherFacilityId,
        organization_id: t.organizationId,
        slug: 'north-complex',
        name: 'North complex',
        timezone: 'America/Los_Angeles',
        address: null,
      })
      .execute();
    const managerId = (await staff(t, ['program_manager'])).personId;
    const offering = (facilityId: string, basePriceMinor: number) =>
      createOfferingFixture(t, {
        responsibleManagerPersonId: managerId,
        facilityId,
        kind: 'membership',
        startsOn: '2027-02-01',
        endsOn: '2027-12-31',
        basePriceMinor,
      });
    const here = await offering(t.facilityId, 100);
    const there = await offering(otherFacilityId, 900);
    const payer = await createPersonFixture(t, { kind: 'adult' });
    const order = await createFulfilledOrder(t, {
      payerPersonId: payer,
      fulfilledAt: t.clock.now(),
      lines: [
        {
          offeringId: here.offeringId,
          participantPersonId: payer,
          priceRuleId: here.priceRuleId!,
          amountMinor: 100,
        },
        {
          offeringId: there.offeringId,
          participantPersonId: payer,
          priceRuleId: there.priceRuleId!,
          amountMinor: 900,
        },
      ],
    });
    // Refunded in full, in two refunds: 667 and 333 of the 1000 paid.
    await createRefundedOrderPayment(t, {
      order,
      payerPersonId: payer,
      paidMinor: 1_000,
      paidAt: t.clock.now(),
      refunds: [
        { amountMinor: 667, resolvedAt: t.clock.now() },
        { amountMinor: 333, resolvedAt: t.clock.now() },
      ],
    });
    const res = await report(finance, { allocationMethod: 'pro_rata' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Each refund is split over the order's lines by their totals (largest remainder): 67 + 33.
    expect(
      valueOf(res.body, 'MET-074', 'Refunds of these sales (adjustment, not netted)', 'USD'),
    ).toBe(100);
  });

  it('access: financial viewers only; cost inputs are managed by finance', async () => {
    const scheduler = await staff(t, ['scheduler']);
    expect((await report(scheduler, { allocationMethod: 'pro_rata' })).status).toBe(403);
    const attempt = await post(t, '/v1/reports/cost-inputs', scheduler, {
      facilityId: t.facilityId,
      basis: 'per_activity_hour',
      amountMinor: 1,
      currency: 'USD',
      effectiveFrom: '2030-01-01',
      description: 'Not allowed',
      approvalReference: 'none',
    });
    expect(attempt.status).toBe(403);
    expect((await get(t, '/v1/reports/cost-inputs', scheduler)).status).toBe(403);
  });
});
