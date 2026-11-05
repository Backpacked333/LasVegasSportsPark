import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { createAssignmentFixture } from '../../workforce';
import {
  adultCustomer,
  enroll,
  entryTestApp,
  family,
  post,
  program,
  sessionRef,
  staffMember,
  type Actor,
  type Family,
  type Program,
} from './support';

/**
 * ENT-02 (SPK-ENTRY-007, SPK-ENTRY-003, SPK-COND-004, §4.14, §4.15, SCR-W-09): before a supervised
 * release, an assigned coach identifies the collecting adult by pass; the release records the
 * identity grant its online check relied on.
 */
describe('collector checks and the release grant (ENT-02)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let coach: Actor;
  let fam: Family;
  let p: Program;
  let guardianPass: string;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
    p = await program(t, manager);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    coach = await staffMember(t, ['coach']);
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
    const issued = await post(t, '/v1/passes', fam.guardian, {
      holder: { kind: 'person', personId: fam.guardian.personId },
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    guardianPass = issued.body.reference as string;
  });
  afterAll(async () => {
    await t.close();
  });

  const check = (actor: Actor, participantPersonId: string, passReference: string) =>
    t.http
      .post('/v1/releases/collector-checks')
      .set(actor.header)
      .send({ activity: sessionRef(p), participantPersonId, passReference });

  const counts = async () => ({
    audit: (await t.db.selectFrom('audit_records').select('id').execute()).length,
    releases: (await t.db.selectFrom('release_records').select('id').execute()).length,
    outbox: (await t.db.selectFrom('outbox_events').select('id').execute()).length,
  });

  it('SPK-ENTRY-007: an assigned coach identifies an authorized collector by pass before release', async () => {
    const before = await counts();
    const res = await check(coach, fam.childA, guardianPass);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      mayCollect: true,
      collector: {
        personId: fam.guardian.personId,
        displayName: expect.any(String),
      },
      checkedAt: t.clock.now().toISOString(),
      restrictions: [
        expect.objectContaining({ code: 'authority_rechecked_at_release' }),
        // The child has not been recorded as arrived at the facility.
        expect.objectContaining({ code: 'participant_not_on_site' }),
      ],
    });
    expect(res.body.collector.displayName.length).toBeGreaterThan(0);
    // Read-only: nothing is recorded, not even an audit row; no idempotency key is needed.
    expect(await counts()).toEqual(before);
    // The pickup desk may check too.
    expect((await check(desk, fam.childA, guardianPass)).body.mayCollect).toBe(true);
    // The coach then releases with the identified collector: verified.
    const release = await post(t, '/v1/releases', coach, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: res.body.collector.personId },
      activity: sessionRef(p),
      recordDeparture: false,
    });
    expect(release.status, JSON.stringify(release.body)).toBe(201);
    expect(release.body.release.verificationOutcome).toBe('verified');
  });

  it('a pass holder without collect is not named', async () => {
    const payer = await adultCustomer(t, { givenName: 'Paula' });
    await createRelationshipFixture(t, {
      actorPersonId: payer.personId,
      subjectPersonId: fam.childA,
      kind: 'caregiver',
      permissions: ['view', 'pay'],
    });
    const payerPass = await post(t, '/v1/passes', payer, {
      holder: { kind: 'person', personId: payer.personId },
    });
    const denied = await check(coach, fam.childA, payerPass.body.reference);
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ mayCollect: false, collector: null });
    expect(JSON.stringify(denied.body)).not.toMatch(/Paula|pay|view/);
    expect(JSON.stringify(denied.body)).not.toContain(payer.personId);

    // An unknown pass, a revoked pass, a household pass and a child outside the activity all read
    // the same: nobody is named and nothing distinguishes the cases.
    const unknown = await check(coach, fam.childA, `spp_${'x'.repeat(40)}`);
    const revokedPass = await post(t, '/v1/passes', fam.guardian, {
      holder: { kind: 'person', personId: fam.guardian.personId },
    });
    await post(t, `/v1/passes/${revokedPass.body.pass.id}/revoke`, fam.guardian, {
      reason: 'Lost it',
      expectedRevision: 1,
    });
    const revoked = await check(coach, fam.childA, revokedPass.body.reference);
    const householdPass = await post(t, '/v1/passes', desk, {
      holder: { kind: 'household', householdId: fam.householdId },
    });
    const household = await check(coach, fam.childA, householdPass.body.reference);
    // childB is the guardian's child but is not enrolled in this session.
    const outside = await check(coach, fam.childB, guardianPass);
    const stranger = await check(
      coach,
      await createPersonFixture(t, { kind: 'child' }),
      guardianPass,
    );
    for (const res of [unknown, revoked, household, outside, stranger]) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ mayCollect: false, collector: null });
      expect(JSON.stringify(res.body)).not.toContain(fam.guardian.personId);
    }
    // Outside the activity, nothing about the participant is reported either.
    expect(outside.body.restrictions).toEqual([
      expect.objectContaining({ code: 'authority_rechecked_at_release' }),
    ]);
  });

  it('authorization: an unassigned coach, an official and a customer may not check collectors', async () => {
    const unassigned = await staffMember(t, ['coach']);
    const res = await check(unassigned, fam.childA, guardianPass);
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ code: 'not_assigned' });
    const official = await staffMember(t, ['official']);
    expect((await check(official, fam.childA, guardianPass)).status).toBe(403);
    expect((await check(fam.guardian, fam.childA, guardianPass)).status).toBe(403);
    // The reference is never accepted in the URL; a malformed body is a validation error.
    const malformed = await t.http
      .post('/v1/releases/collector-checks')
      .set(coach.header)
      .send({ activity: sessionRef(p), participantPersonId: fam.childA });
    expect(malformed.status).toBe(400);
  });

  it('SPK-ENTRY-007: a verified release records the grant id it relied on', async () => {
    const caregiver = await adultCustomer(t);
    const relationship = await createRelationshipFixture(t, {
      actorPersonId: caregiver.personId,
      subjectPersonId: fam.childA,
      kind: 'caregiver',
      permissions: ['view', 'collect'],
    });
    const verified = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: caregiver.personId },
      recordDeparture: false,
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(201);
    expect(verified.body.release).toMatchObject({
      verificationOutcome: 'verified',
      authorityBasis: 'relationship_permission:collect',
      authorityGrantId: relationship.grantIds.collect,
    });
    const stored = await t.db
      .selectFrom('release_records')
      .select(['authority_grant_id'])
      .where('id', '=', verified.body.release.id)
      .executeTakeFirstOrThrow();
    expect(stored.authority_grant_id).toBe(relationship.grantIds.collect);
    // Pickup staff read the grant; the guardian (view over the child) does not.
    const asDesk = await t.http.get(`/v1/releases/${verified.body.release.id}`).set(desk.header);
    expect(asDesk.body.authorityGrantId).toBe(relationship.grantIds.collect);
    const asGuardian = await t.http
      .get(`/v1/releases/${verified.body.release.id}`)
      .set(fam.guardian.header);
    expect(asGuardian.status).toBe(200);
    expect(asGuardian.body.authorityGrantId).toBeNull();

    // A denial names no grant.
    const payer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: payer.personId,
      subjectPersonId: fam.childA,
      kind: 'caregiver',
      permissions: ['view', 'pay'],
    });
    const denied = await post(t, '/v1/releases', desk, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: payer.personId },
      recordDeparture: false,
    });
    expect(denied.body.release).toMatchObject({
      verificationOutcome: 'denied',
      authorityGrantId: null,
    });
    // The assigned coach is told whether collect is held, never the grant.
    const byCoach = await post(t, '/v1/releases', coach, {
      facilityId: t.facilityId,
      childPersonId: fam.childA,
      collector: { personId: caregiver.personId },
      activity: sessionRef(p),
      recordDeparture: false,
    });
    expect(byCoach.body.release).toMatchObject({
      verificationOutcome: 'verified',
      authorityGrantId: null,
    });
    const coachStored = await t.db
      .selectFrom('release_records')
      .select('authority_grant_id')
      .where('id', '=', byCoach.body.release.id)
      .executeTakeFirstOrThrow();
    expect(coachStored.authority_grant_id).toBe(relationship.grantIds.collect);
  });
});
