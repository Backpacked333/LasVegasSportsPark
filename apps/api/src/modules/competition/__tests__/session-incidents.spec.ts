import { newId, type StaffRole } from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, drainOutboxChecked, type TestApp } from '../../../testing';
import { createOfferingFixture, createOfferingSessionFixture } from '../../catalog';
import { CommunicationsModule } from '../../communications';
import { EntryModule } from '../../entry';
import {
  authHeaderForPerson,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../../identity';
import { at } from '../../scheduling';
import { SupportModule } from '../../support';
import { createAssignmentFixture } from '../../workforce';

/**
 * S 4d "Coach · report an injury" (SPK-DISC-001 operational incidents, SPK-DISC-004, SPK-DISC-005,
 * SPK-STAFF-002, SPK-UX-006, SPK-COMMS-002): the assigned coach of a program session reports a
 * child's injury there; it is restricted like every incident, raises an issue on the managers'
 * Today and tells the child's guardians, without copying the narrative anywhere.
 */
interface Actor {
  personId: string;
  header: { Authorization: string };
}

const TODAY = '2027-01-16';

describe('session incidents: a coach reports an injury (S 4d)', () => {
  let t: TestApp;
  let coach: Actor;
  let generalManager: Actor;
  let offeringId: string;
  let sessionId: string;
  let child: string;
  let guardian: string;

  const staff = async (roles: StaffRole[]): Promise<Actor> => {
    const s = await createStaffMemberFixture(t, { roles });
    return { personId: s.personId, header: await authHeaderForPerson(t, s.personId) };
  };
  const report = (actor: Actor, body: object) =>
    t.http
      .post('/v1/incidents')
      .set(actor.header)
      .set('Idempotency-Key', `k-${newId()}`)
      .send(body);
  const injury = (extra: object = {}) => ({
    kind: 'injury',
    offeringId,
    sessionId,
    subjectPersonId: child,
    severity: 'medium',
    summary: 'Ankle / foot: ice and rest; sat out the rest of the session',
    narrative: 'Rolled the ankle during the dribbling drill.',
    ...extra,
  });

  beforeAll(async () => {
    t = await createTestApp({
      imports: [EntryModule, CommunicationsModule, SupportModule],
      principalResolver: 'module',
      clockStart: '2027-01-16T17:00:00Z',
    });
    const manager = await staff(['program_manager']);
    generalManager = await staff(['general_manager']);
    coach = await staff(['coach']);
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: manager.personId,
    });
    offeringId = offering.offeringId;
    sessionId = await createOfferingSessionFixture(t, {
      offeringId,
      scheduledStart: new Date(at(TODAY, '10:00')),
      scheduledEnd: new Date(at(TODAY, '11:00')),
    });
    await createAssignmentFixture(t, {
      targetType: 'session',
      targetId: sessionId,
      offeringId,
      personId: coach.personId,
      kind: 'coach',
      status: 'accepted',
      scheduledStart: at(TODAY, '10:00'),
      scheduledEnd: at(TODAY, '11:00'),
    });
    child = await createPersonFixture(t, { kind: 'child', givenName: 'Noah' });
    guardian = await createPersonFixture(t, { kind: 'adult', givenName: 'Lena' });
    await createRelationshipFixture(t, { actorPersonId: guardian, subjectPersonId: child });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-DISC-001: the assigned coach reports an injury in their session; it names the session and its facility', async () => {
    const res = await report(coach, injury());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'injury',
      sessionId,
      facilityId: t.facilityId,
      fixtureId: null,
      subjectPersonId: child,
      status: 'open',
    });
    // The restricted narrative stays with the incident only (SPK-DISC-004): a general manager
    // reads it, the coach's role does not.
    const read = await t.http.get(`/v1/incidents/${res.body.id}`).set(generalManager.header);
    expect(read.status).toBe(200);
    expect(read.body.narrative).toContain('dribbling');
    expect((await t.http.get(`/v1/incidents/${res.body.id}`).set(coach.header)).status).toBe(404);
  });

  it("SPK-UX-006: an injury is an issue on the managers' Today, without the narrative", async () => {
    const res = await report(coach, injury({ severity: 'high' }));
    expect(res.status).toBe(201);
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('affected_type', '=', 'incident')
      .where('affected_id', '=', res.body.id)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({
      category: 'competition.injury_incident',
      facility_id: t.facilityId,
      owner_queue: 'program_manager',
      severity: 'high',
      status: 'open',
    });
    expect(JSON.stringify(exception)).not.toContain('dribbling');
    const today = await t.http
      .get('/v1/today')
      .query({ facilityId: t.facilityId })
      .set(generalManager.header);
    expect(today.status, JSON.stringify(today.body)).toBe(200);
    const item = today.body.items.find(
      (i: { affected?: { id?: string } | null }) => i.affected?.id === res.body.id,
    );
    expect(item, JSON.stringify(today.body.items)).toBeDefined();
    expect(item.group).toBe('incident');
  });

  it("SPK-COMMS-002: the child's guardians receive one protected injury notice, never the narrative", async () => {
    const res = await report(coach, injury());
    expect(res.status).toBe(201);
    await drainOutboxChecked(t);
    await drainOutboxChecked(t);
    const notices = await t.db
      .selectFrom('notifications')
      .selectAll()
      .where('kind', '=', 'injury_report')
      .where('subject_id', '=', res.body.id)
      .execute();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ category: 'operational', protected: true });
    expect(JSON.stringify(notices[0])).not.toContain('dribbling');
    const recipients = await t.db
      .selectFrom('notification_recipients')
      .select(['person_id'])
      .where('notification_id', '=', notices[0]!.id)
      .execute();
    expect(recipients.map((r) => r.person_id)).toContain(guardian);
    // A replay composes nothing new.
    await drainOutboxChecked(t);
    expect(
      await t.db
        .selectFrom('notifications')
        .select('id')
        .where('kind', '=', 'injury_report')
        .where('subject_id', '=', res.body.id)
        .execute(),
    ).toHaveLength(1);
  });

  it('authorization: a coach of another session, a front desk and a card from a session are refused', async () => {
    const other = await staff(['coach']);
    const denied = await report(other, injury());
    expect(denied.status).toBe(403);
    expect((await report(await staff(['front_desk']), injury())).status).toBe(403);
    // A coach never reports for a fixture, and a session incident is never a card.
    const card = await report(coach, injury({ kind: 'card', cardKind: 'yellow' }));
    expect(card.status).toBe(400);
    // An unknown session is not found.
    const unknown = await report(coach, injury({ sessionId: newId() }));
    expect(unknown.status).toBe(404);
  });

  it('the database refuses a session incident that is a card, lacks its facility or names a fixture', async () => {
    const base = {
      organization_id: t.organizationId,
      occurred_at: new Date(),
      severity: 'low' as const,
      summary: 'x',
      reported_by: JSON.stringify({ actorType: 'staff', actorLabel: 'test' }),
      offering_session_id: sessionId,
    };
    const insert = (values: Record<string, unknown>) =>
      t.db
        .insertInto('incidents')
        .values({ id: newId(), ...base, ...values } as never)
        .execute();
    for (const values of [
      { kind: 'misconduct', facility_id: t.facilityId },
      { kind: 'injury', facility_id: null },
    ]) {
      const error = await insert(values).catch((e: unknown) => e);
      expect(pgErrorCode(error)).toBe('23514');
    }
    // The session must exist in the organization (composite reference).
    const missing = await insert({
      kind: 'injury',
      facility_id: t.facilityId,
      offering_session_id: newId(),
    }).catch((e: unknown) => e);
    expect(pgErrorCode(missing)).toBe('23503');
  });
});
