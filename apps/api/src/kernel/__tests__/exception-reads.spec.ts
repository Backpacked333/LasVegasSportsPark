import { Logger, type ArgumentsHost } from '@nestjs/common';
import { DomainError, errors, newId, systemPrincipal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { UnitOfWork } from '../database/unit-of-work';
import {
  OperationalExceptions,
  type RaiseExceptionInput,
} from '../exceptions/operational-exceptions.service';
import { DomainExceptionFilter } from '../http/domain-exception.filter';
import { OperationsService } from '../operations/operations.service';

describe('exception and operation reads, queue-owner authority (K-10, §4.12, §4.10)', () => {
  let t: TestApp;
  let other: { organizationId: string; facilityId: string };
  let exceptions: OperationalExceptions;
  let uow: UnitOfWork;

  const raise = (input: Partial<RaiseExceptionInput> & { ownerQueue: string }) =>
    uow.run(({ trx }) =>
      exceptions.raise(trx, {
        organizationId: t.organizationId,
        category: 'kerneltest.case',
        severity: 'warning',
        title: 'Probe',
        ...input,
      }),
    );

  beforeAll(async () => {
    t = await createTestApp({ clockStart: '2026-11-02T10:00:00Z' });
    other = await seedOrganization(t.db);
    exceptions = t.app.get(OperationalExceptions);
    uow = t.app.get(UnitOfWork);
  });
  afterAll(async () => {
    await t?.close();
  });
  afterEach(() => vi.restoreAllMocks());

  it("§4.10: transitioning another organization's exception answers NOT_FOUND", async () => {
    const foreign = await uow.run(({ trx }) =>
      exceptions.raise(trx, {
        organizationId: other.organizationId,
        category: 'kerneltest.case',
        severity: 'high',
        title: 'Foreign',
        ownerQueue: 'general_manager',
      }),
    );
    const gm = staffPrincipal(t.organizationId, ['general_manager']);
    await expect(
      uow.run(({ trx }) => exceptions.transition(trx, gm, foreign.id, 'acknowledged')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await exceptions.get(t.organizationId, foreign.id)).toBeNull();
    expect(await exceptions.get(other.organizationId, foreign.id)).toMatchObject({
      id: foreign.id,
      status: 'open',
    });
  });

  it('SPK-UX-006: a finance operator resolves an exception whose owner_queue is finance_operator and is refused one owned by league_manager', async () => {
    const finance = staffPrincipal(t.organizationId, ['finance_operator']);
    const own = await raise({ ownerQueue: 'finance_operator', dedupeKey: `own:${newId()}` });
    await uow.run(({ trx }) =>
      exceptions.transition(trx, finance, own.id, 'resolved', { reason: 'reconciled' }),
    );
    expect((await exceptions.get(t.organizationId, own.id))?.status).toBe('resolved');
    const history = await exceptions.history(t.organizationId, own.id);
    expect(history[0]).toMatchObject({ action: 'exceptions.resolved', reason: 'reconciled' });
    expect(history[0]?.actor.personId).toBe(finance.personId);

    const league = await raise({ ownerQueue: 'league_manager' });
    await expect(
      uow.run(({ trx }) => exceptions.transition(trx, finance, league.id, 'resolved')),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    // The owner role must be held where the exception is: a finance operator scoped to another
    // facility does not settle this facility's finance exceptions.
    const elsewhere = staffPrincipal(t.organizationId, ['finance_operator'], {
      facilityIds: [newId()],
    });
    const scoped = await raise({ ownerQueue: 'finance_operator', facilityId: t.facilityId });
    await expect(
      uow.run(({ trx }) => exceptions.transition(trx, elsewhere, scoped.id, 'acknowledged')),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    // A customer never settles a queue.
    await expect(
      uow.run(({ trx }) =>
        exceptions.transition(trx, customerPrincipal(t.organizationId), scoped.id, 'acknowledged'),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('an exception in the migration queue still needs exceptions.manage', async () => {
    const migration = await raise({ ownerQueue: 'migration' });
    const finance = staffPrincipal(t.organizationId, ['finance_operator']);
    await expect(
      uow.run(({ trx }) => exceptions.transition(trx, finance, migration.id, 'acknowledged')),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const support = staffPrincipal(t.organizationId, ['support_operator']);
    await uow.run(({ trx }) => exceptions.transition(trx, support, migration.id, 'acknowledged'));
    expect((await exceptions.get(t.organizationId, migration.id))?.status).toBe('acknowledged');
    // A system principal (a periodic job) settles any queue.
    await uow.run(({ trx }) =>
      exceptions.transition(
        trx,
        systemPrincipal(t.organizationId, 'kernel.test'),
        migration.id,
        'resolved',
      ),
    );
  });

  it('list pages newest first with filters and never reads another organization', async () => {
    const category = `kerneltest.list.${newId().slice(0, 8)}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        (
          await raise({
            ownerQueue: 'scheduler',
            category,
            affectedType: 'event',
            affectedId: `e${i}`,
          })
        ).id,
      );
      t.clock.advance(1000);
    }
    const first = await exceptions.list(t.organizationId, { category, limit: 2 });
    expect(first.items.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    const second = await exceptions.list(t.organizationId, {
      category,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((e) => e.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await exceptions.list(t.organizationId, { category, affectedId: 'e1' })).items.map(
        (e) => e.id,
      ),
    ).toEqual([ids[1]]);
    expect((await exceptions.list(t.organizationId, { category, statuses: [] })).items).toEqual([]);
    expect((await exceptions.list(other.organizationId, { category })).items).toEqual([]);
    expect(
      (await exceptions.list(t.organizationId, { ownerQueue: 'scheduler', statuses: ['open'] }))
        .items.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('OperationsService.requestedBy names who requested an operation, never across organizations', async () => {
    const operations = t.app.get(OperationsService);
    const customer = customerPrincipal(t.organizationId);
    const id = await uow.run(({ trx }) =>
      operations.create(trx, {
        organizationId: t.organizationId,
        kind: 'kerneltest.op',
        requestedBy: customer,
      }),
    );
    expect(await operations.requestedBy(t.organizationId, id)).toEqual({
      kind: 'customer',
      accountId: customer.accountId,
      personId: customer.personId,
    });
    expect(await operations.requestedBy(other.organizationId, id)).toBeNull();
    expect(await operations.requestedBy(t.organizationId, newId())).toBeNull();
  });

  it('the error filter logs a raised INTEGRATION_UNAVAILABLE at warn and an unexpected error at error', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ correlationId: 'corr-k10' }),
      }),
    } as unknown as ArgumentsHost;
    const filter = new DomainExceptionFilter();
    filter.catch(errors.integrationUnavailable('Payments'), host);
    expect(response.status).toHaveBeenLastCalledWith(503);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    filter.catch(new DomainError('INTERNAL_ERROR', 'broken'), host);
    filter.catch(new Error('boom'), host);
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
