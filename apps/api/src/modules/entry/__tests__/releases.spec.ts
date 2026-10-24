import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { createAssignmentFixture } from '../../workforce';
import {
  FAKE_ACCESS_CONTROL_SIGNATURE_HEADER,
  FakeAccessControlProvider,
} from '../providers/fake-access-control.provider';
import {
  adultCustomer,
  drainInbox,
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
    // §4.14: the guardian's read is the customer projection (no staff identifiers).
    expect(asGuardian.body.staffActor).toMatchObject({ accountId: null, personId: null });
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

  /** A turnstile entry (SPK-COND-004): the device sends a person and no visitor category. */
  const turnstile = async (personId: string) => {
    const event = t.app.get(FakeAccessControlProvider).granted({
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      occurredAt: t.clock.now().toISOString(),
      personId,
    });
    const delivered = await t.http
      .post('/v1/webhooks/access-control/fake-access-control')
      .set(FAKE_ACCESS_CONTROL_SIGNATURE_HEADER, event.signature)
      .send(event.body as object);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(202);
    await drainInbox(t);
    const visit = await t.db
      .selectFrom('visits')
      .select(['id', 'visitor_category'])
      .where('person_id', '=', personId)
      .where('status', '=', 'on_site')
      .executeTakeFirstOrThrow();
    expect(visit.visitor_category).toBe('unclassified');
    return visit.id;
  };
  const checkIn = async (personId: string) => {
    const res = await post(t, '/v1/session-checkins', desk, { personId, activity: sessionRef(p) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('admitted');
  };
  const visitStatus = async (visitId: string) =>
    (
      await t.db
        .selectFrom('visits')
        .select('status')
        .where('id', '=', visitId)
        .executeTakeFirstOrThrow()
    ).status;

  it('SPK-ENTRY-007 / SPK-COND-004: a child with a live session check-in leaves only through a release, whatever the visit category (turnstile, spectator)', async () => {
    // A turnstile arrival is `unclassified`; the child is then admitted to the supervised session.
    const viaTurnstile = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: fam.guardian.personId,
      subjectPersonId: viaTurnstile,
    });
    await enroll(t, p, viaTurnstile, fam.guardian.personId);
    const turnstileVisit = await turnstile(viaTurnstile);
    await checkIn(viaTurnstile);
    const plain = await post(t, '/v1/departures', desk, { visitId: turnstileVisit });
    expect(plain.status, JSON.stringify(plain.body)).toBe(409);
    expect(plain.body.details).toMatchObject({ code: 'release_required' });
    expect(await visitStatus(turnstileVisit)).toBe('on_site');
    const released = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: viaTurnstile,
      collector: { personId: fam.guardian.personId },
      activity: sessionRef(p),
    });
    expect(released.status, JSON.stringify(released.body)).toBe(201);
    expect(released.body.departure).toMatchObject({
      visitId: turnstileVisit,
      source: 'release',
      releaseRecordId: released.body.release.id,
    });

    // A desk arrival recorded as a spectator does not remove the pickup check either.
    const asSpectator = await createPersonFixture(t, { kind: 'child' });
    await enroll(t, p, asSpectator, fam.guardian.personId);
    const spectatorVisit = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: asSpectator, visitorCategory: 'spectator' }],
    });
    await checkIn(asSpectator);
    const spectatorDeparture = await post(t, '/v1/departures', desk, {
      visitId: spectatorVisit.body.visits[0].id,
    });
    expect(spectatorDeparture.status).toBe(409);
    expect(spectatorDeparture.body.details).toMatchObject({ code: 'release_required' });

    // A child spectator with no live check-in (a sibling watching) leaves by a plain departure.
    const sibling = await createPersonFixture(t, { kind: 'child' });
    const siblingVisit = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: sibling, visitorCategory: 'spectator' }],
    });
    const siblingLeft = await post(t, '/v1/departures', desk, {
      visitId: siblingVisit.body.visits[0].id,
    });
    expect(siblingLeft.status, JSON.stringify(siblingLeft.body)).toBe(201);
  });

  it('SPK-AT-016 / SPK-COND-004: after a pay-only pickup denial, a turnstile child cannot be walked out by a plain departure', async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    await enroll(t, p, child, fam.guardian.personId);
    const payer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: payer.personId,
      subjectPersonId: child,
      kind: 'caregiver',
      permissions: ['view', 'pay'],
    });
    const visitId = await turnstile(child);
    await checkIn(child);
    const denied = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: child,
      collector: { personId: payer.personId },
      activity: sessionRef(p),
    });
    expect(denied.body.release).toMatchObject({
      verificationOutcome: 'denied',
      outcome: 'not_released',
    });
    const plain = await post(t, '/v1/departures', desk, { visitId });
    expect(plain.status).toBe(409);
    expect(await visitStatus(visitId)).toBe('on_site');
  });

  it('SPK-ENTRY-007 / §4.14: an assigned coach releases only a child taking part in their activity, and learns only whether collect is held', async () => {
    // The coach's own session (one accepted coach per session slot).
    const mine = await program(t, manager, { from: '10:00', to: '11:15' });
    await enroll(t, mine, fam.childA, fam.guardian.personId);
    await enroll(t, mine, fam.childB, fam.guardian.personId);
    const coach = await staffMember(t, ['coach']);
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: mine.sessionId,
      offeringId: mine.offering.offeringId,
      personId: coach.personId,
      kind: 'coach',
      status: 'accepted',
      scheduledStart: mine.start,
      scheduledEnd: mine.end,
    });
    const coachRelease = (childPersonId: string, collectorPersonId: string) =>
      post(t, '/v1/releases', coach, {
        facilityId: t.facilityId,
        childPersonId,
        collector: { personId: collectorPersonId },
        activity: sessionRef(mine),
        recordDeparture: false,
      });
    // A child enrolled in the coach's session: released; the response names collect only.
    const own = await coachRelease(fam.childA, fam.guardian.personId);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.release.verificationOutcome).toBe('verified');
    expect(own.body.release.collectorPermissions).toEqual(['collect']);

    // A child of another program (admitted there, on site): not found, nothing recorded.
    const q = await program(t, manager, { from: '10:00', to: '11:30' });
    const other = await createPersonFixture(t, { kind: 'child' });
    const otherGuardian = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: otherGuardian.personId,
      subjectPersonId: other,
    });
    await enroll(t, q, other, otherGuardian.personId);
    await arrive(other);
    const admitted = await post(t, '/v1/session-checkins', desk, {
      personId: other,
      activity: sessionRef(q),
    });
    expect(admitted.body.status).toBe('admitted');
    const outside = await coachRelease(other, otherGuardian.personId);
    expect(outside.status, JSON.stringify(outside.body)).toBe(404);
    // An arbitrary child and adult: not found, and no permission evidence is returned.
    const stranger = await createPersonFixture(t, { kind: 'child' });
    const probe = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: probe.personId,
      subjectPersonId: stranger,
      kind: 'caregiver',
      permissions: ['view', 'pay', 'receive_messages'],
    });
    const probed = await coachRelease(stranger, probe.personId);
    expect(probed.status).toBe(404);
    expect(JSON.stringify(probed.body)).not.toMatch(/receive_messages|pay/);
    // An adult is not reported as "not a child" either.
    expect((await coachRelease(probe.personId, fam.guardian.personId)).status).toBe(404);
    const recorded = await t.db
      .selectFrom('release_records')
      .select('id')
      .where('child_person_id', 'in', [other, stranger])
      .execute();
    expect(recorded).toHaveLength(0);

    // A denial in the coach's own session: no other permission is named to the coach.
    const payer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: payer.personId,
      subjectPersonId: fam.childB,
      kind: 'caregiver',
      permissions: ['view', 'pay'],
    });
    const denied = await coachRelease(fam.childB, payer.personId);
    expect(denied.status).toBe(201);
    expect(denied.body.release).toMatchObject({
      verificationOutcome: 'denied',
      collectorPermissions: [],
    });
    expect(denied.body.release.denialReason).not.toMatch(/view|pay/);
    // Pickup staff read the full evidence.
    const full = await t.http.get(`/v1/releases/${denied.body.release.id}`).set(desk.header);
    expect([...full.body.collectorPermissions].sort()).toEqual(['pay', 'view']);

    // The desk still releases the other program's child.
    const byDesk = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: other,
      collector: { personId: otherGuardian.personId },
      activity: sessionRef(q),
    });
    expect(byDesk.status).toBe(201);
    expect(byDesk.body.release.outcome).toBe('released');
  });

  it('§4.14 field-level / SPK-IAM-005: a holder of view over the child reads the customer projection of a release; pickup staff read the full record', async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    const custodial = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: custodial.personId,
      subjectPersonId: child,
    });
    const viewer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: viewer.personId,
      subjectPersonId: child,
      kind: 'caregiver',
      permissions: ['view'],
    });
    // The other parent: view and collect, then collect restricted by a disputed-access review.
    const otherParent = await adultCustomer(t);
    const { grantIds } = await createRelationshipFixture(t, {
      actorPersonId: otherParent.personId,
      subjectPersonId: child,
      permissions: ['view', 'collect'],
    });
    const support = await staffMember(t, ['support_operator']);
    const review = await post(t, '/v1/access-reviews', support, {
      subjectPersonId: child,
      reason: 'interim custody order',
    });
    expect(review.status, JSON.stringify(review.body)).toBe(201);
    const restricted = await post(t, `/v1/access-reviews/${review.body.id}/decisions`, support, {
      kind: 'restrict',
      grantIds: [grantIds.collect],
    });
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(201);
    const escalated = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: child,
      collector: { personId: otherParent.personId },
      escalate: true,
      restrictionNotes: 'Interim order case-2026-118: supervised handover only',
      escalationNotes: 'Custodial parent says the other parent threatened to take the child',
    });
    expect(escalated.status, JSON.stringify(escalated.body)).toBe(201);
    const id = escalated.body.release.id as string;
    expect(escalated.body.release.restrictionNotes).toMatch(/Interim order/);

    for (const reader of [viewer, otherParent, custodial]) {
      const read = await t.http.get(`/v1/releases/${id}`).set(reader.header);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body).toMatchObject({
        id,
        childPersonId: child,
        collectorPersonId: otherParent.personId,
        verificationOutcome: 'escalated',
        outcome: 'not_released',
        restrictionNotes: null,
        escalationNotes: null,
        denialReason: null,
        collectorPermissions: [],
        escalationExceptionId: null,
        staffActor: { accountId: null, personId: null, sessionId: null, staffRoles: [] },
      });
      expect(JSON.stringify(read.body)).not.toMatch(/Interim order|threatened/);
    }
    for (const staff of [desk, support]) {
      const read = await t.http.get(`/v1/releases/${id}`).set(staff.header);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        restrictionNotes: 'Interim order case-2026-118: supervised handover only',
        escalationNotes: 'Custodial parent says the other parent threatened to take the child',
        collectorPermissions: ['view'],
        staffActor: { personId: desk.personId },
      });
      expect(read.body.escalationExceptionId).not.toBeNull();
    }
  });
});
