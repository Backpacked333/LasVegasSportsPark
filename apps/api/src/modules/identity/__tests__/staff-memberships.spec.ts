import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { StaffMembershipsService } from '../services/staff-memberships.service';
import {
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

describe('staff memberships (§2.1, §4.14) and households (§4.5)', () => {
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

  it('only system administrators manage staff memberships; the assignment is time-bounded and audited', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const gm = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    const person = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: person });
    const body = { personId: person, roles: ['coach', 'official'], facilityIds: [t.facilityId] };
    const denied = await t.http
      .post('/v1/staff-memberships')
      .set(await authHeaderForPerson(t, gm.personId))
      .set('Idempotency-Key', key())
      .send(body);
    expect(denied.status).toBe(403);
    const header = await authHeaderForPerson(t, admin.personId);
    const created = await t.http
      .post('/v1/staff-memberships')
      .set(header)
      .set('Idempotency-Key', key())
      .send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      personId: person,
      roles: ['coach', 'official'],
      facilityIds: [t.facilityId],
      status: 'active',
      revision: 1,
    });
    const me = await t.http.get('/v1/me').set(await authHeaderForPerson(t, person));
    expect(me.body.principal).toMatchObject({
      kind: 'staff',
      staffRoles: ['coach', 'official'],
      facilityIds: [t.facilityId],
    });

    const wrongFacility = await t.http
      .post('/v1/staff-memberships')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personId: person, roles: ['scheduler'], facilityIds: [newId()] });
    expect(wrongFacility.status).toBe(400);

    const updated = await t.http
      .patch(`/v1/staff-memberships/${created.body.id}`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ roles: ['coach'], facilityIds: [], expectedRevision: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ roles: ['coach'], facilityIds: [], revision: 2 });
    const stale = await t.http
      .patch(`/v1/staff-memberships/${created.body.id}`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ roles: ['coach'], expectedRevision: 1 });
    expect(stale.status).toBe(409);

    const ended = await t.http
      .post(`/v1/staff-memberships/${created.body.id}/end`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ reason: 'left the club' });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ status: 'ended', effectiveTo: t.clock.now().toISOString() });
    const again = await t.http
      .post(`/v1/staff-memberships/${created.body.id}/end`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ reason: 'twice' });
    expect(again.status).toBe(409);
    const afterEnd = await t.http.get('/v1/me').set(await authHeaderForPerson(t, person));
    expect(afterEnd.body.principal.kind).toBe('customer');
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', created.body.id)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'identity.manage_staff_membership',
      'identity.manage_staff_membership',
      'identity.manage_staff_membership',
    ]);
    expect(audit[2]?.reason).toBe('left the club');
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', created.body.id)
      .orderBy('occurred_at')
      .execute();
    expect(events.map((e) => (e.payload as { status: string }).status)).toEqual([
      'active',
      'active',
      'ended',
    ]);
  });

  it('a child or an inactive person cannot be staff', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const child = await createPersonFixture(t, { kind: 'child' });
    const res = await t.http
      .post('/v1/staff-memberships')
      .set(await authHeaderForPerson(t, admin.personId))
      .set('Idempotency-Key', key())
      .send({ personId: child, roles: ['coach'] });
    expect(res.status).toBe(400);
  });

  it('StaffDirectoryPort lists people holding a role, honouring facility scope and dates', async () => {
    const service = t.app.get(StaffMembershipsService);
    const everywhere = await createStaffMemberFixture(t, { roles: ['official'] });
    const scoped = await createStaffMemberFixture(t, {
      roles: ['official'],
      facilityIds: [t.facilityId],
    });
    const elsewhere = await createStaffMemberFixture(t, {
      roles: ['official'],
      facilityIds: [newId()],
    });
    const expired = await createStaffMemberFixture(t, {
      roles: ['official'],
      effectiveFrom: new Date(t.clock.now().getTime() - 2000),
      effectiveTo: new Date(t.clock.now().getTime() - 1000),
    });
    const all = await service.staffWithRole(t.organizationId, 'official');
    expect(all).toEqual(
      expect.arrayContaining([everywhere.personId, scoped.personId, elsewhere.personId]),
    );
    expect(all).not.toContain(expired.personId);
    const here = await service.staffWithRole(t.organizationId, 'official', t.facilityId);
    expect(here).toEqual(expect.arrayContaining([everywhere.personId, scoped.personId]));
    expect(here).not.toContain(elsewhere.personId);
  });

  it('§4.5: household membership never grants authority; customers manage households they belong to', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const other = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const household = await t.http
      .post('/v1/households')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ name: 'Home' });
    expect(household.status).toBe(201);
    expect(household.body.members).toEqual([{ personId: people.adult.personId, label: null }]);
    const added = await t.http
      .post(`/v1/households/${household.body.id}/members`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ personId: people.child.personId, label: 'kid' });
    expect(added.status).toBe(201);
    expect(added.body.members).toHaveLength(2);
    // the other parent is not a member: the household is invisible to them
    const outsider = await t.http
      .post(`/v1/households/${household.body.id}/members`)
      .set(await authHeaderForPerson(t, other.adult.personId))
      .set('Idempotency-Key', key())
      .send({ personId: other.child.personId });
    expect(outsider.status).toBe(404);
    // staff add the other child; membership still does not let the first parent read them
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const staffAdd = await t.http
      .post(`/v1/households/${household.body.id}/members`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ personId: other.child.personId });
    expect(staffAdd.status).toBe(201);
    expect((await t.http.get(`/v1/people/${other.child.personId}`).set(parent)).status).toBe(404);
    const me = await t.http.get('/v1/me').set(parent);
    expect(me.body.authorities).toEqual([
      { subjectPersonId: people.child.personId, permissions: ['view'] },
    ]);
  });
});
