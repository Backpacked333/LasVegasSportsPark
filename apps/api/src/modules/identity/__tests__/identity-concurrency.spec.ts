import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

/**
 * Identity commands under concurrency (§4.9 a stale edit must fail; SPK-IAM-002 and SPK-IAM-004
 * an invitation or claim is accepted once). Each case fires two requests at once. Under PGlite the
 * transactions run one after the other; under TEST_DATABASE_URL they really overlap and the row
 * locks decide the order. The assertions hold either way: exactly one wins and the other gets the
 * error a sequential second attempt would get, never a 500 and never a second acceptance.
 */
describe('identity commands under concurrency (§4.9, SPK-IAM-002, SPK-IAM-004)', () => {
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

  async function adultWithAccount() {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    const account = await createAccountFixture(t, { personId });
    return { personId, header: await authHeaderForAccount(t, account.id) };
  }

  it('SPK-IAM-004: one invitation is accepted once, by one person, even when two holders of its contact accept at once', async () => {
    const staff = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const child = await createPersonFixture(t, { kind: 'child' });
    const email = `family-${newId()}@example.test`;
    const a = await adultWithAccount();
    const b = await adultWithAccount();
    for (const holder of [a, b]) {
      await createContactPointFixture(t, {
        personId: holder.personId,
        kind: 'email',
        value: email,
        verified: true,
        isPrimary: false,
      });
    }
    const created = await t.http
      .post('/v1/invitations')
      .set(await authHeaderForPerson(t, staff.personId))
      .set('Idempotency-Key', key())
      .send({
        recipientContact: { kind: 'email', value: email },
        scope: { type: 'person', personId: child },
        relationshipKind: 'guardian',
        requestedPermissions: ['view', 'collect'],
      });
    expect(created.status).toBe(201);
    const accept = (header: Record<string, string>) =>
      t.http
        .post(`/v1/invitations/${created.body.id}/accept`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({ token: created.body.token });
    const results = await Promise.all([accept(a.header), accept(b.header)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('INVALID_TRANSITION');
    const relationships = await t.db
      .selectFrom('relationships')
      .select('actor_person_id')
      .where('subject_person_id', '=', child)
      .where('source', '=', 'invitation')
      .execute();
    expect(relationships).toHaveLength(1);
    const row = await t.db
      .selectFrom('invitations')
      .select(['status', 'revision', 'accepted_by_person_id'])
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'accepted', revision: 2 });
    expect(row.accepted_by_person_id).toBe(relationships[0]?.actor_person_id);
    const loser = row.accepted_by_person_id === a.personId ? b : a;
    expect(await authority.hasPermission(t.organizationId, loser.personId, child, 'collect')).toBe(
      false,
    );
    const audits = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('target_id', '=', created.body.id)
      .where('action', '=', 'identity.accept_invitation')
      .execute();
    expect(audits).toHaveLength(1);
  });

  it('SPK-IAM-002: one guardian claim token makes one guardian when two accounts claim at once', async () => {
    const staff = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const child = await createPersonFixture(t, { kind: 'child' });
    const email = `claim-${newId()}@example.test`;
    const issued = await t.http
      .post(`/v1/people/${child}/claims`)
      .set(await authHeaderForPerson(t, staff.personId))
      .set('Idempotency-Key', key())
      .send({
        kind: 'guardian',
        requestedPermissions: ['view', 'collect'],
        recipientContact: { kind: 'email', value: email },
      });
    expect(issued.status).toBe(201);
    const a = await adultWithAccount();
    const b = await adultWithAccount();
    // both claimants hold the claim's contact point, so both pass the recipient check (SPK-IAM-002)
    for (const holder of [a, b]) {
      await createContactPointFixture(t, {
        personId: holder.personId,
        kind: 'email',
        value: email,
        verified: true,
        isPrimary: false,
      });
    }
    const claim = (header: Record<string, string>) =>
      t.http
        .post(`/v1/claims/${issued.body.token}/accept`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({});
    const results = await Promise.all([claim(a.header), claim(b.header)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('INVALID_TRANSITION');
    const guardians = await t.db
      .selectFrom('relationships')
      .select('actor_person_id')
      .where('subject_person_id', '=', child)
      .where('kind', '=', 'guardian')
      .execute();
    expect(guardians).toHaveLength(1);
  });

  it('SPK-IAM-004: a revoke racing an accept leaves live grants only on an accepted invitation', async () => {
    const people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    const recipient = await adultWithAccount();
    const staffHeader = await authHeaderForPerson(t, people.staff.personId);
    const created = await t.http
      .post('/v1/invitations')
      .set(staffHeader)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: recipient.personId,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'caregiver',
        requestedPermissions: ['view', 'collect'],
      });
    expect(created.status).toBe(201);
    const [accepted, revoked] = await Promise.all([
      t.http
        .post(`/v1/invitations/${created.body.id}/accept`)
        .set(recipient.header)
        .set('Idempotency-Key', key())
        .send({ token: created.body.token }),
      t.http
        .post(`/v1/invitations/${created.body.id}/revoke`)
        .set(staffHeader)
        .set('Idempotency-Key', key())
        .send({ reason: 'sent to the wrong person' }),
    ]);
    expect([accepted.status, revoked.status].sort()).toEqual([200, 409]);
    const row = await t.db
      .selectFrom('invitations')
      .select(['status', 'revision'])
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(row.revision).toBe(2);
    const collect = await authority.hasPermission(
      t.organizationId,
      recipient.personId,
      people.child.personId,
      'collect',
    );
    if (row.status === 'accepted') {
      expect(accepted.status).toBe(200);
      expect(collect).toBe(true);
    } else {
      expect(row.status).toBe('revoked');
      expect(revoked.status).toBe(200);
      expect(collect).toBe(false);
    }
  });

  it('§4.9: concurrent review decisions against one revision: one succeeds, the other is STALE_REVISION', async () => {
    const people = await createOrganizationPeople(t);
    const gm = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    const header = await authHeaderForPerson(t, gm.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: people.child.personId, reason: 'conflicting requests' });
    expect(opened.status).toBe(201);
    const decide = (body: Record<string, unknown>) =>
      t.http
        .post(`/v1/access-reviews/${opened.body.id}/decisions`)
        .set(header)
        .set('Idempotency-Key', key())
        .send(body);
    const results = await Promise.all([
      decide({ kind: 'escalate', expectedRevision: 1 }),
      decide({ kind: 'close', expectedRevision: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('STALE_REVISION');
    const decisions = await t.db
      .selectFrom('access_review_decisions')
      .select('sequence')
      .where('review_id', '=', opened.body.id)
      .execute();
    expect(decisions.map((d) => d.sequence)).toEqual([1]);
  });

  it('SPK-IAM-005 / §4.6: a lift on one review racing a restriction by another leaves the grant suspended', async () => {
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const header = await authHeaderForPerson(t, support.personId);
    for (let round = 0; round < 3; round += 1) {
      const people = await createOrganizationPeople(t, { guardianPermissions: ['collect'] });
      const collect = people.guardianGrants.collect as string;
      const open = async () => {
        const opened = await t.http
          .post('/v1/access-reviews')
          .set(header)
          .set('Idempotency-Key', key())
          .send({ subjectPersonId: people.child.personId, reason: 'custody dispute' });
        expect(opened.status).toBe(201);
        return opened.body.id as string;
      };
      const decide = (reviewId: string, body: Record<string, unknown>) =>
        t.http
          .post(`/v1/access-reviews/${reviewId}/decisions`)
          .set(header)
          .set('Idempotency-Key', key())
          .send(body);
      const a = await open();
      const b = await open();
      expect((await decide(a, { kind: 'restrict', grantIds: [collect] })).status).toBe(201);
      const [lift, restrict] = await Promise.all([
        decide(a, { kind: 'lift' }),
        decide(b, { kind: 'restrict', grantIds: [collect] }),
      ]);
      expect(lift.status).toBe(201);
      expect(restrict.status).toBe(201);
      expect(restrict.body.decisions[0].affectedGrantIds).toEqual([collect]);
      expect(
        await authority.hasPermission(
          t.organizationId,
          people.adult.personId,
          people.child.personId,
          'collect',
        ),
      ).toBe(false);
      const grant = await t.db
        .selectFrom('access_grants')
        .select('suspended_by_review_id')
        .where('id', '=', collect)
        .executeTakeFirstOrThrow();
      expect(grant.suspended_by_review_id).toBe(b);
    }
  });

  it('§4.9: concurrent notes without an expected revision both succeed, in sequence', async () => {
    const people = await createOrganizationPeople(t);
    const gm = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    const header = await authHeaderForPerson(t, gm.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: people.child.personId, reason: 'notes' });
    const note = (text: string) =>
      t.http
        .post(`/v1/access-reviews/${opened.body.id}/decisions`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({ kind: 'note', note: text });
    const results = await Promise.all([note('first caller'), note('second caller')]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const decisions = await t.db
      .selectFrom('access_review_decisions')
      .select('sequence')
      .where('review_id', '=', opened.body.id)
      .orderBy('sequence')
      .execute();
    expect(decisions.map((d) => d.sequence)).toEqual([1, 2]);
    const review = await t.db
      .selectFrom('access_reviews')
      .select('revision')
      .where('id', '=', opened.body.id)
      .executeTakeFirstOrThrow();
    expect(review.revision).toBe(3);
  });
});
