import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../../modules';
import {
  CLOCK_START,
  adultCustomer,
  drainInbox,
  enroll,
  family,
  post,
  program,
  sessionRef,
  staffMember,
  type Actor,
  type Program,
} from '../../modules/entry/__tests__/support';
import {
  FAKE_ACCESS_CONTROL_SIGNATURE_HEADER,
  FakeAccessControlProvider,
} from '../../modules/entry/providers/fake-access-control.provider';
import { createRelationshipFixture } from '../../modules/identity';
import { createTestApp, type TestApp } from '../../testing';

/**
 * SPK-AT-016 (spec §6.1): "Unauthorized adult attempts youth pickup — pickup denied or escalated
 * under approved procedure", over the assembled application. SPK-ENTRY-007 / §4.15: a child in
 * supervised care leaves only through a supervised release, whatever category the arrival was
 * recorded under (desk spectator or guardian, a turnstile's unclassified arrival) and whether the
 * departure is recorded online or synchronized from an offline device.
 */
describe('SPK-AT-016: unauthorized adult attempts youth pickup (assembled application)', () => {
  let t: TestApp;
  let desk: Actor;
  let p: Program;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: CLOCK_START,
    });
    desk = await staffMember(t, ['front_desk']);
    p = await program(t, await staffMember(t, ['program_manager']));
  });
  afterAll(async () => {
    await t?.close();
  });

  /** An enrolled child, its guardian, and an adult who may view and pay but not collect. */
  async function setup() {
    const fam = await family(t, desk);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    const payOnly = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: payOnly.personId,
      subjectPersonId: fam.childA,
      kind: 'caregiver',
      permissions: ['view', 'pay'],
    });
    return { fam, payOnly };
  }

  /** Admits the child to the supervised session, then the pay-only adult's pickup is refused. */
  async function admitAndDeny(childId: string, visitId: string, collectorId: string) {
    const checkin = await post(t, '/v1/session-checkins', desk, {
      personId: childId,
      activity: sessionRef(p),
      visitId,
    });
    expect(checkin.status, JSON.stringify(checkin.body)).toBe(201);
    expect(checkin.body.status).toBe('admitted');
    const denied = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: childId,
      collector: { personId: collectorId },
      activity: sessionRef(p),
    });
    expect(denied.status, JSON.stringify(denied.body)).toBe(201);
    expect(denied.body.release.outcome).toBe('not_released');
  }

  async function visitStatus(visitId: string) {
    return (
      await t.db
        .selectFrom('visits')
        .select('status')
        .where('id', '=', visitId)
        .executeTakeFirstOrThrow()
    ).status;
  }

  for (const category of ['spectator', 'guardian'] as const) {
    it(`SPK-AT-016 / SPK-ENTRY-007: a child admitted to a supervised session whose arrival was recorded as ${category} cannot leave by a plain departure after the pickup was denied`, async () => {
      const { fam, payOnly } = await setup();
      const arrived = await post(t, '/v1/visits', desk, {
        facilityId: t.facilityId,
        arrivals: [
          { personId: payOnly.personId, visitorCategory: 'guardian' },
          { personId: fam.childA, visitorCategory: category },
        ],
      });
      expect(arrived.status, JSON.stringify(arrived.body)).toBe(201);
      const visitId = (arrived.body.visits as Array<{ id: string; personId: string }>).find(
        (v) => v.personId === fam.childA,
      )?.id as string;
      await admitAndDeny(fam.childA, visitId, payOnly.personId);

      const departed = await post(t, '/v1/departures', desk, { visitId });
      expect(departed.status, JSON.stringify(departed.body)).toBe(409);
      expect(departed.body.details).toMatchObject({ code: 'release_required' });
      expect(await visitStatus(visitId)).toBe('on_site');

      // the guardian, who holds collect, takes the child through a supervised release
      const released = await post(t, '/v1/releases', desk, {
        facilityId: t.facilityId,
        childPersonId: fam.childA,
        collector: { personId: fam.guardian.personId },
        activity: sessionRef(p),
      });
      expect(released.status, JSON.stringify(released.body)).toBe(201);
      expect(released.body.release.outcome).toBe('released');
      expect(await visitStatus(visitId)).toBe('departed');
    });
  }

  it('SPK-AT-016 / SPK-ENTRY-007: a turnstile (unclassified) arrival admitted to the session cannot leave by a plain departure after the pickup was denied', async () => {
    const { fam, payOnly } = await setup();
    const device = t.app.get(FakeAccessControlProvider);
    const event = device.granted({
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      occurredAt: t.clock.now().toISOString(),
      personId: fam.childA,
    });
    const delivered = await t.http
      .post('/v1/webhooks/access-control/fake-access-control')
      .set(FAKE_ACCESS_CONTROL_SIGNATURE_HEADER, event.signature)
      .send(event.body as object);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(202);
    await drainInbox(t);
    const visit = await t.db
      .selectFrom('visits')
      .selectAll()
      .where('person_id', '=', fam.childA)
      .where('status', '=', 'on_site')
      .executeTakeFirstOrThrow();
    expect(visit.visitor_category).toBe('unclassified');
    await admitAndDeny(fam.childA, visit.id, payOnly.personId);

    const departed = await post(t, '/v1/departures', desk, {
      facilityId: t.facilityId,
      personId: fam.childA,
    });
    expect(departed.status, JSON.stringify(departed.body)).toBe(409);
    expect(departed.body.details).toMatchObject({ code: 'release_required' });
    expect(await visitStatus(visit.id)).toBe('on_site');
  });

  it('SPK-AT-016 / §4.15: an offline departure of an admitted child recorded as spectator is rejected release_required and escalated, never accepted', async () => {
    const { fam, payOnly } = await setup();
    const arrived = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: fam.childA, visitorCategory: 'spectator' }],
    });
    const visitId = arrived.body.visits[0].id as string;
    await admitAndDeny(fam.childA, visitId, payOnly.personId);
    const now = t.clock.now().toISOString();
    const sync = await post(t, '/v1/offline-sync', desk, {
      deviceId: 'tablet-at016',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: { reference: 'roster-at016', takenAt: now },
      items: [
        {
          kind: 'departure',
          clientObservationId: newId(),
          observedAt: now,
          personId: fam.childA,
        },
      ],
    });
    expect(sync.status, JSON.stringify(sync.body)).toBe(201);
    expect(sync.body.items).toEqual([
      expect.objectContaining({ outcome: 'rejected', reason: 'release_required' }),
    ]);
    expect(await visitStatus(visitId)).toBe('on_site');
    const escalated = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'severity'])
      .where('organization_id', '=', t.organizationId)
      .where('category', '=', 'entry.offline_release_unrecorded')
      .execute();
    expect(escalated.length).toBeGreaterThan(0);
  });

  it('SPK-AT-016 control: a sibling spectator who was never in supervised care departs plainly', async () => {
    const { fam } = await setup();
    const arrived = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: fam.childB, visitorCategory: 'spectator' }],
    });
    const departed = await post(t, '/v1/departures', desk, {
      visitId: arrived.body.visits[0].id,
    });
    expect(departed.status, JSON.stringify(departed.body)).toBe(201);
  });
});
