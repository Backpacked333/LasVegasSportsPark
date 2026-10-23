import { newId, type StaffRole } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

describe('people endpoints (SPK-IAM-001, SPK-IAM-002, SPK-IAM-007, §4.9, §4.10)', () => {
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

  const staffHeader = async (roles: StaffRole[]) => {
    const staff = await createStaffMemberFixture(t, { roles });
    return authHeaderForPerson(t, staff.personId);
  };

  it('SPK-IAM-001: staff role matrix for POST /v1/people', async () => {
    for (const role of [
      'front_desk',
      'program_manager',
      'league_manager',
      'system_administrator',
    ] as const) {
      const res = await t.http
        .post('/v1/people')
        .set(await staffHeader([role]))
        .set('Idempotency-Key', key())
        .send({ kind: 'adult', givenName: 'Pat', familyName: 'Doe', dateOfBirth: '1990-01-01' });
      expect(res.status, role).toBe(201);
      expect(res.body).toMatchObject({
        kind: 'adult',
        status: 'active',
        revision: 1,
        dateOfBirth: '1990-01-01',
      });
    }
    for (const role of ['coach', 'official', 'finance_operator', 'scheduler'] as const) {
      const res = await t.http
        .post('/v1/people')
        .set(await staffHeader([role]))
        .set('Idempotency-Key', key())
        .send({ kind: 'adult', givenName: 'Pat', familyName: 'Doe' });
      expect(res.status, role).toBe(403);
      expect(res.body.code).toBe('ACCESS_DENIED');
    }
  });

  it('§4.5: the declared kind must agree with the date of birth', async () => {
    const res = await t.http
      .post('/v1/people')
      .set(await staffHeader(['front_desk']))
      .set('Idempotency-Key', key())
      .send({ kind: 'adult', givenName: 'Kid', familyName: 'Doe', dateOfBirth: '2020-05-05' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { derivedKind: 'child' },
    });
  });

  it('§4.9: POST /v1/people replays on the same idempotency key without creating a second person', async () => {
    const header = await staffHeader(['front_desk']);
    const body = {
      kind: 'child',
      givenName: 'Sam',
      familyName: 'Replay',
      dateOfBirth: '2017-02-03',
    };
    const k = key();
    const first = await t.http.post('/v1/people').set(header).set('Idempotency-Key', k).send(body);
    const replay = await t.http.post('/v1/people').set(header).set('Idempotency-Key', k).send(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    const rows = await t.db
      .selectFrom('persons')
      .select('id')
      .where('family_name', '=', 'Replay')
      .execute();
    expect(rows).toHaveLength(1);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', first.body.id)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['identity.create_person']);
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', first.body.id)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['identity.person_created']);
  });

  it('SPK-IAM-002/003: GET /v1/people/{id} is visible to self, guardians holding view and staff; strangers get NOT_FOUND', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const stranger = await createOrganizationPeople(t, { guardianPermissions: ['collect'] });
    const url = `/v1/people/${people.child.personId}`;

    const guardian = await t.http.get(url).set(await authHeaderForPerson(t, people.adult.personId));
    expect(guardian.status).toBe(200);
    expect(guardian.body).toMatchObject({ id: people.child.personId, kind: 'child' });

    const self = await t.http
      .get(`/v1/people/${people.adult.personId}`)
      .set(await authHeaderForPerson(t, people.adult.personId));
    expect(self.status).toBe(200);

    const staff = await t.http.get(url).set(await authHeaderForPerson(t, people.staff.personId));
    expect(staff.status).toBe(200);

    const other = await t.http.get(url).set(await authHeaderForPerson(t, stranger.adult.personId));
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('NOT_FOUND');

    const missing = await t.http
      .get(`/v1/people/${newId()}`)
      .set(await authHeaderForPerson(t, people.staff.personId));
    expect(missing.status).toBe(404);
  });

  it('SPK-IAM-003: a guardian holding only collect cannot read the child (no implied view)', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['collect'] });
    const res = await t.http
      .get(`/v1/people/${people.child.personId}`)
      .set(await authHeaderForPerson(t, people.adult.personId));
    expect(res.status).toBe(404);
  });

  it('§4.9: PATCH /v1/people/{id} requires the current revision and bumps it', async () => {
    const people = await createOrganizationPeople(t);
    const header = await authHeaderForPerson(t, people.adult.personId);
    const url = `/v1/people/${people.adult.personId}`;
    const ok = await t.http
      .patch(url)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ givenName: 'Renamed', expectedRevision: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ givenName: 'Renamed', revision: 2 });
    const stale = await t.http
      .patch(url)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ givenName: 'Again', expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'STALE_REVISION',
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    const missingRevision = await t.http
      .patch(url)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ givenName: 'NoRev' });
    expect(missingRevision.status).toBe(400);
    const customerStatus = await t.http
      .patch(url)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ status: 'inactive', expectedRevision: 2 });
    expect(customerStatus.status).toBe(403);
  });

  it('SPK-IAM-001: an adult customer may create a child record (self-service) but not an adult, and cannot mark contacts verified', async () => {
    const people = await createOrganizationPeople(t);
    const header = await authHeaderForPerson(t, people.adult.personId);
    const child = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'child', givenName: 'New', familyName: 'Kid', dateOfBirth: '2018-08-08' });
    expect(child.status).toBe(201);
    const row = await t.db
      .selectFrom('persons')
      .select(['source', 'created_by_person_id'])
      .where('id', '=', child.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ source: 'self_service', created_by_person_id: people.adult.personId });
    // creation alone confers no authority (SPK-IAM-001: nothing is implied)
    const read = await t.http.get(`/v1/people/${child.body.id}`).set(header);
    expect(read.status).toBe(404);

    const adult = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'adult', givenName: 'Other', familyName: 'Adult' });
    expect(adult.status).toBe(403);
    const verified = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        kind: 'child',
        givenName: 'V',
        familyName: 'Kid',
        contactPoints: [{ kind: 'email', value: 'v@example.test', verified: true }],
      });
    expect(verified.status).toBe(403);
    const unlinked = await createAccountFixture(t, { personId: null });
    const noPerson = await t.http
      .post('/v1/people')
      .set(await authHeaderForAccount(t, unlinked.id))
      .set('Idempotency-Key', key())
      .send({ kind: 'child', givenName: 'X', familyName: 'Y' });
    expect(noPerson.status).toBe(403);
  });

  it('SPK-IAM-007: creating a person with the same name and date of birth produces a duplicate candidate, never a merge', async () => {
    const header = await staffHeader(['front_desk']);
    const body = {
      kind: 'child',
      givenName: 'Twin',
      familyName: 'Dupe',
      dateOfBirth: '2015-01-02',
    };
    const a = await t.http.post('/v1/people').set(header).set('Idempotency-Key', key()).send(body);
    const b = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        ...body,
        givenName: 'twin',
      });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
    const candidates = await t.db
      .selectFrom('duplicate_candidates')
      .selectAll()
      .where('person_a_id', 'in', [a.body.id, b.body.id])
      .execute();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      status: 'open',
      reasons: ['same_name_and_date_of_birth'],
      score: 80,
    });
    expect(new Set([candidates[0]?.person_a_id, candidates[0]?.person_b_id])).toEqual(
      new Set([a.body.id, b.body.id]),
    );
  });

  it('SPK-IAM-001: contact points — primaries are exclusive per kind and verified identifiers are unique', async () => {
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const url = `/v1/people/${people.adult.personId}/contact-points`;
    const first = await t.http
      .post(url)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'email', value: 'Parent@Example.test', isPrimary: true, verified: true });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ value: 'parent@example.test', isPrimary: true });
    expect(first.body.verifiedAt).not.toBeNull();
    const second = await t.http
      .post(url)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'email', value: 'second@example.test', isPrimary: true });
    expect(second.status).toBe(201);
    const primaries = await t.db
      .selectFrom('contact_points')
      .select(['value', 'is_primary'])
      .where('person_id', '=', people.adult.personId)
      .orderBy('created_at')
      .execute();
    expect(primaries.map((p) => p.is_primary)).toEqual([false, true]);

    const other = await createPersonFixture(t, { kind: 'adult' });
    const clash = await t.http
      .post(`/v1/people/${other}/contact-points`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'email', value: 'second@example.test', isPrimary: true, verified: true });
    expect(clash.status).toBe(201); // second@ is primary but unverified on the first person
    const clash2 = await t.http
      .post(url)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'email', value: 'second@example.test', isPrimary: true, verified: true });
    expect(clash2.status).toBe(409);
    expect(clash2.body.code).toBe('RESOURCE_CONFLICT');

    const customerVerified = await t.http
      .post(url)
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send({ kind: 'phone', value: '+1 702 555 0100', verified: true });
    expect(customerVerified.status).toBe(403);
  });
});
