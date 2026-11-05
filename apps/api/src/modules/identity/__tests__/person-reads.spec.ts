import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import {
  authHeaderForPerson,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

describe('person names and staff person search (ID-02; SPK-IAM-002, SPK-IAM-003, §4.10, §4.14)', () => {
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

  it('SPK-IAM-002 / §4.14: person names omit date of birth and contacts and leave out people the caller may not view', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const stranger = await createPersonFixture(t, {
      kind: 'child',
      givenName: 'Stranger',
      familyName: 'Child',
    });
    await createContactPointFixture(t, {
      personId: family.child.personId,
      kind: 'email',
      value: 'child@example.test',
    });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const ids = [family.child.personId, stranger, family.adult.personId, newId()];
    const res = await t.http.get(`/v1/person-names?ids=${ids.join(',')}`).set(parent);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { personId: string }) => i.personId)).toEqual([
      family.child.personId,
      family.adult.personId,
    ]);
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'canonicalPersonId',
        'displayName',
        'familyName',
        'givenName',
        'kind',
        'personId',
      ]);
    }
    expect(JSON.stringify(res.body)).not.toContain('child@example.test');
    expect(JSON.stringify(res.body)).not.toContain('2016-09-03');
    // repeated ids work too, and a stranger's name is never revealed by a 404
    const repeated = await t.http
      .get(`/v1/person-names?ids=${stranger}&ids=${family.child.personId}`)
      .set(parent);
    expect(repeated.status).toBe(200);
    expect(repeated.body.items).toHaveLength(1);
    // staff with identity.read_person see both
    const desk = await authHeaderForPerson(t, family.staff.personId);
    const staffView = await t.http.get(`/v1/person-names?ids=${ids.join(',')}`).set(desk);
    expect(staffView.body.items).toHaveLength(3);
    // bounds: 1..100 ids
    expect((await t.http.get('/v1/person-names?ids=').set(parent)).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => newId()).join(',');
    expect((await t.http.get(`/v1/person-names?ids=${tooMany}`).set(parent)).status).toBe(400);
  });

  it('a merged person is named with its survivor as canonicalPersonId when the caller may view the survivor', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const old = await createPersonFixture(t, {
      kind: 'child',
      givenName: 'Old',
      familyName: 'Rec',
    });
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: family.child.personId })
      .where('id', '=', old)
      .execute();
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const res = await t.http.get(`/v1/person-names?ids=${old}`).set(parent);
    expect(res.body.items).toEqual([
      {
        personId: old,
        canonicalPersonId: family.child.personId,
        givenName: 'Old',
        familyName: 'Rec',
        displayName: 'Old Rec',
        kind: 'child',
      },
    ]);
  });

  it('staff person search finds by name prefix and by exact contact without returning dates of birth', async () => {
    const tag = `Zq${newId().slice(-6)}`;
    const ann = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Annabel',
      familyName: tag,
    });
    const bob = await createPersonFixture(t, { kind: 'child', givenName: 'Bob', familyName: tag });
    const other = await createPersonFixture(t, {
      kind: 'adult',
      givenName: tag,
      familyName: 'Other',
    });
    await createContactPointFixture(t, {
      personId: ann,
      kind: 'email',
      value: `${tag}.ann@example.test`,
    });
    await createContactPointFixture(t, { personId: bob, kind: 'phone', value: '+15550001234' });
    const desk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const header = await authHeaderForPerson(t, desk.personId);

    const byFamily = await t.http
      .get(`/v1/people?query=${tag.toLowerCase().slice(0, 5)}`)
      .set(header);
    expect(byFamily.status).toBe(200);
    // keyset order: lower(family_name), lower(given_name), id
    expect(byFamily.body.items.map((i: { id: string }) => i.id)).toEqual([other, ann, bob]);
    for (const item of byFamily.body.items) {
      expect(item).not.toHaveProperty('dateOfBirth');
      expect(item).not.toHaveProperty('contactPoints');
      expect(item.matchedOn).toBe('name');
    }
    const fullName = await t.http
      .get(`/v1/people?query=${encodeURIComponent(`ann ${tag}`)}`)
      .set(header);
    expect(fullName.body.items.map((i: { id: string }) => i.id)).toEqual([ann]);
    const byEmail = await t.http
      .get(`/v1/people?query=${encodeURIComponent(`${tag.toUpperCase()}.ANN@example.test`)}`)
      .set(header);
    expect(byEmail.body.items).toEqual([
      {
        id: ann,
        givenName: 'Annabel',
        familyName: tag,
        kind: 'adult',
        status: 'active',
        matchedOn: 'contact',
      },
    ]);
    const byPhone = await t.http
      .get(`/v1/people?query=${encodeURIComponent('+1 (555) 000-1234')}`)
      .set(header);
    expect(byPhone.body.items.map((i: { id: string }) => i.id)).toEqual([bob]);
    // a contact is matched exactly, never as a prefix
    const partial = await t.http.get(`/v1/people?query=%2B1555000`).set(header);
    expect(partial.body.items).toEqual([]);
    // filters and paging
    const children = await t.http.get(`/v1/people?query=${tag}&kind=child`).set(header);
    expect(children.body.items.map((i: { id: string }) => i.id)).toEqual([bob]);
    const first = await t.http.get(`/v1/people?query=${tag}&limit=2`).set(header);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await t.http
      .get(`/v1/people?query=${tag}&limit=2&cursor=${first.body.nextCursor}`)
      .set(header);
    expect(second.body.items.map((i: { id: string }) => i.id)).toEqual([bob]);
    expect(second.body.nextCursor).toBeNull();
    // LIKE wildcards are literal
    expect((await t.http.get('/v1/people?query=%25%25').set(header)).body.items).toEqual([]);
    // query bounds
    expect((await t.http.get('/v1/people?query=a').set(header)).status).toBe(400);
  });

  it('merged persons are listed only with status=merged', async () => {
    const tag = `Mx${newId().slice(-6)}`;
    const survivor = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Sam',
      familyName: tag,
    });
    const merged = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Sam',
      familyName: tag,
    });
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: survivor })
      .where('id', '=', merged)
      .execute();
    const desk = await createStaffMemberFixture(t, { roles: ['league_manager'] });
    const header = await authHeaderForPerson(t, desk.personId);
    const active = await t.http.get(`/v1/people?query=${tag}`).set(header);
    expect(active.body.items.map((i: { id: string }) => i.id)).toEqual([survivor]);
    const onlyMerged = await t.http.get(`/v1/people?query=${tag}&status=merged`).set(header);
    expect(onlyMerged.body.items.map((i: { id: string }) => i.id)).toEqual([merged]);
  });

  it('identity.lookup_person: coaches, officials and customers cannot search people', async () => {
    const family = await createOrganizationPeople(t);
    const coach = await createStaffMemberFixture(t, { roles: ['coach', 'official'] });
    for (const personId of [coach.personId, family.adult.personId]) {
      const res = await t.http
        .get('/v1/people?query=Adult')
        .set(await authHeaderForPerson(t, personId));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCESS_DENIED');
    }
  });
});
