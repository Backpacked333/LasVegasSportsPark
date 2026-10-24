import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { createAssignmentFixture } from '../../workforce';
import {
  adultCustomer,
  enroll,
  entryTestApp,
  exceptionsOf,
  family,
  key,
  post,
  program,
  sessionRef,
  staffMember,
  type Actor,
  type Family,
  type Program,
} from './support';

describe('supervised release (§4.8 POST /v1/releases, SPK-ENTRY-007, SPK-AT-016)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let fam: Family;
  let p: Program;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    // The guardian holds every permission, including collect.
    fam = await family(t, desk);
    p = await program(t, manager);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    await enroll(t, p, fam.childB, fam.guardian.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const arrive = async (personId: string) => {
    const res = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId, visitorCategory: 'participant' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.visits[0].id as string;
  };

  it('SPK-AT-016: an adult who may pay (and view) but may not collect is denied, the child stays, and follow-up is raised', async () => {
    const payer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: payer.personId,
      subjectPersonId: fam.childA,
      kind: 'caregiver',
      permissions: ['view', 'pay'],
    });
    const visitId = await arrive(fam.childA);
    const res = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: payer.personId },
      activity: sessionRef(p),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.departure).toBeNull();
    const release = res.body.release;
    expect(release).toMatchObject({
      childPersonId: fam.childA,
      collectorPersonId: payer.personId,
      verificationMethod: 'online_relationship_check',
      verificationOutcome: 'denied',
      authorityBasis: null,
      outcome: 'not_released',
      releasedAt: null,
      visitId,
      staffActor: { personId: desk.personId },
      source: 'online',
    });
    expect([...release.collectorPermissions].sort()).toEqual(['pay', 'view']);
    expect(release.denialReason).toMatch(
      /schedule visibility and payment permission do not establish/,
    );
    expect(release.authorityCheckedAt).toBe(t.clock.now().toISOString());
    const raised = await exceptionsOf(t, 'entry.pickup_denied');
    expect(raised.find((e) => e.id === release.escalationExceptionId)).toMatchObject({
      affected_id: release.id,
      owner_queue: 'general_manager',
    });
    const visit = await t.db
      .selectFrom('visits')
      .select('status')
      .where('id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(visit.status).toBe('on_site');

    // Escalated under the procedure when staff ask for it (DEC-005).
    const escalated = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: payer.personId },
      escalate: true,
      escalationNotes: 'Called the guardian; awaiting call back',
    });
    expect(escalated.body.release).toMatchObject({
      verificationOutcome: 'escalated',
      outcome: 'not_released',
      escalationNotes: 'Called the guardian; awaiting call back',
    });
    const high = await exceptionsOf(t, 'entry.pickup_escalated');
    expect(high.find((e) => e.id === escalated.body.release.escalationExceptionId)).toMatchObject({
      severity: 'high',
    });
  });

  it('SPK-ENTRY-007: a guardian with current collect permission is verified and released, recording every field and the departure', async () => {
    const visitId = await arrive(fam.childB);
    t.clock.advance(60 * 60_000);
    const idem = key();
    const body = {
      facilityId: t.facilityId,
      childPersonId: fam.childB,
      collector: { personId: fam.guardian.personId },
      activity: sessionRef(p),
    };
    const res = await post(t, '/v1/releases', desk, body, idem);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.release).toMatchObject({
      childPersonId: fam.childB,
      collectorPersonId: fam.guardian.personId,
      verificationOutcome: 'verified',
      authorityBasis: 'relationship_permission:collect',
      outcome: 'released',
      decidedAt: t.clock.now().toISOString(),
      releasedAt: t.clock.now().toISOString(),
      staffActor: { personId: desk.personId, kind: 'staff' },
      activity: { type: 'session', id: p.sessionId },
      denialReason: null,
    });
    expect(res.body.release.collectorPermissions).toContain('collect');
    expect(res.body.departure).toMatchObject({
      visitId,
      personId: fam.childB,
      source: 'release',
      releaseRecordId: res.body.release.id,
    });
    const visit = await t.db
      .selectFrom('visits')
      .select(['status', 'departed_at'])
      .where('id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(visit.status).toBe('departed');
    // Replaying the same key returns the same release; nothing is recorded twice.
    const replay = await post(t, '/v1/releases', desk, body, idem);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.release.id).toBe(res.body.release.id);
    const rows = await t.db
      .selectFrom('release_records')
      .select('id')
      .where('child_person_id', '=', fam.childB)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('SPK-ENTRY-007: authority is checked at the moment of release — a grant revoked minutes earlier no longer counts', async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    const delegate = await adultCustomer(t);
    const { grantIds } = await createRelationshipFixture(t, {
      actorPersonId: delegate.personId,
      subjectPersonId: child,
      kind: 'delegate',
      permissions: ['collect'],
    });
    const before = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: child,
      collector: { personId: delegate.personId },
      recordDeparture: false,
    });
    expect(before.body.release.verificationOutcome).toBe('verified');
    const revoked = await post(t, `/v1/access-grants/${grantIds.collect}/revoke`, manager, {
      reason: 'Guardian withdrew pickup permission',
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    t.clock.advance(5 * 60_000);
    const after = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: child,
      collector: { personId: delegate.personId },
    });
    expect(after.body.release).toMatchObject({
      verificationOutcome: 'denied',
      outcome: 'not_released',
      collectorPermissions: [],
    });
  });

  it('an unregistered collector cannot be verified online; staff may withhold even a verified release with a restriction', async () => {
    const unknown = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { description: 'Neighbour, says the parent sent them' },
    });
    expect(unknown.body.release).toMatchObject({
      collectorPersonId: null,
      collectorDescription: 'Neighbour, says the parent sent them',
      verificationOutcome: 'denied',
      outcome: 'not_released',
    });
    expect(unknown.body.release.denialReason).toMatch(/no verified record/);
    const noNotes = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: fam.guardian.personId },
      decision: 'withhold',
    });
    expect(noNotes.status).toBe(400);
    const withheld = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: fam.guardian.personId },
      decision: 'withhold',
      restrictionNotes: 'Court order on file: supervised handover only',
    });
    expect(withheld.body.release).toMatchObject({
      verificationOutcome: 'verified',
      outcome: 'not_released',
      restrictionNotes: 'Court order on file: supervised handover only',
    });
    expect(withheld.body.release.escalationExceptionId).not.toBeNull();
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const notChild = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: adult,
      collector: { personId: fam.guardian.personId },
    });
    expect(notChild.status).toBe(400);
  });

  it('a child participant leaves only through a release; a plain departure is refused', async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    const visitId = await arrive(child);
    const departure = await post(t, '/v1/departures', desk, { visitId });
    expect(departure.status).toBe(409);
    expect(departure.body.details).toMatchObject({ code: 'release_required' });
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const adultVisit = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: adult, visitorCategory: 'guardian' }],
    });
    const left = await post(t, '/v1/departures', desk, {
      facilityId: t.facilityId,
      personId: adult,
    });
    expect(left.status, JSON.stringify(left.body)).toBe(201);
    expect(left.body).toMatchObject({ visitId: adultVisit.body.visits[0].id, source: 'desk' });
    const twice = await post(t, '/v1/departures', desk, { visitId: adultVisit.body.visits[0].id });
    expect(twice.status).toBe(409);
  });

  it('authorization: customers cannot record releases; release records are protected reads; coaches need the assignment', async () => {
    const asCustomer = await post(t, '/v1/releases', fam.guardian, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: fam.guardian.personId },
    });
    expect(asCustomer.status).toBe(403);
    const record = await t.db
      .selectFrom('release_records')
      .select('id')
      .where('child_person_id', '=', fam.childB)
      .executeTakeFirstOrThrow();
    const asGuardian = await t.http.get(`/v1/releases/${record.id}`).set(fam.guardian.header);
    expect(asGuardian.status).toBe(200);
    expect(asGuardian.body.outcome).toBe('released');
    const stranger = await adultCustomer(t);
    const asStranger = await t.http.get(`/v1/releases/${record.id}`).set(stranger.header);
    expect(asStranger.status).toBe(404);
    const coach = await staffMember(t, ['coach']);
    const body = {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: fam.guardian.personId },
      activity: sessionRef(p),
      recordDeparture: false,
    };
    const unassigned = await post(t, '/v1/releases', coach, body);
    expect(unassigned.status).toBe(403);
    const noActivity = await post(t, '/v1/releases', coach, { ...body, activity: undefined });
    expect(noActivity.status).toBe(403);
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: p.sessionId,
      offeringId: p.offering.offeringId,
      personId: coach.personId,
      kind: 'coach',
      status: 'accepted',
      scheduledStart: p.start,
      scheduledEnd: p.end,
    });
    const assigned = await post(t, '/v1/releases', coach, body);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    expect(assigned.body.release.verificationOutcome).toBe('verified');
  });
});
