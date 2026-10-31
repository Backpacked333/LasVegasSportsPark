import { newId, type Principal, type StaffRole } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { defineActions } from '../authorization/actions';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationsService, type CreateOperationInput } from '../operations/operations.service';

const ScopedReadActions = defineActions({
  readOutcome: {
    id: 'kernel_test.read_outcome',
    description: 'Test-only read action of a module that owns a sensitive operation',
    staffRoles: ['finance_operator'],
    allowSelf: true,
  },
});

describe('authentication guard and operations endpoint', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('serves health publicly and echoes correlation ids', async () => {
    const res = await t.http.get('/v1/health').set('x-correlation-id', 'corr-12345678');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'ok' });
    expect(res.headers['x-correlation-id']).toBe('corr-12345678');
  });

  it('rejects missing, malformed, expired and unknown tokens with the error contract', async () => {
    const none = await t.http.get(`/v1/operations/${'0'.repeat(8)}-0000-7000-8000-000000000000`);
    expect(none.status).toBe(401);
    expect(none.body).toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
      nextAction: 'authenticate',
    });
    expect(typeof none.body.correlationId).toBe('string');

    const bad = await t.http.get('/v1/operations/x').set('Authorization', 'Bearer not-a-token');
    expect(bad.status).toBe(401);

    const expired = await t.identityProvider.mint({ subject: 'nobody', ttlSeconds: 60 });
    // the fake resolver does not know `nobody`
    const unknown = await t.http.get('/v1/operations/x').set('Authorization', `Bearer ${expired}`);
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toMatch(/No active account/);
  });

  it('shows an operation to its requester and to staff, and hides it across accounts and organizations', async () => {
    const requester = customerPrincipal(t.organizationId);
    const otherCustomer = customerPrincipal(t.organizationId);
    const staff = staffPrincipal(t.organizationId, ['support_operator']);
    const otherOrgStaff = staffPrincipal('00000000-0000-7000-8000-00000000beef', [
      'system_administrator',
    ]);

    const uow = t.app.get(UnitOfWork);
    const operations = t.app.get(OperationsService);
    const id = await uow.run((ctx) =>
      operations.create(ctx.trx, {
        organizationId: t.organizationId,
        kind: 'test.op',
        requestedBy: requester,
        input: { a: 1 },
      }),
    );

    const mine = await t.http.get(`/v1/operations/${id}`).set(await t.authHeader(requester));
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      id,
      kind: 'test.op',
      status: 'pending',
      result: null,
      error: null,
    });

    const staffView = await t.http.get(`/v1/operations/${id}`).set(await t.authHeader(staff));
    expect(staffView.status).toBe(200);

    const stranger = await t.http
      .get(`/v1/operations/${id}`)
      .set(await t.authHeader(otherCustomer));
    expect(stranger.status).toBe(404);
    expect(stranger.body.code).toBe('NOT_FOUND');

    const crossOrg = await t.http
      .get(`/v1/operations/${id}`)
      .set(await t.authHeader(otherOrgStaff));
    expect(crossOrg.status).toBe(404);
  });

  it('§4.14: operation outcomes are least privilege: coaches and officials read only their own, and a scoped operation follows its module read action, facility and subjects', async () => {
    const uow = t.app.get(UnitOfWork);
    const operations = t.app.get(OperationsService);
    const create = (input: Omit<CreateOperationInput, 'organizationId' | 'kind'>) =>
      uow.run((ctx) =>
        operations.create(ctx.trx, { organizationId: t.organizationId, kind: 'test.op', ...input }),
      );
    const status = async (id: string, principal: Principal) =>
      (await t.http.get(`/v1/operations/${id}`).set(await t.authHeader(principal))).status;
    const staff = (roles: StaffRole[], facilityIds: string[] = []) =>
      staffPrincipal(t.organizationId, roles, { facilityIds });

    const requester = staff(['front_desk']);
    const plain = await create({ requestedBy: requester });
    expect(await status(plain, staff(['coach']))).toBe(404);
    expect(await status(plain, staff(['official']))).toBe(404);
    expect(await status(plain, staff(['front_desk']))).toBe(200);
    const coach = staff(['coach']);
    const own = await create({ requestedBy: coach });
    expect(await status(own, coach)).toBe(200);

    const subject = newId();
    const scoped = await create({
      requestedBy: requester,
      readScope: {
        action: ScopedReadActions.readOutcome,
        facilityId: t.facilityId,
        subjectPersonIds: [subject],
      },
    });
    const stored = await t.db
      .selectFrom('operations')
      .select(['read_action', 'facility_id', 'subject_person_ids'])
      .where('id', '=', scoped)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      read_action: 'kernel_test.read_outcome',
      facility_id: t.facilityId,
      subject_person_ids: [subject],
    });
    expect(await status(scoped, requester)).toBe(200); // the requester always reads its outcome
    expect(await status(scoped, staff(['front_desk']))).toBe(404);
    expect(await status(scoped, staff(['support_operator', 'general_manager']))).toBe(404);
    expect(await status(scoped, staff(['finance_operator'], [newId()]))).toBe(404);
    expect(await status(scoped, staff(['finance_operator'], [t.facilityId]))).toBe(200);
    expect(await status(scoped, staff(['finance_operator']))).toBe(200);
    const self = customerPrincipal(t.organizationId, { personId: subject });
    expect(await status(scoped, self)).toBe(200);
    expect(await status(scoped, customerPrincipal(t.organizationId))).toBe(404);
  });

  it('operation transitions follow the lifecycle and terminal states are final', async () => {
    const uow = t.app.get(UnitOfWork);
    const operations = t.app.get(OperationsService);
    const requester = staffPrincipal(t.organizationId, ['finance_operator']);
    const id = await uow.run((ctx) =>
      operations.create(ctx.trx, {
        organizationId: t.organizationId,
        kind: 'test.op',
        requestedBy: requester,
      }),
    );
    await uow.run((ctx) => operations.transition(ctx.trx, id, 'running'));
    await uow.run((ctx) =>
      operations.transition(ctx.trx, id, 'recovery_required', {
        error: { code: 'X', message: 'local finalization failed' },
      }),
    );
    await uow.run((ctx) =>
      operations.transition(ctx.trx, id, 'succeeded', { result: { recovered: true } }),
    );
    await expect(
      uow.run((ctx) => operations.transition(ctx.trx, id, 'failed')),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const view = await t.http.get(`/v1/operations/${id}`).set(await t.authHeader(requester));
    expect(view.body).toMatchObject({ status: 'succeeded', result: { recovered: true } });
    expect(view.body.completedAt).not.toBeNull();
  });

  it('validates path parameters with the error contract', async () => {
    const staff = staffPrincipal(t.organizationId, ['front_desk']);
    const res = await t.http.get('/v1/operations/not-a-uuid').set(await t.authHeader(staff));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', nextAction: 'correct_input' });
    expect(res.body.details[0].path).toBe('id');
  });
});
