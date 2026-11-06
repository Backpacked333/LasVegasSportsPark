import { newId, systemPrincipal } from '@sportspark/contracts';
import { json, pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { EventsService } from '../../scheduling';
import {
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling/testing/scheduling-fixtures';
import { CatalogModule } from '../catalog.module';
import {
  createDiscountFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  createProgramFixture,
} from '../testing/catalog-fixtures';

const key = () => `k-${newId()}`;
type Auth = { Authorization: string };

/**
 * Park UI API gaps owned by the catalog (docs/design/park-ui-redesign.md): a session's location
 * and capacity on the facility day (arrival "Sessions now"; SPK-CAT-001 location, SPK-CAT-002
 * sessions, SPK-SCHED-008), free-text discover search (SPK-UX-002 Discover) and automatic
 * discounts as promotion badges on the public offering (SPK-PAY-003).
 */
describe('catalog park UI gaps', () => {
  let t: TestApp;
  let managerPersonId: string;
  let pm: Auth;
  let frontDesk: Auth;
  let customer: Auth;
  let slug: string;
  let pitch: PitchFixture;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-11-02T18:00:00Z',
    });
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    managerPersonId = manager.personId;
    pm = await authHeaderForPerson(t, manager.personId);
    frontDesk = await authHeaderForPerson(
      t,
      (await createStaffMemberFixture(t, { roles: ['front_desk'] })).personId,
    );
    customer = await authHeaderForPerson(t, (await createOrganizationPeople(t)).adult.personId);
    slug = (
      await t.db
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', t.organizationId)
        .executeTakeFirstOrThrow()
    ).slug;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 3',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const at = (iso: string) => new Date(iso);
  const window = { from: '2026-11-02T08:00:00.000Z', to: '2026-11-03T08:00:00.000Z' };

  describe('session location and capacity (arrival "Sessions now")', () => {
    it('SPK-CAT-001: a session records its own location; resources must be at the offering facility', async () => {
      const offering = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        name: 'Saturday kickers',
      });
      const created = await t.http
        .post(`/v1/offerings/${offering.offeringId}/sessions`)
        .set(pm)
        .set('Idempotency-Key', key())
        .send({
          scheduledStart: '2026-11-02T20:00:00Z',
          scheduledEnd: '2026-11-02T21:00:00Z',
          location: { label: '  North half  ', resourceIds: [pitch.northHalfId] },
        });
      expect(created.status).toBe(201);
      expect(created.body.location).toEqual({
        label: 'North half',
        resourceIds: [pitch.northHalfId],
      });
      const audit = await t.db
        .selectFrom('audit_records')
        .select('details')
        .where('target_id', '=', created.body.id as string)
        .where('action', '=', 'catalog.session_created')
        .executeTakeFirstOrThrow();
      expect(audit.details).toMatchObject({
        location: { label: 'North half', resourceIds: [pitch.northHalfId] },
      });

      const unknown = await t.http
        .post(`/v1/offerings/${offering.offeringId}/sessions`)
        .set(pm)
        .set('Idempotency-Key', key())
        .send({
          scheduledStart: '2026-11-02T22:00:00Z',
          scheduledEnd: '2026-11-02T23:00:00Z',
          location: { resourceIds: [newId()] },
        });
      expect(unknown.status).toBe(400);
      expect(unknown.body.details.path).toBe('location.resourceIds');

      const empty = await t.http
        .post(`/v1/offerings/${offering.offeringId}/sessions`)
        .set(pm)
        .set('Idempotency-Key', key())
        .send({
          scheduledStart: '2026-11-02T22:00:00Z',
          scheduledEnd: '2026-11-02T23:00:00Z',
          location: {},
        });
      expect(empty.status).toBe(400);

      // §4.14: the child-safe session view names the place, not the scheduling resources.
      const publicSessions = await t.http
        .get(`/v1/offerings/${offering.offeringId}/sessions`)
        .set(customer);
      expect(publicSessions.status).toBe(200);
      expect(publicSessions.body[0].location).toEqual({ label: 'North half' });
    });

    it('SPK-SCHED-008: GET /sessions gives each session its place (event, session or offering) and its configured capacity', async () => {
      const offering = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        name: 'Futsal clinic',
        capacityUnits: [{ unit: 'seats', limit: 18 }],
      });
      const own = await createOfferingSessionFixture(t, {
        offeringId: offering.offeringId,
        scheduledStart: at('2026-11-03T01:00:00Z'),
        scheduledEnd: at('2026-11-03T02:00:00Z'),
        location: { label: 'South half', resourceIds: [pitch.southHalfId] },
        capacityOverride: [{ unit: 'session_seats', limit: 12 }],
      });
      const inherited = await createOfferingSessionFixture(t, {
        offeringId: offering.offeringId,
        scheduledStart: at('2026-11-03T03:00:00Z'),
        scheduledEnd: at('2026-11-03T04:00:00Z'),
      });
      const event = await t.app
        .get(EventsService)
        .createEvent(systemPrincipal(t.organizationId, 'fixtures'), {
          facilityId: t.facilityId,
          kind: 'practice',
          title: 'Futsal clinic',
          format: null,
          scheduledStart: '2026-11-03T05:00:00.000Z',
          scheduledEnd: '2026-11-03T06:00:00.000Z',
          resourceIds: [pitch.pitchId],
          commitments: [],
          sourceType: 'program',
          sourceId: offering.offeringId,
          status: 'published',
        });
      const reserved = await createOfferingSessionFixture(t, {
        offeringId: offering.offeringId,
        scheduledStart: at('2026-11-03T05:00:00Z'),
        scheduledEnd: at('2026-11-03T06:00:00Z'),
        schedulingEventId: event.id,
        location: { label: 'South half' },
      });
      const day = await t.http
        .get('/v1/sessions')
        .set(frontDesk)
        .query({ facilityId: t.facilityId, ...window });
      expect(day.status).toBe(200);
      const byId = new Map(
        (day.body.items as Array<{ sessionId: string }>).map((s) => [s.sessionId, s]),
      );
      expect(byId.get(own)).toMatchObject({
        location: {
          source: 'session',
          label: 'South half',
          resources: [{ id: pitch.southHalfId, name: expect.any(String) }],
        },
        capacity: { source: 'session', units: [{ unit: 'session_seats', limit: 12 }] },
      });
      expect(byId.get(inherited)).toMatchObject({
        location: { source: 'offering', label: 'Main complex', resources: [] },
        capacity: { source: 'offering', units: [{ unit: 'seats', limit: 18 }] },
      });
      // Scheduling is the authority for reserved space: the event's resources win.
      expect(byId.get(reserved)).toMatchObject({
        location: {
          source: 'scheduling_event',
          label: 'South half',
          resources: [{ id: pitch.pitchId, name: 'Pitch 3' }],
        },
      });
    });

    it('SPK-CAT-001 integrity: the database refuses a session location without a label or resources, or of the wrong shape', async () => {
      const offering = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
      });
      const insert = (location: unknown, sequence: number) =>
        t.db
          .insertInto('offering_sessions')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            offering_id: offering.offeringId,
            sequence,
            title: null,
            scheduled_start: at('2026-12-01T18:00:00Z'),
            scheduled_end: at('2026-12-01T19:00:00Z'),
            scheduling_event_id: null,
            capacity_override: null,
            location: json(location as Record<string, unknown>),
            canceled_at: null,
            cancel_reason: null,
          })
          .execute();
      const code = async (p: Promise<unknown>) => {
        try {
          await p;
          return 'accepted';
        } catch (error) {
          return pgErrorCode(error);
        }
      };
      expect(await code(insert({}, 1))).toBe('23514');
      expect(await code(insert({ label: '   ' }, 2))).toBe('23514');
      expect(await code(insert({ resourceIds: [] }, 3))).toBe('23514');
      expect(await code(insert({ resourceIds: 'pitch' }, 4))).toBe('23514');
      expect(await code(insert({ label: 7 }, 5))).toBe('23514');
      expect(await code(insert(['North'], 6))).toBe('23514');
      expect(await code(insert({ label: 'North half' }, 7))).toBe('accepted');
      expect(await code(insert({ resourceIds: [pitch.pitchId] }, 8))).toBe('accepted');
    });
  });

  describe('discover search', () => {
    it('SPK-UX-002: q matches every word in the offering text or its program name, case-insensitively', async () => {
      const program = await createProgramFixture(t, { name: 'Winter Futsal Academy' });
      const camp = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        programId: program,
        name: 'Holiday camp week 1',
        kind: 'camp',
      });
      const other = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        name: 'Adult league 100% fun',
      });
      const search = (q: string) =>
        t.http.get('/v1/offerings').query({ organization: slug, q, limit: 200 });
      const ids = (res: { body: { items: Array<{ id: string }> } }) =>
        res.body.items.map((o) => o.id);

      const byName = await search('HOLIDAY camp');
      expect(byName.status).toBe(200);
      expect(ids(byName)).toEqual([camp.offeringId]);
      expect(ids(await search('futsal academy'))).toEqual([camp.offeringId]);
      expect(ids(await search('holiday league'))).toEqual([]);
      // LIKE wildcards are literal: "100%" matches the text, "%" alone matches nothing extra.
      expect(ids(await search('100%'))).toEqual([other.offeringId]);
      expect(ids(await search('0_ fun'))).toEqual([]);
      expect((await search('x')).status).toBe(400);
    });
  });

  describe('promotions on the public offering', () => {
    it('SPK-PAY-003: active automatic discounts the offering meets are listed as badges; promo codes and spent offers never are', async () => {
      const program = await createProgramFixture(t);
      const camp = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        programId: program,
        name: 'Spring camp',
        kind: 'camp',
        basePriceMinor: 26_900,
      });
      const term = await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        programId: program,
        name: 'Spring term',
        kind: 'term',
        basePriceMinor: 9_000,
      });
      const earlyBird = await createDiscountFixture(t, {
        code: null,
        name: 'Early bird',
        amountKind: 'percentage',
        amountValue: 1500,
        eligibilityRules: {
          offeringKinds: ['camp'],
          registrationBefore: '2026-12-01T08:00:00.000Z',
        },
      });
      const multiWeek = await createDiscountFixture(t, {
        code: null,
        name: 'Two weeks or more',
        amountKind: 'fixed',
        amountValue: 2_000,
        currency: 'USD',
        eligibilityRules: { programIds: [program], minLines: 2 },
        effectiveTo: new Date('2027-01-31T08:00:00.000Z'),
      });
      // never shown: a promo code, a past deadline, another currency, too cheap, exhausted, draft
      await createDiscountFixture(t, { code: 'SECRET10', eligibilityRules: {} });
      await createDiscountFixture(t, {
        code: null,
        eligibilityRules: { registrationBefore: '2026-11-01T08:00:00.000Z' },
      });
      await createDiscountFixture(t, {
        code: null,
        amountKind: 'fixed',
        currency: 'EUR',
        eligibilityRules: {},
      });
      await createDiscountFixture(t, {
        code: null,
        eligibilityRules: { minLineAmountMinor: 50_000 },
      });
      const spent = await createDiscountFixture(t, {
        code: null,
        redemptionLimit: 1,
        eligibilityRules: {},
      });
      await t.db
        .updateTable('discount_redemptions')
        .set({ redeemed_count: 1 })
        .where('discount_definition_id', '=', spent)
        .execute();
      await createDiscountFixture(t, { code: null, status: 'draft', eligibilityRules: {} });

      const list = await t.http
        .get('/v1/offerings')
        .query({ organization: slug, programId: program });
      expect(list.status).toBe(200);
      const view = (id: string) =>
        (list.body.items as Array<{ id: string; promotions: unknown[] }>).find((o) => o.id === id)!;
      expect(view(camp.offeringId).promotions).toEqual([
        {
          discountDefinitionId: earlyBird,
          name: 'Early bird',
          description: null,
          basis: 'early_registration',
          amountKind: 'percentage',
          amountValue: 1500,
          currency: null,
          minLines: null,
          availableUntil: '2026-12-01T08:00:00.000Z',
        },
        {
          discountDefinitionId: multiWeek,
          name: 'Two weeks or more',
          description: null,
          basis: 'multi_line',
          amountKind: 'fixed',
          amountValue: 2000,
          currency: 'USD',
          minLines: 2,
          availableUntil: '2027-01-31T08:00:00.000Z',
        },
      ]);
      expect(view(term.offeringId).promotions).toEqual([
        expect.objectContaining({ discountDefinitionId: multiWeek }),
      ]);
      // The single read shows the same badges.
      const one = await t.http.get(`/v1/offerings/${camp.offeringId}`).set(customer);
      expect(one.status).toBe(200);
      expect(one.body.promotions).toHaveLength(2);
    });
  });
});
