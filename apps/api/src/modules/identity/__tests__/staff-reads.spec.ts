import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

/** A second facility of the organization (facility-scoped staff, §2.1). */
async function seedFacility(t: TestApp): Promise<string> {
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
}

describe('staff administration reads (ID-05; §2.1, §4.14, SPK-IAM-005, SPK-IAM-007, SPK-UX-005)', () => {
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

  it('§2.1: administrators list staff memberships by person and role; a front desk gets ACCESS_DENIED', async () => {
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const person = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Casey',
      familyName: 'Nguyen',
    });
    const desk = await createStaffMemberFixture(t, {
      personId: person,
      roles: ['front_desk'],
      facilityIds: [t.facilityId],
    });
    const coach = await createStaffMemberFixture(t, { personId: person, roles: ['coach'] });
    const byPerson = await t.http.get(`/v1/staff-memberships?personId=${person}`).set(header);
    expect(byPerson.status).toBe(200);
    expect(byPerson.body.items.map((m: { id: string }) => m.id).sort()).toEqual(
      [desk.membershipId, coach.membershipId].sort(),
    );
    expect(byPerson.body.items[0].personDisplayName).toBe('Casey Nguyen');
    const byRole = await t.http
      .get(`/v1/staff-memberships?personId=${person}&role=coach`)
      .set(header);
    expect(byRole.body.items.map((m: { id: string }) => m.id)).toEqual([coach.membershipId]);
    // covering the facility: the scoped desk membership and the organization-wide coach one
    const other = await seedFacility(t);
    const atOther = await t.http
      .get(`/v1/staff-memberships?personId=${person}&facilityId=${other}`)
      .set(header);
    expect(atOther.body.items.map((m: { id: string }) => m.id)).toEqual([coach.membershipId]);
    const single = await t.http.get(`/v1/staff-memberships/${desk.membershipId}`).set(header);
    expect(single.body).toMatchObject({
      id: desk.membershipId,
      roles: ['front_desk'],
      facilityIds: [t.facilityId],
      status: 'active',
      revision: 1,
    });
    expect((await t.http.get(`/v1/staff-memberships/${newId()}`).set(header)).status).toBe(404);
    const deskHeader = await authHeaderForPerson(t, person);
    const denied = await t.http.get('/v1/staff-memberships').set(deskHeader);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ACCESS_DENIED');
    expect(
      (await t.http.get(`/v1/staff-memberships/${desk.membershipId}`).set(deskHeader)).status,
    ).toBe(403);
  });

  it('the staff directory lists staff in effect now with per-role facility scopes; coaches and officials only for staffing roles', async () => {
    const tag = `Dir${newId().slice(-6)}`;
    const deskPerson = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Ada',
      familyName: tag,
    });
    await createStaffMemberFixture(t, {
      personId: deskPerson,
      roles: ['front_desk'],
      facilityIds: [t.facilityId],
    });
    await createStaffMemberFixture(t, { personId: deskPerson, roles: ['coach'] });
    const coachOnly = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Ben',
      familyName: tag,
    });
    await createStaffMemberFixture(t, { personId: coachOnly, roles: ['coach', 'official'] });
    const future = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Cy',
      familyName: tag,
    });
    await createStaffMemberFixture(t, {
      personId: future,
      roles: ['scheduler'],
      effectiveFrom: new Date(t.clock.now().getTime() + 86_400_000),
    });
    const finance = await createStaffMemberFixture(t, { roles: ['finance_operator'] });
    const financeView = await t.http
      .get(`/v1/staff-directory?query=${tag.toLowerCase()}`)
      .set(await authHeaderForPerson(t, finance.personId));
    expect(financeView.status).toBe(200);
    // without identity.read_workforce_directory: no coach or official rows
    expect(financeView.body.items).toEqual([
      {
        personId: deskPerson,
        displayName: `Ada ${tag}`,
        roles: ['front_desk'],
        facilityIds: [t.facilityId],
        scopes: [{ role: 'front_desk', facilityIds: [t.facilityId] }],
      },
    ]);
    const scheduler = await createStaffMemberFixture(t, { roles: ['scheduler'] });
    const schedulerHeader = await authHeaderForPerson(t, scheduler.personId);
    const staffing = await t.http.get(`/v1/staff-directory?query=${tag}`).set(schedulerHeader);
    expect(
      staffing.body.items.map((e: { personId: string; roles: string[]; facilityIds: string[] }) => [
        e.personId,
        e.roles,
        e.facilityIds,
      ]),
    ).toEqual([
      [deskPerson, ['coach', 'front_desk'], []],
      [coachOnly, ['coach', 'official'], []],
    ]);
    const coaches = await t.http
      .get(`/v1/staff-directory?query=${tag}&role=coach&limit=1`)
      .set(schedulerHeader);
    expect(coaches.body.items.map((e: { personId: string }) => e.personId)).toEqual([deskPerson]);
    const next = await t.http
      .get(`/v1/staff-directory?query=${tag}&role=coach&limit=1&cursor=${coaches.body.nextCursor}`)
      .set(schedulerHeader);
    expect(next.body.items.map((e: { personId: string }) => e.personId)).toEqual([coachOnly]);
    expect(next.body.nextCursor).toBeNull();
    // a front desk role at another facility does not cover it
    const other = await seedFacility(t);
    const atOther = await t.http
      .get(`/v1/staff-directory?query=${tag}&role=front_desk&facilityId=${other}`)
      .set(schedulerHeader);
    expect(atOther.body.items).toEqual([]);
    expect(JSON.stringify(staffing.body)).not.toContain('@');
    // a coach and a customer cannot read the directory
    const family = await createOrganizationPeople(t);
    for (const personId of [coachOnly, family.adult.personId]) {
      const res = await t.http
        .get('/v1/staff-directory')
        .set(await authHeaderForPerson(t, personId));
      expect(res.status).toBe(403);
    }
  });

  it('SPK-IAM-005: open reviews list by status and owner, each with the decisions its state allows', async () => {
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const header = await authHeaderForPerson(t, support.personId);
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const open = async (ownerRole: string) => {
      const res = await t.http
        .post('/v1/access-reviews')
        .set(header)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId: family.child.personId, reason: 'dispute', ownerRole });
      expect(res.status).toBe(201);
      return res.body as { id: string; revision: number };
    };
    const a = await open('support_operator');
    const b = await open('general_manager');
    const c = await open('support_operator');
    const decide = (id: string, body: Record<string, unknown>) =>
      t.http
        .post(`/v1/access-reviews/${id}/decisions`)
        .set(header)
        .set('Idempotency-Key', key())
        .send(body);
    expect(
      (await decide(a.id, { kind: 'restrict', grantIds: [family.guardianGrants.collect] })).status,
    ).toBe(201);
    expect((await decide(c.id, { kind: 'escalate' })).status).toBe(201);
    const closedReview = await open('support_operator');
    expect((await decide(closedReview.id, { kind: 'close' })).status).toBe(201);

    const list = await t.http
      .get(`/v1/access-reviews?subjectPersonId=${family.child.personId}`)
      .set(header);
    expect(list.status).toBe(200);
    // default: every review that is not closed, newest first
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([c.id, b.id, a.id]);
    const byId = new Map<string, { allowedDecisions: string[] }>(
      list.body.items.map((r: { id: string; allowedDecisions: string[] }) => [r.id, r]),
    );
    expect(byId.get(a.id)).toMatchObject({
      status: 'open',
      restrictedGrantCount: 1,
      allowedDecisions: ['restrict', 'lift', 'escalate', 'decide', 'close', 'note', 'reassign'],
    });
    expect(byId.get(c.id)).toMatchObject({
      status: 'escalated',
      allowedDecisions: ['restrict', 'lift', 'decide', 'close', 'note', 'reassign'],
    });
    const openOwned = await t.http
      .get(
        `/v1/access-reviews?status=open&ownerRole=support_operator&subjectPersonId=${family.child.personId}`,
      )
      .set(header);
    expect(openOwned.body.items.map((r: { id: string }) => r.id)).toEqual([a.id]);
    const closed = await t.http
      .get(`/v1/access-reviews?status=closed&subjectPersonId=${family.child.personId}`)
      .set(header);
    expect(closed.body.items).toMatchObject([{ id: closedReview.id, allowedDecisions: ['lift'] }]);
    // the single read publishes the same decisions
    const single = await t.http.get(`/v1/access-reviews/${c.id}`).set(header);
    expect(single.body.allowedDecisions).toEqual(byId.get(c.id)?.allowedDecisions);
    // front desk cannot list reviews
    const desk = await authHeaderForPerson(t, family.staff.personId);
    expect((await t.http.get('/v1/access-reviews').set(desk)).status).toBe(403);
  });

  it('SPK-IAM-007: duplicate candidates list (default open) with names and signals and no dates of birth; the single read adds them', async () => {
    const tag = `Dup${newId().slice(-6)}`;
    const a = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Jo',
      familyName: tag,
      dateOfBirth: '1979-05-06',
    });
    const b = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Jo',
      familyName: tag,
      dateOfBirth: '1979-05-06',
    });
    const desk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const header = await authHeaderForPerson(t, desk.personId);
    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personAId: a, personBId: b, reasons: ['same name and date of birth'], score: 80 });
    expect(flagged.status).toBe(201);
    const list = await t.http.get('/v1/duplicate-candidates').set(header);
    expect(list.status).toBe(200);
    const row = list.body.items.find((c: { id: string }) => c.id === flagged.body.id);
    expect(row).toMatchObject({
      status: 'open',
      reasons: ['same name and date of birth'],
      score: 80,
      personA: { displayName: `Jo ${tag}`, kind: 'adult', status: 'active' },
      personB: { displayName: `Jo ${tag}` },
    });
    expect(JSON.stringify(list.body)).not.toContain('1979-05-06');
    const detail = await t.http.get(`/v1/duplicate-candidates/${flagged.body.id}`).set(header);
    expect(detail.body).toMatchObject({
      id: flagged.body.id,
      personA: { dateOfBirth: '1979-05-06', accountLinked: false, contactPointKinds: [] },
      personB: { dateOfBirth: '1979-05-06' },
    });
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const dismissed = await t.http
      .post(`/v1/duplicate-candidates/${flagged.body.id}/dismiss`)
      .set(await authHeaderForPerson(t, support.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'twins' });
    expect(dismissed.status).toBe(200);
    const openNow = await t.http.get('/v1/duplicate-candidates').set(header);
    expect(openNow.body.items.map((c: { id: string }) => c.id)).not.toContain(flagged.body.id);
    const dismissedList = await t.http.get('/v1/duplicate-candidates?status=dismissed').set(header);
    expect(dismissedList.body.items.map((c: { id: string }) => c.id)).toContain(flagged.body.id);
    const coach = await createStaffMemberFixture(t, { roles: ['coach'] });
    expect(
      (
        await t.http
          .get('/v1/duplicate-candidates')
          .set(await authHeaderForPerson(t, coach.personId))
      ).status,
    ).toBe(403);
  });
});
