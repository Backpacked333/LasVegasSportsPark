import { newId } from '@sportspark/contracts';
import {
  createTestDatabase,
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  seedOrganization,
  type Db,
  type TestDatabase,
} from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, loadConfig, LocalJwtIdentityProvider } from '../../../kernel';
import { TEST_CONFIG_ENV } from '../../../testing/test-app';
import {
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  type IdentityFixtureContext,
} from '../testing/identity-fixtures';

/**
 * Integrity invariants are enforced by the database, not only by services (§4.7). Each test
 * inserts the violating row directly through Kysely and expects the constraint to reject it.
 */
describe('identity schema invariants (migrations 0100-0102)', () => {
  let t: TestDatabase;
  let db: Db;
  let ctx: IdentityFixtureContext;
  let otherOrg: { organizationId: string; facilityId: string };
  const actor = json({ kind: 'system', actorLabel: 'schema-test' });

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
    const seeded = await seedOrganization(db);
    otherOrg = await seedOrganization(db);
    const config = loadConfig(TEST_CONFIG_ENV);
    ctx = {
      db,
      clock: new FixedClock('2026-10-23T12:00:00Z'),
      config,
      identityProvider: new LocalJwtIdentityProvider(config),
      organizationId: seeded.organizationId,
    };
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-IAM-001 / §4.3: a contact point cannot reference a person of another organization', async () => {
    const foreign = await createPersonFixture(ctx, {
      kind: 'adult',
      organizationId: otherOrg.organizationId,
    });
    await expect(
      db
        .insertInto('contact_points')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          person_id: foreign,
          kind: 'email',
          value: 'cross@example.test',
          verified_at: null,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('SPK-IAM-002: at most one active account per person, and (issuer, subject) is unique', async () => {
    const person = await createPersonFixture(ctx, { kind: 'adult' });
    const first = await createAccountFixture(ctx, { personId: person });
    await expect(createAccountFixture(ctx, { personId: person })).rejects.toSatisfy(
      isUniqueViolation,
    );
    // a disabled second account is history, not a second identity
    await createAccountFixture(ctx, { personId: person, status: 'disabled' });
    await expect(
      createAccountFixture(ctx, { personId: null, issuer: first.issuer, subject: first.subject }),
    ).rejects.toSatisfy(isUniqueViolation);
  });

  it('SPK-IAM-003: a grant must belong to a relationship between the same two people (composite FK)', async () => {
    const people = await createOrganizationPeople(ctx);
    const stranger = await createPersonFixture(ctx, { kind: 'adult' });
    await expect(
      db
        .insertInto('access_grants')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          relationship_id: people.relationshipId,
          actor_person_id: stranger, // not the relationship's actor
          subject_person_id: people.child.personId,
          permission: 'view',
          source: 'staff',
          granted_by: actor,
          effective_from: ctx.clock.now(),
          effective_to: null,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
          suspended_at: null,
          suspended_by_review_id: null,
          suspension_reason: null,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('SPK-IAM-003: overlapping unrevoked grants for one permission are rejected; revoked ones may repeat', async () => {
    const people = await createOrganizationPeople(ctx, { guardianPermissions: ['view'] });
    const insert = (revokedAt: Date | null) =>
      db
        .insertInto('access_grants')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          relationship_id: people.relationshipId,
          actor_person_id: people.adult.personId,
          subject_person_id: people.child.personId,
          permission: 'view',
          source: 'staff',
          granted_by: actor,
          effective_from: ctx.clock.now(),
          effective_to: null,
          revoked_at: revokedAt,
          revoked_by: revokedAt ? actor : null,
          revocation_reason: revokedAt ? 'test' : null,
          suspended_at: null,
          suspended_by_review_id: null,
          suspension_reason: null,
        })
        .execute();
    await expect(insert(null)).rejects.toSatisfy(isExclusionViolation);
    await insert(ctx.clock.now());
  });

  it('SPK-IAM-003: permission values are limited to the six action-specific permissions', async () => {
    const people = await createOrganizationPeople(ctx, { guardianPermissions: ['view'] });
    await expect(
      db
        .insertInto('access_grants')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          relationship_id: people.relationshipId,
          actor_person_id: people.adult.personId,
          subject_person_id: people.child.personId,
          permission: 'everything' as never,
          source: 'staff',
          granted_by: actor,
          effective_from: ctx.clock.now(),
          effective_to: null,
          revoked_at: null,
          revoked_by: null,
          revocation_reason: null,
          suspended_at: null,
          suspended_by_review_id: null,
          suspension_reason: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-IAM-001: a relationship cannot pair a person with themselves unless self-managed', async () => {
    const adult = await createPersonFixture(ctx, { kind: 'adult' });
    await expect(
      createRelationshipFixture(ctx, {
        actorPersonId: adult,
        subjectPersonId: adult,
        kind: 'guardian',
        permissions: [],
      }),
    ).rejects.toSatisfy(isCheckViolation);
    const child = await createPersonFixture(ctx, { kind: 'child' });
    await expect(
      createRelationshipFixture(ctx, {
        actorPersonId: adult,
        subjectPersonId: child,
        kind: 'self_managed',
        permissions: [],
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-IAM-001: one live relationship per (actor, subject, kind); cross-organization pairs are rejected', async () => {
    const people = await createOrganizationPeople(ctx, { guardianPermissions: [] });
    await expect(
      createRelationshipFixture(ctx, {
        actorPersonId: people.adult.personId,
        subjectPersonId: people.child.personId,
        permissions: [],
      }),
    ).rejects.toSatisfy(isUniqueViolation);
    const foreignChild = await createPersonFixture(ctx, {
      kind: 'child',
      organizationId: otherOrg.organizationId,
    });
    await expect(
      createRelationshipFixture(ctx, {
        actorPersonId: people.adult.personId,
        subjectPersonId: foreignChild,
        permissions: [],
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('§4.5: household membership is unique per person and household (and is just a grouping)', async () => {
    const people = await createOrganizationPeople(ctx);
    const householdId = newId();
    await db
      .insertInto('households')
      .values({
        id: householdId,
        organization_id: ctx.organizationId,
        name: 'H',
        created_by: actor,
      })
      .execute();
    const member = () =>
      db
        .insertInto('household_memberships')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          household_id: householdId,
          person_id: people.child.personId,
          label: null,
          added_by: actor,
        })
        .execute();
    await member();
    await expect(member()).rejects.toSatisfy(isUniqueViolation);
  });

  it('§2.1: staff roles must come from the StaffRole vocabulary', async () => {
    const adult = await createPersonFixture(ctx, { kind: 'adult' });
    await expect(
      db
        .insertInto('staff_memberships')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          person_id: adult,
          roles: ['overlord'],
          effective_from: ctx.clock.now(),
          effective_to: null,
          ended_at: null,
          ended_reason: null,
          created_by: actor,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-IAM-004: invitation permissions are validated and the token hash is unique', async () => {
    const people = await createOrganizationPeople(ctx);
    const row = (overrides: Record<string, unknown>) => ({
      id: newId(),
      organization_id: ctx.organizationId,
      invited_by: actor,
      invited_by_person_id: people.adult.personId,
      recipient_person_id: null,
      recipient_contact_kind: 'email' as const,
      recipient_contact_value: 'x@example.test',
      scope_type: 'person' as const,
      scope_person_id: people.child.personId,
      scope_household_id: null,
      relationship_kind: 'delegate' as const,
      requested_permissions: ['view' as const],
      token_hash: 'hash-1',
      expires_at: ctx.clock.now(),
      accepted_at: null,
      accepted_by_person_id: null,
      revoked_at: null,
      revoked_by: null,
      revocation_reason: null,
      ...overrides,
    });
    await db.insertInto('invitations').values(row({})).execute();
    await expect(db.insertInto('invitations').values(row({})).execute()).rejects.toSatisfy(
      isUniqueViolation,
    );
    await expect(
      db
        .insertInto('invitations')
        .values(row({ token_hash: 'hash-2', requested_permissions: ['admin'] }))
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('invitations')
        .values(row({ token_hash: 'hash-3', scope_person_id: null }))
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-IAM-004 / §4.3: invitation subjects are an append-only snapshot inside one organization', async () => {
    const people = await createOrganizationPeople(ctx);
    const invitationId = newId();
    await db
      .insertInto('invitations')
      .values({
        id: invitationId,
        organization_id: ctx.organizationId,
        invited_by: actor,
        invited_by_person_id: people.adult.personId,
        recipient_person_id: null,
        recipient_contact_kind: 'email',
        recipient_contact_value: 'snapshot@example.test',
        scope_type: 'person',
        scope_person_id: people.child.personId,
        scope_household_id: null,
        relationship_kind: 'delegate',
        requested_permissions: ['view'],
        token_hash: `hash-${newId()}`,
        expires_at: ctx.clock.now(),
        accepted_at: null,
        accepted_by_person_id: null,
        revoked_at: null,
        revoked_by: null,
        revocation_reason: null,
      })
      .execute();
    const subject = (organizationId: string, invitation: string, personId: string) =>
      db
        .insertInto('invitation_subjects')
        .values({ organization_id: organizationId, invitation_id: invitation, person_id: personId })
        .execute();
    await subject(ctx.organizationId, invitationId, people.child.personId);
    await expect(
      subject(ctx.organizationId, invitationId, people.child.personId),
    ).rejects.toSatisfy(isUniqueViolation);
    // another organization's person, or this invitation under another organization's id
    const foreign = await createPersonFixture(ctx, {
      kind: 'child',
      organizationId: otherOrg.organizationId,
    });
    await expect(subject(ctx.organizationId, invitationId, foreign)).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    await expect(subject(otherOrg.organizationId, invitationId, foreign)).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    // the snapshot is what the inviter authorized: it cannot be widened by editing or removed
    const other = await createPersonFixture(ctx, { kind: 'child' });
    await expect(
      db
        .updateTable('invitation_subjects')
        .set({ person_id: other })
        .where('invitation_id', '=', invitationId)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.deleteFrom('invitation_subjects').where('invitation_id', '=', invitationId).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('SPK-IAM-005: a suspension window needs a suspension and must end after it starts', async () => {
    const people = await createOrganizationPeople(ctx, { guardianPermissions: ['view'] });
    const grantId = people.guardianGrants.view as string;
    const reviewId = newId();
    await db
      .insertInto('access_reviews')
      .values({
        id: reviewId,
        organization_id: ctx.organizationId,
        subject_person_id: people.child.personId,
        opened_by: actor,
        opened_by_person_id: null,
        reason: 'dispute',
        owner_role: 'support_operator',
        owner_person_id: null,
        effective_from: ctx.clock.now(),
        effective_to: null,
        escalated_at: null,
        decided_at: null,
        closed_at: null,
        outcome: null,
      })
      .execute();
    const now = ctx.clock.now();
    await expect(
      db
        .updateTable('access_grants')
        .set({ suspended_until: new Date(now.getTime() + 3600_000) })
        .where('id', '=', grantId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .updateTable('access_grants')
        .set({
          suspended_at: now,
          suspended_by_review_id: reviewId,
          suspended_until: new Date(now.getTime() - 1),
        })
        .where('id', '=', grantId)
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await db
      .updateTable('access_grants')
      .set({
        suspended_at: now,
        suspended_by_review_id: reviewId,
        suspended_until: new Date(now.getTime() + 3600_000),
      })
      .where('id', '=', grantId)
      .execute();
  });

  it('SPK-IAM-007: person merges are append-only and a person can be merged at most once', async () => {
    const a = await createPersonFixture(ctx, { kind: 'adult' });
    const b = await createPersonFixture(ctx, { kind: 'adult' });
    const c = await createPersonFixture(ctx, { kind: 'adult' });
    const id = newId();
    const merge = (survivor: string) =>
      db
        .insertInto('person_merges')
        .values({
          id: newId(),
          organization_id: ctx.organizationId,
          survivor_person_id: survivor,
          merged_person_id: b,
          candidate_id: null,
          moved: json({}),
          actor,
          reason: null,
          operation_id: null,
        })
        .execute();
    await db
      .insertInto('person_merges')
      .values({
        id,
        organization_id: ctx.organizationId,
        survivor_person_id: a,
        merged_person_id: b,
        candidate_id: null,
        moved: json({}),
        actor,
        reason: null,
        operation_id: null,
      })
      .execute();
    await expect(merge(c)).rejects.toSatisfy(isUniqueViolation);
    await expect(
      db.updateTable('person_merges').set({ reason: 'tampered' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('person_merges').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
  });

  it('SPK-IAM-005: access review decisions are append-only history', async () => {
    const people = await createOrganizationPeople(ctx);
    const reviewId = newId();
    await db
      .insertInto('access_reviews')
      .values({
        id: reviewId,
        organization_id: ctx.organizationId,
        subject_person_id: people.child.personId,
        opened_by: actor,
        opened_by_person_id: null,
        reason: 'dispute',
        owner_role: 'support_operator',
        owner_person_id: null,
        effective_from: ctx.clock.now(),
        effective_to: null,
        escalated_at: null,
        decided_at: null,
        closed_at: null,
        outcome: null,
      })
      .execute();
    const decisionId = newId();
    await db
      .insertInto('access_review_decisions')
      .values({
        id: decisionId,
        organization_id: ctx.organizationId,
        review_id: reviewId,
        sequence: 1,
        kind: 'note',
        decided_by: actor,
        note: 'first',
        effective_from: null,
        effective_to: null,
      })
      .execute();
    await expect(
      db
        .updateTable('access_review_decisions')
        .set({ note: 'edited' })
        .where('id', '=', decisionId)
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('SPK-IAM-007: duplicate candidates are canonical pairs and cannot be flagged twice', async () => {
    const a = await createPersonFixture(ctx, { kind: 'adult' });
    const b = await createPersonFixture(ctx, { kind: 'adult' });
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const row = (pa: string, pb: string) => ({
      id: newId(),
      organization_id: ctx.organizationId,
      person_a_id: pa,
      person_b_id: pb,
      reasons: ['test'],
      score: 50,
      flagged_by: actor,
      decision: null,
      decided_by: null,
      decided_at: null,
    });
    await expect(
      db.insertInto('duplicate_candidates').values(row(hi, lo)).execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await db.insertInto('duplicate_candidates').values(row(lo, hi)).execute();
    await expect(
      db.insertInto('duplicate_candidates').values(row(lo, hi)).execute(),
    ).rejects.toSatisfy(isUniqueViolation);
  });
});
