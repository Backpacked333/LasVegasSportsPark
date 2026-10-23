import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { PeopleService } from '../services/people.service';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

describe('duplicate review and merge (SPK-IAM-007)', () => {
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

  it('flagging is idempotent per pair; dismissing is restricted and final', async () => {
    const people = await createOrganizationPeople(t, { staffRoles: ['support_operator'] });
    const header = await authHeaderForPerson(t, people.staff.personId);
    const a = await createPersonFixture(t, { kind: 'adult' });
    const b = await createPersonFixture(t, { kind: 'adult' });
    const first = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: b, personBId: a, reasons: ['same phone on file'], score: 65 });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'open',
      score: 65,
      reasons: ['same phone on file'],
    });
    expect([first.body.personAId, first.body.personBId].sort()).toEqual([a, b].sort());
    const again = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: a, personBId: b, reasons: ['again'] });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const frontDesk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const denied = await t.http
      .post(`/v1/duplicate-candidates/${first.body.id}/dismiss`)
      .set(await authHeaderForPerson(t, frontDesk.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'different people' });
    expect(denied.status).toBe(403);
    const dismissed = await t.http
      .post(`/v1/duplicate-candidates/${first.body.id}/dismiss`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ reason: 'different people', expectedRevision: 1 });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({
      status: 'dismissed',
      decision: { outcome: 'dismissed' },
      revision: 2,
    });
    const twice = await t.http
      .post(`/v1/duplicate-candidates/${first.body.id}/dismiss`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ reason: 'x' });
    expect(twice.status).toBe(409);
  });

  it('merge keeps history reachable, re-points accounts and verified grants, and imports nothing unverified', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const org = t.organizationId;

    // survivor: the parent with an account, guardian of child1 (view, pay)
    const survivor = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Dana',
      familyName: 'Merge',
    });
    const survivorAccount = await createAccountFixture(t, { personId: survivor });
    const child1 = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: survivor,
      subjectPersonId: child1,
      permissions: ['view', 'pay'],
    });
    // duplicate: same person entered again, with another account, guardian of child1 (view, collect)
    // via staff, guardian of child2 via import (unverified), and a sitter holding a grant over them
    const duplicate = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'dana',
      familyName: 'merge',
    });
    const duplicateAccount = await createAccountFixture(t, { personId: duplicate });
    await createContactPointFixture(t, {
      personId: duplicate,
      kind: 'email',
      value: 'dana@example.test',
      verified: true,
    });
    await createRelationshipFixture(t, {
      actorPersonId: duplicate,
      subjectPersonId: child1,
      permissions: ['view', 'collect'],
    });
    const child2 = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: duplicate,
      subjectPersonId: child2,
      permissions: ['view'],
      source: 'import',
    });
    const sitter = await createPersonFixture(t, { kind: 'adult' });
    await createRelationshipFixture(t, {
      actorPersonId: sitter,
      subjectPersonId: duplicate,
      kind: 'caregiver',
      permissions: ['receive_messages'],
    });
    const coach = await createStaffMemberFixture(t, { personId: duplicate, roles: ['coach'] });

    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: survivor, personBId: duplicate, reasons: ['same name'] });
    const frontDesk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const denied = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(await authHeaderForPerson(t, frontDesk.personId))
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: survivor, reason: 'same person' });
    expect(denied.status).toBe(403);
    const grantsBefore = await t.db
      .selectFrom('access_grants')
      .select('id')
      .where('organization_id', '=', org)
      .execute();

    const merged = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: survivor, reason: 'same person, verified at the desk' });
    expect(merged.status).toBe(201);
    expect(merged.body).toMatchObject({
      survivorPersonId: survivor,
      mergedPersonId: duplicate,
      candidateId: flagged.body.id,
      moved: {
        contactPointsMoved: 1,
        accountsMoved: 0,
        accountsDisabled: 1,
        grantsMoved: 2, // collect over child1 and the sitter's receive_messages over the survivor
        grantsRevokedAsDuplicate: 1, // view over child1 already held by the survivor
        relationshipsConsolidated: 1,
        relationshipsMoved: 1,
        unverifiedRelationshipsSkipped: 1,
        unverifiedGrantsSkipped: 1,
        staffMembershipsMoved: 1,
      },
    });
    // no grant was created: the set of grant ids is unchanged
    const grantsAfter = await t.db
      .selectFrom('access_grants')
      .select('id')
      .where('organization_id', '=', org)
      .execute();
    expect(grantsAfter.map((g) => g.id).sort()).toEqual(grantsBefore.map((g) => g.id).sort());
    // authority: survivor now holds collect over child1, nothing over child2 (import was unverified)
    expect(await authority.hasPermission(org, survivor, child1, 'collect')).toBe(true);
    expect(await authority.hasPermission(org, survivor, child1, 'pay')).toBe(true);
    expect(await authority.hasPermission(org, survivor, child1, 'view')).toBe(true);
    expect(await authority.hasPermission(org, survivor, child2, 'view')).toBe(false);
    expect(await authority.hasPermission(org, duplicate, child1, 'view')).toBe(false);
    expect(await authority.hasPermission(org, sitter, survivor, 'receive_messages')).toBe(true);
    // the merged person stays, pointing at the survivor; history reachable through person_merges
    const mergedRow = await t.db
      .selectFrom('persons')
      .select(['status', 'merged_into_person_id'])
      .where('id', '=', duplicate)
      .executeTakeFirstOrThrow();
    expect(mergedRow).toEqual({ status: 'merged', merged_into_person_id: survivor });
    const people = t.app.get(PeopleService);
    expect(await people.resolveCanonicalPersonId(org, duplicate)).toBe(survivor);
    expect((await people.findPerson(org, duplicate))?.canonicalPersonId).toBe(survivor);
    const mergeRows = await t.db
      .selectFrom('person_merges')
      .selectAll()
      .where('merged_person_id', '=', duplicate)
      .execute();
    expect(mergeRows).toHaveLength(1);
    expect(mergeRows[0]?.operation_id).not.toBeNull();
    const operation = await t.db
      .selectFrom('operations')
      .select(['status', 'kind'])
      .where('id', '=', mergeRows[0]?.operation_id as string)
      .executeTakeFirstOrThrow();
    expect(operation).toEqual({ status: 'succeeded', kind: 'identity.merge_persons' });
    // accounts: the survivor's stays active, the duplicate's is disabled (one active account per person)
    expect(
      (await t.http.get('/v1/me').set(await authHeaderForAccount(t, survivorAccount.id))).body
        .principal.personId,
    ).toBe(survivor);
    expect(
      (await t.http.get('/v1/me').set(await authHeaderForAccount(t, duplicateAccount.id))).status,
    ).toBe(401);
    // the coach membership follows the survivor
    const membership = await t.db
      .selectFrom('staff_memberships')
      .select('person_id')
      .where('id', '=', coach.membershipId)
      .executeTakeFirstOrThrow();
    expect(membership.person_id).toBe(survivor);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'identity.persons_merged')
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ survivorPersonId: survivor, mergedPersonId: duplicate });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['target_id'])
      .where('action', '=', 'identity.merge_persons')
      .execute();
    expect(audit.map((a) => a.target_id).sort()).toEqual([survivor, duplicate].sort());
    // a merged person cannot be merged again or edited
    const again = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: survivor, reason: 'twice' });
    expect(again.status).toBe(409);
  });

  it('merge moves the account when the survivor has none, and revokes pending invitations and claims', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const survivor = await createPersonFixture(t, { kind: 'adult' });
    const duplicate = await createPersonFixture(t, { kind: 'adult' });
    const account = await createAccountFixture(t, { personId: duplicate });
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const invitation = await t.http
      .post('/v1/invitations')
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: duplicate,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'delegate',
        requestedPermissions: ['view'],
      });
    const claim = await t.http
      .post(`/v1/people/${duplicate}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'guardian', requestedPermissions: ['view'] });
    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: survivor, personBId: duplicate, reasons: ['desk'] });
    const merged = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: survivor, reason: 'verified' });
    expect(merged.status).toBe(201);
    expect(merged.body.moved).toMatchObject({
      accountsMoved: 1,
      accountsDisabled: 0,
      pendingInvitationsRevoked: 1,
      pendingClaimsRevoked: 1,
    });
    expect(
      (await t.http.get('/v1/me').set(await authHeaderForAccount(t, account.id))).body.principal
        .personId,
    ).toBe(survivor);
    const inv = await t.db
      .selectFrom('invitations')
      .select('status')
      .where('id', '=', invitation.body.id)
      .executeTakeFirstOrThrow();
    expect(inv.status).toBe('revoked');
    const cl = await t.db
      .selectFrom('claims')
      .select('status')
      .where('id', '=', claim.body.id)
      .executeTakeFirstOrThrow();
    expect(cl.status).toBe('revoked');
    const survivorIsNotCandidate = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: newId(), reason: 'x' });
    expect(survivorIsNotCandidate.status).toBe(409);
  });
});
