import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalExceptions, UnitOfWork } from '../kernel';
import { CatalogModule, createOfferingFixture } from '../modules/catalog';
import {
  IdentityModule,
  PrincipalResolver,
  authHeaderForAccount,
  createPersonFixture,
  createStaffMemberFixture,
} from '../modules/identity';
import { createTestApp, type TestApp } from '../testing';

/**
 * identity-05 (§2.1 staff assignment scope, §4.3, §4.14 least privilege): a role held at one
 * facility stays at that facility, even when the same person holds another role organization-wide
 * or at another facility. The resolved principal carries per-role scopes; the kernel authorizes
 * single records and list queries against the scope of the roles that hold the action.
 */
describe('per-role staff facility scopes through the real resolver', () => {
  let t: TestApp;
  let f2: string;
  let key = 0;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule, CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    f2 = (
      await t.db
        .insertInto('facilities')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          slug: 'annex-scopes',
          name: 'Annex',
          timezone: 'America/Los_Angeles',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
  afterAll(async () => {
    await t?.close();
  });

  const addSession = async (offeringId: string, accountId: string) =>
    t.http
      .post(`/v1/offerings/${offeringId}/sessions`)
      .set(await authHeaderForAccount(t, accountId))
      .set('Idempotency-Key', `scopes-${(key += 1)}`)
      .send({ scheduledStart: '2027-01-12T17:00:00Z', scheduledEnd: '2027-01-12T18:00:00Z' });

  it('identity-05: scheduler at F1 plus an organization-wide coach membership cannot add sessions at F2', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const scheduler = await createStaffMemberFixture(t, {
      personId: person,
      roles: ['scheduler'],
      facilityIds: [t.facilityId],
    });
    await createStaffMemberFixture(t, { personId: person, roles: ['coach'] });
    const principal = await t.app.get(PrincipalResolver).resolve({
      issuer: t.config.AUTH_ISSUER,
      subject: scheduler.accountId,
      sessionId: 's',
      issuedAt: t.clock.now(),
      expiresAt: new Date(t.clock.now().getTime() + 60_000),
      claims: {},
    });
    expect(principal).toMatchObject({ staffRoles: ['coach', 'scheduler'], facilityIds: [] });

    const atF1 = await createOfferingFixture(t, {
      facilityId: t.facilityId,
      responsibleManagerPersonId: person,
    });
    const atF2 = await createOfferingFixture(t, {
      facilityId: f2,
      responsibleManagerPersonId: person,
    });
    expect((await addSession(atF1.offeringId, scheduler.accountId)).status).toBe(201);
    const denied = await addSession(atF2.offeringId, scheduler.accountId);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.code).toBe('ACCESS_DENIED');
  });

  it('identity-05: scheduler at F2 plus coach at F1 cannot act as scheduler at F1', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const scheduler = await createStaffMemberFixture(t, {
      personId: person,
      roles: ['scheduler'],
      facilityIds: [f2],
    });
    await createStaffMemberFixture(t, {
      personId: person,
      roles: ['coach'],
      facilityIds: [t.facilityId],
    });
    const atF1 = await createOfferingFixture(t, {
      facilityId: t.facilityId,
      responsibleManagerPersonId: person,
    });
    const atF2 = await createOfferingFixture(t, {
      facilityId: f2,
      responsibleManagerPersonId: person,
    });
    expect((await addSession(atF2.offeringId, scheduler.accountId)).status).toBe(201);
    expect((await addSession(atF1.offeringId, scheduler.accountId)).status).toBe(403);
  });

  it('identity-05: list queries narrow by the scope of the roles that hold the read action', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const staff = await createStaffMemberFixture(t, {
      personId: person,
      roles: ['front_desk'],
      facilityIds: [t.facilityId],
    });
    // coach does not hold exceptions.read; its organization-wide scope must not widen front_desk
    await createStaffMemberFixture(t, { personId: person, roles: ['coach'] });
    const principal = (await t.app.get(PrincipalResolver).resolve({
      issuer: t.config.AUTH_ISSUER,
      subject: staff.accountId,
      sessionId: 's',
      issuedAt: t.clock.now(),
      expiresAt: new Date(t.clock.now().getTime() + 60_000),
      claims: {},
    }))!;
    const exceptions = t.app.get(OperationalExceptions);
    const uow = t.app.get(UnitOfWork);
    const raised = await uow.run(async (ctx) => ({
      own: await exceptions.raise(ctx.trx, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        category: 'scope.check',
        severity: 'warning',
        title: 'own',
        ownerQueue: 'front_desk',
      }),
      other: await exceptions.raise(ctx.trx, {
        organizationId: t.organizationId,
        facilityId: f2,
        category: 'scope.check',
        severity: 'warning',
        title: 'other',
        ownerQueue: 'front_desk',
      }),
    }));
    const ids = (await exceptions.listOpen(principal, t.organizationId)).map((r) => r.id);
    expect(ids).toContain(raised.own.id);
    expect(ids).not.toContain(raised.other.id);
  });
});
