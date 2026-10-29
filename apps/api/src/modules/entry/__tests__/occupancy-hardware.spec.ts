import { newId } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, DATABASE, Inbox, type AppConfig } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { AccessControlWebhooksController } from '../controllers/attendance.controller';
import {
  FAKE_ACCESS_CONTROL_PROVIDER,
  FAKE_ACCESS_CONTROL_SIGNATURE_HEADER,
  FakeAccessControlProvider,
} from '../providers/fake-access-control.provider';
import {
  adultCustomer,
  drainInbox,
  entryTestApp,
  exceptionsOf,
  family,
  post,
  staffMember,
  type Actor,
  type Family,
} from './support';

describe('occupancy (SPK-ENTRY-008)', () => {
  let t: TestApp;
  let desk: Actor;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  const occupancy = () => t.http.get(`/v1/facilities/${t.facilityId}/occupancy`).set(desk.header);

  it('SPK-ENTRY-008: arrivals and departures are separate and never presented as verified occupancy until a physical count reconciles them', async () => {
    const guardian = await createPersonFixture(t, { kind: 'adult' });
    const arrived = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [
        { personId: guardian, visitorCategory: 'guardian' },
        { visitorCategory: 'spectator', visitorDescription: 'Supporters', partySize: 3 },
      ],
    });
    expect(arrived.status).toBe(201);
    const first = await occupancy();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      arrivals: { people: 4, visits: 2 },
      departures: { people: 0, visits: 0 },
      recordedOnSite: 4,
      occupancy: { status: 'unverified', verifiedOccupancy: null, reconciledAt: null },
      lastSnapshot: null,
    });
    expect(first.body.occupancy.statement).toMatch(/not verified occupancy/);

    t.clock.advance(30 * 60_000);
    const left = await post(t, '/v1/departures', desk, {
      facilityId: t.facilityId,
      personId: guardian,
    });
    expect(left.status).toBe(201);
    const second = await occupancy();
    expect(second.body).toMatchObject({
      arrivals: { people: 4, visits: 2 },
      departures: { people: 1, visits: 1 },
      recordedOnSite: 3,
      occupancy: { status: 'unverified', verifiedOccupancy: null },
    });

    // A snapshot without a count records the figures but verifies nothing.
    t.clock.advance(60_000);
    const uncounted = await post(t, `/v1/facilities/${t.facilityId}/occupancy-snapshots`, desk, {});
    expect(uncounted.status, JSON.stringify(uncounted.body)).toBe(201);
    expect(uncounted.body).toMatchObject({
      reconciled: false,
      verifiedOccupancy: null,
      recordedOnSite: 3,
      discrepancy: null,
    });
    expect((await occupancy()).body.occupancy.status).toBe('unverified');

    // A physical count reconciles it; the discrepancy against the records is kept.
    t.clock.advance(60_000);
    const counted = await post(t, `/v1/facilities/${t.facilityId}/occupancy-snapshots`, desk, {
      countedOnSite: 2,
      note: 'Walked the stands',
    });
    expect(counted.body).toMatchObject({
      reconciled: true,
      countedOnSite: 2,
      verifiedOccupancy: 2,
      discrepancy: -1,
    });
    const verified = await occupancy();
    expect(verified.body.occupancy).toMatchObject({
      status: 'verified',
      verifiedOccupancy: 2,
      reconciledAt: t.clock.now().toISOString(),
    });
    expect(verified.body.recordedOnSite).toBe(3);

    // Any later arrival makes the verified figure stale again.
    t.clock.advance(60_000);
    await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ visitorCategory: 'spectator', visitorDescription: 'Late fan' }],
    });
    const after = await occupancy();
    expect(after.body.occupancy).toMatchObject({ status: 'unverified', verifiedOccupancy: null });
    expect(after.body.lastSnapshot).toMatchObject({ reconciled: true });
  });

  it('voided arrivals are not counted; occupancy reads and counts need the right role', async () => {
    const before = (await occupancy()).body.arrivals.people as number;
    const person = await createPersonFixture(t, { kind: 'adult' });
    const visit = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: person, visitorCategory: 'guardian' }],
    });
    await post(t, `/v1/visits/${visit.body.visits[0].id}/void`, desk, {
      reason: 'Recorded twice',
      expectedRevision: 1,
    });
    expect((await occupancy()).body.arrivals.people).toBe(before);
    const customer = await adultCustomer(t);
    const asCustomer = await t.http
      .get(`/v1/facilities/${t.facilityId}/occupancy`)
      .set(customer.header);
    expect(asCustomer.status).toBe(403);
    const coach = await staffMember(t, ['coach']);
    const coachCount = await post(t, `/v1/facilities/${t.facilityId}/occupancy-snapshots`, coach, {
      countedOnSite: 1,
    });
    expect(coachCount.status).toBe(403);
    const unknownFacility = await t.http
      .get(`/v1/facilities/${newId()}/occupancy`)
      .set(desk.header);
    expect(unknownFacility.status).toBe(404);
  });
});

describe('hardware access events (SPK-COND-004)', () => {
  let t: TestApp;
  let desk: Actor;
  let fam: Family;
  let device: FakeAccessControlProvider;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    fam = await family(t, desk);
    device = t.app.get(FakeAccessControlProvider);
  });
  afterAll(async () => {
    await t.close();
  });

  const deliver = (event: { body: unknown; signature: string }, signature = event.signature) =>
    t.http
      .post('/v1/webhooks/access-control/fake-access-control')
      .set(FAKE_ACCESS_CONTROL_SIGNATURE_HEADER, signature)
      .send(event.body as object);

  it('SPK-COND-004: a granted entry is a facility arrival only — never attendance, check-in or pickup authority', async () => {
    const payer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: payer.personId,
      subjectPersonId: fam.childA,
      kind: 'caregiver',
      permissions: ['view', 'pay'],
    });
    const pass = await post(t, '/v1/passes', desk, {
      holder: { kind: 'person', personId: payer.personId },
    });
    const event = device.granted({
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      occurredAt: t.clock.now().toISOString(),
      passReference: pass.body.reference,
      visitorCategory: 'guardian',
    });
    const first = await deliver(event);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body.duplicate).toBe(false);
    const duplicate = await deliver(event);
    expect(duplicate.body).toEqual({ inboxEventId: first.body.inboxEventId, duplicate: true });
    await drainInbox(t);
    const visits = await t.db
      .selectFrom('visits')
      .selectAll()
      .where('person_id', '=', payer.personId)
      .execute();
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({
      source: 'access_control',
      visitor_category: 'guardian',
      pass_id: pass.body.pass.id,
      device_id: 'turnstile-1',
    });
    for (const table of [
      'attendance_observations',
      'session_checkins',
      'release_records',
    ] as const) {
      const rows = await t.db.selectFrom(table).select('id').execute();
      expect(rows, table).toHaveLength(0);
    }
    // Being let in by the turnstile gives no pickup authority: the online check still decides.
    const release = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: payer.personId },
    });
    expect(release.body.release).toMatchObject({
      verificationOutcome: 'denied',
      outcome: 'not_released',
    });
    // A second entry while still on site adds no second arrival.
    await deliver(
      device.granted({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        occurredAt: t.clock.now().toISOString(),
        passReference: pass.body.reference,
      }),
    );
    await drainInbox(t);
    const still = await t.db
      .selectFrom('visits')
      .select('id')
      .where('person_id', '=', payer.personId)
      .execute();
    expect(still).toHaveLength(1);
  });

  it('denied entries record nothing; unknown outcomes raise a device exception; forged or foreign events are refused', async () => {
    const before = (await t.db.selectFrom('visits').select('id').execute()).length;
    await deliver(
      device.denied({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        occurredAt: t.clock.now().toISOString(),
        personId: fam.childB,
      }),
    );
    await deliver(
      device.unknown({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        deviceId: 'gate-2',
        occurredAt: t.clock.now().toISOString(),
        personId: fam.childB,
      }),
    );
    await drainInbox(t);
    expect((await t.db.selectFrom('visits').select('id').execute()).length).toBe(before);
    const raised = await exceptionsOf(t, 'entry.access_outcome_unknown');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ affected_id: 'gate-2', owner_queue: 'front_desk' });
    // An anonymous turnstile entry is unclassified and names nobody.
    await deliver(
      device.granted({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        occurredAt: t.clock.now().toISOString(),
        visitorCategory: 'participant',
      }),
    );
    await drainInbox(t);
    const anonymous = await t.db
      .selectFrom('visits')
      .selectAll()
      .where('source', '=', 'access_control')
      .where('person_id', 'is', null)
      .execute();
    expect(anonymous).toHaveLength(1);
    expect(anonymous[0]!.visitor_category).toBe('unclassified');

    const forged = device.granted({
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      occurredAt: t.clock.now().toISOString(),
      personId: fam.childB,
    });
    const badSignature = await deliver(forged, 'f'.repeat(64));
    expect(badSignature.status).toBe(401);
    const unknownProvider = await t.http
      .post('/v1/webhooks/access-control/some-vendor')
      .set(FAKE_ACCESS_CONTROL_SIGNATURE_HEADER, forged.signature)
      .send(forged.body);
    expect(unknownProvider.status).toBe(404);
    const foreign = device.granted({
      organizationId: newId(),
      facilityId: t.facilityId,
      occurredAt: t.clock.now().toISOString(),
    });
    expect((await deliver(foreign)).status).toBe(404);
  });

  it('§4.11 / §4.14 / §5.2: the fake provider’s events, signed with a published test secret, are refused in production and record nothing', async () => {
    const event = device.granted({
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      occurredAt: t.clock.now().toISOString(),
      personId: fam.childA,
    });
    const production = new AccessControlWebhooksController(
      t.app.get(Inbox),
      t.app.get<Db>(DATABASE),
      { ...t.app.get<AppConfig>(APP_CONFIG), NODE_ENV: 'production' },
    );
    await expect(
      production.receive(FAKE_ACCESS_CONTROL_PROVIDER, event.body, event.signature),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const recorded = await t.db
      .selectFrom('inbox_events')
      .select('id')
      .where('provider_event_id', '=', event.body.id)
      .execute();
    expect(recorded).toEqual([]);
    // Outside production the same signed event is accepted (the fake's purpose in tests).
    expect((await deliver(event)).status).toBe(202);
  });
});
