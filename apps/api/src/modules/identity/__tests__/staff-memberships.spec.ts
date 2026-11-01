import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { StaffMembershipsService } from '../services/staff-memberships.service';
import {
  authHeaderForAccount,
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

  it('SPK-STAFF-004 / SPK-IAM-006: ending a future-dated staff membership succeeds and it never takes effect', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const service = t.app.get(StaffMembershipsService);
    for (const effectiveToDays of [null, 14] as const) {
      const person = await createPersonFixture(t, { kind: 'adult' });
      await createAccountFixture(t, { personId: person });
      const effectiveFrom = new Date(t.clock.now().getTime() + 7 * 86_400_000).toISOString();
      const created = await t.http
        .post('/v1/staff-memberships')
        .set(header)
        .set('Idempotency-Key', key())
        .send({
          personId: person,
          roles: ['official'],
          effectiveFrom,
          ...(effectiveToDays
            ? {
                effectiveTo: new Date(
                  t.clock.now().getTime() + effectiveToDays * 86_400_000,
                ).toISOString(),
              }
            : {}),
        });
      expect(created.status).toBe(201);
      const ended = await t.http
        .post(`/v1/staff-memberships/${created.body.id}/end`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({ reason: 'assignment withdrawn before it started' });
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({
        status: 'ended',
        effectiveFrom,
        effectiveTo: effectiveFrom,
        revision: 2,
      });
      const audit = await t.db
        .selectFrom('audit_records')
        .select('reason')
        .where('target_id', '=', created.body.id)
        .execute();
      expect(audit.map((a) => a.reason)).toContain('assignment withdrawn before it started');
      const events = await t.db
        .selectFrom('outbox_events')
        .select('payload')
        .where('aggregate_id', '=', created.body.id)
        .orderBy('occurred_at')
        .execute();
      expect(events.map((e) => (e.payload as { status: string }).status)).toEqual([
        'active',
        'ended',
      ]);
      // the window it would have opened grants nothing
      const clockAt = t.clock.now();
      t.clock.set(new Date(new Date(effectiveFrom).getTime() + 3600_000));
      const me = await t.http.get('/v1/me').set(await authHeaderForPerson(t, person));
      expect(me.body.principal.kind).toBe('customer');
      expect(await service.staffWithRole(t.organizationId, 'official')).not.toContain(person);
      t.clock.set(clockAt);
    }
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

  // ------------------------------------------------------------------------------------------
  // R3-SECURITY-01: a system administrator acts only within its own facility scope (§2.1 staff
  // assignment scope, §4.3 facility boundaries, §4.14 least privilege).
  // ------------------------------------------------------------------------------------------

  /** A second facility of the organization. */
  const seedFacility = async (): Promise<string> => {
    const id = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id,
        organization_id: t.organizationId,
        slug: `annex-${id.slice(-12)}`,
        name: 'Annex',
        timezone: 'America/Los_Angeles',
        address: null,
      })
      .execute();
    return id;
  };

  it('§2.1 / §4.14: a facility-scoped system administrator cannot widen its own scope or grant roles elsewhere', async () => {
    const f1 = t.facilityId;
    const f2 = await seedFacility();
    const alice = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      facilityIds: [f1],
    });
    const header = await authHeaderForPerson(t, alice.personId);
    const widen = (facilityIds: string[], personId = alice.personId) =>
      t.http
        .post('/v1/staff-memberships')
        .set(header)
        .set('Idempotency-Key', key())
        .send({
          personId,
          roles: ['system_administrator', 'general_manager', 'finance_operator'],
          facilityIds,
        });
    for (const facilityIds of [[], [f2], [f1, f2]]) {
      const refused = await widen(facilityIds);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.code).toBe('ACCESS_DENIED');
    }
    const someone = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: someone });
    expect((await widen([], someone)).status).toBe(403);
    expect((await widen([f2], someone)).status).toBe(403);
    expect(
      await t.db
        .selectFrom('staff_memberships')
        .select('id')
        .where('person_id', 'in', [alice.personId, someone])
        .where('id', '<>', alice.membershipId)
        .execute(),
    ).toEqual([]);
    const me = await t.http.get('/v1/me').set(header);
    expect(me.body.principal).toMatchObject({
      staffRoles: ['system_administrator'],
      facilityIds: [f1],
    });

    // within its own facility it still administers staff
    const atF1 = await widen([f1], someone);
    expect(atF1.status, JSON.stringify(atF1.body)).toBe(201);
    expect(atF1.body).toMatchObject({ personId: someone, facilityIds: [f1] });
    // an organization-wide administrator may assign organization-wide roles
    const root = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const wide = await t.http
      .post('/v1/staff-memberships')
      .set(await authHeaderForPerson(t, root.personId))
      .set('Idempotency-Key', key())
      .send({ personId: someone, roles: ['general_manager'], facilityIds: [] });
    expect(wide.status, JSON.stringify(wide.body)).toBe(201);
  });

  it('§2.1 / §4.14: a facility-scoped system administrator cannot change or end memberships reaching another facility', async () => {
    const f1 = t.facilityId;
    const f2 = await seedFacility();
    const alice = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      facilityIds: [f1],
    });
    const header = await authHeaderForPerson(t, alice.personId);
    const bob = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      facilityIds: [f2],
    });
    const gm = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    const desk = await createStaffMemberFixture(t, { roles: ['front_desk'], facilityIds: [f1] });
    const patch = (id: string, body: Record<string, unknown>) =>
      t.http
        .patch(`/v1/staff-memberships/${id}`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({ expectedRevision: 1, ...body });
    const end = (id: string) =>
      t.http
        .post(`/v1/staff-memberships/${id}/end`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({ reason: 'not yours to end', expectedRevision: 1 });

    // another facility's administrator and an organization-wide manager are out of reach
    for (const id of [bob.membershipId, gm.membershipId]) {
      expect((await end(id)).status).toBe(403);
      expect((await patch(id, { roles: ['coach'] })).status).toBe(403);
    }
    // its own membership and an F1 membership cannot be widened beyond F1
    expect((await patch(alice.membershipId, { facilityIds: [] })).status).toBe(403);
    expect((await patch(alice.membershipId, { facilityIds: [f1, f2] })).status).toBe(403);
    expect((await patch(desk.membershipId, { facilityIds: [f2] })).status).toBe(403);
    const rows = await t.db
      .selectFrom('staff_memberships')
      .select(['status', 'revision'])
      .where('id', 'in', [alice.membershipId, bob.membershipId, gm.membershipId, desk.membershipId])
      .orderBy('id')
      .execute();
    expect(rows.every((r) => r.status === 'active' && r.revision === 1)).toBe(true);
    // nothing refused was audited (the fixtures write memberships without an audit record)
    expect(
      await t.db
        .selectFrom('audit_records')
        .select('id')
        .where('target_id', 'in', [
          alice.membershipId,
          bob.membershipId,
          gm.membershipId,
          desk.membershipId,
        ])
        .execute(),
    ).toEqual([]);

    // within F1 it changes and ends memberships
    const changed = await patch(desk.membershipId, { roles: ['front_desk', 'scheduler'] });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ roles: ['front_desk', 'scheduler'], facilityIds: [f1] });
    const ended = await t.http
      .post(`/v1/staff-memberships/${desk.membershipId}/end`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ reason: 'left the desk', expectedRevision: 2 });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
  });

  it('§4.14 / SPK-AT-025: a facility-scoped system administrator cannot take over staff logins outside its facilities', async () => {
    const f1 = t.facilityId;
    const f2 = await seedFacility();
    const alice = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      facilityIds: [f1],
    });
    const header = await authHeaderForPerson(t, alice.personId);
    const root = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const rootHeader = await authHeaderForPerson(t, root.personId);
    const relink = (accountId: string) =>
      t.http
        .post(`/v1/accounts/${accountId}/relink`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({
          issuer: t.config.AUTH_ISSUER,
          subject: `attacker-${newId()}`,
          reason: 'lost phone',
          expectedRevision: 1,
        });

    // recovery: an organization-wide manager and another facility's staff are refused, F1 staff not
    const gm = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    const atF2 = await createStaffMemberFixture(t, { roles: ['front_desk'], facilityIds: [f2] });
    const both = await createStaffMemberFixture(t, { roles: ['front_desk'], facilityIds: [f1] });
    await createStaffMemberFixture(t, {
      personId: both.personId,
      roles: ['coach'],
      facilityIds: [f2],
    });
    for (const accountId of [gm.accountId, atF2.accountId, both.accountId]) {
      const refused = await relink(accountId);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.code).toBe('ACCESS_DENIED');
    }
    const subjects = await t.db
      .selectFrom('accounts')
      .select(['revision'])
      .where('id', 'in', [gm.accountId, atF2.accountId, both.accountId])
      .execute();
    expect(subjects.every((a) => a.revision === 1)).toBe(true);
    const deskF1 = await createStaffMemberFixture(t, { roles: ['front_desk'], facilityIds: [f1] });
    expect((await relink(deskF1.accountId)).status).toBe(200);

    // provisioning: the login of an organization-wide manager without an account
    const newHire = await createPersonFixture(t, { kind: 'adult' });
    const hired = await t.http
      .post('/v1/staff-memberships')
      .set(rootHeader)
      .set('Idempotency-Key', key())
      .send({ personId: newHire, roles: ['general_manager'], facilityIds: [] });
    expect(hired.status).toBe(201);
    const provisioned = await t.http
      .post('/v1/accounts')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ issuer: t.config.AUTH_ISSUER, subject: `attacker-${newId()}`, personId: newHire });
    expect(provisioned.status, JSON.stringify(provisioned.body)).toBe(403);
    // self claim at issue
    const claimed = await t.http
      .post(`/v1/people/${newHire}/claims`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(403);
    expect(
      await t.db.selectFrom('accounts').select('id').where('person_id', '=', newHire).execute(),
    ).toEqual([]);

    // self claim issued before the person became organization-wide staff: refused at acceptance
    const walkIn = await createPersonFixture(t, { kind: 'adult' });
    const issued = await t.http
      .post(`/v1/people/${walkIn}/claims`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(issued.status).toBe(201);
    const promoted = await t.http
      .post('/v1/staff-memberships')
      .set(rootHeader)
      .set('Idempotency-Key', key())
      .send({ personId: walkIn, roles: ['finance_operator'], facilityIds: [] });
    expect(promoted.status).toBe(201);
    const claimant = await createAccountFixture(t, { personId: null });
    const accepted = await t.http
      .post('/v1/claims/accept')
      .set(await authHeaderForAccount(t, claimant.id))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(403);
    const unlinked = await t.db
      .selectFrom('accounts')
      .select('person_id')
      .where('id', '=', claimant.id)
      .executeTakeFirstOrThrow();
    expect(unlinked.person_id).toBeNull();

    // the same claim issued by that administrator for a person who becomes F1 staff is honoured
    const local = await createPersonFixture(t, { kind: 'adult' });
    const localClaim = await t.http
      .post(`/v1/people/${local}/claims`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(localClaim.status).toBe(201);
    const localHire = await t.http
      .post('/v1/staff-memberships')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personId: local, roles: ['front_desk'], facilityIds: [f1] });
    expect(localHire.status).toBe(201);
    const localClaimant = await createAccountFixture(t, { personId: null });
    const localAccepted = await t.http
      .post('/v1/claims/accept')
      .set(await authHeaderForAccount(t, localClaimant.id))
      .set('Idempotency-Key', key())
      .send({ token: localClaim.body.token });
    expect(localAccepted.status, JSON.stringify(localAccepted.body)).toBe(200);
    expect(localAccepted.body).toMatchObject({ personId: local });
  });

  it('§4.14 / SPK-IAM-007: a facility-scoped system administrator cannot merge away an organization-wide staff record', async () => {
    const alice = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      facilityIds: [t.facilityId],
    });
    const header = await authHeaderForPerson(t, alice.personId);
    const gm = await createStaffMemberFixture(t, { roles: ['general_manager'] });
    const mine = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: mine });
    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: gm.personId, personBId: mine, reasons: ['same name'] });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
    for (const survivorPersonId of [mine, gm.personId]) {
      const merged = await t.http
        .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({ survivorPersonId, reason: 'same person' });
      expect(merged.status, JSON.stringify(merged.body)).toBe(403);
      expect(merged.body.code).toBe('ACCESS_DENIED');
    }
    const membership = await t.db
      .selectFrom('staff_memberships')
      .select('person_id')
      .where('id', '=', gm.membershipId)
      .executeTakeFirstOrThrow();
    expect(membership.person_id).toBe(gm.personId);
    const persons = await t.db
      .selectFrom('persons')
      .select('status')
      .where('id', 'in', [gm.personId, mine])
      .execute();
    expect(persons.map((p) => p.status)).toEqual(['active', 'active']);
  });

  it('§4.14 / SPK-AT-025: changing the person status of staff needs the authority over their memberships, both ways', async () => {
    const f2 = await seedFacility();
    const alice = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      facilityIds: [t.facilityId],
    });
    const deskF1 = await createStaffMemberFixture(t, {
      roles: ['front_desk'],
      facilityIds: [t.facilityId],
    });
    const deskF2 = await createStaffMemberFixture(t, { roles: ['front_desk'], facilityIds: [f2] });
    const root = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const target = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const aliceHeader = await authHeaderForPerson(t, alice.personId);
    const rootHeader = await authHeaderForPerson(t, root.personId);
    const targetHeader = await authHeaderForPerson(t, target.personId);
    const setStatus = async (
      header: Record<string, string>,
      personId: string,
      status: 'active' | 'inactive',
      expectedRevision: number,
    ) =>
      t.http
        .patch(`/v1/people/${personId}`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({ status, expectedRevision, reason: 'access review' });
    const personRow = (personId: string) =>
      t.db
        .selectFrom('persons')
        .select(['status', 'revision'])
        .where('id', '=', personId)
        .executeTakeFirstOrThrow();

    // deactivating an organization-wide administrator: a facility-scoped administrator and a
    // front desk (here or at another facility) are refused, and the administrator keeps access
    for (const header of [
      aliceHeader,
      await authHeaderForPerson(t, deskF1.personId),
      await authHeaderForPerson(t, deskF2.personId),
    ]) {
      const refused = await setStatus(header, target.personId, 'inactive', 1);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.code).toBe('ACCESS_DENIED');
    }
    expect(await personRow(target.personId)).toEqual({ status: 'active', revision: 1 });
    expect((await t.http.get('/v1/me').set(targetHeader)).status).toBe(200);

    // an organization-wide administrator deactivates it; staff authority ends on the next request
    const off = await setStatus(rootHeader, target.personId, 'inactive', 1);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await t.http.get('/v1/me').set(targetHeader)).status).toBe(401);

    // reactivating it is refused to the same callers, so the deactivation holds
    for (const header of [
      aliceHeader,
      await authHeaderForPerson(t, deskF1.personId),
      await authHeaderForPerson(t, deskF2.personId),
    ]) {
      const refused = await setStatus(header, target.personId, 'active', 2);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.code).toBe('ACCESS_DENIED');
    }
    expect(await personRow(target.personId)).toEqual({ status: 'inactive', revision: 2 });
    expect((await t.http.get('/v1/me').set(targetHeader)).status).toBe(401);
    const on = await setStatus(rootHeader, target.personId, 'active', 2);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const me = await t.http.get('/v1/me').set(targetHeader);
    expect(me.status).toBe(200);
    expect(me.body.principal).toMatchObject({
      staffRoles: ['system_administrator'],
      facilityIds: [],
    });

    // within its own facilities the scoped administrator still does it; a front desk still
    // changes the status of a person who holds no staff membership
    const local = await setStatus(aliceHeader, deskF1.personId, 'inactive', 1);
    expect(local.status, JSON.stringify(local.body)).toBe(200);
    const customer = await createPersonFixture(t, { kind: 'adult' });
    const plain = await setStatus(
      await authHeaderForPerson(t, deskF2.personId),
      customer,
      'inactive',
      1,
    );
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
  });

  it('§4.14 / SPK-AT-025: a staff membership past its end date but never ended still guards the login and the merge', async () => {
    const day = 86_400_000;
    const now = t.clock.now().getTime();
    const lapsed = await createStaffMemberFixture(t, {
      roles: ['general_manager'],
      effectiveFrom: new Date(now - 30 * day),
      effectiveTo: new Date(now - day),
    });
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const alice = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      facilityIds: [t.facilityId],
    });
    const deskF1 = await createStaffMemberFixture(t, {
      roles: ['front_desk'],
      facilityIds: [t.facilityId],
    });
    const root = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const aliceHeader = await authHeaderForPerson(t, alice.personId);
    const lapsedHeader = await authHeaderForPerson(t, lapsed.personId);
    // the membership confers nothing today, but it is not ended
    const before = await t.http.get('/v1/me').set(lapsedHeader);
    expect(before.status).toBe(200);
    expect(before.body.principal.staffRoles).toEqual([]);

    // recovery onto another identity needs an organization-wide administrator
    const relinked = await t.http
      .post(`/v1/accounts/${lapsed.accountId}/relink`)
      .set(await authHeaderForPerson(t, support.personId))
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: `attacker-${newId()}`,
        reason: 'lost phone',
        expectedRevision: 1,
      });
    expect(relinked.status, JSON.stringify(relinked.body)).toBe(403);
    expect(relinked.body.code).toBe('ACCESS_DENIED');
    const account = await t.db
      .selectFrom('accounts')
      .select('revision')
      .where('id', '=', lapsed.accountId)
      .executeTakeFirstOrThrow();
    expect(account.revision).toBe(1);

    // a person status change and a merge by a facility-scoped administrator are refused too
    const deactivated = await t.http
      .patch(`/v1/people/${lapsed.personId}`)
      .set(await authHeaderForPerson(t, deskF1.personId))
      .set('Idempotency-Key', key())
      .send({ status: 'inactive', expectedRevision: 1 });
    expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(403);
    const mine = await createPersonFixture(t, { kind: 'adult' });
    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(aliceHeader)
      .set('Idempotency-Key', key())
      .send({ personAId: lapsed.personId, personBId: mine, reasons: ['same name'] });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
    for (const survivorPersonId of [mine, lapsed.personId]) {
      const merged = await t.http
        .post(`/v1/duplicate-candidates/${flagged.body.id}/merge`)
        .set(aliceHeader)
        .set('Idempotency-Key', key())
        .send({ survivorPersonId, reason: 'same person' });
      expect(merged.status, JSON.stringify(merged.body)).toBe(403);
      expect(merged.body.code).toBe('ACCESS_DENIED');
    }
    const membership = await t.db
      .selectFrom('staff_memberships')
      .select(['person_id', 'status'])
      .where('id', '=', lapsed.membershipId)
      .executeTakeFirstOrThrow();
    expect(membership).toEqual({ person_id: lapsed.personId, status: 'active' });

    // reopening it hands the role back to the login that held it all along
    const reopened = await t.http
      .patch(`/v1/staff-memberships/${lapsed.membershipId}`)
      .set(await authHeaderForPerson(t, root.personId))
      .set('Idempotency-Key', key())
      .send({ effectiveTo: null, expectedRevision: 1, reason: 'next season' });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const after = await t.http.get('/v1/me').set(lapsedHeader);
    expect(after.body.principal.staffRoles).toEqual(['general_manager']);

    // once ended, the membership no longer guards the login: support may recover it
    const ended = await createStaffMemberFixture(t, { roles: ['finance_operator'] });
    const end = await t.http
      .post(`/v1/staff-memberships/${ended.membershipId}/end`)
      .set(await authHeaderForPerson(t, root.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'left', expectedRevision: 1 });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    const recovered = await t.http
      .post(`/v1/accounts/${ended.accountId}/relink`)
      .set(await authHeaderForPerson(t, support.personId))
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: `recovered-${newId()}`,
        reason: 'lost phone',
        expectedRevision: 1,
      });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
  });
});
