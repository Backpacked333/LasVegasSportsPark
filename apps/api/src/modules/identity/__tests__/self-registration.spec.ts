import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

describe('self-registration (SPK-IAM-001, SPK-IAM-002, SPK-IAM-007, SPK-UX-001)', () => {
  let t: TestApp;
  let slug: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    const organization = await t.db
      .selectFrom('organizations')
      .select('slug')
      .where('id', '=', t.organizationId)
      .executeTakeFirstOrThrow();
    slug = organization.slug;
  });
  afterAll(async () => {
    await t.close();
  });

  /** A token the identity provider signed for a subject that has no account yet. */
  const verified = async (claims: Record<string, unknown> = {}, subject = `sub-${newId()}`) => ({
    subject,
    header: {
      Authorization: `Bearer ${await t.identityProvider.mint({ subject, sessionId: newId(), extra: claims })}`,
    },
  });

  const register = (header: { Authorization: string }, organizationSlug = slug) =>
    t.http.post('/v1/accounts/register').set(header).send({ organizationSlug });

  const createOwn = (
    header: { Authorization: string },
    body: Record<string, unknown> = {
      givenName: 'Nora',
      familyName: 'Newcomer',
      dateOfBirth: '1990-02-03',
    },
    idempotencyKey = key(),
  ) => t.http.post('/v1/me/person').set(header).set('Idempotency-Key', idempotencyKey).send(body);

  it('SPK-IAM-002: a verified identity with no account is refused everywhere until it registers', async () => {
    const who = await verified();
    const before = await t.http.get('/v1/me').set(who.header);
    expect(before.status).toBe(401);
    expect(before.body.code).toBe('AUTHENTICATION_REQUIRED');

    const registered = await register(who.header);
    expect(registered.status).toBe(200);
    expect(registered.body).toMatchObject({
      issuer: t.config.AUTH_ISSUER,
      subject: who.subject,
      personId: null,
      status: 'active',
      revision: 1,
    });

    const me = await t.http.get('/v1/me').set(who.header);
    expect(me.status).toBe(200);
    expect(me.body.principal).toMatchObject({
      kind: 'customer',
      organizationId: t.organizationId,
      accountId: registered.body.id,
      personId: null,
      staffRoles: [],
    });
    expect(me.body.person).toBeNull();
    expect(me.body.authorities).toEqual([]);
  });

  it('SPK-IAM-002: registration needs the signed token; a body alone, a forged token or an unknown organization registers nothing', async () => {
    const none = await t.http.post('/v1/accounts/register').send({ organizationSlug: slug });
    expect(none.status).toBe(401);

    const forged = await register({ Authorization: 'Bearer not-a-token' });
    expect(forged.status).toBe(401);

    const who = await verified();
    const elsewhere = await register(who.header, 'no-such-organization');
    expect(elsewhere.status).toBe(404);
    const invalid = await t.http.post('/v1/accounts/register').set(who.header).send({});
    expect(invalid.status).toBe(400);
    const count = await t.db
      .selectFrom('accounts')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('subject', '=', who.subject)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  it('§4.9: registering again, or twice at once, answers the same account and writes one audit record and one event', async () => {
    const who = await verified();
    const [a, b] = await Promise.all([register(who.header), register(who.header)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    const again = await register(who.header);
    expect(again.body.id).toBe(a.body.id);

    const accounts = await t.db
      .selectFrom('accounts')
      .select('id')
      .where('subject', '=', who.subject)
      .execute();
    expect(accounts).toHaveLength(1);
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor'])
      .where('target_id', '=', a.body.id)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'identity.register_account' });
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', a.body.id)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['identity.account_registered']);
  });

  it('§4.3, §4.14: an identity whose account is disabled or belongs to another organization gets no account here', async () => {
    const disabled = await createAccountFixture(t, { personId: null, status: 'disabled' });
    const disabledToken = await t.identityProvider.mint({ subject: disabled.subject });
    const refused = await register({ Authorization: `Bearer ${disabledToken}` });
    expect(refused.status).toBe(401);

    const other = await seedOrganization(t.db, { slug: `other-${newId()}` });
    const foreign = await createAccountFixture(t, {
      personId: null,
      organizationId: other.organizationId,
    });
    const foreignToken = await t.identityProvider.mint({ subject: foreign.subject });
    const crossed = await register({ Authorization: `Bearer ${foreignToken}` });
    expect(crossed.status).toBe(401);
    const row = await t.db
      .selectFrom('accounts')
      .select('organization_id')
      .where('id', '=', foreign.id)
      .executeTakeFirstOrThrow();
    expect(row.organization_id).toBe(other.organizationId);
  });

  it('SPK-IAM-001: the account holder creates their own adult record; the provider-verified email becomes a verified contact point and nothing else is granted', async () => {
    const email = `nora.${newId()}@example.test`;
    const who = await verified({ email: `  ${email.toUpperCase()} `, email_verified: true });
    const account = await register(who.header);

    const created = await createOwn(who.header);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'adult',
      givenName: 'Nora',
      familyName: 'Newcomer',
      dateOfBirth: '1990-02-03',
      status: 'active',
    });
    expect(created.body.contactPoints).toHaveLength(1);
    expect(created.body.contactPoints[0]).toMatchObject({
      kind: 'email',
      value: email,
      isPrimary: true,
    });
    expect(created.body.contactPoints[0].verifiedAt).not.toBeNull();

    const me = await t.http.get('/v1/me').set(who.header);
    expect(me.body.principal.personId).toBe(created.body.id);
    expect(me.body.person.id).toBe(created.body.id);
    expect(me.body.authorities).toEqual([]);
    expect(me.body.staffMemberships).toEqual([]);

    const person = await t.db
      .selectFrom('persons')
      .select(['source', 'created_by_person_id'])
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(person).toEqual({ source: 'self_service', created_by_person_id: null });
    const grants = await t.db
      .selectFrom('access_grants')
      .select('id')
      .where('actor_person_id', '=', created.body.id)
      .execute();
    expect(grants).toEqual([]);

    const audits = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_id', 'in', [created.body.id, account.body.id])
      .orderBy('action')
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      'identity.create_own_person',
      'identity.manage_account',
      'identity.register_account',
    ]);
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', 'in', [created.body.id, account.body.id])
      .execute();
    expect(events.map((e) => e.event_type).sort()).toEqual([
      'identity.account_linked',
      'identity.account_registered',
      'identity.person_created',
    ]);
    expect(events.find((e) => e.event_type === 'identity.account_linked')?.payload).toMatchObject({
      accountId: account.body.id,
      personId: created.body.id,
      via: 'self_registration',
    });
  });

  it('§4.14: a contact the provider did not verify is recorded unverified, and the body cannot supply a contact or a kind', async () => {
    const email = `unverified.${newId()}@example.test`;
    const who = await verified({ email, email_verified: false, phone_number: '+17025550100' });
    await register(who.header);
    const created = await createOwn(who.header, {
      givenName: 'Una',
      familyName: 'Verified',
      dateOfBirth: '1988-06-01',
      kind: 'child',
      contactPoints: [{ kind: 'email', value: 'other@example.test', verified: true }],
    });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('adult');
    const contacts = created.body.contactPoints as Array<{
      kind: string;
      value: string;
      verifiedAt: string | null;
    }>;
    expect(contacts.map((c) => [c.kind, c.value, c.verifiedAt]).sort()).toEqual([
      ['email', email, null],
      ['phone', '+17025550100', null],
    ]);
  });

  it('SPK-IAM-001: only an adult creates their own record, and the date of birth is required', async () => {
    const who = await verified();
    await register(who.header);
    const child = await createOwn(who.header, {
      givenName: 'Young',
      familyName: 'Person',
      dateOfBirth: '2015-01-01',
    });
    expect(child.status).toBe(400);
    expect(child.body.code).toBe('VALIDATION_FAILED');
    const missing = await createOwn(who.header, { givenName: 'No', familyName: 'Birthday' });
    expect(missing.status).toBe(400);
    const me = await t.http.get('/v1/me').set(who.header);
    expect(me.body.person).toBeNull();
  });

  it('§4.9: one account creates one person: a retry with the same key replays, a second command conflicts', async () => {
    const who = await verified();
    await register(who.header);
    const idempotencyKey = key();
    const first = await createOwn(who.header, undefined, idempotencyKey);
    expect(first.status).toBe(201);
    const replay = await createOwn(who.header, undefined, idempotencyKey);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    const second = await createOwn(who.header);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('RESOURCE_CONFLICT');
    const persons = await t.db
      .selectFrom('persons')
      .select('id')
      .where('family_name', '=', 'Newcomer')
      .where('given_name', '=', 'Nora')
      .where('id', '=', first.body.id)
      .execute();
    expect(persons).toHaveLength(1);
  });

  it('SPK-IAM-002: when staff already verified the same email on a desk-created record, no second participant is made; the person is sent to claim it', async () => {
    const email = `desk.${newId()}@example.test`;
    const deskRecord = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Dana',
      familyName: 'Desk',
    });
    await createContactPointFixture(t, {
      personId: deskRecord,
      kind: 'email',
      value: email,
      verified: true,
    });
    const who = await verified({ email, email_verified: true });
    const account = await register(who.header);

    const refused = await createOwn(who.header, {
      givenName: 'Dana',
      familyName: 'Desk',
      dateOfBirth: '1985-04-12',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    expect(refused.body.details).toEqual({ kind: 'email', resolution: 'claim_existing_record' });
    const persons = await t.db
      .selectFrom('persons')
      .select('id')
      .where('family_name', '=', 'Desk')
      .execute();
    expect(persons.map((p) => p.id)).toEqual([deskRecord]);

    // The way forward the answer names: staff issue a claim, the same account accepts it.
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const issued = await t.http
      .post(`/v1/people/${deskRecord}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(issued.status).toBe(201);
    const accepted = await t.http
      .post('/v1/claims/accept')
      .set(who.header)
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(accepted.status).toBe(200);
    const linked = await t.db
      .selectFrom('accounts')
      .select('person_id')
      .where('id', '=', account.body.id)
      .executeTakeFirstOrThrow();
    expect(linked.person_id).toBe(deskRecord);
  });

  it('§4.7: the database refuses a second verified primary holder of one email even without the service check', async () => {
    const email = `unique.${newId()}@example.test`;
    const first = await createPersonFixture(t, { kind: 'adult' });
    const second = await createPersonFixture(t, { kind: 'adult' });
    await createContactPointFixture(t, {
      personId: first,
      kind: 'email',
      value: email,
      verified: true,
    });
    await expect(
      createContactPointFixture(t, {
        personId: second,
        kind: 'email',
        value: email,
        verified: true,
      }),
    ).rejects.toThrow(/contact_points_verified_identifier_idx/);
  });

  it('SPK-IAM-007: a self-created record that matches an existing person by name and date of birth becomes a duplicate candidate for staff, never a merge', async () => {
    const existing = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Pat',
      familyName: 'Twin',
      dateOfBirth: '1979-11-30',
    });
    const who = await verified();
    await register(who.header);
    const created = await createOwn(who.header, {
      givenName: 'pat',
      familyName: 'TWIN',
      dateOfBirth: '1979-11-30',
    });
    expect(created.status).toBe(201);
    const candidates = await t.db
      .selectFrom('duplicate_candidates')
      .select(['person_a_id', 'person_b_id', 'reasons', 'status'])
      .where((eb) =>
        eb.or([eb('person_a_id', '=', created.body.id), eb('person_b_id', '=', created.body.id)]),
      )
      .execute();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      reasons: ['same_name_and_date_of_birth'],
      status: 'open',
    });
    expect([candidates[0]?.person_a_id, candidates[0]?.person_b_id].sort()).toEqual(
      [existing, created.body.id].sort(),
    );
    const both = await t.db
      .selectFrom('persons')
      .select(['id', 'status'])
      .where('id', 'in', [existing, created.body.id])
      .execute();
    expect(both.every((p) => p.status === 'active')).toBe(true);
  });

  it('SPK-IAM-001: a self-registered adult then creates a child record through the existing self-service path', async () => {
    const who = await verified();
    await register(who.header);
    const adult = await createOwn(who.header, {
      givenName: 'Gail',
      familyName: 'Guardian',
      dateOfBirth: '1984-03-09',
    });
    expect(adult.status).toBe(201);
    const child = await t.http
      .post('/v1/people')
      .set(who.header)
      .set('Idempotency-Key', key())
      .send({ kind: 'child', givenName: 'Kit', familyName: 'Guardian', dateOfBirth: '2017-05-05' });
    expect(child.status).toBe(201);
    expect(child.body.kind).toBe('child');
  });

  it('§4.14: registration is rate limited per client address', async () => {
    const limited = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
      env: { RATE_LIMITS: 'account_registration=2/600' },
    });
    try {
      const organization = await limited.db
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', limited.organizationId)
        .executeTakeFirstOrThrow();
      const attempt = async () => {
        const token = await limited.identityProvider.mint({ subject: `sub-${newId()}` });
        return limited.http
          .post('/v1/accounts/register')
          .set({ Authorization: `Bearer ${token}` })
          .send({ organizationSlug: organization.slug });
      };
      expect((await attempt()).status).toBe(200);
      expect((await attempt()).status).toBe(200);
      const third = await attempt();
      expect(third.status).toBe(429);
      expect(third.body.code).toBe('RATE_LIMITED');
      expect(third.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
