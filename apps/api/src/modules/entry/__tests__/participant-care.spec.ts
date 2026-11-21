import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { createAssignmentFixture } from '../../workforce';
import {
  enroll,
  entryTestApp,
  family,
  post,
  program,
  staffMember,
  type Actor,
  type Family,
  type Program,
} from './support';

/**
 * S 2d (SPK-ENTRY-004, §1.7, §4.14, SPK-UX-007): the assigned coach's attendance tiles flag which
 * children have operational care notes (by kind, no text, nothing audited) and read one child's
 * notes on tap, each read audited. Children outside the session, unassigned coaches and roles that
 * may not read care notes learn nothing.
 */
describe('care flags and notes for the assigned coach (S 2d)', () => {
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
    for (const childId of [fam.childA, fam.childB]) {
      const note = await post(t, `/v1/people/${childId}/care-notes`, desk, {
        kind: 'allergy',
        body: 'Peanuts. Carries an adrenaline pen.',
      });
      expect(note.status, JSON.stringify(note.body)).toBe(201);
    }
  });
  afterAll(async () => {
    await t.close();
  });

  const activity = () => ({
    activityType: 'session',
    activityId: p.sessionId,
    offeringId: p.offering.offeringId,
  });
  const flags = (actor: Actor, personIds: string[]) =>
    t.http
      .get('/v1/attendance/care-flags')
      .set(actor.header)
      .query({ ...activity(), personIds: personIds.join(',') });
  const notes = (actor: Actor, personId: string) =>
    t.http
      .get('/v1/attendance/care-notes')
      .set(actor.header)
      .query({ ...activity(), personId });
  const auditCount = async () =>
    (
      await t.db
        .selectFrom('audit_records')
        .select('id')
        .where('action', '=', 'identity.read_care_notes')
        .execute()
    ).length;

  it('SPK-ENTRY-004: the assigned coach sees which children of the session have a note, by kind only', async () => {
    const before = await auditCount();
    const stranger = await createPersonFixture(t, { kind: 'child' });
    const res = await flags(coach, [fam.childA, fam.childB, stranger]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // childB has a note too but is not in the session: left out.
    expect(res.body).toEqual({ items: [{ personId: fam.childA, kinds: ['allergy'] }] });
    expect(JSON.stringify(res.body)).not.toContain('Peanuts');
    expect(await auditCount()).toBe(before);
  });

  it('§4.14: reading the text is audited, one record per read, and only for a child of the session', async () => {
    const before = await auditCount();
    const res = await notes(coach, fam.childA);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.notes).toEqual([
      expect.objectContaining({ kind: 'allergy', body: 'Peanuts. Carries an adrenaline pen.' }),
    ]);
    expect(await auditCount()).toBe(before + 1);
    const records = await t.db
      .selectFrom('audit_records')
      .select(['target_id'])
      .where('action', '=', 'identity.read_care_notes')
      .execute();
    expect(records.map((r) => r.target_id)).toContain(fam.childA);
    const outside = await notes(coach, fam.childB);
    expect(outside.status).toBe(404);
    expect(JSON.stringify(outside.body)).not.toContain('Peanuts');
    expect(await auditCount()).toBe(before + 1);
  });

  it('authorization: an unassigned coach and a role that may not read care notes are refused', async () => {
    const unassigned = await staffMember(t, ['coach']);
    expect((await flags(unassigned, [fam.childA])).status).toBe(403);
    expect((await notes(unassigned, fam.childA)).status).toBe(403);
    const league = await staffMember(t, ['league_manager']);
    expect((await flags(league, [fam.childA])).status).toBe(403);
    expect((await notes(fam.guardian, fam.childA)).status).toBe(403);
    // The desk reads them (its role may read care notes).
    expect((await notes(desk, fam.childA)).status).toBe(200);
  });
});
