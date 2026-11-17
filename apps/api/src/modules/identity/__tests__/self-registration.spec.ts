import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal } from '../../../testing';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { PeopleService } from '../services/people.service';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';
import { MigrationModule } from '../../migration/migration.module';
import { createAuthorityAssignmentFixture } from '../../migration/testing/migration-fixtures';

const key = () => `k-${newId()}`;
const validBody = {
  givenName: 'Taylor',
  familyName: 'Register',
  dateOfBirth: '1989-05-12',
};

describe('customer self-registration (SCR-C-01, SPK-IAM-001/002/007, §4.9)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  async function register(accountId: string, body: object = validBody, idempotencyKey = key()) {
    return t.http
      .post('/v1/me/registration')
      .set(await authHeaderForAccount(t, accountId))
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
  }

  it('SPK-IAM-001: requires an authenticated account', async () => {
    const response = await t.http
      .post('/v1/me/registration')
      .set('Idempotency-Key', key())
      .send(validBody);

    expect(response.status).toBe(401);
  });

  it('SPK-IAM-001: cannot choose another organization or its account for registration', async () => {
    const otherOrganization = await seedOrganization(t.db, { slug: `registration-${newId()}` });
    const account = await createAccountFixture(t, { personId: null });
    const otherAccount = await createAccountFixture(t, {
      organizationId: otherOrganization.organizationId,
      personId: null,
    });
    const attemptedTarget = await register(account.id, {
      ...validBody,
      organizationId: otherOrganization.organizationId,
      accountId: otherAccount.id,
    });
    expect(attemptedTarget.status).toBe(400);

    const response = await register(account.id, { ...validBody, familyName: 'OwnOrganization' });
    expect(response.status).toBe(201);
    const untouched = await t.db
      .selectFrom('accounts')
      .select(['person_id', 'revision'])
      .where('id', '=', otherAccount.id)
      .executeTakeFirstOrThrow();
    expect(untouched).toEqual({ person_id: null, revision: 1 });
  });

  it('SPK-IAM-001/007: rejects malformed, underage, and caller-selected identity data', async () => {
    const account = await createAccountFixture(t, { personId: null });
    const rejectedBody = { givenName: 'Taylor', familyName: 'RejectedRegistration' };
    const malformed = await register(account.id, {
      ...rejectedBody,
      dateOfBirth: 'not-a-date',
    });
    const missingDate = await register(account.id, rejectedBody);
    const underage = await register(account.id, { ...rejectedBody, dateOfBirth: '2010-05-12' });
    const callerSelected = await register(account.id, {
      ...validBody,
      organizationId: newId(),
      accountId: newId(),
      personId: newId(),
      roles: ['front_desk'],
      contactPoints: [{ kind: 'email', value: 'taylor@example.test', verified: true }],
    });

    expect(malformed.status).toBe(400);
    expect(missingDate.status).toBe(400);
    expect(underage.status).toBe(400);
    expect(callerSelected.status).toBe(400);
    const storedAccount = await t.db
      .selectFrom('accounts')
      .select(['person_id', 'revision'])
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(storedAccount).toMatchObject({ person_id: null, revision: 1 });
    const rejectedPersons = await t.db
      .selectFrom('persons')
      .select('id')
      .where('family_name', '=', rejectedBody.familyName)
      .execute();
    expect(rejectedPersons).toHaveLength(0);
  });

  it('SPK-IAM-002/007: links one self-service adult and records audit and domain events atomically', async () => {
    const account = await createAccountFixture(t, { personId: null });
    const reason = 'Customer completed adult self-registration.';
    const policyReferences = ['SPK-IAM-001', 'SPK-IAM-002', 'SPK-IAM-007', '§4.9'];
    const householdsBefore = new Set(
      (await t.db.selectFrom('households').select('id').execute()).map((household) => household.id),
    );

    const response = await register(account.id, {
      givenName: ` ${validBody.givenName} `,
      familyName: ` ${validBody.familyName} `,
      dateOfBirth: validBody.dateOfBirth,
      expectedRevision: 1,
      reason,
      policyReferences,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      kind: 'adult',
      givenName: validBody.givenName,
      familyName: validBody.familyName,
      dateOfBirth: validBody.dateOfBirth,
    });
    const createdPerson = await t.db
      .selectFrom('persons')
      .select('source')
      .where('id', '=', response.body.id)
      .executeTakeFirstOrThrow();
    expect(createdPerson.source).toBe('self_service');
    const linkedAccount = await t.db
      .selectFrom('accounts')
      .select(['person_id', 'revision'])
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(linkedAccount).toEqual({ person_id: response.body.id, revision: 2 });

    const auditRows = await t.db
      .selectFrom('audit_records')
      .select(['target_id', 'action', 'after_revision', 'reason', 'details'])
      .where('target_id', 'in', [account.id, response.body.id])
      .execute();
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_id: response.body.id,
          action: 'identity.self_register',
          reason,
          details: expect.objectContaining({ policyReferences }),
        }),
        expect.objectContaining({
          target_id: account.id,
          action: 'identity.self_register',
          reason,
          details: expect.objectContaining({ policyReferences }),
        }),
      ]),
    );
    const personEvent = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'identity.person_created')
      .where('aggregate_id', '=', response.body.id)
      .executeTakeFirstOrThrow();
    const accountEvent = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'identity.account_linked')
      .where('aggregate_id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(personEvent.payload).toMatchObject({
      personId: response.body.id,
      source: 'self_service',
    });
    expect(accountEvent.payload).toMatchObject({
      accountId: account.id,
      personId: response.body.id,
      via: 'self_service',
    });

    const [householdsAfter, relationships, grants, householdMemberships, staffMemberships] =
      await Promise.all([
        t.db.selectFrom('households').select('id').execute(),
        t.db
          .selectFrom('relationships')
          .select('id')
          .where((eb) =>
            eb.or([
              eb('actor_person_id', '=', response.body.id),
              eb('subject_person_id', '=', response.body.id),
            ]),
          )
          .execute(),
        t.db
          .selectFrom('access_grants')
          .select('id')
          .where((eb) =>
            eb.or([
              eb('actor_person_id', '=', response.body.id),
              eb('subject_person_id', '=', response.body.id),
            ]),
          )
          .execute(),
        t.db
          .selectFrom('household_memberships')
          .select('id')
          .where('person_id', '=', response.body.id)
          .execute(),
        t.db
          .selectFrom('staff_memberships')
          .select('person_id')
          .where('person_id', '=', response.body.id)
          .execute(),
      ]);
    expect(householdsAfter.filter((household) => !householdsBefore.has(household.id))).toHaveLength(
      0,
    );
    expect(relationships).toHaveLength(0);
    expect(grants).toHaveLength(0);
    expect(householdMemberships).toHaveLength(0);
    expect(staffMemberships).toHaveLength(0);
  });

  it('SPK-IAM-002: rejects a linked or disabled account without creating a person', async () => {
    const linkedPerson = await createPersonFixture(t, { kind: 'adult' });
    const linkedAccount = await createAccountFixture(t, { personId: linkedPerson });
    const disabledAccount = await createAccountFixture(t, { personId: null, status: 'disabled' });
    const body = { ...validBody, familyName: 'MustNotRegister' };

    const linked = await register(linkedAccount.id, body);
    const disabled = await register(disabledAccount.id, body);

    expect(linked.status).toBe(409);
    expect(disabled.status).toBe(401);
    const people = await t.db
      .selectFrom('persons')
      .select('id')
      .where('family_name', '=', body.familyName)
      .execute();
    expect(people).toHaveLength(0);
  });

  it('§4.9: rejects a stale expected revision before creating or linking a person', async () => {
    const account = await createAccountFixture(t, { personId: null });
    const body = { ...validBody, familyName: 'StaleRegistrationRevision', expectedRevision: 2 };

    const response = await register(account.id, body);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'STALE_REVISION' });
    expect(
      await t.db
        .selectFrom('accounts')
        .select(['person_id', 'revision'])
        .where('id', '=', account.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ person_id: null, revision: 1 });
    expect(
      await t.db
        .selectFrom('persons')
        .select('id')
        .where('family_name', '=', body.familyName)
        .execute(),
    ).toEqual([]);
    expect(
      await t.db
        .selectFrom('outbox_events')
        .select('id')
        .where('aggregate_id', '=', account.id)
        .execute(),
    ).toEqual([]);
  });

  it('SPK-IAM-001: retries on the same idempotency key return the same person', async () => {
    const account = await createAccountFixture(t, { personId: null });
    const idempotencyKey = key();
    const body = { ...validBody, familyName: 'ReplayRegistration' };

    const first = await register(account.id, body, idempotencyKey);
    const replay = await register(account.id, body, idempotencyKey);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    const persons = await t.db
      .selectFrom('persons')
      .select('id')
      .where('family_name', '=', body.familyName)
      .where('given_name', '=', body.givenName)
      .execute();
    expect(persons).toHaveLength(1);
  });

  it('§4.9: concurrent different-key submissions link one person and leave no orphan', async () => {
    const account = await createAccountFixture(t, { personId: null });
    const body = { ...validBody, familyName: 'ConcurrentRegistration' };
    const [first, second] = await Promise.all([
      register(account.id, body, key()),
      register(account.id, body, key()),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const linked = await t.db
      .selectFrom('accounts')
      .select(['person_id', 'revision'])
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    const created = await t.db
      .selectFrom('persons')
      .select(['id', 'source'])
      .where('family_name', '=', body.familyName)
      .execute();
    expect(created).toHaveLength(1);
    expect(linked).toEqual({ person_id: created[0]?.id, revision: 2 });
    expect(created[0]?.source).toBe('self_service');
  });

  it('§4.9 SPK-IAM-002: registration racing a pending self-claim leaves exactly one linked person', async () => {
    const account = await createAccountFixture(t, { personId: null });
    const existingPerson = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Claim',
      familyName: 'RaceTarget',
    });
    const staff = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const issued = await t.http
      .post(`/v1/people/${existingPerson}/claims`)
      .set(await authHeaderForPerson(t, staff.personId))
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(issued.status).toBe(201);

    const body = { ...validBody, familyName: 'RaceRegistration' };
    const customer = await authHeaderForAccount(t, account.id);
    const [registration, acceptedClaim] = await Promise.all([
      t.http.post('/v1/me/registration').set(customer).set('Idempotency-Key', key()).send(body),
      t.http
        .post('/v1/claims/accept')
        .set(customer)
        .set('Idempotency-Key', key())
        .send({ token: issued.body.token }),
    ]);

    const linked = await t.db
      .selectFrom('accounts')
      .select(['person_id', 'revision'])
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    const registeredPeople = await t.db
      .selectFrom('persons')
      .select('id')
      .where('family_name', '=', body.familyName)
      .execute();

    expect(linked.revision).toBe(2);
    if (registration.status === 201) {
      expect(acceptedClaim.status).toBe(409);
      expect(linked.person_id).toBe(registration.body.id);
      expect(registeredPeople.map((person) => person.id)).toEqual([registration.body.id]);
    } else {
      expect(registration.status).toBe(409);
      expect(acceptedClaim.status).toBe(200);
      expect(linked.person_id).toBe(existingPerson);
      expect(acceptedClaim.body.personId).toBe(existingPerson);
      expect(registeredPeople).toHaveLength(0);
    }
  });

  it('SPK-IAM-007: duplicate detection creates a review candidate without returning matches or granting access', async () => {
    const duplicate = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Morgan',
      familyName: 'PossibleDuplicate',
      dateOfBirth: '1989-05-12',
    });
    const account = await createAccountFixture(t, { personId: null });
    const response = await register(account.id, {
      givenName: 'Morgan',
      familyName: 'PossibleDuplicate',
      dateOfBirth: '1989-05-12',
    });

    expect(response.status).toBe(201);
    expect(response.body).not.toHaveProperty('duplicateCandidates');
    const candidates = await t.db
      .selectFrom('duplicate_candidates')
      .select(['person_a_id', 'person_b_id', 'status'])
      .where((eb) =>
        eb.or([eb('person_a_id', '=', response.body.id), eb('person_b_id', '=', response.body.id)]),
      )
      .execute();
    expect(candidates).toHaveLength(1);
    expect([candidates[0]?.person_a_id, candidates[0]?.person_b_id]).toContain(duplicate);
    expect(candidates[0]?.status).toBe('open');
    expect(
      await t.db
        .selectFrom('access_grants')
        .select('id')
        .where((eb) =>
          eb.or([
            eb('actor_person_id', '=', response.body.id),
            eb('subject_person_id', '=', response.body.id),
          ]),
        )
        .execute(),
    ).toHaveLength(0);
    expect(
      await t.db
        .selectFrom('household_memberships')
        .select('id')
        .where('person_id', '=', response.body.id)
        .execute(),
    ).toHaveLength(0);
  });
});

describe('self-registration legacy record authority (SCR-C-01, §5.6)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [MigrationModule],
      principalResolver: 'module',
      clockStart: '2027-01-16T20:00:00.000Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it.each(['person', 'account'] as const)(
    '§5.6: refuses self-registration while legacy authority owns %s without creating records or events',
    async (recordCategory) => {
      const familyName = `LegacyRefusal${recordCategory}`;
      const account = await createAccountFixture(t, { personId: null });
      const assignmentId = await createAuthorityAssignmentFixture(t, {
        recordCategory,
        authoritativeSystem: 'legacy',
      });
      const principal = customerPrincipal(t.organizationId, {
        accountId: account.id,
        personId: null,
      });

      await expect(
        t.app
          .get(PeopleService, { strict: false })
          .registerSelf(principal, { ...validBody, familyName }, null),
      ).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
        nextAction: 'write_in_authoritative_system',
        details: { code: 'LEGACY_AUTHORITY', recordCategory, assignmentId },
      });

      const storedAccount = await t.db
        .selectFrom('accounts')
        .select(['person_id', 'revision'])
        .where('id', '=', account.id)
        .executeTakeFirstOrThrow();
      expect(storedAccount).toEqual({ person_id: null, revision: 1 });
      expect(
        await t.db
          .selectFrom('persons')
          .select('id')
          .where('family_name', '=', familyName)
          .execute(),
      ).toEqual([]);
      expect(
        await t.db
          .selectFrom('audit_records')
          .select('id')
          .where('action', '=', 'identity.self_register')
          .where('organization_id', '=', t.organizationId)
          .execute(),
      ).toEqual([]);
      expect(
        await t.db
          .selectFrom('outbox_events')
          .select(['event_type', 'aggregate_id'])
          .where('event_type', 'in', ['identity.person_created', 'identity.account_linked'])
          .execute(),
      ).toEqual([]);
    },
  );
});
