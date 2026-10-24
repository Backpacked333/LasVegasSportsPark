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

  it('SPK-IAM-005: an opener who is not a decider reads their submission and progress, never staff notes, affected grants or the outcome', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const mother = await authHeaderForPerson(t, people.adult.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(mother)
      .set('Idempotency-Key', key())
      .send({
        subjectPersonId: people.child.personId,
        reason: 'contested pickup',
        parties: [{ description: 'father (no account)' }],
        evidence: [{ type: 'court_order', reference: 'case-2026-200', note: 'my copy' }],
      });
    expect(opened.status).toBe(201);
    const reviewId = opened.body.id as string;
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const header = await authHeaderForPerson(t, support.personId);
    const decide = async (body: Record<string, unknown>) => {
      const res = await t.http
        .post(`/v1/access-reviews/${reviewId}/decisions`)
        .set(header)
        .set('Idempotency-Key', key())
        .send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res;
    };
    const internal =
      'Internal: father produced court order ref 2026-FAM-123; mother prior incident';
    await decide({ kind: 'note', note: internal });
    await decide({
      kind: 'restrict',
      actorPersonId: people.adult.personId,
      note: 'pending hearing',
    });
    await decide({ kind: 'reassign', ownerPersonId: support.personId });
    await decide({ kind: 'decide', outcome: { finding: 'father has sole custody per order' } });

    const asMother = await t.http.get(`/v1/access-reviews/${reviewId}`).set(mother);
    expect(asMother.status).toBe(200);
    expect(asMother.body).toMatchObject({
      id: reviewId,
      status: 'decided',
      reason: 'contested pickup',
      parties: [{ description: 'father (no account)' }],
      evidence: [{ type: 'court_order', reference: 'case-2026-200', note: 'my copy' }],
      decisions: [],
      outcome: null,
      ownerPersonId: null,
    });
    expect(asMother.body.decidedAt).not.toBeNull();
    const text = JSON.stringify(asMother.body);
    expect(text).not.toContain('2026-FAM-123');
    expect(text).not.toContain('pending hearing');
    expect(text).not.toContain('sole custody');
    expect(text).not.toContain(people.guardianGrants.view);

    const asSupport = await t.http.get(`/v1/access-reviews/${reviewId}`).set(header);
    expect(asSupport.status).toBe(200);
    expect(asSupport.body.decisions.map((d: { kind: string }) => d.kind)).toEqual([
      'note',
      'restrict',
      'reassign',
      'decide',
    ]);
    expect(asSupport.body.decisions[0].note).toBe(internal);
    expect(asSupport.body.outcome).toEqual({ finding: 'father has sole custody per order' });
    expect(asSupport.body.ownerPersonId).toBe(support.personId);
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

  /** Two reviews over the same child, each owned by its own support operator (SPK-IAM-005). */
  async function twoReviews(permissions: ('view' | 'collect')[] = ['view', 'collect']) {
    const people = await createOrganizationPeople(t, { guardianPermissions: permissions });
    const open = async () => {
      const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
      const header = await authHeaderForPerson(t, support.personId);
      const opened = await t.http
        .post('/v1/access-reviews')
        .set(header)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: people.child.personId, reason: 'custody dispute' });
      expect(opened.status).toBe(201);
      const id = opened.body.id as string;
      const decide = (body: Record<string, unknown>) =>
        t.http
          .post(`/v1/access-reviews/${id}/decisions`)
          .set(header)
          .set('Idempotency-Key', key())
          .send(body);
      return { id, decide };
    };
    const can = (permission: 'view' | 'collect') =>
      authority.hasPermission(
        t.organizationId,
        people.adult.personId,
        people.child.personId,
        permission,
      );
    const suspendedBy = async (grantId: string) =>
      (
        await t.db
          .selectFrom('access_grants')
          .select('suspended_by_review_id')
          .where('id', '=', grantId)
          .executeTakeFirstOrThrow()
      ).suspended_by_review_id;
    const liftedEvents = (reviewId: string) =>
      t.db
        .selectFrom('outbox_events')
        .select('payload')
        .where('event_type', '=', 'identity.access_restriction_lifted')
        .where('aggregate_id', '=', reviewId)
        .execute();
    return { people, a: await open(), b: await open(), can, suspendedBy, liftedEvents };
  }

  it('SPK-IAM-005 / §4.6: lifting one review keeps a grant suspended while another review still restricts it', async () => {
    const { people, a, b, can, suspendedBy, liftedEvents } = await twoReviews();
    const grants = [people.guardianGrants.view, people.guardianGrants.collect].sort();
    const restrictA = await a.decide({ kind: 'restrict', actorPersonId: people.adult.personId });
    expect(restrictA.status).toBe(201);
    expect(restrictA.body.decisions[0].affectedGrantIds.sort()).toEqual(grants);
    // the second review records its own restriction of grants that are already suspended
    const restrictB = await b.decide({ kind: 'restrict', actorPersonId: people.adult.personId });
    expect(restrictB.status).toBe(201);
    expect(restrictB.body.decisions[0].affectedGrantIds.sort()).toEqual(grants);

    const liftA = await a.decide({ kind: 'lift', note: 'first dispute settled' });
    expect(liftA.status).toBe(201);
    expect(liftA.body.decisions.at(-1).affectedGrantIds.sort()).toEqual(grants);
    // review B is still open and still restricts the guardian
    expect(await can('collect')).toBe(false);
    expect(await can('view')).toBe(false);
    expect(await suspendedBy(people.guardianGrants.collect as string)).toBe(b.id);
    expect(await liftedEvents(a.id)).toHaveLength(0);
    expect(
      (
        await t.http
          .get(`/v1/people/${people.child.personId}`)
          .set(await authHeaderForPerson(t, people.adult.personId))
      ).status,
    ).toBe(404);

    const liftB = await b.decide({ kind: 'lift' });
    expect(liftB.status).toBe(201);
    expect(liftB.body.decisions.at(-1).affectedGrantIds.sort()).toEqual(grants);
    expect(await can('collect')).toBe(true);
    expect(await can('view')).toBe(true);
    expect(await suspendedBy(people.guardianGrants.collect as string)).toBeNull();
    const lifted = await liftedEvents(b.id);
    expect(lifted).toHaveLength(1);
    expect((lifted[0]?.payload as { grantIds: string[] }).grantIds.sort()).toEqual(grants);
  });

  it('SPK-IAM-005 / §4.6: a second review restricting explicit grantIds keeps them suspended after the first review lifts', async () => {
    const { people, a, b, can } = await twoReviews();
    const collect = people.guardianGrants.collect as string;
    expect(
      (await a.decide({ kind: 'restrict', actorPersonId: people.adult.personId })).status,
    ).toBe(201);
    const restrictB = await b.decide({ kind: 'restrict', grantIds: [collect] });
    expect(restrictB.status).toBe(201);
    expect(restrictB.body.decisions[0].affectedGrantIds).toEqual([collect]);
    // restricting again under the same review records nothing new
    const again = await b.decide({ kind: 'restrict', grantIds: [collect] });
    expect(again.body.decisions.at(-1).affectedGrantIds).toEqual([]);
    expect((await a.decide({ kind: 'lift' })).status).toBe(201);
    expect(await can('view')).toBe(true);
    expect(await can('collect')).toBe(false);
    // lifting a grant this review never restricted affects nothing
    const liftView = await b.decide({ kind: 'lift', grantIds: [people.guardianGrants.view] });
    expect(liftView.body.decisions.at(-1).affectedGrantIds).toEqual([]);
    expect(await can('collect')).toBe(false);
    expect((await b.decide({ kind: 'lift', grantIds: [collect] })).status).toBe(201);
    expect(await can('collect')).toBe(true);
  });

  it('SPK-IAM-005: a temporary restriction ending does not end another review’s open-ended restriction of the same grant', async () => {
    const start = t.clock.now();
    const { people, a, b, can } = await twoReviews(['view']);
    try {
      const timed = await a.decide({
        kind: 'restrict',
        actorPersonId: people.adult.personId,
        effectiveTo: new Date(start.getTime() + 3600_000).toISOString(),
      });
      expect(timed.status).toBe(201);
      const openEnded = await b.decide({ kind: 'restrict', actorPersonId: people.adult.personId });
      expect(openEnded.body.decisions[0].affectedGrantIds).toEqual([people.guardianGrants.view]);
      t.clock.advance(2 * 3600_000);
      expect(await can('view')).toBe(false);
      expect((await b.decide({ kind: 'lift' })).status).toBe(201);
      expect(await can('view')).toBe(true);
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
