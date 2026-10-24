import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { attemptsOf, dispatchOutbox, recipientsOf } from '../testing/communications-fixtures';

const key = () => `k-${newId()}`;

describe('staff composition flow (SPK-COMMS-002/003/006, §4.9 commands)', () => {
  let t: TestApp;
  let org: string;
  let people: OrganizationPeople;
  let staff: { Authorization: string };
  let parent: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'phone',
      value: '+17025550100',
    });
    staff = await authHeaderForPerson(t, people.staff.personId);
    parent = await authHeaderForPerson(t, people.adult.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, body: object, headers = staff, k = key()) =>
    t.http.post(path).set(headers).set('Idempotency-Key', k).send(body);

  const composeBody = (overrides: object = {}) => ({
    kind: 'youth_feedback',
    audience: { subjectPersonIds: [people.child.personId] },
    title: 'Coach feedback approved',
    body: 'Great progress on passing this week.',
    protected: true,
    ...overrides,
  });

  it('SPK-COMMS-006: only composer roles may compose; a customer is denied and a reader role may read but not compose', async () => {
    expect((await post('/v1/notifications', composeBody(), parent)).status).toBe(403);
    const finance = await createStaffMemberFixture(t, { roles: ['finance_operator'] });
    const financeAuth = await authHeaderForPerson(t, finance.personId);
    const denied = await post('/v1/notifications', composeBody(), financeAuth);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ACCESS_DENIED');
    const composed = await post('/v1/notifications', composeBody());
    expect(composed.status).toBe(201);
    const read = await t.http.get(`/v1/notifications/${composed.body.id}`).set(financeAuth);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'composed', protected: true, revision: 1 });
  });

  it('validates the body and refuses a facility of another organization', async () => {
    const invalid = await post('/v1/notifications', composeBody({ audience: {} }));
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_FAILED');
    const other = await seedOrganization(t.db, { slug: `other-${newId()}` });
    const foreign = await post('/v1/notifications', composeBody({ facilityId: other.facilityId }));
    expect(foreign.status).toBe(404);
    const missingKey = await t.http.post('/v1/notifications').set(staff).send(composeBody());
    expect(missingKey.status).toBe(400);
  });

  it('SPK-COMMS-006 + SPK-COMMS-003: preview shows names and a count from CURRENT permissions and never a contact list; send resolves recipients, creates an operation and dispatch creates attempts', async () => {
    const composed = await post('/v1/notifications', composeBody());
    const id = composed.body.id as string;

    const preview1 = await t.http.get(`/v1/notifications/${id}/recipients`).set(staff);
    expect(preview1.status).toBe(200);
    expect(preview1.body.count).toBe(1);
    expect(preview1.body.recipients[0]).toMatchObject({
      personId: people.adult.personId,
      basis: 'receive_messages',
      subjectPersonIds: [people.child.personId],
    });
    expect(preview1.body.recipients[0].displayName).toMatch(/^Adult\d+ Family\d+$/);
    const serialized = JSON.stringify(preview1.body);
    expect(serialized).not.toContain('parent@example.test');
    expect(serialized).not.toContain('7025550100');
    expect(serialized).not.toContain('contactPoints');

    // a second guardian added after composition is a recipient: resolution is never a stored list
    const second = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: second });
    await createRelationshipFixture(t, {
      actorPersonId: second,
      subjectPersonId: people.child.personId,
      permissions: ['view', 'receive_messages'],
    });
    const preview2 = await t.http.get(`/v1/notifications/${id}/recipients`).set(staff);
    expect(preview2.body.count).toBe(2);
    expect(preview2.body.recipients.map((r: { personId: string }) => r.personId).sort()).toEqual(
      [people.adult.personId, second].sort(),
    );

    const sent = await post(`/v1/notifications/${id}/send`, { expectedRevision: 1 });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'queued', revision: 2 });
    expect(sent.body.operationId).toEqual(expect.any(String));
    const operation = await t.http.get(`/v1/operations/${sent.body.operationId}`).set(staff);
    expect(operation.status).toBe(200);
    expect(operation.body.status).toBe('running');
    const recipients = await recipientsOf(t.db, org, id);
    expect(recipients.map((r) => r.status)).toEqual(['pending', 'pending']);

    await dispatchOutbox(t.app);
    const deliveries = await t.http.get(`/v1/notifications/${id}/deliveries`).set(staff);
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.notification).toMatchObject({ status: 'dispatched' });
    expect(
      deliveries.body.recipients.every((r: { status: string }) => r.status === 'authorized'),
    ).toBe(true);
    const byPerson = (personId: string) =>
      deliveries.body.attempts.filter(
        (a: { recipientId: string }) =>
          deliveries.body.recipients.find((r: { id: string }) => r.id === a.recipientId)
            ?.personId === personId,
      );
    // operational defaults: in-app (delivered by the platform), push and email queued; sms off
    expect(
      byPerson(people.adult.personId)
        .map((a: { channel: string; status: string }) => `${a.channel}:${a.status}`)
        .sort(),
    ).toEqual(['email:queued', 'in_app:delivered', 'push:queued']);
    expect(byPerson(second)).toHaveLength(3);
    const done = await t.http.get(`/v1/operations/${sent.body.operationId}`).set(staff);
    expect(done.body.status).toBe('succeeded');
    expect(done.body.result).toMatchObject({ authorized: 2, revoked: 0, attempts: 6 });
  });

  it('§4.9: the same idempotency key replays the send, a different payload conflicts, a stale revision fails, and a queued notice cannot be sent twice', async () => {
    const composed = await post('/v1/notifications', composeBody({ protected: false }));
    const id = composed.body.id as string;
    const stale = await post(`/v1/notifications/${id}/send`, { expectedRevision: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');

    const k = key();
    const first = await post(`/v1/notifications/${id}/send`, { expectedRevision: 1 }, staff, k);
    expect(first.status).toBe(200);
    const resolvedOnce = await recipientsOf(t.db, org, id);
    expect(resolvedOnce.length).toBeGreaterThan(0);
    const replay = await post(`/v1/notifications/${id}/send`, { expectedRevision: 1 }, staff, k);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await recipientsOf(t.db, org, id)).toHaveLength(resolvedOnce.length);
    const conflict = await post(`/v1/notifications/${id}/send`, { reason: 'changed' }, staff, k);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const again = await post(`/v1/notifications/${id}/send`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  it('§4.3/§4.10: a staff member of another organization sees nothing', async () => {
    const composed = await post('/v1/notifications', composeBody());
    const id = composed.body.id as string;
    const other = await seedOrganization(t.db, { slug: `other-${newId()}` });
    const outsider = await createStaffMemberFixture(t, {
      roles: ['general_manager'],
      organizationId: other.organizationId,
    });
    const outsiderAuth = await authHeaderForPerson(t, outsider.personId);
    expect((await t.http.get(`/v1/notifications/${id}`).set(outsiderAuth)).status).toBe(404);
    expect((await t.http.get(`/v1/notifications/${id}/recipients`).set(outsiderAuth)).status).toBe(
      404,
    );
    expect((await post(`/v1/notifications/${id}/send`, {}, outsiderAuth)).status).toBe(404);
    const list = await t.http.get('/v1/notifications').set(outsiderAuth);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
  });

  it('SPK-COMMS-003: a staff-role audience resolves to the people holding the role right now, within the facility scope', async () => {
    const scheduler = await createStaffMemberFixture(t, {
      roles: ['scheduler'],
      facilityIds: [t.facilityId],
    });
    const former = await createStaffMemberFixture(t, {
      roles: ['scheduler'],
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: new Date('2026-06-01T00:00:00Z'),
    });
    const elsewhere = await createStaffMemberFixture(t, {
      roles: ['scheduler'],
      facilityIds: [newId()],
    });
    const composed = await post(
      '/v1/notifications',
      composeBody({
        kind: 'staff_broadcast',
        facilityId: t.facilityId,
        audience: { staffRoles: ['scheduler'], facilityId: t.facilityId },
        protected: false,
      }),
    );
    const preview = await t.http.get(`/v1/notifications/${composed.body.id}/recipients`).set(staff);
    const ids = preview.body.recipients.map((r: { personId: string }) => r.personId);
    expect(ids).toContain(scheduler.personId);
    expect(ids).not.toContain(former.personId);
    expect(ids).not.toContain(elsewhere.personId);
    expect(preview.body.recipients[0]).toMatchObject({
      basis: 'staff_role',
      basisDetail: 'scheduler',
    });
  });

  it('an audience that resolves to nobody is suppressed with reason no_recipients and the operation completes', async () => {
    const composed = await post(
      '/v1/notifications',
      composeBody({ audience: { personIds: [newId()] }, protected: false }),
    );
    const sent = await post(`/v1/notifications/${composed.body.id}/send`, {});
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'suppressed', suppressionReason: 'no_recipients' });
    expect(await attemptsOf(t.db, org, composed.body.id)).toHaveLength(0);
  });

  it('GET /notifications lists newest first with status and kind filters and a cursor', async () => {
    const list = await t.http.get('/v1/notifications?limit=2&status=suppressed').set(staff);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    for (const item of list.body.items) expect(item.status).toBe('suppressed');
    const all = await t.http.get('/v1/notifications?limit=2').set(staff);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.nextCursor).toEqual(expect.any(String));
    const next = await t.http
      .get(`/v1/notifications?limit=2&cursor=${encodeURIComponent(all.body.nextCursor)}`)
      .set(staff);
    expect(next.status).toBe(200);
    expect(next.body.items.map((i: { id: string }) => i.id)).not.toContain(all.body.items[0].id);
    expect(
      new Date(all.body.items[0].createdAt).getTime() >=
        new Date(all.body.items[1].createdAt).getTime(),
    ).toBe(true);
  });
});
