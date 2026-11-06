import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingFixture } from '../../catalog';
import { FinanceModule, createObligationFixture } from '../../finance';
import { createPersonFixture } from '../../identity';
import {
  at,
  ClosuresService,
  createAppliedClosure,
  createScheduledEvent,
  EventsService,
  seedOperatingHours,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { hourCells } from '../reports/utilization.report';
import {
  createFulfilledOrder,
  customer,
  get,
  post,
  reportingTestApp,
  staff,
  valueOf,
  type Actor,
} from './support';

const DATE = '2027-02-03'; // a Wednesday
type Row = Record<string, string | number | boolean | null>;

/**
 * Park UI redesign reporting gaps: utilization by weekday and hour (MET-106 to MET-108,
 * SPK-REPORT-003/006), sales by product line (MET-109, MET-110; SPK-REPORT-004, SPK-PAY-011) and
 * the sidebar attention counts (GET /v1/me/attention, SPK-UX-005).
 */
describe('redesign reports: utilization heatmap, sales by product line, attention counts', () => {
  let t: TestApp;
  let scheduler: Actor;
  let manager: Actor;
  let desk: Actor;
  let finance: Actor;
  let pitch: PitchFixture;

  beforeAll(async () => {
    t = await reportingTestApp({ imports: [FinanceModule] });
    await t.enableCapability('point_of_sale');
    scheduler = await staff(t, ['scheduler']);
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    finance = await staff(t, ['finance_operator']);
    const org = t.organizationId;
    await seedOperatingHours(t.db, {
      organizationId: org,
      facilityId: t.facilityId,
      opensAt: '08:00',
      closesAt: '22:00',
    });
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: t.facilityId,
      name: 'Pitch 1',
      defaultCleanupMinutes: 10,
    });
    const events = t.app.get(EventsService);
    await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.pitchId],
      start: at(DATE, '10:00'),
      end: at(DATE, '11:00'),
      kind: 'game',
    });
    await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.northHalfId],
      start: at(DATE, '14:00'),
      end: at(DATE, '15:00'),
      kind: 'practice',
    });
    await createAppliedClosure(t.app.get(ClosuresService), {
      organizationId: org,
      facilityId: t.facilityId,
      resourceId: pitch.southHalfId,
      start: at(DATE, '18:00'),
      end: at(DATE, '20:00'),
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-003 / SPK-REPORT-006: utilization by weekday and hour counts each physical unit-hour once per local clock hour', async () => {
    const res = await get(t, '/v1/reports/utilization-heatmap', scheduler, {
      facilityId: t.facilityId,
      from: DATE,
      to: DATE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.rows as Row[];
    const cell = (hour: number) => rows.find((r) => r.weekday === 3 && r.hour === hour);
    // Two conflict units (the pitch halves), open 08:00-22:00.
    expect(rows).toHaveLength(14);
    expect(cell(7)).toBeUndefined();
    expect(cell(8)).toMatchObject({ weekdayName: 'wednesday', days: 1, availableUnitHours: 2 });
    // The whole-pitch game holds both units 10:00-11:10 (ten-minute cleanup).
    expect(cell(10)).toMatchObject({ reservedUnitHours: 2, utilizationRate: 1 });
    expect(Number(cell(11)!.reservedUnitHours)).toBeCloseTo(20 / 60, 4);
    // The half-pitch practice holds one unit 14:00-15:10.
    expect(cell(14)).toMatchObject({ reservedUnitHours: 1, utilizationRate: 0.5 });
    // The south half is closed 18:00-20:00: closure time, not available time.
    expect(cell(18)).toMatchObject({ availableUnitHours: 1, closureUnitHours: 1 });
    expect(valueOf(res.body, 'MET-108', 'Available unit-hours (all cells)')).toBeCloseTo(26, 4);
    const busiest = (res.body.values as Array<{ metric: string; dimensions: object }>).find(
      (v) => v.metric === 'MET-107',
    );
    expect(busiest).toMatchObject({ dimensions: { weekday: 'wednesday', hour: '10' } });
    // Every value cites its metric definition (SPK-REPORT-001).
    const keys = (res.body.metrics as Array<{ metricKey: string }>).map((d) => d.metricKey);
    expect(keys).toEqual(expect.arrayContaining(['MET-106', 'MET-107', 'MET-108']));
    // A role without the utilization view is refused.
    const byDesk = await get(t, '/v1/reports/utilization-heatmap', desk, {
      facilityId: t.facilityId,
      from: DATE,
      to: DATE,
    });
    expect(byDesk.status).toBe(403);
  });

  it('hourCells: a day splits at local clock hours, also across a daylight-saving change', () => {
    const day = {
      start: Date.parse('2027-03-14T08:00:00Z'),
      end: Date.parse('2027-03-15T07:00:00Z'),
    };
    const cells = hourCells('America/Los_Angeles', day);
    // 14 March 2027 is the spring-forward day: 23 local hours, and no 02:00 hour.
    expect(cells).toHaveLength(23);
    expect(cells.map((c) => c.key)).not.toContain('0:2');
    expect(cells.every((c) => c.end - c.start === 3_600_000)).toBe(true);
  });

  it('SPK-REPORT-004 / SPK-PAY-011: sales by product line split registrations by offering kind and the register by product kind; returns stay apart', async () => {
    const managerId = (await staff(t, ['program_manager'])).personId;
    const camp = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      kind: 'camp',
      startsOn: '2027-02-04',
      endsOn: '2027-02-04',
      basePriceMinor: 4_500,
    });
    const payer = await createPersonFixture(t, { kind: 'adult' });
    const kid = await createPersonFixture(t, { kind: 'child' });
    await createFulfilledOrder(t, {
      payerPersonId: payer,
      fulfilledAt: t.clock.now(),
      lines: [
        {
          offeringId: camp.offeringId,
          participantPersonId: kid,
          priceRuleId: camp.priceRuleId!,
          amountMinor: 4_500,
        },
      ],
    });
    const product = await post(t, '/v1/pos-products', manager, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Sports drink',
      kind: 'concession',
      priceMinor: 300,
      currency: 'USD',
      chargePolicyKeys: [],
    });
    const register = await post(t, '/v1/pos-registers', manager, {
      facilityId: t.facilityId,
      code: 'SBP1',
      name: 'Sales desk',
    });
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    const sale = await post(t, '/v1/pos-sales', desk, { registerSessionId: session.body.id });
    const added = await post(t, `/v1/pos-sales/${sale.body.id}/lines`, desk, {
      productId: product.body.id,
      quantity: 1,
    });
    // Changed to 2 before payment: only the line in effect is sold.
    const changed = await post(
      t,
      `/v1/pos-sales/${sale.body.id}/lines/${added.body.lines[0].id}/quantity`,
      desk,
      { quantity: 2, expectedRevision: added.body.revision },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const paid = await post(t, `/v1/pos-sales/${sale.body.id}/tenders`, desk, {
      kind: 'cash',
      amountMinor: 600,
    });
    expect(paid.body.status).toBe('paid');
    const returned = await post(t, `/v1/pos-sales/${sale.body.id}/returns`, finance, {
      lines: [{ saleLineId: changed.body.lines[0].id, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Spilled',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);

    const today = t.clock.now().toISOString().slice(0, 10);
    const res = await get(t, '/v1/reports/sales-by-product-line', finance, {
      facilityId: t.facilityId,
      from: '2027-02-01',
      to: today,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.rows as Row[];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'registration',
          productLine: 'camp',
          currency: 'USD',
          salesMinor: 4_500,
          returnsMinor: null,
        }),
        expect.objectContaining({
          source: 'point_of_sale',
          productLine: 'concession',
          lines: 1,
          salesMinor: 600,
          returnsMinor: 300,
        }),
      ]),
    );
    expect((res.body.disclosures as string[]).join(' ')).toContain('not recognized revenue');
    const bySched = await get(t, '/v1/reports/sales-by-product-line', scheduler, {
      facilityId: t.facilityId,
      from: '2027-02-01',
      to: today,
    });
    expect(bySched.status).toBe(403);
  });

  it('SPK-UX-005: attention counts list only the areas whose lists the viewer may read, with what each counts', async () => {
    const parent = await customer(t);
    await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 1_000,
      dueAt: new Date(t.clock.now().getTime() - 86_400_000),
    });
    const forFinance = await get(t, '/v1/me/attention', finance, {});
    expect(forFinance.status, JSON.stringify(forFinance.body)).toBe(200);
    const areas = (forFinance.body.areas as Array<{ area: string; count: number }>).map(
      (a) => a.area,
    );
    expect(areas).toContain('finance');
    // A scheduler holds no finance list: the finance area is left out, not shown as zero.
    const forScheduler = await get(t, '/v1/me/attention', scheduler, {});
    expect((forScheduler.body.areas as Array<{ area: string }>).map((a) => a.area)).not.toContain(
      'finance',
    );
    const financeArea = forFinance.body.areas.find((a: { area: string }) => a.area === 'finance');
    expect(financeArea).toMatchObject({ count: 0, capped: false });
    // A customer reads none of the staff lists: no area, never a zero for an area they cannot see.
    const forCustomer = await get(t, '/v1/me/attention', parent, {});
    expect(forCustomer.status).toBe(200);
    expect(forCustomer.body.areas).toEqual([]);
    expect(forCustomer.body.cap).toBe(99);
  });
});
