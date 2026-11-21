import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { createAssignmentFixture } from '../../workforce';
import {
  adultCustomer,
  enroll,
  entryTestApp,
  family,
  program,
  staffMember,
  type Actor,
  type Family,
  type Program,
} from './support';

/**
 * S 3g (SPK-ENTRY-007, SCR-W-09, §4.10, §4.14): before a supervised release the assigned coach (or
 * the pickup desk) lists the adults who may collect one participant of the activity now, by name
 * only, to match the person in front of them. Everyone else, and anyone asking about a child
 * outside the activity, learns nothing.
 */
describe('authorized collectors of a participant (S 3g)', () => {
  let t: TestApp;
  let desk: Actor;
  let coach: Actor;
  let fam: Family;
  let p: Program;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    const manager = await staffMember(t, ['program_manager']);
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
  });
  afterAll(async () => {
    await t.close();
  });

  const list = (actor: Actor, participantPersonId: string) =>
    t.http.get('/v1/releases/authorized-collectors').set(actor.header).query({
      activityType: 'session',
      activityId: p.sessionId,
      offeringId: p.offering.offeringId,
      participantPersonId,
    });

  it('SPK-ENTRY-007: the assigned coach sees only the adults holding collect over the child, by name', async () => {
    const grandmother = await adultCustomer(t, { givenName: 'Rosa' });
    await createRelationshipFixture(t, {
      actorPersonId: grandmother.personId,
      subjectPersonId: fam.childA,
      kind: 'caregiver',
      permissions: ['view', 'collect'],
    });
    const payer = await adultCustomer(t, { givenName: 'Paula' });
    await createRelationshipFixture(t, {
      actorPersonId: payer.personId,
      subjectPersonId: fam.childA,
      kind: 'caregiver',
      permissions: ['view', 'pay'],
    });
    const before = (await t.db.selectFrom('audit_records').select('id').execute()).length;
    const res = await list(coach, fam.childA);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.collectors.map((c: { personId: string }) => c.personId);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([fam.guardian.personId, grandmother.personId]));
    expect(ids).not.toContain(payer.personId);
    expect(res.body.checkedAt).toBe(t.clock.now().toISOString());
    expect(res.body.restrictions).toEqual([
      expect.objectContaining({ code: 'authority_rechecked_at_release' }),
    ]);
    // Names only: nothing about contacts or other permissions.
    expect(JSON.stringify(res.body)).not.toMatch(/Paula|pay|view|@|phone|email/);
    for (const collector of res.body.collectors) {
      expect(Object.keys(collector).sort()).toEqual([
        'displayName',
        'familyName',
        'givenName',
        'personId',
      ]);
    }
    // A read records nothing.
    expect((await t.db.selectFrom('audit_records').select('id').execute()).length).toBe(before);
    // The pickup desk may read it too.
    expect((await list(desk, fam.childA)).status).toBe(200);
  });

  it('§4.10: a child outside the activity, or an unknown person, reads as not found', async () => {
    const outside = await list(coach, fam.childB);
    expect(outside.status).toBe(404);
    expect(JSON.stringify(outside.body)).not.toContain(fam.guardian.personId);
    const stranger = await list(coach, await createPersonFixture(t, { kind: 'child' }));
    expect(stranger.status).toBe(404);
    expect(stranger.body.code).toBe(outside.body.code);
  });

  it('authorization: an unassigned coach, an official and a customer may not list collectors', async () => {
    const unassigned = await staffMember(t, ['coach']);
    const res = await list(unassigned, fam.childA);
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ code: 'not_assigned' });
    expect((await list(await staffMember(t, ['official']), fam.childA)).status).toBe(403);
    expect((await list(fam.guardian, fam.childA)).status).toBe(403);
  });
});
