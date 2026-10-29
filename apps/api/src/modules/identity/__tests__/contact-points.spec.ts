import { newId } from '@sportspark/contracts';
import { isUniqueViolation } from '@sportspark/db';
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

describe('contact point management (ID-06; SPK-IAM-001, §4.9, §4.14)', () => {
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

  async function adultWithAccount() {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId });
    return { personId, header: await authHeaderForPerson(t, personId) };
  }

  const primaries = (personId: string) =>
    t.db
      .selectFrom('contact_points')
      .select(['id', 'kind'])
      .where('person_id', '=', personId)
      .where('is_primary', '=', true)
      .orderBy('kind')
      .execute();

  it('SPK-IAM-001: making a contact point primary moves the flag in one transaction', async () => {
    const me = await adultWithAccount();
    const first = await createContactPointFixture(t, {
      personId: me.personId,
      kind: 'email',
      value: `first-${newId()}@example.test`,
      isPrimary: true,
    });
    const second = await createContactPointFixture(t, {
      personId: me.personId,
      kind: 'email',
      value: `second-${newId()}@example.test`,
      isPrimary: false,
    });
    const phone = await createContactPointFixture(t, {
      personId: me.personId,
      kind: 'phone',
      value: '+15559990000',
      isPrimary: true,
    });
    const res = await t.http
      .post(`/v1/people/${me.personId}/contact-points/${second}/make-primary`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: second, isPrimary: true, kind: 'email' });
    // exactly one primary per kind; the other kind is untouched
    expect(await primaries(me.personId)).toEqual([
      { id: second, kind: 'email' },
      { id: phone, kind: 'phone' },
    ]);
    expect(first).not.toBe(second);
    const person = await t.db
      .selectFrom('persons')
      .select('revision')
      .where('id', '=', me.personId)
      .executeTakeFirstOrThrow();
    expect(person.revision).toBe(2);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', me.personId)
      .where('event_type', '=', 'identity.person_updated')
      .executeTakeFirstOrThrow();
    expect(event.payload).toEqual({ personId: me.personId, revision: 2 });
    // a stale revision is refused (§4.9)
    const stale = await t.http
      .post(`/v1/people/${me.personId}/contact-points/${first}/make-primary`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
  });

  it('the database rejects two primary contact points of one kind', async () => {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    await createContactPointFixture(t, {
      personId,
      kind: 'email',
      value: `a-${newId()}@example.test`,
      isPrimary: true,
    });
    const second = await createContactPointFixture(t, {
      personId,
      kind: 'email',
      value: `b-${newId()}@example.test`,
      isPrimary: false,
    });
    const error = await t.db
      .updateTable('contact_points')
      .set({ is_primary: true })
      .where('id', '=', second)
      .execute()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isUniqueViolation(error)).toBe(true);
  });

  it("another person's contact point reads as not found; a stranger cannot change mine", async () => {
    const me = await adultWithAccount();
    const other = await adultWithAccount();
    const theirs = await createContactPointFixture(t, {
      personId: other.personId,
      kind: 'email',
      value: `theirs-${newId()}@example.test`,
      isPrimary: false,
    });
    const viaMyPath = await t.http
      .post(`/v1/people/${me.personId}/contact-points/${theirs}/make-primary`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({});
    expect(viaMyPath.status).toBe(404);
    const viaTheirPath = await t.http
      .post(`/v1/people/${other.personId}/contact-points/${theirs}/remove`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({});
    expect(viaTheirPath.status).toBe(404);
    expect(viaTheirPath.body.code).toBe('NOT_FOUND');
  });

  it('removing deletes the row, audits a masked value only, and keeps the last verified contact of an account holder (LAST_VERIFIED_CONTACT)', async () => {
    const me = await adultWithAccount();
    const email = `keep.me-${newId()}@example.test`;
    const verified = await createContactPointFixture(t, {
      personId: me.personId,
      kind: 'email',
      value: email,
      verified: true,
    });
    const unverified = await createContactPointFixture(t, {
      personId: me.personId,
      kind: 'phone',
      value: '+15551112222',
      isPrimary: false,
    });
    const refused = await t.http
      .post(`/v1/people/${me.personId}/contact-points/${verified}/remove`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({ reason: 'changing address' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'LAST_VERIFIED_CONTACT' },
    });
    const removed = await t.http
      .post(`/v1/people/${me.personId}/contact-points/${unverified}/remove`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({ reason: 'old number' });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removedContactPointId: unverified });
    expect(
      await t.db
        .selectFrom('contact_points')
        .select('id')
        .where('id', '=', unverified)
        .executeTakeFirst(),
    ).toBeUndefined();
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['details', 'reason'])
      .where('target_id', '=', me.personId)
      .where('action', '=', 'identity.add_contact_point')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('old number');
    expect(audit.details).toMatchObject({ operation: 'remove', kind: 'phone', value: '***2222' });
    expect(JSON.stringify(audit.details)).not.toContain('5551112222');
    // with a second verified contact the first may go
    await createContactPointFixture(t, {
      personId: me.personId,
      kind: 'phone',
      value: '+15553334444',
      verified: true,
    });
    const now = await t.http
      .post(`/v1/people/${me.personId}/contact-points/${verified}/remove`)
      .set(me.header)
      .set('Idempotency-Key', key())
      .send({});
    expect(now.status).toBe(200);
  });

  it('a guardian holding register manages a child contact point; one holding only view cannot', async () => {
    const withRegister = await createOrganizationPeople(t, {
      guardianPermissions: ['view', 'register'],
    });
    const cp = await createContactPointFixture(t, {
      personId: withRegister.child.personId,
      kind: 'email',
      value: `kid-${newId()}@example.test`,
      isPrimary: false,
    });
    const ok = await t.http
      .post(`/v1/people/${withRegister.child.personId}/contact-points/${cp}/make-primary`)
      .set(await authHeaderForPerson(t, withRegister.adult.personId))
      .set('Idempotency-Key', key())
      .send({});
    expect(ok.status).toBe(200);
    const viewOnly = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const cp2 = await createContactPointFixture(t, {
      personId: viewOnly.child.personId,
      kind: 'email',
      value: `kid2-${newId()}@example.test`,
      isPrimary: false,
    });
    const denied = await t.http
      .post(`/v1/people/${viewOnly.child.personId}/contact-points/${cp2}/remove`)
      .set(await authHeaderForPerson(t, viewOnly.adult.personId))
      .set('Idempotency-Key', key())
      .send({});
    expect(denied.status).toBe(404);
  });
});
