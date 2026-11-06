import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;
const DAY = 86_400_000;

/**
 * Staff access reviews, last seen and staff invitations (migration 0181; §2.1 system administrator:
 * accounts and permissions; §4.14 least privilege, audited privileged actions; SPK-IAM-004).
 */
describe('staff access (§2.1, §4.14, SPK-IAM-004)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-11-06T15:00:00Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.14: an administrator reviews another staff member; the list shows last seen and the latest review; the summary counts', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const coach = await createStaffMemberFixture(t, {
      roles: ['coach'],
      facilityIds: [t.facilityId],
    });
    const header = await authHeaderForPerson(t, admin.personId);
    // The coach signs in once: the resolver records last seen.
    await t.http.get('/v1/me').set(await authHeaderForPerson(t, coach.personId));

    const before = await t.http.get('/v1/staff-access-summary').set(header);
    expect(before.status).toBe(200);
    const due = new Date(t.clock.now().getTime() + 90 * DAY).toISOString();
    const self = await t.http
      .post('/v1/staff-access-reviews')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personId: admin.personId, outcome: 'confirmed', nextReviewDueAt: due });
    expect(self.status).toBe(403);
    const past = await t.http
      .post('/v1/staff-access-reviews')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        personId: coach.personId,
        outcome: 'confirmed',
        nextReviewDueAt: '2026-01-01T00:00:00Z',
      });
    expect(past.status).toBe(400);
    const review = await t.http
      .post('/v1/staff-access-reviews')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personId: coach.personId, outcome: 'confirmed', nextReviewDueAt: due });
    expect(review.status).toBe(201);
    expect(review.body).toMatchObject({
      personId: coach.personId,
      rolesReviewed: ['coach'],
      reviewedByPersonId: admin.personId,
      nextReviewDueAt: due,
    });

    const list = await t.http
      .get('/v1/staff-memberships')
      .query({ personId: coach.personId })
      .set(header);
    expect(list.body.items[0]).toMatchObject({
      lastSeenAt: t.clock.now().toISOString(),
      lastAccessReview: { reviewId: review.body.id, outcome: 'confirmed', nextReviewDueAt: due },
    });
    const after = await t.http.get('/v1/staff-access-summary').set(header);
    expect(after.body.neverReviewed).toBe(before.body.neverReviewed - 1);
    expect(after.body.nextReviewDueAt).toBe(due);

    const front = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const denied = await t.http
      .get('/v1/staff-access-reviews')
      .set(await authHeaderForPerson(t, front.personId));
    expect(denied.status).toBe(403);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', review.body.id)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['identity.record_staff_access_review']);
  });

  it('§4.14: the database refuses a self review, a past due date and any change to a recorded review', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const now = t.clock.now();
    const insert = (personId: string, due: Date) =>
      t.db
        .insertInto('staff_access_reviews')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          person_id: personId,
          outcome: 'confirmed',
          notes: null,
          roles_reviewed: ['coach'],
          reviewed_by: json({ kind: 'system' }),
          reviewed_by_person_id: admin.personId,
          reviewed_at: now,
          next_review_due_at: due,
        })
        .execute();
    await expect(insert(admin.personId, new Date(now.getTime() + DAY))).rejects.toThrow();
    const other = await createPersonFixture(t, { kind: 'adult' });
    await expect(insert(other, new Date(now.getTime() - DAY))).rejects.toThrow();
    await insert(other, new Date(now.getTime() + DAY));
    await expect(
      t.db
        .updateTable('staff_access_reviews')
        .set({ outcome: 'changes_required' })
        .where('person_id', '=', other)
        .execute(),
    ).rejects.toThrow();
  });

  it('SPK-IAM-004: an invited email accepts with its token and gets exactly the invited roles; the token works once', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const email = `new.coach.${newId().slice(0, 8)}@example.test`;
    const issued = await t.http
      .post('/v1/staff-invitations')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ email: email.toUpperCase(), roles: ['coach'], facilityIds: [t.facilityId] });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({
      recipientEmail: email,
      status: 'pending',
      roles: ['coach'],
    });
    expect(typeof issued.body.token).toBe('string');
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', issued.body.id)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['identity.staff_invitation_created']);
    expect(JSON.stringify(events[0]?.payload)).not.toContain(email);
    expect(JSON.stringify(events[0]?.payload)).not.toContain(issued.body.token);

    const duplicate = await t.http
      .post('/v1/staff-invitations')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ email, roles: ['official'] });
    expect(duplicate.status).toBe(409);

    // An account whose email is not verified cannot accept.
    const invitee = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: invitee });
    const unverified = await createContactPointFixture(t, {
      personId: invitee,
      kind: 'email',
      value: email,
      verified: false,
    });
    const inviteeHeader = await authHeaderForPerson(t, invitee);
    const notVerified = await t.http
      .post(`/v1/staff-invitations/${issued.body.id}/accept`)
      .set(inviteeHeader)
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(notVerified.status).toBe(403);
    await t.db
      .updateTable('contact_points')
      .set({ verified_at: t.clock.now() })
      .where('id', '=', unverified)
      .execute();
    const wrongToken = await t.http
      .post(`/v1/staff-invitations/${issued.body.id}/accept`)
      .set(inviteeHeader)
      .set('Idempotency-Key', key())
      .send({ token: 'x'.repeat(43) });
    expect(wrongToken.status).toBe(404);
    const accepted = await t.http
      .post(`/v1/staff-invitations/${issued.body.id}/accept`)
      .set(inviteeHeader)
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.invitation).toMatchObject({
      status: 'accepted',
      acceptedByPersonId: invitee,
    });
    const me = await t.http.get('/v1/me').set(inviteeHeader);
    expect(me.body.principal).toMatchObject({
      kind: 'staff',
      staffRoles: ['coach'],
      facilityIds: [t.facilityId],
    });
    const twice = await t.http
      .post(`/v1/staff-invitations/${issued.body.id}/accept`)
      .set(inviteeHeader)
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(twice.status).toBe(409);
    const listed = await t.http
      .get('/v1/staff-invitations')
      .query({ status: 'accepted' })
      .set(header);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toContain(issued.body.id);
    expect(JSON.stringify(listed.body)).not.toContain(issued.body.token);
  });

  it('SPK-IAM-004: acceptance grants nothing once the inviter no longer administers the scope; revoke and expiry end an invitation', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const email = `ops.${newId().slice(0, 8)}@example.test`;
    const issued = await t.http
      .post('/v1/staff-invitations')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ email, roles: ['front_desk'], facilityIds: [t.facilityId] });
    const invitee = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: invitee });
    await createContactPointFixture(t, {
      personId: invitee,
      kind: 'email',
      value: email,
      verified: true,
    });
    await t.db
      .updateTable('staff_memberships')
      .set({
        status: 'ended',
        ended_at: t.clock.now(),
        ended_reason: 'left',
        effective_to: t.clock.now(),
      })
      .where('id', '=', admin.membershipId)
      .execute();
    const lapsed = await t.http
      .post(`/v1/staff-invitations/${issued.body.id}/accept`)
      .set(await authHeaderForPerson(t, invitee))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(lapsed.status).toBe(403);

    // A scoped administrator cannot invite organization-wide; revoke needs a reason.
    const scoped = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      facilityIds: [t.facilityId],
    });
    const scopedHeader = await authHeaderForPerson(t, scoped.personId);
    const wide = await t.http
      .post('/v1/staff-invitations')
      .set(scopedHeader)
      .set('Idempotency-Key', key())
      .send({ email: `wide.${newId().slice(0, 8)}@example.test`, roles: ['scheduler'] });
    expect(wide.status).toBe(403);
    const other = await t.http
      .post('/v1/staff-invitations')
      .set(scopedHeader)
      .set('Idempotency-Key', key())
      .send({
        email: `other.${newId().slice(0, 8)}@example.test`,
        roles: ['scheduler'],
        facilityIds: [t.facilityId],
        expiresInHours: 1,
      });
    const revoked = await t.http
      .post(`/v1/staff-invitations/${other.body.id}/revoke`)
      .set(scopedHeader)
      .set('Idempotency-Key', key())
      .send({ reason: 'sent to the wrong address' });
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');

    const expiring = await t.http
      .post('/v1/staff-invitations')
      .set(scopedHeader)
      .set('Idempotency-Key', key())
      .send({ email, roles: ['scheduler'], facilityIds: [t.facilityId], expiresInHours: 1 });
    // The earlier invitation to this address is still pending (the inviter lapsed, nothing accepted).
    expect(expiring.status).toBe(409);
  });

  it('SPK-IAM-004: an expired invitation reads as expired, cannot be accepted, and frees the address for a new one', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const email = `late.${newId().slice(0, 8)}@example.test`;
    const issued = await t.http
      .post('/v1/staff-invitations')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ email, roles: ['official'], expiresInHours: 1 });
    t.clock.advance(2 * 3600_000);
    const invitee = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: invitee });
    await createContactPointFixture(t, {
      personId: invitee,
      kind: 'email',
      value: email,
      verified: true,
    });
    const late = await t.http
      .post(`/v1/staff-invitations/${issued.body.id}/accept`)
      .set(await authHeaderForPerson(t, invitee))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(late.status).toBe(409);
    const row = await t.db
      .selectFrom('staff_invitations')
      .select(['status'])
      .where('id', '=', issued.body.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
    const reissued = await t.http
      .post('/v1/staff-invitations')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ email, roles: ['official'] });
    expect(reissued.status).toBe(201);
  });

  it('SPK-IAM-004: the database allows one pending invitation per address and refuses an accepted row without its membership', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const email = `db.${newId().slice(0, 8)}@example.test`;
    const row = () => ({
      id: newId(),
      organization_id: t.organizationId,
      recipient_email: email,
      roles: ['coach'],
      invited_by: json({ kind: 'system' }),
      invited_by_person_id: admin.personId,
      token_hash: newId(),
      expires_at: new Date(t.clock.now().getTime() + DAY),
      accepted_at: null,
      accepted_by_person_id: null,
      staff_membership_id: null,
      revoked_at: null,
      revoked_by: null,
      revocation_reason: null,
      expired_at: null,
    });
    await t.db.insertInto('staff_invitations').values(row()).execute();
    await expect(t.db.insertInto('staff_invitations').values(row()).execute()).rejects.toThrow();
    await expect(
      t.db
        .insertInto('staff_invitations')
        .values({
          ...row(),
          recipient_email: `x${email}`,
          status: 'accepted',
          accepted_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      t.db
        .insertInto('staff_invitations')
        .values({ ...row(), recipient_email: `Upper${email}` })
        .execute(),
    ).rejects.toThrow();
  });
});
