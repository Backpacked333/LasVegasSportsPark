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
    const duplicateOverChild1 = await createRelationshipFixture(t, {
      actorPersonId: duplicate,
      subjectPersonId: child1,
      permissions: ['view', 'collect'],
    });
    const child2 = await createPersonFixture(t, { kind: 'child' });
    const importedOverChild2 = await createRelationshipFixture(t, {
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
    // another open candidate about the duplicate, which the merge makes moot
    const lookalike = await createPersonFixture(t, { kind: 'adult' });
    const otherCandidate = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: duplicate, personBId: lookalike, reasons: ['same phone'] });
    expect(otherCandidate.status).toBe(201);
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
    // §4.4, §4.14: the disabled login's own history records the merge that disabled it
    const accountAudits = await t.db
      .selectFrom('audit_records')
      .select(['target_id', 'before_revision', 'after_revision', 'operation_id', 'details'])
      .where('target_type', '=', 'account')
      .where('target_id', 'in', [survivorAccount.id, duplicateAccount.id])
      .where('action', '=', 'identity.merge_persons')
      .execute();
    expect(accountAudits).toEqual([
      {
        target_id: duplicateAccount.id,
        before_revision: 1,
        after_revision: 2,
        operation_id: merged.body.operationId,
        details: {
          via: 'merge',
          operation: 'disable',
          personId: duplicate,
          survivorAccountId: survivorAccount.id,
          disabledReason: `merged into person ${survivor}`,
          mergeId: merged.body.id,
          survivorPersonId: survivor,
          mergedPersonId: duplicate,
        },
      },
    ]);
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
      .where('target_type', '=', 'person')
      .execute();
    expect(audit.map((a) => a.target_id).sort()).toEqual([survivor, duplicate].sort());

    // §4.6, §4.9, §4.14: every relationship, grant and candidate the merge ends takes its own
    // lifecycle transition (machine, revision bump) with its own audit record and, for grants, one
    // revoke event, all tied to the merge's operation.
    const operationId = merged.body.operationId as string;
    const mergeDetails = {
      via: 'merge',
      mergeId: merged.body.id,
      survivorPersonId: survivor,
      mergedPersonId: duplicate,
    };
    const endedIds = [duplicateOverChild1.relationshipId, importedOverChild2.relationshipId];
    const ended = await t.db
      .selectFrom('relationships')
      .select(['id', 'status', 'revision', 'ended_reason'])
      .where('id', 'in', endedIds)
      .execute();
    expect(ended.map((r) => ({ ...r })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        {
          id: duplicateOverChild1.relationshipId,
          status: 'ended',
          revision: 2,
          ended_reason: expect.stringMatching(/^merge: consolidated into relationship /),
        },
        {
          id: importedOverChild2.relationshipId,
          status: 'ended',
          revision: 2,
          ended_reason: 'merge: unverified import authority is not transferred',
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const relationshipAudits = await t.db
      .selectFrom('audit_records')
      .select([
        'target_id',
        'action',
        'before_revision',
        'after_revision',
        'operation_id',
        'details',
      ])
      .where('target_type', '=', 'relationship')
      .where('target_id', 'in', endedIds)
      .execute();
    expect(relationshipAudits).toHaveLength(2);
    for (const row of relationshipAudits) {
      expect(row).toMatchObject({
        action: 'identity.merge_persons',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: { ...mergeDetails, transition: 'end' },
      });
    }
    const revokedGrantIds = [
      duplicateOverChild1.grantIds.view as string, // equivalent already held by the survivor
      importedOverChild2.grantIds.view as string, // unverified import
    ];
    const grantAudits = await t.db
      .selectFrom('audit_records')
      .select([
        'target_id',
        'action',
        'before_revision',
        'after_revision',
        'operation_id',
        'details',
      ])
      .where('target_id', 'in', revokedGrantIds)
      .execute();
    expect(grantAudits.map((a) => a.target_id).sort()).toEqual([...revokedGrantIds].sort());
    for (const row of grantAudits) {
      expect(row).toMatchObject({
        action: 'identity.revoke_access',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: mergeDetails,
      });
    }
    const grantEvents = await t.db
      .selectFrom('outbox_events')
      .select(['aggregate_id', 'operation_id'])
      .where('event_type', '=', 'identity.access_grant_revoked')
      .where('aggregate_id', 'in', revokedGrantIds)
      .execute();
    expect(grantEvents.map((e) => e.aggregate_id).sort()).toEqual([...revokedGrantIds].sort());
    expect(grantEvents.every((e) => e.operation_id === operationId)).toBe(true);
    expect(merged.body.moved).toMatchObject({ otherCandidatesDismissed: 1 });
    const other = await t.db
      .selectFrom('duplicate_candidates')
      .select(['status', 'revision', 'decision'])
      .where('id', '=', otherCandidate.body.id)
      .executeTakeFirstOrThrow();
    expect(other).toEqual({
      status: 'dismissed',
      revision: 2,
      decision: { outcome: 'dismissed', reason: 'person_merged', mergeId: merged.body.id },
    });
    const dismissAudits = await t.db
      .selectFrom('audit_records')
      .select(['action', 'before_revision', 'after_revision', 'operation_id', 'details'])
      .where('target_id', '=', otherCandidate.body.id)
      .where('action', '=', 'identity.dismiss_duplicate')
      .execute();
    expect(dismissAudits).toEqual([
      {
        action: 'identity.dismiss_duplicate',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: mergeDetails,
      },
    ]);
    // a staff screen still holding revision 1 of that candidate is told it changed
    const staleDismiss = await t.http
      .post(`/v1/duplicate-candidates/${otherCandidate.body.id}/dismiss`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ reason: 'stale screen', expectedRevision: 1 });
    expect(staleDismiss.status).toBe(409);
    expect(staleDismiss.body.code).toBe('STALE_REVISION');
    // a merged person cannot be merged again or edited
    const again = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: survivor, reason: 'twice' });
    expect(again.status).toBe(409);
  });

  it('§4.9 / §4.4 (R4-LIFECYCLES-REVISIONS-03): every record a merge moves to the survivor bumps its revision and carries its own audit, so an edit or decision read before the merge is refused', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const supportHeader = await authHeaderForPerson(t, support.personId);
    const org = t.organizationId;
    const survivor = await createPersonFixture(t, { kind: 'adult' });
    const duplicate = await createPersonFixture(t, { kind: 'adult' });
    // One carer looks after both records: `view` over the duplicate, which a review about the
    // duplicate shows, and `receive_messages` over the survivor, which it never shows. The merge
    // consolidates the carer's relationships, so both grants are then over the survivor.
    const survivorCarer = await createPersonFixture(t, { kind: 'adult' });
    const overSurvivor = await createRelationshipFixture(t, {
      actorPersonId: survivorCarer,
      subjectPersonId: survivor,
      kind: 'caregiver',
      permissions: ['receive_messages'],
    });
    const carerOverDuplicate = await createRelationshipFixture(t, {
      actorPersonId: survivorCarer,
      subjectPersonId: duplicate,
      kind: 'caregiver',
      permissions: ['view'],
    });
    // what moves: a login, a staff membership, a caregiver relationship with its grant, a review
    const login = await createAccountFixture(t, { personId: duplicate });
    const coach = await createStaffMemberFixture(t, { personId: duplicate, roles: ['coach'] });
    const duplicateCarer = await createPersonFixture(t, { kind: 'adult' });
    const overDuplicate = await createRelationshipFixture(t, {
      actorPersonId: duplicateCarer,
      subjectPersonId: duplicate,
      kind: 'caregiver',
      permissions: ['receive_messages'],
    });
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: duplicate, reason: 'disputed caregiver access' });
    expect(opened.status).toBe(201);
    const reviewId = opened.body.id as string;
    // the revisions a staff screen holds before the merge
    expect(opened.body.revision).toBe(1);
    const membershipBefore = await t.db
      .selectFrom('staff_memberships')
      .select('revision')
      .where('id', '=', coach.membershipId)
      .executeTakeFirstOrThrow();
    expect(membershipBefore.revision).toBe(1);

    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: survivor, personBId: duplicate, reasons: ['same person'] });
    const merged = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: survivor, reason: 'verified at the desk' });
    expect(merged.status, JSON.stringify(merged.body)).toBe(201);
    expect(merged.body.moved).toMatchObject({
      accountsMoved: 1,
      staffMembershipsMoved: 1,
      accessReviewsMoved: 1,
      relationshipsMoved: 1,
      relationshipsConsolidated: 1,
      grantsMoved: 2,
    });
    const operationId = merged.body.operationId as string;
    const moveDetails = {
      via: 'merge',
      operation: 'move',
      mergeId: merged.body.id,
      survivorPersonId: survivor,
      mergedPersonId: duplicate,
    };

    // each moved record: new holder, revision bumped, its own audit tied to the merge
    const grantId = overDuplicate.grantIds.receive_messages as string;
    const rows = {
      account: await t.db
        .selectFrom('accounts')
        .select(['person_id', 'revision', 'status'])
        .where('id', '=', login.id)
        .executeTakeFirstOrThrow(),
      membership: await t.db
        .selectFrom('staff_memberships')
        .select(['person_id', 'revision'])
        .where('id', '=', coach.membershipId)
        .executeTakeFirstOrThrow(),
      review: await t.db
        .selectFrom('access_reviews')
        .select(['subject_person_id', 'revision', 'status'])
        .where('id', '=', reviewId)
        .executeTakeFirstOrThrow(),
      relationship: await t.db
        .selectFrom('relationships')
        .select(['subject_person_id', 'revision'])
        .where('id', '=', overDuplicate.relationshipId)
        .executeTakeFirstOrThrow(),
      grant: await t.db
        .selectFrom('access_grants')
        .select(['subject_person_id', 'revision'])
        .where('id', '=', grantId)
        .executeTakeFirstOrThrow(),
    };
    expect(rows).toEqual({
      account: { person_id: survivor, revision: 2, status: 'active' },
      membership: { person_id: survivor, revision: 2 },
      review: { subject_person_id: survivor, revision: 2, status: 'open' },
      relationship: { subject_person_id: survivor, revision: 2 },
      grant: { subject_person_id: survivor, revision: 2 },
    });
    const audits = await t.db
      .selectFrom('audit_records')
      .select([
        'target_type',
        'target_id',
        'action',
        'before_revision',
        'after_revision',
        'operation_id',
        'details',
      ])
      .where('target_id', 'in', [
        login.id,
        coach.membershipId,
        reviewId,
        overDuplicate.relationshipId,
        grantId,
      ])
      .where('action', '=', 'identity.merge_persons')
      .orderBy('target_type')
      .execute();
    expect(audits).toEqual([
      {
        target_type: 'access_grant',
        target_id: grantId,
        action: 'identity.merge_persons',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: {
          ...moveDetails,
          permission: 'receive_messages',
          from: {
            relationshipId: overDuplicate.relationshipId,
            actorPersonId: duplicateCarer,
            subjectPersonId: duplicate,
          },
          to: {
            relationshipId: overDuplicate.relationshipId,
            actorPersonId: duplicateCarer,
            subjectPersonId: survivor,
          },
        },
      },
      {
        target_type: 'access_review',
        target_id: reviewId,
        action: 'identity.merge_persons',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: {
          ...moveDetails,
          status: 'open',
          from: { subjectPersonId: duplicate },
          to: { subjectPersonId: survivor },
        },
      },
      {
        // §4.4, §4.14: the login now resolves to another person record; its own history says so
        target_type: 'account',
        target_id: login.id,
        action: 'identity.merge_persons',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: {
          ...moveDetails,
          from: { personId: duplicate },
          to: { personId: survivor },
        },
      },
      {
        target_type: 'relationship',
        target_id: overDuplicate.relationshipId,
        action: 'identity.merge_persons',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: {
          ...moveDetails,
          kind: 'caregiver',
          source: 'staff',
          from: { actorPersonId: duplicateCarer, subjectPersonId: duplicate },
          to: { actorPersonId: duplicateCarer, subjectPersonId: survivor },
        },
      },
      {
        target_type: 'staff_membership',
        target_id: coach.membershipId,
        action: 'identity.merge_persons',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: {
          ...moveDetails,
          roles: ['coach'],
          facilityIds: [],
          from: { personId: duplicate },
          to: { personId: survivor },
        },
      },
    ]);
    const membershipEvents = await t.db
      .selectFrom('outbox_events')
      .select(['payload', 'operation_id'])
      .where('event_type', '=', 'identity.staff_membership_changed')
      .where('aggregate_id', '=', coach.membershipId)
      .execute();
    expect(membershipEvents).toEqual([
      {
        payload: {
          membershipId: coach.membershipId,
          personId: survivor,
          status: 'active',
          roles: ['coach'],
        },
        operation_id: operationId,
      },
    ]);

    // a staff screen still holding the pre-merge revision is told the record changed
    const stalePatch = await t.http
      .patch(`/v1/staff-memberships/${coach.membershipId}`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ roles: ['coach', 'official'], expectedRevision: 1 });
    expect(stalePatch.status).toBe(409);
    expect(stalePatch.body.code).toBe('STALE_REVISION');
    const staleEnd = await t.http
      .post(`/v1/staff-memberships/${coach.membershipId}/end`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ reason: 'stale screen', expectedRevision: 1 });
    expect(staleEnd.status).toBe(409);
    expect(staleEnd.body.code).toBe('STALE_REVISION');
    // The reviewer read the review (about the duplicate) before the merge and restricts the
    // carer's access to it. Decided on the moved review, that restrict would select every grant
    // the carer holds over the survivor, including `receive_messages`, which the reviewer never
    // saw: refused, and nothing is restricted or recorded.
    const staleRestrict = await t.http
      .post(`/v1/access-reviews/${reviewId}/decisions`)
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send({
        kind: 'restrict',
        actorPersonId: survivorCarer,
        note: 'pending the hearing',
        expectedRevision: 1,
      });
    expect(staleRestrict.status, JSON.stringify(staleRestrict.body)).toBe(409);
    expect(staleRestrict.body.code).toBe('STALE_REVISION');
    expect(await authority.hasPermission(org, survivorCarer, survivor, 'receive_messages')).toBe(
      true,
    );
    expect(await authority.hasPermission(org, survivorCarer, survivor, 'view')).toBe(true);
    const carerGrants = await t.db
      .selectFrom('access_grants')
      .select(['id', 'subject_person_id', 'suspended_by_review_id', 'revision'])
      .where('id', 'in', [
        overSurvivor.grantIds.receive_messages as string,
        carerOverDuplicate.grantIds.view as string,
      ])
      .orderBy('id')
      .execute();
    expect(carerGrants).toEqual(
      [
        {
          id: overSurvivor.grantIds.receive_messages as string,
          subject_person_id: survivor,
          suspended_by_review_id: null,
          revision: 1,
        },
        {
          id: carerOverDuplicate.grantIds.view as string,
          subject_person_id: survivor,
          suspended_by_review_id: null,
          revision: 2,
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(
      await t.db
        .selectFrom('access_review_decisions')
        .select('id')
        .where('review_id', '=', reviewId)
        .execute(),
    ).toEqual([]);
    // with the current revision the edit goes through
    const fresh = await t.http
      .patch(`/v1/staff-memberships/${coach.membershipId}`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ roles: ['coach', 'official'], expectedRevision: 2 });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body).toMatchObject({ personId: survivor, revision: 3 });
  });

  /** Staff for the access-review cases below: a merging administrator and a review decider. */
  async function reviewStaff() {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const adminHeader = await authHeaderForPerson(t, admin.personId);
    const supportHeader = await authHeaderForPerson(t, support.personId);
    const decide = (reviewId: string, body: Record<string, unknown>) =>
      t.http
        .post(`/v1/access-reviews/${reviewId}/decisions`)
        .set(supportHeader)
        .set('Idempotency-Key', key())
        .send(body);
    const mergeInto = async (survivor: string, duplicate: string) => {
      const flagged = await t.http
        .post('/v1/duplicate-candidates')
        .set(adminHeader)
        .set('Idempotency-Key', key())
        .send({ personAId: survivor, personBId: duplicate, reasons: ['same person'] });
      expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
      const merged = await t.http
        .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
        .set(adminHeader)
        .set('Idempotency-Key', key())
        .send({ survivorPersonId: survivor, reason: 'verified at the desk' });
      expect(merged.status, JSON.stringify(merged.body)).toBe(201);
      return merged.body as { id: string; operationId: string; moved: Record<string, unknown> };
    };
    return { supportHeader, decide, mergeInto };
  }

  it('SPK-IAM-005 / SPK-IAM-007 (R4-LIFECYCLES-REVISIONS-03): a restrict or lift naming a merged actor on a review about someone else is refused naming the survivor; naming the survivor reaches the grants the merge moved', async () => {
    const { supportHeader, decide, mergeInto } = await reviewStaff();
    const org = t.organizationId;
    const survivor = await createPersonFixture(t, { kind: 'adult' });
    const duplicate = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    // the guardian, entered twice, may collect (pick up) the child through the duplicate record
    const guardianship = await createRelationshipFixture(t, {
      actorPersonId: duplicate,
      subjectPersonId: child,
      permissions: ['collect', 'view'],
    });
    const collectGrant = guardianship.grantIds.collect as string;
    const viewGrant = guardianship.grantIds.view as string;
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: child, reason: 'custody dispute' });
    expect(opened.status).toBe(201);
    const reviewId = opened.body.id as string;
    // before the merge the reviewer restricts pickup through the duplicate record
    const restricted = await decide(reviewId, {
      kind: 'restrict',
      actorPersonId: duplicate,
      grantIds: [collectGrant],
      expectedRevision: 1,
    });
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(201);
    const merged = await mergeInto(survivor, duplicate);
    expect(merged.moved).toMatchObject({ grantsMoved: 2, accessReviewsMoved: 0 });
    // the restriction stays on the grant, which the survivor now holds; the review (about the
    // child) is not moved and keeps its revision
    expect(await authority.hasPermission(org, survivor, child, 'collect')).toBe(false);
    expect(await authority.hasPermission(org, survivor, child, 'view')).toBe(true);

    // A screen read before the merge still names the duplicate. Its grants are now the
    // survivor's, so the decision would match none of them and still be recorded as made:
    // refused, naming the survivor, and nothing is recorded.
    for (const kind of ['restrict', 'lift'] as const) {
      const stale = await decide(reviewId, { kind, actorPersonId: duplicate, expectedRevision: 2 });
      expect(stale.status, JSON.stringify(stale.body)).toBe(400);
      expect(stale.body.code).toBe('VALIDATION_FAILED');
      expect(stale.body.details).toEqual({
        field: 'actorPersonId',
        personId: duplicate,
        mergedIntoPersonId: survivor,
      });
    }
    const review = await t.db
      .selectFrom('access_reviews')
      .select('revision')
      .where('id', '=', reviewId)
      .executeTakeFirstOrThrow();
    expect(review.revision).toBe(2);
    expect(await authority.hasPermission(org, survivor, child, 'collect')).toBe(false);

    // naming the survivor reaches the moved grants: restrict adds `view`, lift ends both
    const restrictSurvivor = await decide(reviewId, {
      kind: 'restrict',
      actorPersonId: survivor,
      expectedRevision: 2,
    });
    expect(restrictSurvivor.status, JSON.stringify(restrictSurvivor.body)).toBe(201);
    expect(restrictSurvivor.body.decisions.at(-1).affectedGrantIds).toEqual([viewGrant]);
    expect(await authority.hasPermission(org, survivor, child, 'view')).toBe(false);
    const lifted = await decide(reviewId, {
      kind: 'lift',
      actorPersonId: survivor,
      expectedRevision: 3,
    });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(201);
    expect([...lifted.body.decisions.at(-1).affectedGrantIds].sort()).toEqual(
      [collectGrant, viewGrant].sort(),
    );
    expect(await authority.hasPermission(org, survivor, child, 'collect')).toBe(true);
    expect(await authority.hasPermission(org, survivor, child, 'view')).toBe(true);
  });

  it('SPK-IAM-005 / SPK-IAM-007: an access review cannot be opened about a merged person record; the refusal names the survivor and nothing is recorded', async () => {
    const { supportHeader, mergeInto } = await reviewStaff();
    const survivor = await createPersonFixture(t, { kind: 'adult' });
    const duplicate = await createPersonFixture(t, { kind: 'adult' });
    await mergeInto(survivor, duplicate);
    // a staff screen opened before the merge still shows the duplicate
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: duplicate, reason: 'stale screen' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(400);
    expect(opened.body.code).toBe('VALIDATION_FAILED');
    expect(opened.body.details).toEqual({
      field: 'subjectPersonId',
      personId: duplicate,
      mergedIntoPersonId: survivor,
    });
    const reviews = await t.db
      .selectFrom('access_reviews')
      .select('id')
      .where('subject_person_id', '=', duplicate)
      .execute();
    expect(reviews).toEqual([]);
    // §4.10: a caller without the action learns nothing about the merge (reads as not found)
    const outsider = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: outsider });
    const denied = await t.http
      .post('/v1/access-reviews')
      .set(await authHeaderForPerson(t, outsider))
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: duplicate, reason: 'probe' });
    expect(denied.status).toBe(404);
    expect(denied.body.details?.mergedIntoPersonId).toBeUndefined();
  });

  it('SPK-IAM-005 / SPK-IAM-007 (R4-LIFECYCLES-REVISIONS-03): a closed review whose restriction is still in force moves with the restricted grant, so it is listed and lifted by actor about the survivor; a closed review that restricts nothing stays with the merged record', async () => {
    const { supportHeader, decide, mergeInto } = await reviewStaff();
    const org = t.organizationId;
    const survivor = await createPersonFixture(t, { kind: 'adult' });
    const duplicate = await createPersonFixture(t, { kind: 'adult' });
    const carer = await createPersonFixture(t, { kind: 'adult' });
    const overDuplicate = await createRelationshipFixture(t, {
      actorPersonId: carer,
      subjectPersonId: duplicate,
      kind: 'caregiver',
      permissions: ['receive_messages'],
    });
    const grantId = overDuplicate.grantIds.receive_messages as string;
    const open = async (reason: string) => {
      const opened = await t.http
        .post('/v1/access-reviews')
        .set(supportHeader)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: duplicate, reason });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      return opened.body.id as string;
    };
    // review 1: restricts the carer, is decided and closed; closing never lifts the restriction
    const restricting = await open('disputed caregiver access');
    expect(
      (await decide(restricting, { kind: 'restrict', actorPersonId: carer, expectedRevision: 1 }))
        .status,
    ).toBe(201);
    expect((await decide(restricting, { kind: 'decide', expectedRevision: 2 })).status).toBe(201);
    const closed = await decide(restricting, { kind: 'close', expectedRevision: 3 });
    expect(closed.body).toMatchObject({ status: 'closed', revision: 4 });
    // review 2: closed without restricting anything (history)
    const historical = await open('resolved at the desk');
    expect((await decide(historical, { kind: 'decide', expectedRevision: 1 })).status).toBe(201);
    expect((await decide(historical, { kind: 'close', expectedRevision: 2 })).status).toBe(201);
    expect(await authority.hasPermission(org, carer, duplicate, 'receive_messages')).toBe(false);

    const merged = await mergeInto(survivor, duplicate);
    expect(merged.moved).toMatchObject({ grantsMoved: 1, accessReviewsMoved: 1 });
    // the restriction followed the grant to the survivor, and so did the review that holds it
    expect(await authority.hasPermission(org, carer, survivor, 'receive_messages')).toBe(false);
    const rows = await t.db
      .selectFrom('access_reviews')
      .select(['id', 'subject_person_id', 'status', 'revision'])
      .where('id', 'in', [restricting, historical])
      .execute();
    expect(Object.fromEntries(rows.map((r) => [r.id, { ...r, id: undefined }]))).toEqual({
      [restricting]: { id: undefined, subject_person_id: survivor, status: 'closed', revision: 5 },
      [historical]: { id: undefined, subject_person_id: duplicate, status: 'closed', revision: 3 },
    });
    const moveAudit = await t.db
      .selectFrom('audit_records')
      .select(['before_revision', 'after_revision', 'operation_id', 'details'])
      .where('target_id', '=', restricting)
      .where('action', '=', 'identity.merge_persons')
      .executeTakeFirstOrThrow();
    expect(moveAudit).toMatchObject({
      before_revision: 4,
      after_revision: 5,
      operation_id: merged.operationId,
      details: {
        operation: 'move',
        status: 'closed',
        from: { subjectPersonId: duplicate },
        to: { subjectPersonId: survivor },
      },
    });
    // the survivor's closed reviews list the one restricting the survivor's grant
    const listed = await t.http
      .get(`/v1/access-reviews?subjectPersonId=${survivor}&status=closed`)
      .set(supportHeader);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((r: { id: string }) => r.id)).toEqual([restricting]);
    expect(listed.body.items[0].restrictedGrantCount).toBe(1);
    // a lift read before the merge is told the review changed; the current one restores access
    const stale = await decide(restricting, {
      kind: 'lift',
      actorPersonId: carer,
      expectedRevision: 4,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const lifted = await decide(restricting, {
      kind: 'lift',
      actorPersonId: carer,
      expectedRevision: 5,
    });
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(201);
    expect(lifted.body.decisions.at(-1).affectedGrantIds).toEqual([grantId]);
    expect(await authority.hasPermission(org, carer, survivor, 'receive_messages')).toBe(true);
  });

  /**
   * A customer who knows a child's name and date of birth creates a matching child record and
   * gives themselves guardian grants over it (self-service, unverified). Detection flags the pair
   * on its own; a routine merge must not hand those grants to the real child.
   */
  async function selfServiceLookalike(givenName: string, dateOfBirth: string) {
    const realParent = await createPersonFixture(t, { kind: 'adult' });
    const realChild = await createPersonFixture(t, {
      kind: 'child',
      givenName,
      familyName: 'Real',
      dateOfBirth,
    });
    const parentGrants = await createRelationshipFixture(t, {
      actorPersonId: realParent,
      subjectPersonId: realChild,
      permissions: ['view', 'collect'],
    });
    const mallory = await createPersonFixture(t, { kind: 'adult' });
    const malloryAccount = await createAccountFixture(t, { personId: mallory });
    const mh = await authHeaderForAccount(t, malloryAccount.id);
    const fake = await t.http
      .post('/v1/people')
      .set(mh)
      .set('Idempotency-Key', key())
      .send({ kind: 'child', givenName, familyName: 'Real', dateOfBirth, contactPoints: [] });
    expect(fake.status).toBe(201);
    const rel = await t.http
      .post('/v1/relationships')
      .set(mh)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: mallory,
        subjectPersonId: fake.body.id,
        kind: 'guardian',
        permissions: ['view', 'register', 'pay', 'collect'],
      });
    expect(rel.status).toBe(201);
    expect(rel.body.relationship.source).toBe('self_service');
    const candidate = await t.db
      .selectFrom('duplicate_candidates')
      .select(['id', 'reasons'])
      .where('organization_id', '=', t.organizationId)
      .where('status', '=', 'open')
      .where((eb) =>
        eb.or([eb('person_a_id', '=', fake.body.id), eb('person_b_id', '=', fake.body.id)]),
      )
      .executeTakeFirstOrThrow();
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    return {
      realParent,
      realChild,
      parentCollectGrant: parentGrants.grantIds.collect as string,
      mallory,
      mh,
      fakeId: fake.body.id as string,
      candidateId: candidate.id,
      adminHeader: await authHeaderForPerson(t, admin.personId),
    };
  }

  it('SPK-IAM-007: a self-service guardian of the merged duplicate gains nothing over the survivor', async () => {
    const s = await selfServiceLookalike('Ava', '2016-05-05');
    const org = t.organizationId;
    expect((await t.http.get(`/v1/people/${s.realChild}`).set(s.mh)).status).toBe(404);
    const merged = await t.http
      .post(`/v1/duplicate-candidates/${s.candidateId}/merge`)
      .set(s.adminHeader)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: s.realChild, reason: 'same child' });
    expect(merged.status).toBe(201);
    expect(merged.body.moved).toMatchObject({
      grantsMoved: 0,
      relationshipsMoved: 0,
      unverifiedRelationshipsSkipped: 1,
      unverifiedGrantsSkipped: 4,
    });
    for (const permission of ['view', 'register', 'pay', 'collect'] as const) {
      expect(await authority.hasPermission(org, s.mallory, s.realChild, permission)).toBe(false);
    }
    expect((await t.http.get(`/v1/people/${s.realChild}`).set(s.mh)).status).toBe(404);
    // the verified guardian keeps their authority
    expect(await authority.hasPermission(org, s.realParent, s.realChild, 'collect')).toBe(true);
    // the self-service grants are revoked history, not moved rows
    const malloryGrants = await t.db
      .selectFrom('access_grants')
      .select(['subject_person_id', 'revoked_at'])
      .where('actor_person_id', '=', s.mallory)
      .execute();
    expect(malloryGrants).toHaveLength(4);
    expect(malloryGrants.every((g) => g.subject_person_id === s.fakeId && g.revoked_at)).toBe(true);
  });

  it("SPK-IAM-007: when the self-service record survives, its creator's unverified authority ends and the creator privilege is cleared", async () => {
    const s = await selfServiceLookalike('Ben', '2015-03-03');
    const org = t.organizationId;
    const merged = await t.http
      .post(`/v1/duplicate-candidates/${s.candidateId}/merge`)
      .set(s.adminHeader)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: s.fakeId, reason: 'same child' });
    expect(merged.status).toBe(201);
    expect(merged.body.moved).toMatchObject({
      survivorUnverifiedRelationshipsEnded: 1,
      survivorCreatorPrivilegeCleared: true,
      unverifiedGrantsSkipped: 4,
    });
    expect(await authority.hasPermission(org, s.mallory, s.fakeId, 'collect')).toBe(false);
    expect(await authority.hasPermission(org, s.mallory, s.fakeId, 'view')).toBe(false);
    // the real parent's verified authority followed the child onto the survivor
    expect(await authority.hasPermission(org, s.realParent, s.fakeId, 'collect')).toBe(true);
    const survivorRow = await t.db
      .selectFrom('persons')
      .select(['created_by_person_id', 'source'])
      .where('id', '=', s.fakeId)
      .executeTakeFirstOrThrow();
    expect(survivorRow).toEqual({ created_by_person_id: null, source: 'self_service' });
    // the former creator can neither strip the real parent's grant nor re-create guardianship
    const parentGrant = await t.db
      .selectFrom('access_grants')
      .select('revision')
      .where('id', '=', s.parentCollectGrant)
      .executeTakeFirstOrThrow();
    const revoke = await t.http
      .post(`/v1/access-grants/${s.parentCollectGrant}/revoke`)
      .set(s.mh)
      .set('Idempotency-Key', key())
      .send({ reason: 'mine now', expectedRevision: parentGrant.revision });
    expect(revoke.status).toBe(404);
    expect(await authority.hasPermission(org, s.realParent, s.fakeId, 'collect')).toBe(true);
    const again = await t.http
      .post('/v1/relationships')
      .set(s.mh)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: s.mallory,
        subjectPersonId: s.fakeId,
        kind: 'guardian',
        permissions: ['view', 'collect'],
      });
    expect(again.status).toBe(404);
    expect(await authority.hasPermission(org, s.mallory, s.fakeId, 'collect')).toBe(false);
  });

  it('SPK-IAM-007: a merge never makes a child the survivor of an adult (no account, authority or staff role moves onto a child)', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const org = t.organizationId;
    const adult = await createPersonFixture(t, { kind: 'adult', dateOfBirth: '1985-01-01' });
    const account = await createAccountFixture(t, { personId: adult });
    const staff = await createStaffMemberFixture(t, { personId: adult, roles: ['front_desk'] });
    const otherChild = await createPersonFixture(t, { kind: 'child' });
    const grants = await createRelationshipFixture(t, {
      actorPersonId: adult,
      subjectPersonId: otherChild,
    });
    const child = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2016-01-01' });
    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: adult, personBId: child, reasons: ['same name'] });
    expect(flagged.status).toBe(201);
    const refused = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: child, reason: 'keep the older record' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    // nothing changed
    const candidate = await t.db
      .selectFrom('duplicate_candidates')
      .select(['status', 'revision'])
      .where('id', '=', flagged.body.id)
      .executeTakeFirstOrThrow();
    expect(candidate).toEqual({ status: 'open', revision: 1 });
    const persons = await t.db
      .selectFrom('persons')
      .select(['id', 'status'])
      .where('id', 'in', [adult, child])
      .execute();
    expect(persons.every((p) => p.status === 'active')).toBe(true);
    const accountRow = await t.db
      .selectFrom('accounts')
      .select('person_id')
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(accountRow.person_id).toBe(adult);
    const membership = await t.db
      .selectFrom('staff_memberships')
      .select('person_id')
      .where('id', '=', staff.membershipId)
      .executeTakeFirstOrThrow();
    expect(membership.person_id).toBe(adult);
    const collect = await t.db
      .selectFrom('access_grants')
      .select(['actor_person_id', 'revoked_at'])
      .where('id', '=', grants.grantIds.collect as string)
      .executeTakeFirstOrThrow();
    expect(collect).toEqual({ actor_person_id: adult, revoked_at: null });
    expect(await authority.hasPermission(org, child, otherChild, 'collect')).toBe(false);
    // the adult record may survive
    const merged = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: adult, reason: 'grown-up child record' });
    expect(merged.status).toBe(201);
  });

  it('SPK-IAM-007 / §4.9: merge moves the account when the survivor has none, and revokes pending invitations and claims with a revision bump, their own audit and revoke events', async () => {
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
      .send({
        kind: 'guardian',
        requestedPermissions: ['view'],
        recipientContact: { kind: 'email', value: 'merge-guardian@example.test' },
      });
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
    // §4.6, §4.9, §4.12: the same pending → revoked transition as the revoke commands — revision
    // bumped, the record's own audit and revoke event, tied to the merge's operation.
    expect(invitation.body.revision).toBe(1);
    expect(claim.body.revision).toBe(1);
    const inv = await t.db
      .selectFrom('invitations')
      .select(['status', 'revision', 'revocation_reason'])
      .where('id', '=', invitation.body.id)
      .executeTakeFirstOrThrow();
    expect(inv).toEqual({
      status: 'revoked',
      revision: 2,
      revocation_reason: 'merge: pending invitation not transferred',
    });
    const cl = await t.db
      .selectFrom('claims')
      .select(['status', 'revision', 'revocation_reason'])
      .where('id', '=', claim.body.id)
      .executeTakeFirstOrThrow();
    expect(cl).toEqual({
      status: 'revoked',
      revision: 2,
      revocation_reason: 'merge: pending claim not transferred',
    });
    const operationId = merged.body.operationId as string;
    const revokedEvents = await t.db
      .selectFrom('outbox_events')
      .select(['aggregate_id', 'event_type', 'payload', 'operation_id'])
      .where('aggregate_id', 'in', [invitation.body.id, claim.body.id])
      .where('event_type', 'in', ['identity.invitation_revoked', 'identity.claim_revoked'])
      .orderBy('event_type')
      .execute();
    expect(revokedEvents).toEqual([
      {
        aggregate_id: claim.body.id,
        event_type: 'identity.claim_revoked',
        payload: {
          claimId: claim.body.id,
          subjectPersonId: duplicate,
          reason: 'merge: pending claim not transferred',
        },
        operation_id: operationId,
      },
      {
        aggregate_id: invitation.body.id,
        event_type: 'identity.invitation_revoked',
        payload: {
          invitationId: invitation.body.id,
          reason: 'merge: pending invitation not transferred',
        },
        operation_id: operationId,
      },
    ]);
    const revokedAudits = await t.db
      .selectFrom('audit_records')
      .select([
        'target_id',
        'action',
        'before_revision',
        'after_revision',
        'operation_id',
        'details',
      ])
      .where('target_id', 'in', [invitation.body.id, claim.body.id])
      .where('action', 'in', ['identity.revoke_invitation', 'identity.revoke_claim'])
      .orderBy('action')
      .execute();
    const mergeDetails = {
      via: 'merge',
      mergeId: merged.body.id,
      survivorPersonId: survivor,
      mergedPersonId: duplicate,
    };
    expect(revokedAudits).toEqual([
      {
        target_id: claim.body.id,
        action: 'identity.revoke_claim',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: { ...mergeDetails, subjectPersonId: duplicate, kind: 'guardian' },
      },
      {
        target_id: invitation.body.id,
        action: 'identity.revoke_invitation',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
        details: mergeDetails,
      },
    ]);
    // a client still holding revision 1 is told the record changed
    const staleRevoke = await t.http
      .post(`/v1/invitations/${invitation.body.id}/revoke`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ reason: 'stale screen', expectedRevision: 1 });
    expect(staleRevoke.status).toBe(409);
    expect(staleRevoke.body.code).toBe('STALE_REVISION');
    const survivorIsNotCandidate = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId: newId(), reason: 'x' });
    expect(survivorIsNotCandidate.status).toBe(409);
  });
});
