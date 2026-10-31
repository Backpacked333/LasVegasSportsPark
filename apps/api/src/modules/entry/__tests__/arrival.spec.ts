import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createAcknowledgmentFixture } from '../../catalog';
import { createSessionBookingFixture } from '../../enrollment';
import { createPersonFixture } from '../../identity';
import { createAssignmentFixture } from '../../workforce';
import { hashPassReference, PASS_REFERENCE_PREFIX } from '../entry.shared';
import {
  adultCustomer,
  enroll,
  entryTestApp,
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

describe('arrival: passes, visits and session check-ins (SPK-ENTRY-001..004, 006)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let fam: Family;
  let p: Program;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
    p = await program(t, manager);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    await enroll(t, p, fam.childB, fam.guardian.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-ENTRY-002: a pass is an opaque random reference that reveals no child or household detail', async () => {
    const issued = await post(t, '/v1/passes', desk, {
      holder: { kind: 'household', householdId: fam.householdId },
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const reference = issued.body.reference as string;
    expect(reference.startsWith(PASS_REFERENCE_PREFIX)).toBe(true);
    expect(reference.length).toBeGreaterThanOrEqual(40);
    for (const secret of [
      fam.householdId,
      fam.childA,
      fam.childB,
      fam.guardian.personId,
      t.organizationId,
      'Ava',
      'Ben',
    ]) {
      expect(reference).not.toContain(secret);
      expect(reference.toLowerCase()).not.toContain(secret.toLowerCase().replaceAll('-', ''));
    }
    // Only the hash is stored; the reference itself appears in no column.
    const row = await t.db
      .selectFrom('passes')
      .selectAll()
      .where('id', '=', issued.body.pass.id)
      .executeTakeFirstOrThrow();
    expect(row.reference_hash).toBe(hashPassReference(reference));
    expect(JSON.stringify(row)).not.toContain(reference);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', issued.body.pass.id)
      .execute();
    expect(JSON.stringify(audit)).not.toContain(reference);
    // Two passes for the same holder are unrelated references.
    const second = await post(t, '/v1/passes', desk, {
      holder: { kind: 'household', householdId: fam.householdId },
    });
    expect(second.body.reference).not.toBe(reference);
  });

  it('SPK-ENTRY-002: customers issue only their own person pass; a household pass or another person is not found', async () => {
    const own = await post(t, '/v1/passes', fam.guardian, {
      holder: { kind: 'person', personId: fam.guardian.personId },
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const household = await post(t, '/v1/passes', fam.guardian, {
      holder: { kind: 'household', householdId: fam.householdId },
    });
    expect(household.status).toBe(404);
    const stranger = await adultCustomer(t);
    const other = await post(t, '/v1/passes', stranger, {
      holder: { kind: 'person', personId: fam.guardian.personId },
    });
    expect(other.status).toBe(404);
  });

  it("SPK-AT-015 / SPK-ENTRY-003: a household scan resolves both children and today's session but marks nobody present; only the child who came is recorded", async () => {
    const issued = await post(t, '/v1/passes', desk, {
      holder: { kind: 'household', householdId: fam.householdId },
    });
    const scan = await t.http
      .post('/v1/passes/scan')
      .set(desk.header)
      .send({ reference: issued.body.reference, facilityId: t.facilityId });
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.recorded).toBe('nothing');
    const people = scan.body.people as Array<{
      personId: string;
      relation: string;
      onSite: boolean;
      activities: Array<{ activity: { id: string }; basis: { kind: string }; checkin: unknown }>;
    }>;
    expect(people.map((x) => x.personId).sort()).toEqual(
      [fam.guardian.personId, fam.childA, fam.childB].sort(),
    );
    for (const child of [fam.childA, fam.childB]) {
      const entry = people.find((x) => x.personId === child)!;
      expect(entry.relation).toBe('household_member');
      expect(entry.onSite).toBe(false);
      expect(entry.activities).toEqual([
        expect.objectContaining({
          activity: expect.objectContaining({ id: p.sessionId, type: 'session' }),
          basis: expect.objectContaining({ kind: 'enrollment', status: 'confirmed' }),
          checkin: null,
        }),
      ]);
    }
    const counts = async () => ({
      visits: (await t.db.selectFrom('visits').select('id').execute()).length,
      checkins: (await t.db.selectFrom('session_checkins').select('id').execute()).length,
      observations: (await t.db.selectFrom('attendance_observations').select('id').execute())
        .length,
    });
    expect(await counts()).toEqual({ visits: 0, checkins: 0, observations: 0 });

    // Staff select the parent and the one child who actually arrived, and that child's session.
    const arrived = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      passId: issued.body.pass.id,
      arrivals: [
        { personId: fam.guardian.personId, visitorCategory: 'guardian' },
        { personId: fam.childA, visitorCategory: 'participant' },
      ],
    });
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(201);
    const checkin = await post(t, '/v1/session-checkins', desk, {
      personId: fam.childA,
      activity: sessionRef(p),
    });
    expect(checkin.status, JSON.stringify(checkin.body)).toBe(201);
    expect(checkin.body).toMatchObject({
      personId: fam.childA,
      status: 'admitted',
      basis: { kind: 'enrollment' },
      activity: { type: 'session', id: p.sessionId },
    });
    expect(checkin.body.visitId).toBe(
      arrived.body.visits.find((v: { personId: string }) => v.personId === fam.childA).id,
    );
    expect(await counts()).toEqual({ visits: 2, checkins: 1, observations: 0 });
    const childBRecords = await t.db
      .selectFrom('visits')
      .select('id')
      .where('person_id', '=', fam.childB)
      .execute();
    expect(childBRecords).toHaveLength(0);
    const childBCheckins = await t.db
      .selectFrom('session_checkins')
      .select('id')
      .where('person_id', '=', fam.childB)
      .execute();
    expect(childBCheckins).toHaveLength(0);

    // A second scan reflects what was recorded and still writes nothing.
    const again = await t.http
      .post('/v1/passes/scan')
      .set(desk.header)
      .send({ reference: issued.body.reference, facilityId: t.facilityId });
    const a = (again.body.people as typeof people).find((x) => x.personId === fam.childA)!;
    const b = (again.body.people as typeof people).find((x) => x.personId === fam.childB)!;
    expect(a.onSite).toBe(true);
    expect(a.activities[0]!.checkin).toMatchObject({ status: 'admitted' });
    expect(b.onSite).toBe(false);
    expect(b.activities[0]!.checkin).toBeNull();
    expect(await counts()).toEqual({ visits: 2, checkins: 1, observations: 0 });
  });

  it('SPK-ENTRY-002: scanning requires the desk role; unknown and revoked references are refused', async () => {
    const issued = await post(t, '/v1/passes', desk, {
      holder: { kind: 'person', personId: fam.guardian.personId },
    });
    const asCustomer = await t.http
      .post('/v1/passes/scan')
      .set(fam.guardian.header)
      .send({ reference: issued.body.reference, facilityId: t.facilityId });
    expect(asCustomer.status).toBe(403);
    const unknown = await t.http
      .post('/v1/passes/scan')
      .set(desk.header)
      .send({ reference: `${PASS_REFERENCE_PREFIX}${'x'.repeat(43)}`, facilityId: t.facilityId });
    expect(unknown.status).toBe(404);
    // A person pass opens the holder and the children they may view (authority, not household).
    const scan = await t.http
      .post('/v1/passes/scan')
      .set(desk.header)
      .send({ reference: issued.body.reference, facilityId: t.facilityId });
    expect(scan.status).toBe(200);
    const dependents = (
      scan.body.people as Array<{ relation: string; holderMayCollect: boolean }>
    ).filter((x) => x.relation === 'dependent');
    expect(dependents).toHaveLength(2);
    expect(dependents.every((d) => d.holderMayCollect === true)).toBe(true);

    const stale = await post(t, `/v1/passes/${issued.body.pass.id}/revoke`, desk, {
      reason: 'Lost card',
      expectedRevision: 7,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const revoked = await post(t, `/v1/passes/${issued.body.pass.id}/revoke`, desk, {
      reason: 'Lost card',
      expectedRevision: 1,
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body).toMatchObject({
      status: 'revoked',
      revokedReason: 'Lost card',
      revision: 2,
    });
    const twice = await post(t, `/v1/passes/${issued.body.pass.id}/revoke`, desk, {
      reason: 'Again',
      expectedRevision: 2,
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_TRANSITION');
    const scanRevoked = await t.http
      .post('/v1/passes/scan')
      .set(desk.header)
      .send({ reference: issued.body.reference, facilityId: t.facilityId });
    expect(scanRevoked.status).toBe(409);
    expect(scanRevoked.body.details).toMatchObject({ code: 'pass_revoked' });
  });

  it('SPK-ENTRY-006: guardians and spectators arrive without fabricated participants or enrollments', async () => {
    const enrollmentsBefore = await t.db.selectFrom('enrollments').select('id').execute();
    const spectatorPerson = await createPersonFixture(t, { kind: 'adult' });
    const arrived = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [
        { personId: spectatorPerson, visitorCategory: 'spectator' },
        { visitorCategory: 'spectator', visitorDescription: 'Grandparents', partySize: 2 },
        { visitorCategory: 'contractor', visitorDescription: 'Turf repair crew', partySize: 3 },
      ],
    });
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(201);
    expect(arrived.body.visits.map((v: { visitorCategory: string }) => v.visitorCategory)).toEqual([
      'spectator',
      'spectator',
      'contractor',
    ]);
    expect(arrived.body.visits[1]).toMatchObject({ personId: null, partySize: 2 });
    const enrollmentsAfter = await t.db.selectFrom('enrollments').select('id').execute();
    expect(enrollmentsAfter).toHaveLength(enrollmentsBefore.length);
    // An anonymous "participant" is refused: a participant is always a real person.
    const fabricated = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ visitorCategory: 'participant', visitorDescription: 'Some kid' }],
    });
    expect(fabricated.status).toBe(400);
    // A spectator checked into the session is held: no participation basis exists.
    const checkin = await post(t, '/v1/session-checkins', desk, {
      personId: spectatorPerson,
      activity: sessionRef(p),
    });
    expect(checkin.status).toBe(201);
    expect(checkin.body).toMatchObject({ status: 'held', basis: null });
    expect(checkin.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'no_participation',
          severity: 'blocking',
          nextAction: 'register_or_book',
        }),
      ]),
    );
  });

  it('records each arrival once: a person already on site is a conflict, and a replayed request is not a second arrival', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const idem = key();
    const body = {
      facilityId: t.facilityId,
      arrivals: [{ personId: person, visitorCategory: 'guardian' }],
    };
    const first = await post(t, '/v1/visits', desk, body, idem);
    expect(first.status).toBe(201);
    const replay = await post(t, '/v1/visits', desk, body, idem);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const conflictingKey = await post(t, '/v1/visits', desk, { ...body, passId: newId() }, idem);
    expect(conflictingKey.status).toBe(409);
    expect(conflictingKey.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const again = await post(t, '/v1/visits', desk, body);
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({ code: 'already_on_site' });
    const rows = await t.db
      .selectFrom('visits')
      .select('id')
      .where('person_id', '=', person)
      .execute();
    expect(rows).toHaveLength(1);

    // Voiding a mistaken arrival keeps the record and needs the current revision.
    const visitId = first.body.visits[0].id as string;
    const stale = await post(t, `/v1/visits/${visitId}/void`, desk, {
      reason: 'Wrong person',
      expectedRevision: 3,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const voided = await post(t, `/v1/visits/${visitId}/void`, desk, {
      reason: 'Wrong person',
      expectedRevision: 1,
    });
    expect(voided.status).toBe(200);
    expect(voided.body).toMatchObject({ status: 'voided', voidReason: 'Wrong person' });
    const departAfterVoid = await post(t, '/v1/departures', desk, { visitId });
    expect(departAfterVoid.status).toBe(409);
    expect(departAfterVoid.body.code).toBe('INVALID_TRANSITION');
  });

  it('SPK-ENTRY-004: arrival checks are actionable issues; a held check-in is admitted once the cause is resolved', async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    await enroll(t, p, child, fam.guardian.personId, { acknowledge: false });
    const held = await post(t, '/v1/session-checkins', desk, {
      personId: child,
      activity: sessionRef(p),
    });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expect(held.body.status).toBe('held');
    const codes = (held.body.issues as Array<{ code: string; severity: string }>).map(
      (i) => `${i.code}:${i.severity}`,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'missing_acknowledgment:blocking',
        'not_on_site:warning',
        'balance_unknown:info',
      ]),
    );
    // The unknown balance never blocks (DEC-056 default); every issue has a next action.
    for (const i of held.body.issues as Array<{ nextAction: string }>) {
      expect(i.nextAction.length).toBeGreaterThan(0);
    }
    const duplicate = await post(t, '/v1/session-checkins', desk, {
      personId: child,
      activity: sessionRef(p),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.details).toMatchObject({ code: 'already_checked_in' });

    const stillHeld = await post(t, `/v1/session-checkins/${held.body.id}/recheck`, desk, {
      expectedRevision: held.body.revision,
    });
    expect(stillHeld.status).toBe(200);
    expect(stillHeld.body).toMatchObject({ status: 'held', revision: 2 });

    await createAcknowledgmentFixture(t, {
      subjectPersonId: child,
      policyVersionId: p.offering.formPolicyVersionId,
      signedByPersonId: fam.guardian.personId,
    });
    const stale = await post(t, `/v1/session-checkins/${held.body.id}/recheck`, desk, {
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const admitted = await post(t, `/v1/session-checkins/${held.body.id}/recheck`, desk, {
      expectedRevision: 2,
    });
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
    expect(admitted.body).toMatchObject({ status: 'admitted', revision: 3 });
    expect(admitted.body.issues.some((i: { severity: string }) => i.severity === 'blocking')).toBe(
      false,
    );
    // admitted → recheck is not a transition; admitted → withdrawn is.
    const recheckAdmitted = await post(t, `/v1/session-checkins/${held.body.id}/recheck`, desk, {
      expectedRevision: 3,
    });
    expect(recheckAdmitted.status).toBe(409);
    expect(recheckAdmitted.body.code).toBe('INVALID_TRANSITION');
    const withdrawn = await post(t, `/v1/session-checkins/${held.body.id}/withdraw`, desk, {
      reason: 'Went home sick',
      expectedRevision: 3,
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'Went home sick',
    });
    const withdrawAgain = await post(t, `/v1/session-checkins/${held.body.id}/withdraw`, desk, {
      reason: 'Again',
      expectedRevision: 4,
    });
    expect(withdrawAgain.status).toBe(409);
    expect(withdrawAgain.body.code).toBe('INVALID_TRANSITION');
  });

  it('SPK-ENTRY-004: an unconfirmed enrollment holds the check-in; a confirmed booking admits it', async () => {
    const pendingChild = await createPersonFixture(t, { kind: 'child' });
    await enroll(t, p, pendingChild, fam.guardian.personId, { status: 'pending' });
    const pending = await post(t, '/v1/session-checkins', desk, {
      personId: pendingChild,
      activity: sessionRef(p),
    });
    expect(pending.body.status).toBe('held');
    expect(pending.body.basis).toMatchObject({ kind: 'enrollment' });
    expect(pending.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'enrollment_not_confirmed', severity: 'blocking' }),
      ]),
    );
    const dropIn = await createPersonFixture(t, { kind: 'child' });
    const bookingId = await createSessionBookingFixture(t, {
      offeringId: p.offering.offeringId,
      sessionId: p.sessionId,
      participantPersonId: dropIn,
      scheduledStart: new Date(p.start),
      scheduledEnd: new Date(p.end),
    });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: dropIn,
      policyVersionId: p.offering.formPolicyVersionId,
      signedByPersonId: fam.guardian.personId,
    });
    const booked = await post(t, '/v1/session-checkins', desk, {
      personId: dropIn,
      activity: sessionRef(p),
    });
    expect(booked.body).toMatchObject({
      status: 'admitted',
      basis: { kind: 'session_booking', id: bookingId },
    });
  });

  it('reads of a check-in are protected: the guardian sees it, a stranger gets NOT_FOUND', async () => {
    const row = await t.db
      .selectFrom('session_checkins')
      .select('id')
      .where('person_id', '=', fam.childA)
      .executeTakeFirstOrThrow();
    const asGuardian = await t.http.get(`/v1/session-checkins/${row.id}`).set(fam.guardian.header);
    expect(asGuardian.status).toBe(200);
    const stranger = await adultCustomer(t);
    const asStranger = await t.http.get(`/v1/session-checkins/${row.id}`).set(stranger.header);
    expect(asStranger.status).toBe(404);
  });

  it('§4.14 / SPK-UX-007: a coach or official reads a check-in only of an activity they are assigned to; a customer reads it without staff identifiers', async () => {
    const row = await t.db
      .selectFrom('session_checkins')
      .select('id')
      .where('person_id', '=', fam.childA)
      .executeTakeFirstOrThrow();
    const path = `/v1/session-checkins/${row.id}`;
    const unassignedCoach = await staffMember(t, ['coach']);
    expect((await t.http.get(path).set(unassignedCoach.header)).status).toBe(404);
    const unassignedOfficial = await staffMember(t, ['official']);
    expect((await t.http.get(path).set(unassignedOfficial.header)).status).toBe(404);
    const coach = await staffMember(t, ['coach']);
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
    const assigned = await t.http.get(path).set(coach.header);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.recordedBy.personId).toBe(desk.personId);
    const asDesk = await t.http.get(path).set(desk.header);
    expect(asDesk.body.recordedBy).toMatchObject({ personId: desk.personId, kind: 'staff' });
    const asGuardian = await t.http.get(path).set(fam.guardian.header);
    expect(asGuardian.status).toBe(200);
    expect(asGuardian.body.recordedBy).toEqual({
      kind: 'staff',
      accountId: null,
      personId: null,
      staffRoles: [],
      sessionId: null,
      actorLabel: 'staff',
    });
  });

  it('enforces facility scope and organization scope', async () => {
    const otherFacility = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: otherFacility,
        organization_id: t.organizationId,
        slug: `annex-${otherFacility}`,
        name: 'Annex',
        timezone: 'America/Los_Angeles',
      })
      .execute();
    const annexDesk = await staffMember(t, ['front_desk'], { facilityIds: [otherFacility] });
    const person = await createPersonFixture(t, { kind: 'adult' });
    const outOfScope = await post(t, '/v1/visits', annexDesk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: person, visitorCategory: 'guardian' }],
    });
    expect(outOfScope.status).toBe(403);
    const checkinOutOfScope = await post(t, '/v1/session-checkins', annexDesk, {
      personId: fam.childB,
      activity: sessionRef(p),
    });
    expect(checkinOutOfScope.status).toBe(403);
    const inScope = await post(t, '/v1/visits', annexDesk, {
      facilityId: otherFacility,
      arrivals: [{ personId: person, visitorCategory: 'guardian' }],
    });
    expect(inScope.status).toBe(201);

    const other = await seedOrganization(t.db);
    const foreignDesk = await staffMember(t, ['front_desk'], {
      organizationId: other.organizationId,
    });
    const foreignPerson = await post(t, '/v1/visits', foreignDesk, {
      facilityId: other.facilityId,
      arrivals: [{ personId: fam.childB, visitorCategory: 'participant' }],
    });
    expect(foreignPerson.status).toBe(404);
    const foreignFacility = await post(t, '/v1/visits', foreignDesk, {
      facilityId: t.facilityId,
      arrivals: [{ visitorCategory: 'spectator', visitorDescription: 'Fan' }],
    });
    expect(foreignFacility.status).toBe(404);
    const foreignSession = await post(t, '/v1/session-checkins', foreignDesk, {
      personId: fam.childB,
      activity: sessionRef(p),
    });
    expect(foreignSession.status).toBe(404);
    const foreignCustomer = await adultCustomer(t, { organizationId: other.organizationId });
    const peek = await t.http
      .get(`/v1/visits?facilityId=${t.facilityId}`)
      .set(foreignCustomer.header);
    expect(peek.status).toBe(403);
    const listed = await t.http.get(`/v1/visits?facilityId=${t.facilityId}`).set(desk.header);
    expect(listed.status).toBe(200);
    expect(listed.body.items.length).toBeGreaterThan(0);
  });
});
