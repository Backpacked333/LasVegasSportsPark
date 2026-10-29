import {
  importActorLabel,
  newId,
  systemPrincipal,
  type CreatePersonInput,
} from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationService, UnitOfWork } from '../../../kernel';
import { staffPrincipal } from '../../../testing/principals';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityActions } from '../identity.actions';
import { IdentityModule } from '../identity.module';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../identity.ports';
import { AccessReviewsService } from '../services/access-reviews.service';
import { PeopleService } from '../services/people.service';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

/** Marks `mergedId` as merged into `survivorId` the way DuplicatesService.merge leaves the row. */
async function markMerged(t: TestApp, mergedId: string, survivorId: string): Promise<void> {
  await t.db
    .updateTable('persons')
    .set({ status: 'merged', merged_into_person_id: survivorId })
    .where('id', '=', mergedId)
    .execute();
}

describe('person directory and authority lookup ports (ID-01, ID-09, IF-01, IF-09, IF-46)', () => {
  let t: TestApp;
  let directory: PersonDirectoryPort;
  let people: PeopleService;
  let authority: RelationshipAuthority;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    directory = t.app.get<PersonDirectoryPort>(PERSON_DIRECTORY_PORT);
    people = t.app.get(PeopleService);
    authority = t.app.get(RelationshipAuthority);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-IAM-007: chain A merged into B merged into C returns [C,B,A] for C, and resolveCanonicalPersonId(A) = C', async () => {
    const a = await createPersonFixture(t, { kind: 'adult' });
    const b = await createPersonFixture(t, { kind: 'adult' });
    const c = await createPersonFixture(t, { kind: 'adult' });
    const unrelated = await createPersonFixture(t, { kind: 'adult' });
    await markMerged(t, a, b);
    await markMerged(t, b, c);
    const org = t.organizationId;
    expect(await directory.personIdsResolvingTo(org, c)).toEqual([c, b, a]);
    // any id in the chain resolves to the same history, canonical first
    expect(await directory.personIdsResolvingTo(org, a)).toEqual([c, b, a]);
    expect(await directory.resolveCanonicalPersonId(org, a)).toBe(c);
    expect(await directory.personIdsResolvingTo(org, unrelated)).toEqual([unrelated]);
    // a merged person keeps its own row (history is never rewritten)
    expect((await directory.findPerson(org, a))?.canonicalPersonId).toBe(c);
  });

  it("IF-09: another organization's id returns [] and is omitted from displayNames", async () => {
    const other = await seedOrganization(t.db);
    const foreign = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    const mine = await createPersonFixture(t, {
      kind: 'child',
      givenName: 'Robin',
      familyName: 'Vale',
    });
    expect(await directory.personIdsResolvingTo(t.organizationId, foreign)).toEqual([]);
    expect(await directory.personIdsResolvingTo(t.organizationId, newId())).toEqual([]);
    expect(await directory.personIdsResolvingTo(t.organizationId, 'not-a-uuid')).toEqual([]);
    const names = await directory.displayNames(t.organizationId, [
      mine,
      foreign,
      newId(),
      'not-a-uuid',
    ]);
    expect([...names.keys()]).toEqual([mine]);
    // §4.14: names only, never date of birth, contacts or household
    expect(names.get(mine)).toEqual({
      personId: mine,
      givenName: 'Robin',
      familyName: 'Vale',
      displayName: 'Robin Vale',
      kind: 'child',
    });
  });

  it("IF-09: the directory reads through the caller's transaction (sees its uncommitted writes)", async () => {
    const uow = t.app.get(UnitOfWork);
    const id = newId();
    const seen = await uow.run(async ({ trx }) => {
      await trx
        .insertInto('persons')
        .values({
          id,
          organization_id: t.organizationId,
          kind: 'adult',
          given_name: 'Inside',
          family_name: 'Transaction',
          date_of_birth: null,
          source: 'staff',
          created_by: json({ kind: 'system' }),
          created_by_person_id: null,
          merged_into_person_id: null,
        })
        .execute();
      return {
        implicit: (await directory.displayNames(t.organizationId, [id])).get(id)?.displayName,
        chain: await directory.personIdsResolvingTo(t.organizationId, id),
      };
    });
    expect(seen).toEqual({ implicit: 'Inside Transaction', chain: [id] });
  });

  describe('IF-40: person import provenance', () => {
    const input = (overrides: Partial<CreatePersonInput> = {}): CreatePersonInput => ({
      kind: 'adult',
      givenName: 'Imported',
      familyName: 'Person',
      dateOfBirth: '1980-02-03',
      contactPoints: [
        { kind: 'email', value: 'Imported.Person@Example.test', isPrimary: true, verified: false },
      ],
      ...overrides,
    });

    it('creates the person with id = recordId and source import, create-if-absent', async () => {
      const batchId = newId();
      const provenance = { batchId, externalKey: 'legacy-17', recordId: newId() };
      const principal = systemPrincipal(t.organizationId, importActorLabel(batchId));
      const uow = t.app.get(UnitOfWork);
      // joins the caller's unit of work (the migration's per-row transaction)
      const created = await uow.run(() =>
        people.createPerson(principal, input(), 'migration:m1', { importProvenance: provenance }),
      );
      expect(created.id).toBe(provenance.recordId);
      const row = await t.db
        .selectFrom('persons')
        .select(['source', 'created_by_person_id'])
        .where('id', '=', provenance.recordId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ source: 'import', created_by_person_id: null });
      // the same record and content again: the existing person, no new effects
      const again = await people.create(principal, input(), 'migration:m1', {
        importProvenance: provenance,
      });
      expect(again.id).toBe(provenance.recordId);
      const audits = await t.db
        .selectFrom('audit_records')
        .select(['details'])
        .where('target_id', '=', provenance.recordId)
        .where('action', '=', IdentityActions.createPerson.id)
        .execute();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.details).toMatchObject({
        source: 'import',
        importBatchId: batchId,
        importExternalKey: 'legacy-17',
      });
      const events = await t.db
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', provenance.recordId)
        .where('event_type', '=', 'identity.person_created')
        .execute();
      expect(events).toHaveLength(1);
      // different content: IMPORT_CONTENT_MISMATCH
      await expect(
        people.createPerson(principal, input({ givenName: 'Changed' }), null, {
          importProvenance: provenance,
        }),
      ).rejects.toMatchObject({
        code: 'RESOURCE_CONFLICT',
        details: { code: 'IMPORT_CONTENT_MISMATCH' },
      });
    });

    it('any other principal asking for source import gets ACCESS_DENIED; POST /v1/people cannot ask for it', async () => {
      const batchId = newId();
      const provenance = { batchId, externalKey: 'legacy-18', recordId: newId() };
      const staff = staffPrincipal(t.organizationId, ['system_administrator']);
      await expect(
        people.createPerson(staff, input(), null, { importProvenance: provenance }),
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      const otherBatch = systemPrincipal(t.organizationId, importActorLabel(newId()));
      await expect(
        people.createPerson(otherBatch, input(), null, { importProvenance: provenance }),
      ).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
        details: { code: 'IMPORT_PRINCIPAL_REQUIRED' },
      });
      expect(
        await t.db
          .selectFrom('persons')
          .select('id')
          .where('id', '=', provenance.recordId)
          .executeTakeFirst(),
      ).toBeUndefined();
      const desk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
      const header = {
        Authorization: `Bearer ${await t.identityProvider.mint({
          subject: (
            await t.db
              .selectFrom('accounts')
              .select('subject')
              .where('id', '=', desk.accountId)
              .executeTakeFirstOrThrow()
          ).subject,
          sessionId: newId(),
        })}`,
      };
      const res = await t.http
        .post('/v1/people')
        .set(header)
        .set('Idempotency-Key', `k-${newId()}`)
        .send({
          kind: 'adult',
          givenName: 'Desk',
          familyName: 'Entry',
          source: 'import',
          importProvenance: provenance,
        });
      expect(res.status).toBe(201);
      expect(res.body.id).not.toBe(provenance.recordId);
      const row = await t.db
        .selectFrom('persons')
        .select('source')
        .where('id', '=', res.body.id)
        .executeTakeFirstOrThrow();
      expect(row.source).toBe('staff');
    });
  });

  describe('ID-09: AuthorityLookupPort.effectiveGrant', () => {
    it('SPK-IAM-005: a grant suspended by a review yields null exactly when hasPermission answers false', async () => {
      const cast = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
      const org = t.organizationId;
      const parent = cast.adult.personId;
      const child = cast.child.personId;
      const grant = await authority.effectiveGrant(org, parent, child, 'collect', t.clock.now());
      expect(grant).toMatchObject({
        grantId: cast.guardianGrants.collect,
        relationshipId: cast.relationshipId,
        source: 'staff',
        effectiveTo: null,
      });
      expect(await authority.hasPermission(org, parent, child, 'collect')).toBe(true);
      const reviews = t.app.get(AccessReviewsService);
      const support = staffPrincipal(org, ['support_operator'], { personId: null });
      const review = await reviews.open(
        support,
        {
          subjectPersonId: child,
          reason: 'custody dispute',
          parties: [],
          evidence: [],
          ownerRole: 'support_operator',
        },
        null,
      );
      await reviews.decide(
        support,
        review.id,
        { kind: 'restrict', grantIds: [cast.guardianGrants.collect as string] },
        null,
      );
      expect(await authority.hasPermission(org, parent, child, 'collect')).toBe(false);
      expect(
        await authority.effectiveGrant(org, parent, child, 'collect', t.clock.now()),
      ).toBeNull();
      // the other permission is untouched by the restriction
      expect(await authority.hasPermission(org, parent, child, 'view')).toBe(true);
      expect(
        (await authority.effectiveGrant(org, parent, child, 'view', t.clock.now()))?.grantId,
      ).toBe(cast.guardianGrants.view);
      await reviews.decide(
        support,
        review.id,
        { kind: 'lift', grantIds: [cast.guardianGrants.collect as string] },
        null,
      );
      expect(await authority.hasPermission(org, parent, child, 'collect')).toBe(true);
      expect(
        (await authority.effectiveGrant(org, parent, child, 'collect', t.clock.now()))?.grantId,
      ).toBe(cast.guardianGrants.collect);
      // self authority carries no grant
      expect(await authority.effectiveGrant(org, parent, parent, 'view', t.clock.now())).toBeNull();
    });

    it('of two effective grants the later one is named; a revoked or not-yet-effective one never is', async () => {
      // The database forbids two unrevoked grants of one permission with overlapping windows
      // (exclusion constraint, migration 0100), so successive grants name the one in force at `at`.
      const org = t.organizationId;
      const adult = await createPersonFixture(t, { kind: 'adult' });
      const child = await createPersonFixture(t, { kind: 'child' });
      const now = t.clock.now();
      const day = 86_400_000;
      const at = (offsetDays: number) => new Date(now.getTime() + offsetDays * day);
      const earlier = await createRelationshipFixture(t, {
        actorPersonId: adult,
        subjectPersonId: child,
        kind: 'guardian',
        permissions: ['view'],
        effectiveFrom: at(-10),
        effectiveTo: at(-1),
      });
      const later = await createRelationshipFixture(t, {
        actorPersonId: adult,
        subjectPersonId: child,
        kind: 'caregiver',
        permissions: ['view'],
        effectiveFrom: at(-1),
        effectiveTo: at(1),
      });
      const future = await createRelationshipFixture(t, {
        actorPersonId: adult,
        subjectPersonId: child,
        kind: 'delegate',
        permissions: ['view'],
        effectiveFrom: at(1),
      });
      expect(await authority.effectiveGrant(org, adult, child, 'view', now)).toMatchObject({
        grantId: later.grantIds.view,
        relationshipId: later.relationshipId,
        effectiveFrom: at(-1).toISOString(),
        effectiveTo: at(1).toISOString(),
      });
      expect((await authority.effectiveGrant(org, adult, child, 'view', at(-5)))?.grantId).toBe(
        earlier.grantIds.view,
      );
      expect((await authority.effectiveGrant(org, adult, child, 'view', at(2)))?.grantId).toBe(
        future.grantIds.view,
      );
      await t.db
        .updateTable('access_grants')
        .set({ revoked_at: now, revoked_by: json({ kind: 'system' }), revocation_reason: 'test' })
        .where('id', '=', later.grantIds.view as string)
        .execute();
      expect(await authority.hasPermission(org, adult, child, 'view')).toBe(false);
      expect(await authority.effectiveGrant(org, adult, child, 'view', now)).toBeNull();
      expect(await authority.effectiveGrant(org, adult, child, 'pay', at(2))).toBeNull();
    });
  });

  it('IF-01: subjectsWithPermission lists the others the actor holds the permission over now, never the actor', async () => {
    const org = t.organizationId;
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const childA = await createPersonFixture(t, { kind: 'child' });
    const childB = await createPersonFixture(t, { kind: 'child' });
    const ended = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: adult,
      subjectPersonId: childA,
      permissions: ['view', 'pay'],
    });
    await createRelationshipFixture(t, {
      actorPersonId: adult,
      subjectPersonId: childB,
      permissions: ['view'],
    });
    await createRelationshipFixture(t, {
      actorPersonId: adult,
      subjectPersonId: ended,
      permissions: ['view'],
      effectiveFrom: new Date(t.clock.now().getTime() - 2 * 86_400_000),
      effectiveTo: new Date(t.clock.now().getTime() - 86_400_000),
    });
    expect(await authority.subjectsWithPermission(org, adult, 'view')).toEqual(
      [childA, childB].sort(),
    );
    expect(await authority.subjectsWithPermission(org, adult, 'pay')).toEqual([childA]);
    expect(await authority.subjectsWithPermission(org, childA, 'view')).toEqual([]);
    // the kernel's customer lists start from these subjects (K-05)
    const subjects = await t.app.get(AuthorizationService).customerSubjects(
      {
        kind: 'customer',
        organizationId: org,
        accountId: newId(),
        personId: adult,
        staffRoles: [],
        facilityIds: [],
        sessionId: null,
        actorLabel: 'customer:test',
      },
      IdentityActions.readPerson,
    );
    expect(subjects).toEqual([adult, ...[childA, childB].sort()]);
  });
});
