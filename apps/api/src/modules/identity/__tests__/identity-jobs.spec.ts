import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import {
  END_ELAPSED_RESTRICTIONS_JOB,
  EXPIRE_INVITATIONS_AND_CLAIMS_JOB,
} from '../services/identity-jobs';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;
const HOUR = 3600_000;

/**
 * Identity background work (§4.12): the expiry sweep (ID-07) and the end of restriction windows
 * (ID-08). Jobs scan every organization, so assertions name the rows each case created. The
 * concurrent case runs the sweep and an acceptance at once: under PGlite they serialize, under
 * TEST_DATABASE_URL the row lock (FOR UPDATE / SKIP LOCKED) decides; either way one expiry is
 * recorded.
 */
describe('identity periodic jobs (ID-07, ID-08; SPK-IAM-002, SPK-IAM-004, SPK-IAM-005, §4.12)', () => {
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

  const events = (aggregateId: string, eventType: string) =>
    t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', aggregateId)
      .where('event_type', '=', eventType)
      .orderBy('id')
      .execute()
      .then((rows) => rows.map((r) => r.payload));

  async function adultWithAccount() {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    const account = await createAccountFixture(t, { personId });
    return { personId, accountId: account.id, header: await authHeaderForAccount(t, account.id) };
  }

  async function invitationFor(recipientPersonId: string, expiresInHours = 1) {
    const staff = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const child = await createPersonFixture(t, { kind: 'child' });
    const res = await t.http
      .post('/v1/invitations')
      .set(await authHeaderForPerson(t, staff.personId))
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId,
        scope: { type: 'person', personId: child },
        relationshipKind: 'guardian',
        requestedPermissions: ['view'],
        expiresInHours,
      });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, token: res.body.token as string };
  }

  const invitationRow = (id: string) =>
    t.db
      .selectFrom('invitations')
      .select(['status', 'revision'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('registers both jobs with the support operator as failure owner', async () => {
    const summaries = await t.runPeriodicJobs([
      EXPIRE_INVITATIONS_AND_CLAIMS_JOB,
      END_ELAPSED_RESTRICTIONS_JOB,
    ]);
    expect(summaries.map((s) => [s.name, s.ran, s.failed])).toEqual([
      [EXPIRE_INVITATIONS_AND_CLAIMS_JOB, true, false],
      [END_ELAPSED_RESTRICTIONS_JOB, true, false],
    ]);
  });

  it('SPK-IAM-004: the sweep expires an invitation after FixedClock passes expires_at and emits the event once', async () => {
    const recipient = await adultWithAccount();
    const invitation = await invitationFor(recipient.personId, 1);
    await t.runPeriodicJobs([EXPIRE_INVITATIONS_AND_CLAIMS_JOB]);
    expect(await invitationRow(invitation.id)).toEqual({ status: 'pending', revision: 1 });
    t.clock.advance(HOUR);
    // expires_at <= now is due
    const [summary] = await t.runPeriodicJobs([EXPIRE_INVITATIONS_AND_CLAIMS_JOB]);
    expect(summary?.failed).toBe(false);
    expect(await invitationRow(invitation.id)).toEqual({ status: 'expired', revision: 2 });
    await t.runPeriodicJobs([EXPIRE_INVITATIONS_AND_CLAIMS_JOB]);
    expect(await events(invitation.id, 'identity.invitation_expired')).toEqual([
      { invitationId: invitation.id, via: 'sweep' },
    ]);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['actor', 'details'])
      .where('target_id', '=', invitation.id)
      .where('action', '=', 'identity.expire_invitation')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toMatchObject({
      kind: 'system',
      actorLabel: EXPIRE_INVITATIONS_AND_CLAIMS_JOB,
    });
    expect(audit[0]?.details).toMatchObject({ via: 'sweep', outcome: 'expired' });
  });

  it('acceptance after the sweep answers INVALID_TRANSITION', async () => {
    const recipient = await adultWithAccount();
    const invitation = await invitationFor(recipient.personId, 1);
    t.clock.advance(2 * HOUR);
    await t.runPeriodicJobs([EXPIRE_INVITATIONS_AND_CLAIMS_JOB]);
    const res = await t.http
      .post(`/v1/invitations/${invitation.id}/accept`)
      .set(recipient.header)
      .set('Idempotency-Key', key())
      .send({ token: invitation.token });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'expired' } });
    expect(await events(invitation.id, 'identity.invitation_expired')).toEqual([
      { invitationId: invitation.id, via: 'sweep' },
    ]);
  });

  it('SPK-IAM-002: the sweep expires a pending claim once; accepting it afterwards answers INVALID_TRANSITION', async () => {
    const staff = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const issued = await t.http
      .post(`/v1/people/${adult}/claims`)
      .set(await authHeaderForPerson(t, staff.personId))
      .set('Idempotency-Key', key())
      .send({ kind: 'self', requestedPermissions: [], expiresInHours: 1 });
    expect(issued.status).toBe(201);
    t.clock.advance(2 * HOUR);
    await t.runPeriodicJobs([EXPIRE_INVITATIONS_AND_CLAIMS_JOB]);
    await t.runPeriodicJobs([EXPIRE_INVITATIONS_AND_CLAIMS_JOB]);
    const claim = await t.db
      .selectFrom('claims')
      .select(['status', 'revision'])
      .where('id', '=', issued.body.id)
      .executeTakeFirstOrThrow();
    expect(claim).toEqual({ status: 'expired', revision: 2 });
    expect(await events(issued.body.id, 'identity.claim_expired')).toEqual([
      { claimId: issued.body.id, via: 'sweep' },
    ]);
    const account = await createAccountFixture(t, { personId: null });
    const accept = await t.http
      .post('/v1/claims/accept')
      .set(await authHeaderForAccount(t, account.id))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(accept.status).toBe(409);
    expect(accept.body.code).toBe('INVALID_TRANSITION');
  });

  it('IF-25: the sweep and an acceptance racing for one expired invitation record its expiry once (PGlite and TEST_DATABASE_URL)', async () => {
    const recipient = await adultWithAccount();
    const invitation = await invitationFor(recipient.personId, 1);
    t.clock.advance(2 * HOUR);
    const [accepted] = await Promise.all([
      t.http
        .post(`/v1/invitations/${invitation.id}/accept`)
        .set(recipient.header)
        .set('Idempotency-Key', key())
        .send({ token: invitation.token }),
      t.runPeriodicJobs([EXPIRE_INVITATIONS_AND_CLAIMS_JOB]),
    ]);
    expect(accepted.status).toBe(409);
    expect(accepted.body.code).toBe('INVALID_TRANSITION');
    expect(await invitationRow(invitation.id)).toEqual({ status: 'expired', revision: 2 });
    const expired = await events(invitation.id, 'identity.invitation_expired');
    expect(expired).toHaveLength(1);
    expect(['sweep', 'acceptance_attempt']).toContain((expired[0] as { via: string }).via);
  });

  describe('ID-08: the end of a restriction window', () => {
    async function reviewer() {
      const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
      return authHeaderForPerson(t, support.personId);
    }

    async function openReview(header: Record<string, string>, subjectPersonId: string) {
      const res = await t.http
        .post('/v1/access-reviews')
        .set(header)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId, reason: 'temporary protective order' });
      expect(res.status).toBe(201);
      return res.body.id as string;
    }

    async function decide(
      header: Record<string, string>,
      reviewId: string,
      body: Record<string, unknown>,
    ) {
      const res = await t.http
        .post(`/v1/access-reviews/${reviewId}/decisions`)
        .set(header)
        .set('Idempotency-Key', key())
        .send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    }

    it('SPK-IAM-005: the window end lifts exactly once with the event', async () => {
      const family = await createOrganizationPeople(t, {
        guardianPermissions: ['view', 'collect'],
      });
      const header = await reviewer();
      const reviewId = await openReview(header, family.child.personId);
      const windowEnd = new Date(t.clock.now().getTime() + HOUR);
      await decide(header, reviewId, {
        kind: 'restrict',
        grantIds: [family.guardianGrants.collect],
        effectiveTo: windowEnd.toISOString(),
      });
      const org = t.organizationId;
      const parent = family.adult.personId;
      const child = family.child.personId;
      expect(await authority.hasPermission(org, parent, child, 'collect')).toBe(false);
      t.clock.advance(2 * HOUR);
      // authority already honours the window; the job records the end
      expect(await authority.hasPermission(org, parent, child, 'collect')).toBe(true);
      await t.runPeriodicJobs([END_ELAPSED_RESTRICTIONS_JOB]);
      await t.runPeriodicJobs([END_ELAPSED_RESTRICTIONS_JOB]);
      const suspension = await t.db
        .selectFrom('access_grant_suspensions')
        .select(['ended_at', 'end_decision_id'])
        .where('review_id', '=', reviewId)
        .executeTakeFirstOrThrow();
      expect(new Date(suspension.ended_at as Date).toISOString()).toBe(windowEnd.toISOString());
      const grant = await t.db
        .selectFrom('access_grants')
        .select(['suspended_at', 'suspended_by_review_id'])
        .where('id', '=', family.guardianGrants.collect as string)
        .executeTakeFirstOrThrow();
      expect(grant).toEqual({ suspended_at: null, suspended_by_review_id: null });
      expect(await events(reviewId, 'identity.access_restriction_lifted')).toEqual([
        {
          reviewId,
          subjectPersonId: child,
          grantIds: [family.guardianGrants.collect],
          cause: 'window_ended',
        },
      ]);
      const decided = await events(reviewId, 'identity.access_review_decided');
      expect(decided.at(-1)).toEqual({
        reviewId,
        subjectPersonId: child,
        kind: 'lift',
        status: 'open',
      });
      expect(decided).toHaveLength(2);
      const read = await t.http.get(`/v1/access-reviews/${reviewId}`).set(header);
      expect(read.body.status).toBe('open');
      expect(read.body.revision).toBe(3);
      expect(read.body.decisions.map((d: { kind: string }) => d.kind)).toEqual([
        'restrict',
        'lift',
      ]);
      expect(read.body.decisions[1]).toMatchObject({
        id: suspension.end_decision_id,
        kind: 'lift',
        note: 'restriction window ended',
        bySystem: true,
        affectedGrantIds: [family.guardianGrants.collect],
        effectiveFrom: windowEnd.toISOString(),
      });
      expect(read.body.decisions[0].bySystem).toBe(false);
      const audits = await t.db
        .selectFrom('audit_records')
        .select('actor')
        .where('target_id', '=', reviewId)
        .where('action', '=', 'identity.end_restriction_window')
        .execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor).toMatchObject({
        kind: 'system',
        actorLabel: 'identity.restriction_window',
      });
    });

    it('a grant also restricted by a second open review stays suspended and is not listed', async () => {
      const family = await createOrganizationPeople(t, {
        guardianPermissions: ['view', 'collect'],
      });
      const header = await reviewer();
      const child = family.child.personId;
      const first = await openReview(header, child);
      const second = await openReview(header, child);
      await decide(header, first, {
        kind: 'restrict',
        grantIds: [family.guardianGrants.view, family.guardianGrants.collect],
        effectiveTo: new Date(t.clock.now().getTime() + HOUR).toISOString(),
      });
      await decide(header, second, { kind: 'restrict', grantIds: [family.guardianGrants.collect] });
      t.clock.advance(2 * HOUR);
      await t.runPeriodicJobs([END_ELAPSED_RESTRICTIONS_JOB]);
      expect(await events(first, 'identity.access_restriction_lifted')).toEqual([
        {
          reviewId: first,
          subjectPersonId: child,
          grantIds: [family.guardianGrants.view],
          cause: 'window_ended',
        },
      ]);
      const org = t.organizationId;
      const parent = family.adult.personId;
      expect(await authority.hasPermission(org, parent, child, 'view')).toBe(true);
      expect(await authority.hasPermission(org, parent, child, 'collect')).toBe(false);
      const collect = await t.db
        .selectFrom('access_grants')
        .select('suspended_by_review_id')
        .where('id', '=', family.guardianGrants.collect as string)
        .executeTakeFirstOrThrow();
      expect(collect.suspended_by_review_id).toBe(second);
      // the first review's decision records both window ends
      const firstRead = await t.http.get(`/v1/access-reviews/${first}`).set(header);
      expect(firstRead.body.decisions.at(-1).affectedGrantIds.sort()).toEqual(
        [family.guardianGrants.view, family.guardianGrants.collect].sort(),
      );
      expect(await events(second, 'identity.access_restriction_lifted')).toEqual([]);
    });

    it('a manual lift naming actorPersonId ends only that actor’s suspensions (cause decision)', async () => {
      const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
      const otherParent = await createPersonFixture(t, { kind: 'adult' });
      const other = await createRelationshipFixture(t, {
        actorPersonId: otherParent,
        subjectPersonId: family.child.personId,
        permissions: ['view'],
      });
      const header = await reviewer();
      const reviewId = await openReview(header, family.child.personId);
      await decide(header, reviewId, { kind: 'restrict', actorPersonId: family.adult.personId });
      await decide(header, reviewId, { kind: 'restrict', actorPersonId: otherParent });
      const org = t.organizationId;
      const child = family.child.personId;
      expect(await authority.hasPermission(org, family.adult.personId, child, 'view')).toBe(false);
      expect(await authority.hasPermission(org, otherParent, child, 'view')).toBe(false);
      const lifted = await decide(header, reviewId, {
        kind: 'lift',
        actorPersonId: family.adult.personId,
      });
      expect(lifted.decisions.at(-1).affectedGrantIds).toEqual([family.guardianGrants.view]);
      expect(await authority.hasPermission(org, family.adult.personId, child, 'view')).toBe(true);
      expect(await authority.hasPermission(org, otherParent, child, 'view')).toBe(false);
      expect(await events(reviewId, 'identity.access_restriction_lifted')).toEqual([
        {
          reviewId,
          subjectPersonId: child,
          grantIds: [family.guardianGrants.view],
          cause: 'decision',
        },
      ]);
      expect(other.grantIds.view).not.toBe(family.guardianGrants.view);
    });
  });
});
