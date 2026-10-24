import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

describe('disputed access reviews (SPK-IAM-005)', () => {
  let t: TestApp;
  let authority: RelationshipAuthority;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    authority = t.app.get(RelationshipAuthority);
  });
  afterAll(async () => {
    await t.close();
  });

  it('a guardian opens a review; temporary restriction suspends grants without deleting them; lifting restores', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({
        subjectPersonId: people.child.personId,
        reason: 'contested custody arrangement',
        parties: [
          { personId: people.adult.personId, description: 'mother' },
          { description: 'father (no account)' },
        ],
        evidence: [{ type: 'court_order', reference: 'case-2026-118', note: 'interim order' }],
      });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({
      status: 'open',
      ownerRole: 'support_operator',
      subjectPersonId: people.child.personId,
      parties: [
        { personId: people.adult.personId, description: 'mother' },
        { description: 'father (no account)' },
      ],
      evidence: [{ type: 'court_order', reference: 'case-2026-118', note: 'interim order' }],
      decisions: [],
    });
    const reviewId = opened.body.id as string;
    // the opener may read it; front desk may not decide
    expect((await t.http.get(`/v1/access-reviews/${reviewId}`).set(parent)).status).toBe(200);
    const frontDesk = await t.http
      .post(`/v1/access-reviews/${reviewId}/decisions`)
      .set(await authHeaderForPerson(t, people.staff.personId))
      .set('Idempotency-Key', key())
      .send({ kind: 'restrict', actorPersonId: people.adult.personId });
    expect(frontDesk.status).toBe(404);

    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const header = await authHeaderForPerson(t, support.personId);
    const restricted = await t.http
      .post(`/v1/access-reviews/${reviewId}/decisions`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        kind: 'restrict',
        actorPersonId: people.adult.personId,
        note: 'pending the hearing',
        expectedRevision: 1,
      });
    expect(restricted.status).toBe(201);
    expect(restricted.body.decisions).toHaveLength(1);
    expect(restricted.body.decisions[0]).toMatchObject({
      sequence: 1,
      kind: 'restrict',
      note: 'pending the hearing',
    });
    expect(restricted.body.decisions[0].affectedGrantIds.sort()).toEqual(
      [people.guardianGrants.view, people.guardianGrants.collect].sort(),
    );
    const org = t.organizationId;
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'view'),
    ).toBe(false);
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'collect'),
    ).toBe(false);
    const rows = await t.db
      .selectFrom('access_grants')
      .select(['revoked_at', 'suspended_by_review_id'])
      .where('actor_person_id', '=', people.adult.personId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revoked_at === null && r.suspended_by_review_id === reviewId)).toBe(
      true,
    );
    const restrictedEvent = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'identity.access_restricted')
      .where('aggregate_id', '=', reviewId)
      .executeTakeFirstOrThrow();
    expect(restrictedEvent.payload).toMatchObject({ actorPersonIds: [people.adult.personId] });
    // the restricted guardian can no longer read the child record
    expect((await t.http.get(`/v1/people/${people.child.personId}`).set(parent)).status).toBe(404);

    const lifted = await t.http
      .post(`/v1/access-reviews/${reviewId}/decisions`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'lift', grantIds: [people.guardianGrants.view] });
    expect(lifted.status).toBe(201);
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'view'),
    ).toBe(true);
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'collect'),
    ).toBe(false);
  });

  it('state machine: open → escalated → decided → closed; closed reviews accept no decisions', async () => {
    const people = await createOrganizationPeople(t);
    const gm = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    const header = await authHeaderForPerson(t, gm.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        subjectPersonId: people.child.personId,
        reason: 'conflicting requests',
        ownerRole: 'general_manager',
      });
    const id = opened.body.id as string;
    const decide = (body: Record<string, unknown>) =>
      t.http
        .post(`/v1/access-reviews/${id}/decisions`)
        .set(header)
        .set('Idempotency-Key', key())
        .send(body);
    expect((await decide({ kind: 'note', note: 'called both parties' })).body.status).toBe('open');
    const escalated = await decide({
      kind: 'escalate',
      ownerRole: 'system_administrator',
      note: 'legal input needed',
    });
    expect(escalated.body).toMatchObject({
      status: 'escalated',
      ownerRole: 'system_administrator',
    });
    expect(escalated.body.escalatedAt).not.toBeNull();
    const escalateAgain = await decide({ kind: 'escalate' });
    expect(escalateAgain.status).toBe(409);
    expect(escalateAgain.body.code).toBe('INVALID_TRANSITION');
    const decided = await decide({
      kind: 'decide',
      outcome: { ruling: 'both guardians retain view' },
    });
    expect(decided.body).toMatchObject({
      status: 'decided',
      outcome: { ruling: 'both guardians retain view' },
    });
    const closed = await decide({ kind: 'close', note: 'done' });
    expect(closed.body.status).toBe('closed');
    expect(closed.body.effectiveTo).not.toBeNull();
    expect(closed.body.decisions.map((d: { kind: string }) => d.kind)).toEqual([
      'note',
      'escalate',
      'decide',
      'close',
    ]);
    const afterClose = await decide({ kind: 'note', note: 'too late' });
    expect(afterClose.status).toBe(409);
    const read = await t.http.get(`/v1/access-reviews/${id}`).set(header);
    expect(read.body.decisions).toHaveLength(4);
    const stranger = await createOrganizationPeople(t);
    expect(
      (
        await t.http
          .get(`/v1/access-reviews/${id}`)
          .set(await authHeaderForPerson(t, stranger.adult.personId))
      ).status,
    ).toBe(404);
  });

  async function restrictedGuardian() {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const header = await authHeaderForPerson(t, support.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        subjectPersonId: people.child.personId,
        reason: 'dispute',
        effectiveTo: new Date(t.clock.now().getTime() + 24 * 3600_000).toISOString(),
      });
    expect(opened.status).toBe(201);
    const decide = (body: Record<string, unknown>) =>
      t.http
        .post(`/v1/access-reviews/${opened.body.id}/decisions`)
        .set(header)
        .set('Idempotency-Key', key())
        .send(body);
    const canView = () =>
      authority.hasPermission(
        t.organizationId,
        people.adult.personId,
        people.child.personId,
        'view',
      );
    return { people, decide, canView };
  }

  it('SPK-IAM-005: restrictions left in place by a closed review can still be lifted', async () => {
    const { people, decide, canView } = await restrictedGuardian();
    expect((await decide({ kind: 'restrict', actorPersonId: people.adult.personId })).status).toBe(
      201,
    );
    const closed = await decide({ kind: 'close', note: 'hearing done' });
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('closed');
    // closing never lifts silently
    expect(await canView()).toBe(false);
    const note = await decide({ kind: 'note', note: 'too late' });
    expect(note.status).toBe(409);
    expect(note.body.code).toBe('INVALID_TRANSITION');
    const lifted = await decide({ kind: 'lift', note: 'order expired' });
    expect(lifted.status).toBe(201);
    expect(lifted.body.status).toBe('closed');
    expect(lifted.body.decisions.map((d: { kind: string }) => d.kind)).toEqual([
      'restrict',
      'close',
      'lift',
    ]);
    expect(lifted.body.decisions[2].affectedGrantIds).toEqual([people.guardianGrants.view]);
    expect(await canView()).toBe(true);
  });

  it('SPK-IAM-005: a restriction with an end time stops suspending at that time, without a lift', async () => {
    const start = t.clock.now();
    const { people, decide, canView } = await restrictedGuardian();
    const restricted = await decide({
      kind: 'restrict',
      actorPersonId: people.adult.personId,
      effectiveTo: new Date(start.getTime() + 3600_000).toISOString(),
    });
    expect(restricted.status).toBe(201);
    const grant = await t.db
      .selectFrom('access_grants')
      .select(['suspended_at', 'suspended_until'])
      .where('id', '=', people.guardianGrants.view as string)
      .executeTakeFirstOrThrow();
    expect(grant.suspended_until).not.toBeNull();
    try {
      expect(await canView()).toBe(false);
      t.clock.advance(2 * 3600_000);
      expect(await canView()).toBe(true);
      expect(await authority.authoritiesOf(t.organizationId, people.adult.personId)).toEqual([
        { subjectPersonId: people.child.personId, permissions: ['view'] },
      ]);
      // an expired restriction can be applied again, and an end time in the past is refused
      const past = await decide({
        kind: 'restrict',
        actorPersonId: people.adult.personId,
        effectiveTo: new Date(t.clock.now().getTime() - 1).toISOString(),
      });
      expect(past.status).toBe(400);
      const again = await decide({ kind: 'restrict', actorPersonId: people.adult.personId });
      expect(again.status).toBe(201);
      expect(again.body.decisions.at(-1).affectedGrantIds).toEqual([people.guardianGrants.view]);
      expect(await canView()).toBe(false);
    } finally {
      t.clock.set(start);
    }
  });

  it('a review cannot be opened by someone with no authority over the subject, and restrict needs a target', async () => {
    const people = await createOrganizationPeople(t);
    const stranger = await createOrganizationPeople(t);
    const denied = await t.http
      .post('/v1/access-reviews')
      .set(await authHeaderForPerson(t, stranger.adult.personId))
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: people.child.personId, reason: 'I want access' });
    expect(denied.status).toBe(404);
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: people.child.personId, reason: 'x' });
    const noTarget = await t.http
      .post(`/v1/access-reviews/${opened.body.id}/decisions`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'restrict' });
    expect(noTarget.status).toBe(400);
    const foreignGrant = await t.http
      .post(`/v1/access-reviews/${opened.body.id}/decisions`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'restrict', grantIds: [stranger.guardianGrants.view] });
    expect(foreignGrant.status).toBe(400);
  });
});
