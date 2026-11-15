import { newId, type Principal } from '@sportspark/contracts';
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation, json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../kernel';
import {
  createTestApp,
  setCapability,
  staffPrincipal,
  TEST_CONFIG_ENV,
  type TestApp,
} from '../../../testing';
import { EventsService } from '../services/events.service';
import { SchedulingModule } from '../scheduling.module';
import { SchedulingSettings } from '../scheduling.settings';
import { at, createScheduledEvent, seedResource } from '../testing/scheduling-fixtures';

type Json = Record<string, unknown>;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DAY = '2026-11-21';

/** Every key that appears anywhere in a JSON value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  }
  return into;
}

const notAvailable = { code: 'NOT_FOUND', message: 'This view is not available.' };
/** The parts of an error answer that must not differ between the "not available" cases. */
const answerOf = (res: { status: number; body: Json; headers: Record<string, string> }) => ({
  status: res.status,
  code: res.body['code'],
  message: res.body['message'],
  details: res.body['details'],
  cache: res.headers['cache-control'],
});

/**
 * The facility day schedule without sign-in (SPK-SCHED-010, proposed amendment PA-06; capability
 * `public_schedule`; ADR-005). The values an operator has not decided (DEC-100) are the proposed
 * defaults: a private booking reads "Reserved".
 */
describe('public facility schedule (SPK-SCHED-010)', () => {
  let t: TestApp;
  let events: EventsService;
  let scheduler: Principal;
  let slug: string;
  let code: string;
  const names = {
    renter: 'Okafor family reunion',
    child: 'Tommy Lindqvist',
    coach: 'Coach Anna Petrov',
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [SchedulingModule],
      clockStart: '2026-11-21T18:00:00Z',
      capabilities: ['public_schedule'],
    });
    events = t.app.get(EventsService);
    scheduler = staffPrincipal(t.organizationId, ['scheduler']);
    // The seeded organization's slug and name carry its id; a real one has neither.
    slug = 'desert-park';
    await t.db
      .updateTable('organizations')
      .set({ slug, name: 'Desert Park' })
      .where('id', '=', t.organizationId)
      .execute();
    const field1 = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Field 1',
    });
    const field2 = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Field 2',
    });
    const base = { organizationId: t.organizationId, facilityId: t.facilityId };
    // A private booking whose title names the renter and whose commitment names a person.
    await createScheduledEvent(events, {
      ...base,
      resourceIds: [field1.resourceId],
      start: at(DAY, '09:00'),
      end: at(DAY, '10:00'),
      kind: 'rental',
      title: names.renter,
      sourceType: 'booking',
      commitments: [{ partyType: 'person', partyId: newId(), role: 'renter' }],
    });
    // A class whose title a person typed, with a child's and a coach's name in it.
    await createScheduledEvent(events, {
      ...base,
      resourceIds: [field2.resourceId],
      start: at(DAY, '09:00'),
      end: at(DAY, '09:45'),
      kind: 'session',
      title: `Tots with ${names.coach} (${names.child}'s group)`,
      sourceType: 'session',
    });
    // A game; no module vouches for its title in this application.
    await createScheduledEvent(events, {
      ...base,
      resourceIds: [field1.resourceId, field2.resourceId],
      start: at(DAY, '19:00'),
      end: at(DAY, '20:00'),
      kind: 'game',
      title: 'Comets vs Rockets',
    });
    await createScheduledEvent(events, {
      ...base,
      resourceIds: [field2.resourceId],
      start: at(DAY, '12:00'),
      end: at(DAY, '13:00'),
      kind: 'maintenance',
      title: 'Turf repair by Desert Turf LLC',
      sourceType: 'maintenance',
    });
    // Not part of the day: a draft, and a game of the next day.
    await createScheduledEvent(events, {
      ...base,
      resourceIds: [field1.resourceId],
      start: at(DAY, '15:00'),
      end: at(DAY, '16:00'),
      kind: 'practice',
      title: 'Draft practice',
      status: 'draft',
    });
    await createScheduledEvent(events, {
      ...base,
      resourceIds: [field1.resourceId],
      start: at('2026-11-22', '09:00'),
      end: at('2026-11-22', '10:00'),
      kind: 'practice',
      title: 'Tomorrow',
    });
    const enabled = await t.http
      .post(`/v1/facilities/${t.facilityId}/public-schedule-view/enable`)
      .set(await t.authHeader(scheduler))
      .set('Idempotency-Key', `k-${newId()}`)
      .send({});
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    code = enabled.body.publicCode as string;
  });
  afterAll(async () => {
    await t.close();
  });

  const read = (organization: string, publicCode: string, query = `?date=${DAY}`) =>
    t.http.get(`/v1/public/${organization}/schedule/${publicCode}${query}`);

  it('SPK-SCHED-010: a facility schedule for a day, by field and time, is read without sign-in', async () => {
    const res = await read(slug, code);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      organizationName: 'Desert Park',
      facilityName: 'Main complex',
      timezone: 'America/Los_Angeles',
      date: DAY,
      // yesterday to 14 days ahead, in the facility's zone (proposed default)
      window: { from: '2026-11-20', to: '2026-12-05' },
      fields: ['Field 1', 'Field 2'],
      computedAt: t.clock.now().toISOString(),
      cacheSeconds: 30,
    });
    expect(res.body.entries).toEqual([
      {
        startsAt: at(DAY, '09:00'),
        endsAt: at(DAY, '10:00'),
        fields: ['Field 1'],
        kind: 'reserved',
        title: 'Reserved',
        score: null,
      },
      {
        startsAt: at(DAY, '09:00'),
        endsAt: at(DAY, '09:45'),
        fields: ['Field 2'],
        kind: 'class',
        title: 'Class',
        score: null,
      },
      {
        startsAt: at(DAY, '12:00'),
        endsAt: at(DAY, '13:00'),
        fields: ['Field 2'],
        kind: 'unavailable',
        title: 'Not available',
        score: null,
      },
      {
        startsAt: at(DAY, '19:00'),
        endsAt: at(DAY, '20:00'),
        fields: ['Field 1', 'Field 2'],
        kind: 'game',
        title: 'League game',
        score: null,
      },
    ]);
    // A short public cache lifetime, and the time the answer was computed.
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    // Without a date: today in the facility's zone (the clock is 10:00 local on that day).
    const today = await read(slug, code, '');
    expect(today.body.date).toBe(DAY);
    expect(today.body.entries).toHaveLength(4);
  });

  it('SPK-SCHED-010: the payload has no field for a person, a booker, a contact or an internal id; a private booking reads "Reserved" and a typed title is never shown', async () => {
    const res = await read(slug, code);
    // Exhaustive: every key that appears anywhere in the answer.
    expect([...keysOf(res.body)].sort()).toEqual(
      [
        'cacheSeconds',
        'computedAt',
        'date',
        'endsAt',
        'entries',
        'facilityName',
        'fields',
        'from',
        'kind',
        'organizationName',
        'score',
        'startsAt',
        'timezone',
        'title',
        'to',
        'window',
      ].sort(),
    );
    const text = JSON.stringify(res.body);
    // No identifier usable to read a private record: no uuid at all, not the facility's either.
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain(t.facilityId);
    expect(text).not.toContain(t.organizationId);
    // No renter, no child, no coach, no supplier: nothing a person typed.
    for (const name of [
      ...Object.values(names),
      'Okafor',
      'Tommy',
      'Anna',
      'Desert Turf',
      'Draft',
    ]) {
      expect(text).not.toContain(name);
    }
    expect(res.body.entries.map((entry: Json) => entry['title'])).toEqual([
      'Reserved',
      'Class',
      'Not available',
      'League game',
    ]);
  });

  it('SPK-SCHED-010 (security review L-3): the public day schedule answers only for a window around today in the facility’s zone; any other day is "not available" like an unknown code', async () => {
    const unknownCode = answerOf(await read(slug, '0'.repeat(24)));
    expect(unknownCode.status).toBe(404);
    // The clock is 2026-11-21 10:00 in the facility's zone: yesterday to 14 days ahead.
    const inside = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-12-05'];
    for (const date of inside) {
      const res = await read(slug, code, `?date=${date}`);
      expect(res.status, date).toBe(200);
      expect(res.body.date).toBe(date);
      expect(res.body.window).toEqual({ from: '2026-11-20', to: '2026-12-05' });
    }
    // The facility's history and its forward booking state are not an anonymous read: one day
    // before the window, one day after it, last year, next year.
    const outside = ['2026-11-19', '2026-12-06', '2025-11-21', '2027-11-21', '2026-01-01'];
    for (const date of outside) {
      expect(answerOf(await read(slug, code, `?date=${date}`)), date).toEqual(unknownCode);
    }
    // Something is scheduled on a day outside the window: it is not shown either.
    const field = await t.db
      .selectFrom('resources')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .where('name', '=', 'Field 1')
      .executeTakeFirstOrThrow();
    await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [field.id],
      start: at('2026-12-20', '09:00'),
      end: at('2026-12-20', '10:00'),
      kind: 'rental',
      title: names.renter,
      sourceType: 'booking',
    });
    expect(answerOf(await read(slug, code, '?date=2026-12-20'))).toEqual(unknownCode);

    // The window follows the facility's local day, not UTC: at 23:30 local on the 21st it is
    // already the 22nd in UTC, and the window is still the one of the 21st.
    t.clock.advance(13.5 * 3_600_000);
    try {
      expect(t.clock.now().toISOString()).toBe('2026-11-22T07:30:00.000Z');
      const late = await read(slug, code, '');
      expect(late.body).toMatchObject({
        date: '2026-11-21',
        window: { from: '2026-11-20', to: '2026-12-05' },
      });
      expect((await read(slug, code, '?date=2026-12-06')).status).toBe(404);
      // Half an hour later the local day turns, and the window moves with it.
      t.clock.advance(3_600_000);
      const next = await read(slug, code, '');
      expect(next.body).toMatchObject({
        date: '2026-11-22',
        window: { from: '2026-11-21', to: '2026-12-06' },
      });
      expect((await read(slug, code, '?date=2026-12-06')).status).toBe(200);
      expect(answerOf(await read(slug, code, '?date=2026-11-20'))).toEqual(unknownCode);
    } finally {
      t.clock.advance(-14.5 * 3_600_000);
    }
    // A date that is not a calendar date is a validation answer, as before.
    expect((await read(slug, code, '?date=2026-13-40')).status).toBe(400);
  });

  it('SPK-SCHED-010: the window is a technical setting of the scheduling module, validated at boot (Proposed defaults, DEC-100)', async () => {
    expect(SchedulingSettings.schema.parse({})).toEqual({
      PUBLIC_SCHEDULE_DAYS_BACK: 1,
      PUBLIC_SCHEDULE_DAYS_AHEAD: 14,
    });
    expect(() =>
      loadConfig({ ...TEST_CONFIG_ENV, SCHEDULING_PUBLIC_SCHEDULE_DAYS_AHEAD: 'many' }),
    ).toThrow(/SCHEDULING_PUBLIC_SCHEDULE_DAYS_AHEAD/);
    expect(() =>
      loadConfig({ ...TEST_CONFIG_ENV, SCHEDULING_PUBLIC_SCHEDULE_DAYS_BACK: '-1' }),
    ).toThrow(/SCHEDULING_PUBLIC_SCHEDULE_DAYS_BACK/);
    const narrow = await createTestApp({
      imports: [SchedulingModule],
      clockStart: '2026-11-21T18:00:00Z',
      capabilities: ['public_schedule'],
      env: {
        SCHEDULING_PUBLIC_SCHEDULE_DAYS_BACK: '0',
        SCHEDULING_PUBLIC_SCHEDULE_DAYS_AHEAD: '2',
      },
    });
    try {
      await narrow.db
        .updateTable('organizations')
        .set({ slug: 'narrow-park' })
        .where('id', '=', narrow.organizationId)
        .execute();
      const enabled = await narrow.http
        .post(`/v1/facilities/${narrow.facilityId}/public-schedule-view/enable`)
        .set(await narrow.authHeader(staffPrincipal(narrow.organizationId, ['scheduler'])))
        .set('Idempotency-Key', `narrow-${narrow.facilityId}`)
        .send({});
      expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
      const path = `/v1/public/narrow-park/schedule/${enabled.body.publicCode as string}`;
      const today = await narrow.http.get(path);
      expect(today.body.window).toEqual({ from: '2026-11-21', to: '2026-11-23' });
      expect((await narrow.http.get(`${path}?date=2026-11-23`)).status).toBe(200);
      expect((await narrow.http.get(`${path}?date=2026-11-20`)).status).toBe(404);
      expect((await narrow.http.get(`${path}?date=2026-11-24`)).status).toBe(404);
    } finally {
      await narrow.close();
    }
  });

  it('SPK-SCHED-010: an unknown organization, an unknown code, a malformed code, a disabled view and the capability turned off all answer the same "not available"', async () => {
    const unknownOrganization = answerOf(await read('no-such-organization', code));
    expect(unknownOrganization).toEqual({
      status: 404,
      ...notAvailable,
      details: { code: 'PUBLIC_VIEW_NOT_AVAILABLE' },
      cache: 'no-store',
    });
    expect(answerOf(await read(slug, 'a'.repeat(24)))).toEqual(unknownOrganization);
    expect(answerOf(await read(slug, 'NOT-A-CODE'))).toEqual(unknownOrganization);
    // The facility's id is not an address.
    expect(answerOf(await read(slug, t.facilityId))).toEqual(unknownOrganization);

    await setCapability(t.db, t.organizationId, 'public_schedule', false);
    try {
      expect(answerOf(await read(slug, code))).toEqual(unknownOrganization);
    } finally {
      await setCapability(t.db, t.organizationId, 'public_schedule', true);
    }
    expect((await read(slug, code)).status).toBe(200);

    const header = await t.authHeader(scheduler);
    const disabled = await t.http
      .post(`/v1/facilities/${t.facilityId}/public-schedule-view/disable`)
      .set(header)
      .set('Idempotency-Key', `k-${newId()}`)
      .send({ expectedRevision: 1 });
    expect(disabled.body).toMatchObject({ enabled: false, publicCode: code, revision: 2 });
    expect(answerOf(await read(slug, code))).toEqual(unknownOrganization);
    // Enabling again keeps the code, so a link that was shared works again.
    const again = await t.http
      .post(`/v1/facilities/${t.facilityId}/public-schedule-view/enable`)
      .set(header)
      .set('Idempotency-Key', `k-${newId()}`)
      .send({ expectedRevision: 2 });
    expect(again.body).toMatchObject({ enabled: true, publicCode: code, revision: 3 });
    expect((await read(slug, code)).status).toBe(200);
    // A new code on request: the old link stops working.
    const rotated = await t.http
      .post(`/v1/facilities/${t.facilityId}/public-schedule-view/enable`)
      .set(header)
      .set('Idempotency-Key', `k-${newId()}`)
      .send({ expectedRevision: 3, newCode: true });
    expect(rotated.body.publicCode).not.toBe(code);
    expect(answerOf(await read(slug, code))).toEqual(unknownOrganization);
    code = rotated.body.publicCode as string;
    expect((await read(slug, code)).status).toBe(200);
  });

  it('SPK-SCHED-010: only permitted staff enable a public schedule, only while the capability is on; taking it down is never gated; the code is not written to the audit record', async () => {
    const frontDesk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    const view = `/v1/facilities/${t.facilityId}/public-schedule-view`;
    const refused = await t.http
      .post(`${view}/enable`)
      .set(frontDesk)
      .set('Idempotency-Key', `k-${newId()}`)
      .send({});
    expect(refused.status).toBe(403);
    // Staff who read the schedule read the switch and its link.
    const seen = await t.http.get(view).set(frontDesk);
    expect(seen.body).toMatchObject({ enabled: true, organizationSlug: slug, publicCode: code });
    // The staff route is not public.
    expect((await t.http.get(view)).status).toBe(401);

    const header = await t.authHeader(scheduler);
    await setCapability(t.db, t.organizationId, 'public_schedule', false);
    try {
      const off = await t.http
        .post(`${view}/enable`)
        .set(header)
        .set('Idempotency-Key', `k-${newId()}`)
        .send({ newCode: true });
      expect(off.status).toBe(403);
      expect(off.body).toMatchObject({
        code: 'ACCESS_DENIED',
        details: {
          code: 'CAPABILITY_DISABLED',
          capability: 'public_schedule',
          applicabilityReferences: ['DEC-016', 'DEC-100'],
        },
      });
      const down = await t.http
        .post(`${view}/disable`)
        .set(header)
        .set('Idempotency-Key', `k-${newId()}`)
        .send({ expectedRevision: seen.body.revision });
      expect(down.status, JSON.stringify(down.body)).toBe(200);
      expect(down.body.enabled).toBe(false);
    } finally {
      await setCapability(t.db, t.organizationId, 'public_schedule', true);
    }
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_type', '=', 'facility_public_view')
      .execute();
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(code);
    const up = await t.http
      .post(`${view}/enable`)
      .set(header)
      .set('Idempotency-Key', `k-${newId()}`)
      .send({});
    expect(up.body.enabled).toBe(true);
  });

  it("SPK-SCHED-010: the database keeps one view per facility, one view per code, a well-formed code, the disabled fact, and never a view of another organization's facility", async () => {
    const other = await t.db
      .selectFrom('facility_public_views')
      .selectAll()
      .where('facility_id', '=', t.facilityId)
      .executeTakeFirstOrThrow();
    const row = (overrides: Json = {}) => ({
      id: newId(),
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      public_code: 'b'.repeat(24),
      enabled_at: t.clock.now(),
      enabled_by: json({ kind: 'system' }),
      ...overrides,
    });
    // a second view of the same facility
    await expect(
      t.db.insertInto('facility_public_views').values(row()).execute(),
    ).rejects.toSatisfy(isUniqueViolation);
    // a view of a facility of another organization
    const foreign = newId();
    await t.db
      .insertInto('organizations')
      .values({ id: foreign, slug: `other-${foreign}`, name: 'Other' })
      .execute();
    const foreignFacility = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: foreignFacility,
        organization_id: foreign,
        slug: 'main',
        name: 'Other complex',
        timezone: 'America/Los_Angeles',
        address: null,
      })
      .execute();
    await expect(
      t.db
        .insertInto('facility_public_views')
        .values(row({ facility_id: foreignFacility }))
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // the same code for another view
    await expect(
      t.db
        .insertInto('facility_public_views')
        .values(
          row({
            organization_id: foreign,
            facility_id: foreignFacility,
            public_code: other.public_code,
          }),
        )
        .execute(),
    ).rejects.toSatisfy(isUniqueViolation);
    // a guessable code
    await expect(
      t.db
        .insertInto('facility_public_views')
        .values(
          row({ organization_id: foreign, facility_id: foreignFacility, public_code: 'main' }),
        )
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // disabled without the fact of it
    await expect(
      t.db
        .updateTable('facility_public_views')
        .set({ enabled: false })
        .where('id', '=', other.id)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('public views rate limit (SPK-SCHED-010, §4.14)', () => {
  it('SPK-SCHED-010: every public read counts against `public_views` per address, a wrong code included; past the limit the answer is 429 with Retry-After', async () => {
    const t = await createTestApp({
      imports: [SchedulingModule],
      clockStart: '2026-11-21T18:00:05Z',
      capabilities: ['public_schedule'],
      env: { RATE_LIMITS: 'public_views=3/60' },
    });
    try {
      const path = `/v1/public/no-such-organization/schedule/${'c'.repeat(24)}`;
      for (let i = 0; i < 3; i += 1) expect((await t.http.get(path)).status).toBe(404);
      const refused = await t.http.get(path);
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe('RATE_LIMITED');
      expect(refused.headers['retry-after']).toBe('55');
      t.clock.advance(60_000);
      expect((await t.http.get(path)).status).toBe(404);
    } finally {
      await t.close();
    }
  });
});
